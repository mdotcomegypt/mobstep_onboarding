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
