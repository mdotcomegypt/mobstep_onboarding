-- Structured onboarding facts, separate from the agent's checkpoint so they
-- survive a prompt or graph rewrite and can be read without deserializing one.
CREATE TABLE IF NOT EXISTS onboarding_facts (
  session_id BIGINT PRIMARY KEY REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
  facts      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Chat transcript, for support and for rendering history on reconnect.
CREATE TABLE IF NOT EXISTS onboarding_messages (
  id         BIGSERIAL PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  cards      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_messages_session_idx
  ON onboarding_messages (session_id, id);
