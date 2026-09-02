-- Onboarding sessions, OTP, audit trail and collected assets.
-- LangGraph's PostgresSaver creates its own checkpoint tables on first use.

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  id                BIGSERIAL PRIMARY KEY,
  drupal_uid        INTEGER NOT NULL UNIQUE,
  email             TEXT,
  name              TEXT,
  app_id            INTEGER,
  phone             TEXT,
  phone_verified_at TIMESTAMPTZ,
  status            TEXT NOT NULL DEFAULT 'new',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Handoff tokens are single-use: a replayed jti is refused even inside its
-- five-minute validity window.
CREATE TABLE IF NOT EXISTS onboarding_used_tokens (
  jti        TEXT PRIMARY KEY,
  drupal_uid INTEGER NOT NULL,
  used_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS onboarding_used_tokens_expires_idx
  ON onboarding_used_tokens (expires_at);

-- Codes are stored hashed; a database read must not yield a working OTP.
CREATE TABLE IF NOT EXISTS onboarding_otp (
  id          BIGSERIAL PRIMARY KEY,
  session_id  BIGINT NOT NULL REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_otp_active_idx
  ON onboarding_otp (session_id, consumed_at, expires_at DESC);
CREATE INDEX IF NOT EXISTS onboarding_otp_phone_idx
  ON onboarding_otp (phone, created_at DESC);

CREATE TABLE IF NOT EXISTS onboarding_events (
  id         BIGSERIAL PRIMARY KEY,
  session_id BIGINT REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_events_session_idx
  ON onboarding_events (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS onboarding_assets (
  id         BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  path       TEXT,
  source_url TEXT,
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
