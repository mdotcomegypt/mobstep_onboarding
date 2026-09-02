-- Files the owner uploads during onboarding: menu photos, logos, brand assets.
--
-- Bytes live on disk (UPLOAD_DIR); this table is the index. `id` is a 32-byte
-- random token and doubles as the public URL segment, because Drupal fetches
-- these server-to-server and cannot present a session cookie.
CREATE TABLE IF NOT EXISTS onboarding_uploads (
  id         TEXT PRIMARY KEY,
  session_id BIGINT NOT NULL REFERENCES onboarding_sessions(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'attachment',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS onboarding_uploads_session_idx
  ON onboarding_uploads (session_id, created_at DESC);
