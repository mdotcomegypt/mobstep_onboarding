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
    // Asserted on the behaviour, not one phrase: the guidance must both refuse
    // the promise and tell the model to wait. Pinning exact wording made this
    // fail the moment the sentence was reworded, which is a test measuring
    // itself rather than the thing that matters.
    const guidance = String(result["next"] ?? "");
    check(
      "forbids promising a follow-up",
      /Do NOT say you (are|will)[^.]*(retry|look|investigat|fix)/i.test(guidance),
      guidance.slice(0, 100),
    );
    check("tells the model to wait for an answer", /WAIT for their answer/i.test(guidance));
  }

  console.log("\n4 · assembly resumes a half-built app without duplicating");
  {
    const sessionId = await freshSession();
    const facts = await loadFacts(sessionId);
    facts.locations.branches = [
      { name: "Nasr City", phone: "01001234567" },
      { name: "Maadi", phone: "01009876543" },
    ];
    await saveFacts(sessionId, facts);

    const tools = buildTools({ sessionId, uid: UID, appId: null });
    const first = parse(await call(tools, "assemble_app", {}));
    const afterFirst = await loadFacts(sessionId);

    check("first run creates the app", typeof first["appId"] === "number");
    check("both branches created", afterFirst.assembly.branches.length === 2,
      `branches = ${afterFirst.assembly.branches.length}`);
    check("catalog recorded", afterFirst.assembly.categories.length > 0);

    const drupalBranchesAfterFirst = [...drupal.state.branches.values()].flat().length;

    // Simulate the exact production failure: the theme step never went through.
    const broken = await loadFacts(sessionId);
    delete broken.assembly.steps.theme;
    await saveFacts(sessionId, broken);

    const second = parse(await call(tools, "assemble_app", {}));
    const afterSecond = await loadFacts(sessionId);
    const drupalBranchesAfterSecond = [...drupal.state.branches.values()].flat().length;

    check("second run re-runs only the missing step",
      JSON.stringify(second["ran"] ?? []) === '["theme"]',
      `ran = ${JSON.stringify(second["ran"])}`);
    check("branches are NOT duplicated",
      drupalBranchesAfterSecond === drupalBranchesAfterFirst,
      `${drupalBranchesAfterFirst} → ${drupalBranchesAfterSecond}`);
    check("categories are NOT duplicated",
      afterSecond.assembly.categories.length === afterFirst.assembly.categories.length);
    check("a third run does nothing at all",
      JSON.stringify(parse(await call(tools, "assemble_app", {}))["ran"] ?? []) === "[]");
  }

  console.log("\n5 · assembly publishes the web app and hands over the URL");
  {
    const sessionId = await freshSession();
    const tools = buildTools({ sessionId, uid: UID, appId: null });
    const result = parse(await call(tools, "assemble_app", {}));
    const facts = await loadFacts(sessionId);

    check("the web app is live", facts.web.status === "live", `status = ${facts.web.status}`);
    check("a real URL was recorded", /^https:\/\/.+\.mobstep\.com$/.test(facts.web.url ?? ""),
      facts.web.url ?? "(none)");
    check("the URL is on the card", String((result["card"] as {log?:string})?.log ?? "").includes("mobstep.com"));
    check("the agent is told to hand it over", /LIVE at https/i.test(String(result["next"] ?? "")));
    check("the phase moved to web", facts.phase === "web", facts.phase);
    check("published revision is recorded", facts.web.publishedRevision === facts.web.revision);
  }

  console.log("\n6 · a change re-publishes; an unchanged app does not");
  {
    const sessionId = await freshSession();
    const tools = buildTools({ sessionId, uid: UID, appId: null });
    await call(tools, "assemble_app", {});

    // Every freshSession() creates a NEW app, so the id has to come from the
    // facts rather than being assumed — reading a hardcoded 9000 silently
    // measured a different app's publish count and passed for the wrong reason.
    const appId = (await loadFacts(sessionId)).appId ?? 0;
    const count = (): number => drupal.state.webPublishes.get(appId)?.count ?? 0;
    const first = count();
    check("assembly published once", first === 1, `count = ${first}`);

    // No change: assembling again must not re-publish.
    await call(tools, "assemble_app", {});
    check("an unchanged app is not re-published", count() === first, `${first} → ${count()}`);

    // A real change: the catalog is confirmed.
    const before = count();
    await call(tools, "set_catalog", {});
    check("a catalog change re-publishes", count() > before, `${before} → ${count()}`);

    // The Next process only has to be bounced for a tenant it has never served.
    // Doing it on every checkpoint would restart the site for all ~200 apps.
    const restarts = drupal.state.webPublishes.get(appId)?.restarts ?? 0;
    check("only the first publish restarts the site", restarts === 1, `restarts = ${restarts}`);
  }

  console.log("\n7 · Android is refused when Firebase cannot register it");
  {
    const sessionId = await freshSession();
    const tools = buildTools({ sessionId, uid: UID, appId: null });
    await call(tools, "assemble_app", {});

    // No credentials configured — the operator case. The owner must be told
    // plainly, and their web app must be unaffected.
    const saved = process.env["FIREBASE_CREDENTIALS"];
    delete process.env["FIREBASE_CREDENTIALS"];
    const result = parse(await call(tools, "start_build", {}));
    if (saved) process.env["FIREBASE_CREDENTIALS"] = saved;

    const card = result["card"] as { label?: string; status?: string; log?: string } | undefined;
    check("refuses rather than starting a doomed build", result["failed"] === true);
    check("says it is the Android app that cannot be built",
      /Cannot build the Android app/i.test(String(card?.label ?? "")));
    check("names the real reason", /FIREBASE_CREDENTIALS/i.test(String(card?.log ?? "")),
      String(card?.log ?? "").slice(0, 80));
    check("reassures them the web app is fine",
      /web app is unaffected/i.test(String(result["next"] ?? "")));
    check("does not promise to sort it out",
      /Do NOT promise/i.test(String(result["next"] ?? "")));

    const facts = await loadFacts(sessionId);
    check("the web app really is still live", facts.web.status === "live", facts.web.status);
  }

  console.log("\n8 · start_build before the app exists");
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

  console.log("\n9 · the build endpoint rejects the call");
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
    check("carries the real message", /no such app|not a template|failed/i.test(String(card?.log ?? "")),
      String(card?.log ?? "").slice(0, 80));
    // The refusal now happens at the Firebase check, before any build is
    // started — earlier and more specific than before. What must hold either
    // way is that it does not promise a follow-up it cannot make.
    check(
      "forbids promising a fix",
      /Do NOT promise|Do NOT say you are looking into it/i.test(String(result["next"] ?? "")),
      String(result["next"] ?? "").slice(0, 90),
    );
  }

  console.log("\n10 · a build that never started is not polled forever");
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

  console.log("\n11 · Drupal answers with an HTML error page");
  {
    const sessionId = await freshSession();
    const facts = await loadFacts(sessionId);
    facts.appId = 8888;
    await saveFacts(sessionId, facts);

    const tools = buildTools({ sessionId, uid: UID, appId: 8888 });
    const result = parse(await call(tools, "start_build", {}));
    const log = String((result["card"] as { log?: string } | undefined)?.log ?? "");

    check("reports rather than throws", result["failed"] === true);
    check("says it was an HTML page", /HTML page instead of JSON/i.test(log));
    check("names it a server-side fault", /server-side fault/i.test(log));
    check("does not dump the doctype at the owner", !/DOCTYPE/i.test(log));
    check("keeps the page title as a clue", /Error \| Mobstep/i.test(log), log.slice(0, 120));
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
