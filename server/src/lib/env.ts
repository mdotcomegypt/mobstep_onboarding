/**
 * Configuration, validated once at boot.
 *
 * A missing secret should stop the process here rather than surfacing as a
 * failed OTP send to a real store owner halfway through signup, so everything
 * required is asserted up front.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const env = {
  port: Number(optional("PORT", "8080")),
  publicOrigin: optional("PUBLIC_ORIGIN", "http://localhost:5173"),
  isDev: process.env.NODE_ENV !== "production",

  /** Shared with Drupal's $settings['onboarding_secret']; verifies the handoff JWT. */
  onboardingSecret: required("ONBOARDING_SECRET"),
  /** Shared with Drupal's $settings['apps.mobld_secret']; authorizes our API calls. */
  mobldSecret: required("MOBLD_SECRET"),
  drupalBaseUrl: optional("DRUPAL_BASE_URL", "https://mobstep.com").replace(/\/$/, ""),

  sessionSecret: required("SESSION_SECRET"),
  databaseUrl: required("DATABASE_URL"),

  /** Where owner-uploaded files are written. Must be writable and persistent. */
  uploadDir: optional("UPLOAD_DIR", "/opt/mobstep_onboarding/uploads"),

  whatsapp: {
    businessAccountId: required("WA_BUSINESS_ACCOUNT_ID"),
    phoneNumberId: required("WA_PHONE_NUMBER_ID"),
    accessToken: required("WA_ACCESS_TOKEN"),
    otpTemplate: optional("WA_OTP_TEMPLATE", "mobstep_otp_for_all"),
    apiVersion: optional("WA_API_VERSION", "v21.0"),
  },

  vertex: {
    project: optional("GOOGLE_CLOUD_PROJECT", "mob-step"),
    // The global endpoint, not a regional one: regional endpoints return 429s
    // under our traffic and the global one does not.
    location: optional("GOOGLE_CLOUD_LOCATION", "global"),
    chatModel: optional("MODEL_CHAT", "gemini-2.5-flash"),
    reasonModel: optional("MODEL_REASON", "gemini-2.5-pro"),
    imageModel: optional("MODEL_IMAGE", "gemini-2.5-flash-image"),
  },
} as const;
