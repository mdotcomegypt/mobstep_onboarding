import { generateJson } from "../src/lib/vertex.ts";

/**
 * The store owner, played by a model.
 *
 * A scripted owner cannot test the thing most worth testing. The failure this
 * service actually has is getting *stuck* — asking a question it already has
 * the answer to, promising work it never does, ending a turn with nothing for
 * the owner to do. A fixed script sails straight past all of that, because the
 * next line goes out regardless of what came back.
 *
 * An owner who only answers what was actually asked, and who says "you already
 * know that" when the agent asks twice, surfaces those immediately.
 */

export interface OwnerBrief {
  name: string;
  facts: string;
  goal: string;
}

export const ROSTO: OwnerBrief = {
  name: "Hossam",
  facts: [
    "You own Rosto Fried Chicken, a fried chicken and pizza restaurant in Nasr City, Cairo, Egypt.",
    "Your Facebook page is https://www.facebook.com/rostoegypt — you have no website.",
    "You have no logo file to hand; the only one you have is on your Facebook page.",
    "Your brand colour is the red on your menu and signage. You like it and want to keep it.",
    "Prices are in Egyptian pounds. Your customers order in Arabic, but you are comfortable in English.",
    "You have two branches:",
    "  - Nasr City (main): 22 Abbas El Akkad St, Nasr City, Cairo. Phone 01001234567. Also the WhatsApp number.",
    "  - Maadi: 15 Road 9, Maadi, Cairo. Phone 01009876543.",
    "You deliver around Nasr City and Maadi; delivery is 25 EGP.",
    "Your menu is a printed sheet. You have a photo of it on your phone and can send it.",
    "You do NOT know your menu by heart item-by-item; the photo is the source of truth.",
  ].join("\n"),
  goal: "Get a working app for your restaurant with as little typing as possible.",
};

export interface OwnerTurn {
  /** What the owner types. May be empty when they only send a photo. */
  message: string;
  /** Set when the owner attaches their menu photo this turn. */
  sendMenu: boolean;
  /** Set when the owner considers the job finished. */
  finished: boolean;
  /** Private note for the transcript: why they said that. */
  note: string;
}

export async function ownerReply(
  brief: OwnerBrief,
  history: Array<{ role: "assistant" | "owner"; text: string }>,
  options: { menuAlreadySent: boolean; turn: number },
): Promise<OwnerTurn> {
  const transcript = history
    .slice(-14)
    .map((m) => `${m.role === "assistant" ? "ASSISTANT" : "YOU"}: ${m.text}`)
    .join("\n\n");

  const prompt = `
You are role-playing a real store owner talking to an app-building assistant in a chat window.

WHO YOU ARE
${brief.name}. ${brief.goal}

WHAT YOU KNOW (never invent anything beyond this):
${brief.facts}

HOW YOU TYPE
- Short. One or two sentences. Lowercase is fine. You are on your phone.
- You answer ONLY what was actually asked. You do not volunteer your whole life story.
- You are not technical. You do not know what a "package name" or a "theme id" is, and
  if asked for one you say so rather than inventing it.
- If the assistant asks something it has already been told, say so bluntly:
  "i already told you that" — and repeat it once, briefly.
- If the assistant says it will do something later, push: "ok do it now".
- If the assistant asks you to pick between options, pick one and say which.
- You are happy to be efficient: if it proposes something sensible, say yes.

THE MENU PHOTO
${
  options.menuAlreadySent
    ? "You have ALREADY sent your menu photo. Do not send it again; refer back to it."
    : 'You have a photo of your printed menu. The moment the assistant asks for your menu, ' +
      "products, or prices — or asks how to get your items in — attach it. Set sendMenu to true " +
      'and keep the message short, like "here\'s the menu".'
}

CONVERSATION SO FAR
${transcript || "(nothing yet — the assistant is about to greet you)"}

Reply as the owner to the assistant's LAST message only.

Return JSON with exactly these keys:
  "message"  - what you type (a string; "" only if you are sending the photo with no words)
  "sendMenu" - true only if you are attaching the menu photo this turn
  "finished" - true only if the assistant has told you the app is BUILT and there is nothing left to do
  "note"     - one short phrase for the observer explaining your intent
`.trim();

  const reply = await generateJson<OwnerTurn>(prompt, { timeoutMs: 45_000 });

  return {
    message: String(reply.message ?? "").trim(),
    sendMenu: Boolean(reply.sendMenu) && !options.menuAlreadySent,
    finished: Boolean(reply.finished),
    note: String(reply.note ?? ""),
  };
}
