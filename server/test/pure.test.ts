/**
 * Unit tests for the pure helpers.
 *
 * Every case here is a bug that reached production. They are regression tests
 * first and documentation second: each name says what broke.
 *
 * Uses node:test so there is no test-runner dependency to install on a server.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";

import { hasRenderableContent, sanitizeHistory, stripOldImages } from "../src/lib/messages.ts";
import { eachWithProgress, withProgress } from "../src/lib/progress.ts";
import { decodeEntities } from "../src/lib/site.ts";
import { slugify } from "../src/lib/slug.ts";
import { textOf } from "../src/lib/text.ts";

describe("textOf — Gemini chunk shapes", () => {
  it("reads plain string content", () => {
    assert.equal(textOf({ content: "hi" }), "hi");
  });
  it("joins text parts", () => {
    assert.equal(textOf({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "ab");
  });
  it("reads text that accompanies a tool call", () => {
    // The bug: `.text` is "" for array content, so every reply alongside a
    // function call was silently dropped and turns ended on "Great".
    assert.equal(textOf({ content: [{ type: "text", text: "x" }, { type: "tool_use" }], text: "" }), "x");
  });
  it("returns empty for a tool call with no prose", () => {
    assert.equal(textOf({ content: [{ type: "tool_use" }], text: "" }), "");
  });
  it("falls back to legacy .text", () => {
    assert.equal(textOf({ text: "z" }), "z");
  });
  it("tolerates undefined", () => {
    assert.equal(textOf(undefined), "");
  });
});

describe("hasRenderableContent — what may enter the checkpoint", () => {
  // An assistant message with no parts makes Gemini reject the ENTIRE request
  // with 400 "must include at least one parts field", permanently breaking the
  // conversation from that point on.
  it("rejects an empty assistant message", () => {
    assert.equal(hasRenderableContent(new AIMessage("")), false);
    assert.equal(hasRenderableContent(new AIMessage({ content: [] })), false);
    assert.equal(hasRenderableContent(new AIMessage("   ")), false);
  });
  it("keeps real text", () => {
    assert.equal(hasRenderableContent(new AIMessage("hello")), true);
  });
  it("keeps an empty message that carries tool calls", () => {
    // Dropping this would break the call/result pairing Gemini validates.
    assert.equal(
      hasRenderableContent(new AIMessage({ content: "", tool_calls: [{ name: "t", args: {}, id: "1" }] })),
      true,
    );
  });
  it("keeps tool results", () => {
    assert.equal(hasRenderableContent(new ToolMessage({ content: "ok", tool_call_id: "1" })), true);
  });
  it("keeps an image-only message", () => {
    assert.equal(
      hasRenderableContent(new HumanMessage({ content: [{ type: "image_url", image_url: { url: "data:x" } }] })),
      true,
    );
  });
});

describe("sanitizeHistory — the real poisoned transcript", () => {
  const poisoned = () => [
    new HumanMessage("Rosto Fried Chicken"),
    new AIMessage("Great"),
    new AIMessage({ content: "", tool_calls: [{ name: "record_business", args: {}, id: "1" }] }),
    new ToolMessage({ content: "Saved.", tool_call_id: "1" }),
    new AIMessage(""),
    new AIMessage({ content: [] }),
    new HumanMessage({
      content: [
        { type: "text", text: "here is our menu" },
        { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } },
      ],
    }),
  ];

  it("drops exactly the two empty messages", () => {
    const clean = sanitizeHistory(poisoned(), { sessionId: 1 });
    assert.equal(poisoned().length - clean.length, 2);
  });
  it("leaves nothing that would serialize to zero parts", () => {
    assert.ok(sanitizeHistory(poisoned(), { sessionId: 1 }).every(hasRenderableContent));
  });
  it("preserves the tool call and its result", () => {
    const clean = sanitizeHistory(poisoned(), { sessionId: 1 });
    assert.ok(clean.some((m) => ((m as { tool_calls?: unknown[] }).tool_calls ?? []).length > 0));
    assert.ok(clean.some((m) => m.getType() === "tool"));
  });
});

describe("stripOldImages — context growth", () => {
  const img = (n: number) => ({ type: "image_url", image_url: { url: "data:image/jpeg;base64," + "A".repeat(n) } });

  it("keeps only the most recent image", () => {
    const history = [
      new HumanMessage({ content: [{ type: "text", text: "menu 1" }, img(1000)] }),
      new AIMessage("Read 12 items."),
      new HumanMessage({ content: [{ type: "text", text: "menu 2" }, img(1000)] }),
    ];
    const out = stripOldImages(history);
    const withImages = out.filter(
      (m) => Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some((p) => p.type === "image_url"),
    );
    assert.equal(withImages.length, 1);
  });

  it("leaves a placeholder so no message becomes empty", () => {
    // A message that was ONLY an image must not strip down to zero parts.
    const history = [
      new HumanMessage({ content: [img(1000)] }),
      new HumanMessage({ content: [{ type: "text", text: "and this one" }, img(1000)] }),
    ];
    assert.ok(stripOldImages(history).every(hasRenderableContent));
  });

  it("does not mutate the checkpointed originals", () => {
    const history = [
      new HumanMessage({ content: [{ type: "text", text: "a" }, img(100)] }),
      new HumanMessage({ content: [{ type: "text", text: "b" }, img(100)] }),
    ];
    stripOldImages(history);
    assert.ok((history[0]!.content as Array<{ type?: string }>).some((p) => p.type === "image_url"));
  });
});

describe("slugify — package names for this market", () => {
  const DRUPAL = /^[a-z][a-z0-9_]{2,29}$/;

  it("handles a plain Latin name", () => {
    assert.equal(slugify("Rosto Fried Chicken", 42), "rosto_fried_chicken");
  });
  it("falls back for an all-Arabic name", () => {
    // Most shops here are named in Arabic; this used to produce "" and block
    // the build entirely.
    assert.equal(slugify("مطعم روستو", 42), "store_42");
  });
  it("handles a digit-leading name", () => {
    // Drupal requires a leading letter, so "7 Eleven" used to produce "".
    assert.equal(slugify("7 Eleven", 42), "app_7_eleven");
  });
  it("always satisfies Drupal's package pattern", () => {
    for (const name of ["Rosto Fried Chicken", "مطعم روستو", "7 Eleven", "!!!", "Café Crème & Co.", "  Bobs   Burgers  "]) {
      assert.match(slugify(name, 42), DRUPAL, `failed for ${name}`);
    }
  });
});

describe("decodeEntities — text read off a customer's page", () => {
  it("decodes hex numeric entities", () => {
    // The bug: Facebook serves Arabic page titles as runs of numeric entities,
    // and only &amp; and &nbsp; were decoded. "مطعم روستو" reached the facts
    // record — and would have reached the app — as raw entity text.
    assert.equal(decodeEntities("&#x645;&#x637;&#x639;&#x645;"), "مطعم");
  });
  it("decodes decimal numeric entities", () => {
    assert.equal(decodeEntities("&#1605;"), "م");
  });
  it("still decodes the named ones", () => {
    assert.equal(decodeEntities("Fish &amp; Chips&nbsp;Co"), "Fish & Chips Co");
  });
  it("leaves unknown entities alone rather than mangling them", () => {
    assert.equal(decodeEntities("100 &fakeentity; off"), "100 &fakeentity; off");
  });
  it("handles text with no entities at all", () => {
    assert.equal(decodeEntities("Rosto Fried Chicken"), "Rosto Fried Chicken");
  });
});

describe("eachWithProgress — batches that must not fail whole", () => {
  it("keeps going when one item throws, and says which", async () => {
    // Every batch here is decorative artwork. One 429 on the third icon must
    // not cost the other five.
    const results = await eachWithProgress(
      [1, 2, 3, 4],
      (n) => `item ${n}`,
      async (n) => {
        if (n === 3) throw new Error("429");
        return n * 10;
      },
      { concurrency: 2 },
    );

    assert.deepEqual(
      results.map((r) => r.value),
      [10, 20, null, 40],
    );
    assert.equal(results[2]?.error, "429");
    assert.equal(results.filter((r) => r.error).length, 1);
  });

  it("keeps results aligned with their inputs under concurrency", async () => {
    // Two runners finishing out of order must not reorder the results; the
    // caller matches icons back to categories by position.
    const results = await eachWithProgress(
      ["a", "b", "c", "d", "e"],
      (s) => s,
      async (s, i) => {
        await new Promise((r) => setTimeout(r, i % 2 === 0 ? 12 : 1));
        return s.toUpperCase();
      },
      { concurrency: 3 },
    );
    assert.deepEqual(
      results.map((r) => r.value),
      ["A", "B", "C", "D", "E"],
    );
    assert.deepEqual(results.map((r) => r.item), ["a", "b", "c", "d", "e"]);
  });

  it("reports a monotonic completed count", async () => {
    // The counter used to report the index of whatever had just STARTED, so
    // with two runners it went 1, 2, 1, 3, 2 while the labels named different
    // sections. A progress indicator that goes backwards is worse than none.
    const seen: number[] = [];
    await withProgress(
      (u) => {
        if (u.step !== undefined) seen.push(u.step);
      },
      () =>
        eachWithProgress(
          [1, 2, 3, 4],
          (n) => `n${n}`,
          async (n) => {
            await new Promise((r) => setTimeout(r, n % 2 ? 8 : 2));
            return n;
          },
          { concurrency: 2 },
        ),
    );

    assert.ok(seen.length > 0, "expected progress updates");
    for (let i = 1; i < seen.length; i += 1) {
      assert.ok(
        (seen[i] as number) >= (seen[i - 1] as number),
        `progress went backwards: ${seen.join(",")}`,
      );
    }
    assert.equal(seen.at(-1), 4);
  });

  it("drops updates when nothing is listening", async () => {
    // Tools are also called outside a turn — by tests, and by the simulation
    // harness. No sink must never mean a crash.
    const results = await eachWithProgress([1], () => "x", async (n) => n);
    assert.equal(results[0]?.value, 1);
  });
});
