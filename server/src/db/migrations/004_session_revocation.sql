-- Logging out of Mobstep left the onboarding session alive.
--
-- The handoff token is verified once and exchanged for a cookie that lasts 30
-- days; nothing afterwards ever asks Drupal whether that person is still
-- signed in. Drupal now calls this service on logout, and the session is
-- marked here rather than deleted so an owner's facts, events and app_id
-- survive them signing back in.
ALTER TABLE onboarding_sessions
  ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
