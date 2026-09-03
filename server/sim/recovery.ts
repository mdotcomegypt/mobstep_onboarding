/**
 * The failure paths, driven directly.
 *
 * A full conversation run takes ten minutes and only exercises the happy path,
 * because the agent has to be persuaded into a mistake to reach anything else.
 * These call the tools themselves, so the cases that actually broke production
 * can be reproduced in seconds:
 *
 *   1. choose_theme is handed an id nobody published — the exact shape of the
 *      failure that reached a real owner, where the agent invented a number and
 *      Drupal rejected it ten minutes later during assembly.
 *   2. assemble_app is handed a bad theme anyway, to prove the app survives
 *      something cosmetic.
 *   3. assemble_app fails outright, to prove the owner is told which step and
 *      with what message.
 */
import pg from "pg";
import { startDrupalMock } from "./drupal-mock.ts";

const DRUPAL_PORT = Number(process.env["SIM_DRUPAL_PORT"] ?? 8794);
const SECRET = "sim-mobld-secret";
const UID = 4243;

Object.assign(process.env, {
  ONBOARDING_SECRET: "sim",
  MOBLD_SECRET: SECRET,
  SESSION_SECRET: "sim",
  DATABASE_URL:
    process.env["SIM_DATABASE_URL"] ??
    "postgres://onboarding:onboarding@127.0.0.1:5432/onboarding",
  WA_BUSINESS_ACCOUNT_ID: "sim",
  WA_PHONE_NUMBER_ID: "sim",
  WA_ACCESS_TOKEN: "sim",
  DRUPAL_BASE_URL: `http://127.0.0.1:${DRUPAL_PORT}`,
  PUBLIC_ORIGIN: `http://127.0.0.1:${DRUPAL_PORT}`,
} satisfies NodeJS.ProcessEnv);

const drupal = await startDrupalMock({ port: DRUPAL_PORT, secret: SECRET });
const { buildTools } = await import("../src/graph/tools.ts");
const { saveFacts, loadFacts } = await import("../src/graph/facts.ts");
const { emptyFacts } = await import("../src/graph/state.ts");
const { pool } = await import("../src/db/index.ts");

let failures = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? `\n      ${detail}` : ""}`);
};

/**
 * Invokes a tool by name.
 *
 * The array buildTools returns is a union of differently-typed StructuredTools,
 * so its `.invoke` is not callable generically — TypeScript cannot pick one
 * signature. Narrowing to the shape actually used here is honest about what
 * this harness does: it hands a tool an argument object and reads back a
 * string, exactly as the agent does.
 */
type Invokable = { name: string; invoke: (input: unknown) => Promise<unknown> };

const call = async (
  tools: ReturnType<typeof buildTools>,
  name: string,
  args: unknown,
): Promise<string> => {
  const tool = (tools as unknown as Invokable[]).find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return String(await tool.invoke(args));
};

const parse = (raw: string): Record<string, unknown> => {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { text: raw };
  }
};

async function freshSession(): Promise<number> {
  await pool.query("DELETE FROM onboarding_sessions WHERE drupal_uid = $1", [UID]);
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO onboarding_sessions (drupal_uid, email, name, phone, phone_verified_at)
     VALUES ($1, 'sim@test', 'Sim', '200000000', now()) RETURNING id`,
    [UID],
  );
  const id = rows[0]!.id;

  const facts = emptyFacts();
  facts.business = { name: "Rosto Fried Chicken", type: "Food & Beverage", currency: "EGP" };
  facts.brand.palette = {
    brand: "#D31130",
    onBrand: "#FFFFFF",
    surface: "#F2F4F6",
    onSurface: "#242526",
    border: "#666A72",
  };
  facts.catalog.categories = [
    { name: "بيتزا", items: [{ name: "مارغريتا", price: 110 }, { name: "روستو", price: 120 }] },
  ];
  facts.locations.branches = [{ name: "Nasr City", phone: "01001234567" }];
  facts.features = ["catalog_browse", "cart_checkout"];
  await saveFacts(id, facts);
  return id;
}

try {
  console.log("\n1 · choose_theme rejects an id nobody published");
  {
    const sessionId = await freshSession();
    const tools = buildTools({ sessionId, uid: UID, appId: null });

    const bogus = await call(tools, "choose_theme", { themeId: 9999 });
    const after = await loadFacts(sessionId);
    check("does not record the invented id", after.themeId === null, `themeId = ${String(after.themeId)}`);
    check("says the layout does not exist", /no layout #9999/i.test(bogus));
    check("does not leave the agent stuck", /standard Mobstep layout/i.test(bogus));

    await call(tools, "choose_theme", { themeId: 41 });
    check("still records a real one", (await loadFacts(sessionId)).themeId === 41);

    await call(tools, "choose_theme", {});
    check("omitting the id means the standard layout", (await loadFacts(sessionId)).themeId === null);
  }

  console.log("\n2 · a bad theme must not cost the owner the app");
  {
    const sessionId = await freshSession();
    // Written straight into the facts, as if it had been recorded before the
    // validation above existed — which is exactly the state a live session is
    // in right now.
    const facts = await loadFacts(sessionId);
    facts.themeId = 9999;
    await saveFacts(sessionId, facts);

    const tools = buildTools({ sessionId, uid: UID, appId: null });
    const result = parse(await call(tools, "assemble_app", {}));
    const after = await loadFacts(sessionId);

    check("the app is created anyway", typeof result["appId"] === "number", `appId = ${String(result["appId"])}`);
    check("the bad theme is cleared", after.themeId === null);
    check(
      "the owner is told the layout fell back",
      JSON.stringify(result["notes"] ?? []).includes("standard Mobstep"),
    );
    check("branches reached Drupal", drupal.state.branches.size > 0);
    check("the catalog reached Drupal", drupal.state.catalog.size > 0);
  }

  console.log("\n3 · an outright failure names its step and promises nothing");
  {
    const sessionId = await freshSession();
    const facts = await loadFacts(sessionId);
    // No name is the one thing assembly genuinely cannot work around.
    facts.business.name = "";
    await saveFacts(sessionId, facts);

    const tools = buildTools({ sessionId, uid: UID, appId: null });
    const result = parse(await call(tools, "assemble_app", {}));
    const card = result["card"] as { kind?: string; status?: string; log?: string } | undefined;

    check("reports failure rather than throwing", result["failed"] === true);
    check("shows a failed card the owner can see", card?.kind === "progress" && card.status === "failed");
    check("carries the real message", Boolean(card?.log));
    check(
      "forbids promising a retry",
      /Do NOT say you will retry/i.test(String(result["next"] ?? "")),
    );
  }

  console.log("\n4 · start_build before the app exists");
  {
    const sessionId = await freshSession();
    const tools = buildTools({ sessionId, uid: UID, appId: null });
    const result = parse(await call(tools, "start_build", {}));

    check("does not throw an opaque error", result["failed"] === true);
    check(
      "says there is nothing to build",
      /not been created in Mobstep/i.test(String(result["next"] ?? "")),
    );
    check(
      "forbids 'looking into it'",
      /Do NOT say you will look into it/i.test(String(result["next"] ?? "")),
    );
  }

  console.log("\n5 · the build endpoint rejects the call");
  {
    const sessionId = await freshSession();
    const tools = buildTools({ sessionId, uid: UID, appId: null });
    await call(tools, "assemble_app", {});

    // Drupal refuses a build it cannot start — a missing project directory, a
    // script that is not executable. The mock answers 422 for app 9999 so the
    // agent's side of that exchange can be exercised without one.
    const broken = buildTools({ sessionId, uid: UID, appId: 9999 });
    const facts = await loadFacts(sessionId);
    facts.appId = 9999;
    await saveFacts(sessionId, facts);

    const result = parse(await call(broken, "start_build", {}));
    const card = result["card"] as { status?: string; log?: string } | undefined;

    check("reports rather than throws", result["failed"] === true);
    check("shows a failed card", card?.status === "failed");
    check("carries the real message", /no such app|not a template|failed/i.test(String(card?.log ?? "")));
    check(
      "forbids promising a fix",
      /Do NOT say you are looking into it/i.test(String(result["next"] ?? "")),
    );
  }

  console.log("\n6 · a build that never started is not polled forever");
  {
    const sessionId = await freshSession();
    const tools = buildTools({ sessionId, uid: UID, appId: null });
    await call(tools, "assemble_app", {});

    // No start_build, so Drupal has no log: the `pending` case.
    const result = parse(await call(tools, "check_build", {}));
    check("reports pending", result["status"] === "pending");
    check(
      "tells the agent to stop after a second look",
      /rather than checking a third time/i.test(String(result["next"] ?? "")),
    );
  }

  console.log(
    failures === 0
      ? "\nall recovery paths hold\n"
      : `\n${failures} check(s) failed\n`,
  );
} finally {
  await drupal.stop().catch(() => {});
  await pool.end().catch(() => {});
}

process.exit(failures === 0 ? 0 : 1);
