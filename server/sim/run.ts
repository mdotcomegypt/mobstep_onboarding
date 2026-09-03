import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { startDrupalMock, type MockState } from "./drupal-mock.ts";

/**
 * A full onboarding run, end to end, with nothing stubbed that matters.
 *
 * Real: the Fastify server (started the way systemd starts it), the LangGraph
 * agent, Vertex Gemini for both conversation and image generation, Postgres,
 * the checkpointer, uploads, SSE, and every tool.
 *
 * Not real, and deliberately so:
 *   - Drupal, which is replaced by sim/drupal-mock.ts. Those endpoints create
 *     real app tenancies and queue real Gradle builds on the production host.
 *   - The WhatsApp OTP. Verifying for real means sending a WhatsApp message to
 *     a live phone number, so the row is marked verified directly instead. The
 *     OTP path has its own tests; what is under test here is everything after it.
 *
 * Everything the run produces — transcript, cards, generated artwork, and the
 * exact payloads Drupal was handed — is written to sim/out/.
 */

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "out");
const MENU = join(here, "fixtures", "rosto-menu.png");

const PORT = Number(process.env["SIM_PORT"] ?? 8791);
const DRUPAL_PORT = Number(process.env["SIM_DRUPAL_PORT"] ?? 8792);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MAX_TURNS = Number(process.env["SIM_MAX_TURNS"] ?? 26);

const SECRETS = {
  onboarding: "sim-onboarding-secret",
  mobld: "sim-mobld-secret",
  session: "sim-session-secret-0123456789abcdef",
};

const UID = 4242;

/**
 * The driver needs the same configuration the child does.
 *
 * It plays the owner with the same Vertex client the server uses, and
 * src/lib/env.ts asserts every required variable at import time — correctly, for
 * the server. So the environment is assembled here first, and the modules that
 * read it are imported afterwards, dynamically. A static import would be hoisted
 * above these assignments and throw before the first line ran.
 */
Object.assign(process.env, {
  ONBOARDING_SECRET: SECRETS.onboarding,
  MOBLD_SECRET: SECRETS.mobld,
  SESSION_SECRET: SECRETS.session,
  DATABASE_URL:
    process.env["SIM_DATABASE_URL"] ??
    "postgres://onboarding:onboarding@127.0.0.1:5432/onboarding",
  WA_BUSINESS_ACCOUNT_ID: "sim",
  WA_PHONE_NUMBER_ID: "sim",
  WA_ACCESS_TOKEN: "sim",
  GOOGLE_APPLICATION_CREDENTIALS:
    process.env["SIM_GOOGLE_CREDENTIALS"] ?? process.env["GOOGLE_APPLICATION_CREDENTIALS"] ?? "",
  GOOGLE_CLOUD_PROJECT: process.env["SIM_GOOGLE_PROJECT"] ?? "comcore",
  GOOGLE_CLOUD_LOCATION: "global",
} satisfies NodeJS.ProcessEnv);

const { ROSTO, ownerReply } = await import("./owner.ts");

// ---------------------------------------------------------------- reporting

const t0 = Date.now();
const stamp = (): string => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;

const log = (icon: string, message: string): void => {
  console.log(`${stamp()} ${icon} ${message}`);
};

interface Event {
  at: number;
  kind: string;
  data: unknown;
}

const events: Event[] = [];
const record = (kind: string, data: unknown): void => {
  events.push({ at: Date.now() - t0, kind, data });
};

// ---------------------------------------------------------------- handoff

/** Mints the JWT Drupal's OnboardingHandoff::signJwt() would. */
function handoffToken(): string {
  const b64 = (value: string): string =>
    Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(
    JSON.stringify({
      uid: UID,
      email: "hossam@rostoegypt.test",
      name: "Hossam",
      app_id: null,
      phone: null,
      iat: now,
      exp: now + 300,
      jti: randomUUID(),
    }),
  );
  const signature = createHmac("sha256", SECRETS.onboarding)
    .update(`${header}.${payload}`)
    .digest("base64url");

  return `${header}.${payload}.${signature}`;
}

// ---------------------------------------------------------------- SSE turn

interface TurnResult {
  text: string;
  cards: unknown[];
  tools: string[];
  statuses: string[];
  retries: number;
  phase: string;
  error: { message: string; detail?: string } | null;
  ms: number;
}

/**
 * Sends one message and consumes the SSE stream, printing it as it arrives.
 *
 * Reading the stream live is the point: it is the only way to see whether the
 * owner is left staring at nothing, and for how long.
 */
async function sendTurn(
  cookie: string,
  message: string,
  attachments: string[],
): Promise<TurnResult> {
  const startedAt = Date.now();
  const result: TurnResult = {
    text: "",
    cards: [],
    tools: [],
    statuses: [],
    retries: 0,
    phase: "",
    error: null,
    ms: 0,
  };

  const response = await fetch(`${ORIGIN}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify({ message, attachments }),
  });

  if (!response.ok || !response.body) {
    result.error = { message: `HTTP ${response.status}: ${await response.text()}` };
    result.ms = Date.now() - startedAt;
    return result;
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let sinceOutput = Date.now();
  let printedPrefix = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;

    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      let event = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (!data) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        continue;
      }

      switch (event) {
        case "token": {
          const piece = String(parsed["text"] ?? "");
          if (!printedPrefix) {
            process.stdout.write(`${stamp()} 🤖 `);
            printedPrefix = true;
          }
          process.stdout.write(piece);
          result.text += piece;
          sinceOutput = Date.now();
          break;
        }
        case "tool":
          if (printedPrefix) {
            process.stdout.write("\n");
            printedPrefix = false;
          }
          result.tools.push(String(parsed["name"]));
          log("🔧", String(parsed["name"]));
          sinceOutput = Date.now();
          break;
        case "status": {
          const label = String(parsed["label"] ?? "");
          const step = parsed["step"];
          const total = parsed["total"];
          const suffix = step && total ? ` (${String(step)}/${String(total)})` : "";
          result.statuses.push(label + suffix);
          log("   ⋯", `${label}${suffix}`);
          sinceOutput = Date.now();
          break;
        }
        case "tool_done":
          sinceOutput = Date.now();
          break;
        case "retry":
          result.retries += 1;
          log("↻", `RETRY ${String(parsed["attempt"])}/${String(parsed["of"])}: ${String(parsed["message"])}`);
          sinceOutput = Date.now();
          break;
        case "card": {
          if (printedPrefix) {
            process.stdout.write("\n");
            printedPrefix = false;
          }
          result.cards.push(parsed);
          log("🃏", describeCard(parsed));
          sinceOutput = Date.now();
          break;
        }
        case "done":
          result.phase = String(parsed["phase"] ?? "");
          break;
        case "error":
          result.error = {
            message: String(parsed["message"]),
            ...(parsed["detail"] ? { detail: String(parsed["detail"]) } : {}),
          };
          break;
      }

      // The metric that matters most: how long the owner sees nothing at all.
      const gap = Date.now() - sinceOutput;
      if (gap > 20_000) record("silence", { seconds: Math.round(gap / 1000) });
    }
  }

  if (printedPrefix) process.stdout.write("\n");
  result.ms = Date.now() - startedAt;
  return result;
}

function describeCard(card: Record<string, unknown>): string {
  const kind = String(card["kind"]);
  switch (kind) {
    case "palette":
      return `palette · ${(card["options"] as Array<{ name?: string; brand: string }>)
        .map((p) => `${p.name ?? "?"} ${p.brand}`)
        .join(" | ")}`;
    case "themes":
      return `themes · ${(card["options"] as Array<{ name: string }>).map((t) => t.name).join(", ")}`;
    case "catalog": {
      const categories = card["categories"] as Array<{ name: string; items: unknown[] }>;
      const items = categories.reduce((n, c) => n + c.items.length, 0);
      return `catalog · ${categories.length} sections, ${items} items — ${categories
        .map((c) => `${c.name}(${c.items.length})`)
        .join(", ")}`;
    }
    case "gallery": {
      const images = card["images"] as Array<{ label?: string }>;
      return `gallery · ${String(card["title"])} — ${images.length} images`;
    }
    case "logo":
      return `logo · ${(card["options"] as string[]).length} option(s)`;
    case "progress":
      return `progress · ${String(card["label"])} [${String(card["status"])}]`;
    case "table":
      return `table · ${String(card["title"])} (${(card["rows"] as unknown[]).length} rows)`;
    default:
      return kind;
  }
}

// ---------------------------------------------------------------- boot

async function waitForHealth(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`${url} never became healthy`);
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/**
 * Frees a port left bound by an earlier run.
 *
 * An aborted run leaves the child server alive — it is spawned detached from
 * this script's own lifetime — and the next run then binds nothing, talks to
 * the *previous* server against the previous mock, and produces a transcript
 * that looks plausible and means nothing. Better to reclaim the port loudly.
 */
async function freePort(port: number): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  try {
    const { stdout } = await run("lsof", ["-ti", `tcp:${port}`]);
    const pids = stdout.split("\n").map((p) => p.trim()).filter(Boolean);
    for (const pid of pids) {
      log("⚠", `port ${port} held by pid ${pid} from an earlier run — stopping it`);
      process.kill(Number(pid), "SIGTERM");
    }
    if (pids.length > 0) await new Promise((resolve) => setTimeout(resolve, 700));
  } catch {
    // lsof exits non-zero when nothing holds the port, which is the good case.
  }
}

async function main(): Promise<void> {
  await freePort(PORT);
  await freePort(DRUPAL_PORT);
  await mkdir(OUT, { recursive: true });
  await mkdir(join(OUT, "artwork"), { recursive: true });

  const credentials =
    process.env["SIM_GOOGLE_CREDENTIALS"] ?? process.env["GOOGLE_APPLICATION_CREDENTIALS"] ?? "";
  const databaseUrl =
    process.env["SIM_DATABASE_URL"] ?? "postgres://onboarding:onboarding@127.0.0.1:5432/onboarding";
  const uploadDir = join(OUT, "uploads");
  await mkdir(uploadDir, { recursive: true });

  log("▸", "Starting mock Drupal");
  const drupal = await startDrupalMock({ port: DRUPAL_PORT, secret: SECRETS.mobld });

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "development",
    PORT: String(PORT),
    PUBLIC_ORIGIN: ORIGIN,
    ONBOARDING_SECRET: SECRETS.onboarding,
    MOBLD_SECRET: SECRETS.mobld,
    DRUPAL_BASE_URL: drupal.url,
    SESSION_SECRET: SECRETS.session,
    DATABASE_URL: databaseUrl,
    UPLOAD_DIR: uploadDir,
    // Never reached: the run never requests an OTP. Present because env.ts
    // refuses to start without them, which is the behaviour under test elsewhere.
    WA_BUSINESS_ACCOUNT_ID: "sim",
    WA_PHONE_NUMBER_ID: "sim",
    WA_ACCESS_TOKEN: "sim",
    GOOGLE_APPLICATION_CREDENTIALS: credentials,
    GOOGLE_CLOUD_PROJECT: process.env["SIM_GOOGLE_PROJECT"] ?? "comcore",
    GOOGLE_CLOUD_LOCATION: "global",
    MODEL_CHAT: process.env["MODEL_CHAT"] ?? "gemini-2.5-flash",
    MODEL_IMAGE: process.env["MODEL_IMAGE"] ?? "gemini-2.5-flash-image",
    DEBUG_KEY: "sim-debug",
  };

  log("▸", "Applying migrations");
  await new Promise<void>((resolve, reject) => {
    const migrate = spawn(
      process.execPath,
      ["--experimental-strip-types", join(here, "..", "src", "db", "migrate.ts")],
      { env: childEnv, stdio: "inherit" },
    );
    migrate.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`migrate exited ${String(code)}`)),
    );
  });

  log("▸", `Starting the onboarding server on :${PORT}`);
  const serverLog: string[] = [];
  const server: ChildProcess = spawn(
    process.execPath,
    ["--experimental-strip-types", join(here, "..", "src", "index.ts")],
    { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = (chunk: Buffer): void => {
    const line = chunk.toString();
    serverLog.push(line);
    if (/error|ERR|warn/i.test(line)) process.stderr.write(`     ⚠ ${line}`);
  };
  server.stdout?.on("data", capture);
  server.stderr?.on("data", capture);

  const pool = new pg.Pool({ connectionString: databaseUrl });

  const shutdown = async (): Promise<void> => {
    server.kill("SIGTERM");
    await drupal.stop().catch(() => {});
    await pool.end().catch(() => {});
  };

  try {
    await waitForHealth(`${ORIGIN}/api/health`, 30_000);
    log("✓", "Server healthy");

    // A clean slate, so a re-run is not a resumed conversation.
    await pool.query("DELETE FROM onboarding_sessions WHERE drupal_uid = $1", [UID]);

    // ---- session -------------------------------------------------------
    const sessionResponse = await fetch(`${ORIGIN}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: handoffToken() }),
    });
    if (!sessionResponse.ok) {
      throw new Error(`session exchange failed: ${await sessionResponse.text()}`);
    }
    const cookie = (sessionResponse.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    log("✓", "Handoff token exchanged for a session");

    // ---- phone ---------------------------------------------------------
    // Marked verified directly. Requesting an OTP would send a real WhatsApp
    // message to a real number; what this run exercises is everything past it.
    await pool.query(
      `UPDATE onboarding_sessions
          SET phone = $2, phone_verified_at = now()
        WHERE drupal_uid = $1`,
      [UID, "201001234567"],
    );
    log("✓", "Phone marked verified (OTP send skipped by design)");

    // ---- menu upload ---------------------------------------------------
    const menuBytes = await readFile(MENU);
    const form = new FormData();
    form.append("files", new Blob([menuBytes], { type: "image/png" }), "rosto-menu.png");
    const uploadResponse = await fetch(`${ORIGIN}/api/upload`, {
      method: "POST",
      headers: { cookie },
      body: form,
    });
    if (!uploadResponse.ok) throw new Error(`upload failed: ${await uploadResponse.text()}`);
    const uploaded = (await uploadResponse.json()) as { files: Array<{ id: string }> };
    const menuId = uploaded.files[0]?.id ?? "";
    log("✓", `Menu photo uploaded (${(menuBytes.length / 1024).toFixed(0)} KB) as ${menuId.slice(0, 8)}…`);

    // ---- the conversation ----------------------------------------------
    console.log("\n" + "─".repeat(78) + "\n");

    const history: Array<{ role: "assistant" | "owner"; text: string }> = [];
    const turns: Array<{ owner: string; note: string; result: TurnResult }> = [];
    let menuSent = false;
    let stuckCount = 0;

    // The opening turn: an empty message is how the client asks for a greeting.
    let result = await sendTurn(cookie, "", []);
    history.push({ role: "assistant", text: result.text });
    turns.push({ owner: "(arrived)", note: "opening", result });
    record("turn", { owner: "", ...summarize(result) });

    for (let turn = 1; turn <= MAX_TURNS; turn += 1) {
      if (result.error) {
        log("✗", `stream error: ${result.error.message}`);
        if (result.error.detail) log(" ", `   ${result.error.detail}`);
      }

      // The owner is played by the same model the agent uses, against the same
      // quota, so it hits the same 429s. A failure here is a fault in the test
      // rig, not in the thing under test, and it must not end the run — so it
      // falls back to a neutral nudge and carries on.
      let reply;
      try {
        reply = await ownerReply(ROSTO, history, { menuAlreadySent: menuSent, turn });
      } catch (error) {
        log("⚠", `owner model failed (${(error as Error).message.slice(0, 80)}) — nudging instead`);
        reply = { message: "ok, go ahead", sendMenu: false, finished: false, note: "rig fallback" };
      }
      if (reply.finished) {
        log("🏁", `Owner considers it done — ${reply.note}`);
        break;
      }

      const attachments = reply.sendMenu ? [menuId] : [];
      if (reply.sendMenu) menuSent = true;

      await new Promise((resolve) => setTimeout(resolve, 1_200));

      console.log("");
      log("👤", `${reply.message}${reply.sendMenu ? "  [📎 rosto-menu.png]" : ""}`);
      if (reply.note) log("  ", `   (${reply.note})`);

      history.push({
        role: "owner",
        text: reply.message + (reply.sendMenu ? " [attached the menu photo]" : ""),
      });

      result = await sendTurn(cookie, reply.message, attachments);
      history.push({ role: "assistant", text: result.text });
      turns.push({ owner: reply.message, note: reply.note, result });
      record("turn", { owner: reply.message, ...summarize(result) });

      // "Stuck" has a precise meaning here: a turn that produced no prose, no
      // card and no tool call. That is the failure this whole run exists to
      // catch, so it stops the run rather than being buried in the transcript.
      if (!result.text.trim() && result.cards.length === 0 && result.tools.length === 0) {
        stuckCount += 1;
        log("✗", `STUCK: turn produced nothing (${stuckCount})`);
        if (stuckCount >= 2) break;
      } else {
        stuckCount = 0;
      }

      if (result.phase === "done") {
        log("🏁", "Build finished");
        // One more turn so the assistant can hand over the result.
        const closing = await ownerReply(ROSTO, history, {
          menuAlreadySent: menuSent,
          turn,
        }).catch(() => ({ message: "", sendMenu: false, finished: true, note: "" }));
        if (closing.message) {
          console.log("");
          log("👤", closing.message);
          result = await sendTurn(cookie, closing.message, []);
          turns.push({ owner: closing.message, note: closing.note, result });
        }
        break;
      }
    }

    console.log("\n" + "─".repeat(78) + "\n");

    // ---- collect --------------------------------------------------------
    // The server's own ring-buffer trace, which is the only place that says
    // *why* a turn failed — model retries, pruned history, queue waits.
    const traceEvents = await fetch(`${ORIGIN}/api/debug/log?key=sim-debug&limit=400`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);

    await collect(pool, drupal.state, turns, uploadDir, serverLog, traceEvents);
  } finally {
    await shutdown();
  }
}

function summarize(result: TurnResult): Record<string, unknown> {
  return {
    ms: result.ms,
    chars: result.text.length,
    tools: result.tools,
    cards: result.cards.length,
    statuses: result.statuses.length,
    retries: result.retries,
    phase: result.phase,
    error: result.error?.message ?? null,
  };
}

async function collect(
  pool: pg.Pool,
  drupalState: MockState,
  turns: Array<{ owner: string; note: string; result: TurnResult }>,
  uploadDir: string,
  serverLog: string[],
  traceEvents: unknown,
): Promise<void> {
  const facts = (
    await pool.query<{ facts: Record<string, unknown> }>(
      "SELECT facts FROM onboarding_facts f JOIN onboarding_sessions s ON s.id = f.session_id WHERE s.drupal_uid = $1",
      [UID],
    )
  ).rows[0]?.facts;

  const uploads = (
    await pool.query<{ id: string; filename: string; kind: string; mime: string; bytes: number }>(
      `SELECT u.id, u.filename, u.kind, u.mime, u.bytes
         FROM onboarding_uploads u JOIN onboarding_sessions s ON s.id = u.session_id
        WHERE s.drupal_uid = $1 ORDER BY u.created_at`,
      [UID],
    )
  ).rows;

  // Copy the generated artwork out where it can actually be looked at.
  for (const upload of uploads) {
    if (upload.kind === "attachment") continue;
    const ext = upload.mime === "image/jpeg" ? "jpg" : "png";
    await copyFile(
      join(uploadDir, `${upload.id}.${ext}`),
      join(OUT, "artwork", `${upload.kind}-${upload.filename}`),
    ).catch(() => {});
  }

  const messages = (
    await pool.query<{ role: string; content: string; cards: unknown }>(
      `SELECT m.role, m.content, m.cards FROM onboarding_messages m
         JOIN onboarding_sessions s ON s.id = m.session_id
        WHERE s.drupal_uid = $1 ORDER BY m.id`,
      [UID],
    )
  ).rows;

  const report = {
    ranAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - t0) / 1000),
    turns: turns.map((t) => ({ owner: t.owner, note: t.note, ...summarize(t.result) })),
    facts,
    uploads,
    drupal: {
      requests: drupalState.requests.map((r) => ({ method: r.method, path: r.path })),
      apps: [...drupalState.apps.entries()].map(([id, body]) => ({ id, ...body })),
      branches: [...drupalState.branches.entries()].map(([id, rows]) => ({ app: id, branches: rows })),
      catalog: [...drupalState.catalog.entries()].map(([id, rows]) => ({ app: id, categories: rows })),
      themeKeys: [...drupalState.themeKeys.entries()].map(([id, keys]) => ({ app: id, keys })),
      assets: [...drupalState.assets.entries()].map(([id, rows]) => ({ app: id, assets: rows })),
      features: [...drupalState.features.entries()].map(([id, list]) => ({ app: id, features: list })),
    },
    events,
    trace: traceEvents,
  };

  await writeFile(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(join(OUT, "transcript.json"), JSON.stringify(messages, null, 2));
  await writeFile(join(OUT, "server.log"), serverLog.join(""));

  // ---- the summary a human actually reads -----------------------------
  const catalog = (facts?.["catalog"] as { categories?: Array<{ name: string; iconUrl?: string; items: Array<{ imageUrl?: string }> }> })?.categories ?? [];
  const totalItems = catalog.reduce((n, c) => n + c.items.length, 0);
  const withIcons = catalog.filter((c) => c.iconUrl).length;
  const photographed = catalog.reduce((n, c) => n + c.items.filter((i) => i.imageUrl).length, 0);

  console.log("RESULT");
  console.log(`  turns              ${turns.length}`);
  console.log(`  stuck turns        ${turns.filter((t) => !t.result.text.trim() && t.result.cards.length === 0 && t.result.tools.length === 0).length}`);
  console.log(`  errors             ${turns.filter((t) => t.result.error).length}`);
  console.log(`  retries            ${turns.reduce((n, t) => n + t.result.retries, 0)}`);
  console.log(`  status lines       ${turns.reduce((n, t) => n + t.result.statuses.length, 0)}`);
  console.log(`  slowest turn       ${(Math.max(...turns.map((t) => t.result.ms)) / 1000).toFixed(1)}s`);
  console.log("");
  console.log(`  categories         ${catalog.length}  (${withIcons} with icons)`);
  console.log(`  items              ${totalItems}  (${photographed} photographed)`);
  console.log(`  placeholder        ${(facts?.["artwork"] as { placeholderUrl?: string })?.placeholderUrl ? "yes" : "no"}`);
  console.log(`  branches           ${((facts?.["locations"] as { branches?: unknown[] })?.branches ?? []).length}`);
  const features = (facts?.["features"] as string[] | undefined) ?? [];
  console.log(`  features           ${features.length}${features.length ? "  " + features.join(", ") : ""}`);
  console.log(`  app id             ${String(facts?.["appId"] ?? "—")}`);
  console.log(`  package            ${String(facts?.["packageName"] ?? "—")}`);
  console.log("");
  console.log(`  Drupal calls       ${drupalState.requests.length}`);
  for (const request of drupalState.requests) {
    console.log(`    ${request.method.padEnd(6)} ${request.path}`);
  }
  console.log("");
  console.log(`  written to         ${OUT}`);
}

main().catch((error: unknown) => {
  console.error("\nSIMULATION FAILED\n", error);
  process.exit(1);
});
