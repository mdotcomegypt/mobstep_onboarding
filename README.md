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
- `server/sim/` — a full onboarding run against a mock Drupal. See below.
- `web/` — Vite + React chat client. Previews (palettes, logos, the catalog,
  generated artwork) render as cards inside the chat stream, beside a live mock
  of the app being built.

## What the agent does

One tool-using agent over a checkpointed LangGraph. The arc is business →
layout → branding → catalog → artwork → branches → assembly → build, and the
two parts worth knowing about:

**Menu scanning** (`server/src/lib/menu.ts`) does not run inside the agent's
turn. A photographed menu is around a hundred items, and emitting those as a
tool call shares one `maxOutputTokens` budget with the reply the owner is
waiting to read — when it ran out, Gemini returned an empty candidate and the
turn produced nothing at all. Extraction is now its own call with its own
budget, followed by a second cheap pass over the *section list* that merges the
same section printed in two languages and drops the masthead.

**Artwork** (`server/src/lib/imagery.ts`) draws a category icon per section, a
brand-matched placeholder, and photographs for a handful of headline items.
Everything else falls back to the placeholder — generating a photo per item
costs more than the app and takes longer than anyone waits. Every image is
optional: a failure is named and the catalog ships without it.

Vertex quota shapes both. Requests are serialized through `lib/gate.ts`, because
the limit is on concurrency rather than rate — retrying harder is exactly wrong,
since each retry adds to the pile that caused the rejection. Image quota is
granted per region, so a 429 there rotates to another region instead of waiting.

## Simulating a run

```sh
pnpm sim
```

Drives a complete onboarding end to end: the real server, the real agent, real
Vertex calls, real Postgres, a real menu photograph. Drupal is replaced by
`server/sim/drupal-mock.ts` — the live endpoints create app tenancies and queue
Gradle builds — and the OTP is skipped rather than sending WhatsApp to a real
number. The store owner is played by the model, so it only answers what was
actually asked and pushes back when the agent stalls, which is what catches the
failure that matters: turns that promise work and then end.

Output lands in `server/sim/out/`: the transcript, the generated artwork, the
exact payloads Drupal was handed, and the server's own trace.

`web/design-proof.html` renders every chat surface against that artwork, for
reviewing the states that are hard to reach by hand.

## Running locally

```sh
cp .env.example .env      # fill in the secrets
pnpm install
pnpm migrate
pnpm dev
```

`server/src/lib/env.ts` fails fast on a missing required variable, so a
misconfigured process refuses to start rather than failing at the first OTP.

The Vertex service account must have `roles/aiplatform.user` **on
`GOOGLE_CLOUD_PROJECT`**. A key from another project authenticates fine and then
403s on every call, with an error about the model rather than about IAM;
`pnpm preflight` names that case specifically.

## Deploying

Single Node process behind nginx on the app server; Postgres is local.
Full runbook: **`deploy/DEPLOY.md`**. Run `pnpm preflight` on the server before
cutting over — it checks every dependency and names the fix for each failure.
