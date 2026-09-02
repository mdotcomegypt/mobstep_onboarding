# Mobstep Onboarding

The store-owner onboarding experience at `onboarding.mobstep.com`: WhatsApp phone
verification followed by a conversational, multi-agent build of the owner's app.

Drupal (`mobstep_drupal`) remains the identity provider and the system of record.
It hands a signed-in owner off here with a short-lived HS256 JWT in the URL
fragment; this service exchanges it once for its own session cookie, runs the
onboarding conversation, and drives the existing app-build pipeline through
Drupal's `/api/v3.0/onboarding/*` machine API.

```
mobstep.com/user/register ──┐
                            ├─► apps_user_login() ──► onboarding.mobstep.com/#t=<jwt>
mobstep.com/user/login/google ┘                              │
                                                             ▼
                              POST /api/session ──► phone + WhatsApp OTP ──► chat
                                                                              │
                          Drupal /api/v3.0/onboarding/* ◄────────────────────┘
                          (app, branches, catalog, theme, assets, build)
```

## Layout

- `server/` — Fastify API, LangGraph.js agent, Postgres, WhatsApp OTP.
- `web/` — Vite + React chat client. Previews (palettes, logos, mockups, catalog
  tables) render as cards inside the chat stream; there is no separate live
  app-preview pane.

## Running locally

```sh
cp .env.example .env      # fill in the secrets
pnpm install
pnpm migrate
pnpm dev
```

`server/src/lib/env.ts` fails fast on a missing required variable, so a
misconfigured process refuses to start rather than failing at the first OTP.

## Deploying

Single Node process behind nginx on the app server; Postgres is local.
Full runbook: **`deploy/DEPLOY.md`**. Run `pnpm preflight` on the server before
cutting over — it checks every dependency and names the fix for each failure.
