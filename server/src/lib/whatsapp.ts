import { env } from "./env.ts";

/**
 * Mobstep's platform WhatsApp Business account.
 *
 * A port of Drupal's MobstepWhatsapp service, including the one behaviour that
 * matters most: the template's language is looked up from the Graph API and
 * memoized, never hardcoded. Sending `en_US` to a template registered as `en`
 * (or the reverse) fails with error 132001 and no message is delivered — and we
 * already have a sibling Mobstep template registered as `en`, so guessing here
 * is a known way to lose every OTP.
 */

const graph = (path: string): string =>
  `https://graph.facebook.com/${env.whatsapp.apiVersion}/${path}`;

const authHeaders = {
  Authorization: `Bearer ${env.whatsapp.accessToken}`,
  "Content-Type": "application/json",
};

/** template name -> language code, resolved once per process. */
const languageCache = new Map<string, string>();

/**
 * E.164 without the leading "+", which is what the Graph API expects.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length < 8 || digits.length > 15) {
    throw new Error("That does not look like a valid phone number.");
  }
  return digits;
}

/**
 * The language code the template is actually registered under.
 */
export async function resolveTemplateLanguage(name: string): Promise<string> {
  const cached = languageCache.get(name);
  if (cached) return cached;

  const url = new URL(graph(`${env.whatsapp.businessAccountId}/message_templates`));
  url.searchParams.set("name", name);
  url.searchParams.set("fields", "name,language,status");
  url.searchParams.set("limit", "50");

  const response = await fetch(url, { headers: authHeaders });
  if (!response.ok) {
    throw new Error(
      `Could not look up template "${name}": ${response.status} ${await response.text()}`,
    );
  }

  const body = (await response.json()) as {
    data?: Array<{ name: string; language: string; status: string }>;
  };
  const match =
    body.data?.find((t) => t.name === name && t.status === "APPROVED") ??
    body.data?.find((t) => t.name === name);

  if (!match) {
    throw new Error(`WhatsApp template "${name}" is not available on this account.`);
  }

  languageCache.set(name, match.language);
  return match.language;
}

/**
 * Sends the OTP.
 *
 * Authentication-category templates with a copy-code button need the code in
 * *two* components: once in the body, and once as the button's parameter. Send
 * only the body parameter and the button renders with an empty code.
 */
export async function sendOtp(phone: string, code: string): Promise<string> {
  const template = env.whatsapp.otpTemplate;
  const language = await resolveTemplateLanguage(template);

  const response = await fetch(graph(`${env.whatsapp.phoneNumberId}/messages`), {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: phone,
      type: "template",
      template: {
        name: template,
        language: { code: language },
        components: [
          { type: "body", parameters: [{ type: "text", text: code }] },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: code }],
          },
        ],
      },
    }),
  });

  const body = (await response.json()) as {
    messages?: Array<{ id: string }>;
    error?: { message: string; code: number };
  };

  if (!response.ok || body.error) {
    throw new Error(
      `WhatsApp send failed (${body.error?.code ?? response.status}): ${
        body.error?.message ?? "unknown error"
      }`,
    );
  }

  return body.messages?.[0]?.id ?? "";
}
