# Deploying onboarding.mobstep.com

Two sides ship together: the Drupal changes in `mobstep_drupal` and this service.
Deploy Drupal **first** — until its routes exist, this service has nothing to
call, and `pnpm preflight` will tell you so.

Nothing here is destructive to the existing signup flow: with
`onboarding_origin` unset (or `onboarding_legacy_fallback = TRUE`) every owner
keeps using `/create/*` exactly as today. The cutover is one settings line.

---

## 0. One-time: enable Vertex AI

The service account authenticates fine, but the API is not enabled on the
project. **This is the only step that must be done from your own Google account:**

```bash
gcloud services enable aiplatform.googleapis.com --project mob-step
```

Then confirm the service account can use it. `firebase-adminsdk-j93po@` usually
carries Editor, which is sufficient; if preflight reports a permission error:

```bash
gcloud projects add-iam-policy-binding mob-step \
  --member=serviceAccount:firebase-adminsdk-j93po@mob-step.iam.gserviceaccount.com \
  --role=roles/aiplatform.user
```

> The key currently in `.secrets/vertex-sa.json` was pasted into a chat
> transcript. Rotate it once you are live:
> `gcloud iam service-accounts keys create ... && gcloud iam service-accounts keys delete 31cb0e78e555079ce6c07d83cd3a64a113e8f312`

---

## 1. Drupal side

```bash
cd /var/www/html/kiwi
git pull
drush cr          # required: 15 new routes and 2 new services
```

Add to `sites/default/settings.php` (see `drupal-settings.php.example`). Keep
these out of git — `settings.php` is currently tracked and already holds live
secrets; put them in a gitignored include instead.

```php
$settings['onboarding_secret']  = '<openssl rand -hex 32>';   // == ONBOARDING_SECRET
$settings['apps.mobld_secret']  = '<openssl rand -hex 32>';   // == MOBLD_SECRET
$settings['onboarding_origin']  = '';                          // EMPTY until step 4
$settings['google_oauth'] = ['client_id' => '', 'client_secret' => ''];
```

Leaving `onboarding_origin` empty means owners still go to `/create/*`. Nothing
changes for users yet.

**Google sign-in** (optional, can come later): create an OAuth client in the
Google console, authorized redirect URI
`https://mobstep.com/user/login/google/callback`. The button only renders once
both `client_id` and `client_secret` are set.

---

## 2. Postgres

```bash
sudo -u postgres createuser onboarding --pwprompt
sudo -u postgres createdb  onboarding_db --owner=onboarding
```

`DATABASE_URL=postgres://onboarding:<password>@127.0.0.1:5432/onboarding_db`

---

## 3. This service

Build on a machine with the toolchain, ship the result:

```bash
bash deploy/build.sh                       # install + typecheck + build
rsync -a --exclude node_modules --exclude .git \
      ./ root@<server>:/opt/mobstep_onboarding/
```

> `deploy/mobstep-onboarding.service` hardcodes `/opt/mobstep_onboarding`.
> If you deploy somewhere else — `/var/www/html/mobstep_onboarding`, say — edit
> `WorkingDirectory`, `EnvironmentFile` and `ReadWritePaths` in the unit to
> match, or `ProtectSystem=strict` will make the whole tree read-only and the
> service will refuse to start.

On the server:

```bash
cd /opt/mobstep_onboarding
cp .env.example .env && $EDITOR .env       # fill in everything
mkdir -p .secrets && chmod 700 .secrets    # put vertex-sa.json here, chmod 600

# Uploaded menu photos and logos live here. It must be writable by the service
# user and inside the unit's ReadWritePaths, or the process refuses to start.
mkdir -p uploads && chown www-data uploads && chmod 750 uploads

pnpm install --prod --filter ./server
pnpm migrate                               # re-run after EVERY deploy
pnpm preflight                             # must be 7/7 before going further
```

Every script loads `.env` from the repository root itself
(`--env-file-if-exists`), so `pnpm migrate` and `pnpm preflight` work from a
plain shell. Real environment variables still win, so systemd's
`EnvironmentFile` keeps precedence in the running service.

`pnpm migrate` needs only `DATABASE_URL` — it does not pull in the server's
config, so a missing WhatsApp token cannot block a schema change.

### When the site returns 502

nginx is up but Node is not. The app's own logs will be empty if systemd never
started the process, so check the unit first:

```bash
systemctl status mobstep-onboarding --no-pager
journalctl -u mobstep-onboarding -n 50 --no-pager
```

Most likely causes, in order:

1. **The unit's paths do not match the deploy.** `WorkingDirectory`,
   `EnvironmentFile` and `ReadWritePaths` are set for `/opt/mobstep_onboarding`.
   With `ProtectSystem=strict`, a `ReadWritePaths` pointing at a directory that
   does not exist makes systemd fail the unit *before node runs*, so there is
   nothing in the application log. Fix with the `sed` in the unit's header.
2. **`dist/` is missing** — the build never ran. `pnpm deploy`.
3. **A required environment variable is missing**, in which case `env.ts` throws
   at startup and the reason is the first line of `journalctl`.

An unwritable `UPLOAD_DIR` is deliberately *not* on this list: it disables
uploads and logs loudly, but the service still starts, because
`/api/upload/health` has to be reachable to report it.

### Updating an existing deployment

```bash
cd /var/www/html/mobstep_onboarding
git pull
pnpm deploy                       # install + build + migrate
sudo systemctl restart mobstep-onboarding
curl -s localhost:8080/api/health # commit here must match `git rev-parse --short HEAD`
```

**`dist/` is gitignored and systemd runs `dist/index.js`, so a `git pull`
changes nothing until you rebuild.** Skipping the build leaves the service on
old code while the checkout looks current — new routes 404 and old bugs persist,
which reads as "the fix didn't work". `pnpm deploy` exists so the build cannot
be forgotten, and `/api/health` reports the built commit so the mismatch is visible (use
`/api/health`, not `/health` — nginx serves anything outside `/api/` from the
SPA, so a bare `/health` returns the React app):

```json
{"ok":true,"commit":"33cf36f","builtAt":"2026-09-02T05:17:37.558Z"}
```

Note the asymmetry that makes this confusing: `pnpm migrate` and `pnpm preflight`
run from `src/` via type-stripping, so they pick up a pull immediately. Only the
service runs compiled output.

**`pnpm migrate` is not a one-time step.** New migrations ship with the code, and
a deploy that skips it leaves tables missing — which surfaces as a 500 from the
feature that needed them, nowhere near the cause. `pnpm preflight` checks every
table by name for exactly that reason.

`pnpm preflight` checks Postgres, the migrations, every expected table by name,
the upload directory's writability, the Drupal secret, the WhatsApp template
(and reports which language code it is actually registered under) and a live
Vertex round-trip. Every failure names its own fix.

Then:

```bash
sudo cp deploy/mobstep-onboarding.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now mobstep-onboarding
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/onboarding.mobstep.com
sudo ln -s /etc/nginx/sites-available/onboarding.mobstep.com /etc/nginx/sites-enabled/
sudo certbot --nginx -d onboarding.mobstep.com
sudo nginx -t && sudo systemctl reload nginx
```

`curl https://onboarding.mobstep.com/health` → `{"ok":true}`.

---

## 4. Cutover

One line on the Drupal side:

```php
$settings['onboarding_origin'] = 'https://onboarding.mobstep.com';
```

`drush cr`. From that moment, an owner without a finished app is redirected to
the new service instead of `/create/business`.

**Rollback is one line and needs no deploy:**

```php
$settings['onboarding_legacy_fallback'] = TRUE;
```

---

## 5. Verify end to end

1. Register a fresh account at `mobstep.com/user/register`.
2. Confirm the redirect lands on `onboarding.mobstep.com/#t=…` and that the
   fragment disappears from the address bar immediately.
3. Enter a real number; a WhatsApp message arrives from the Mobstep number with
   a working copy-code button.
4. Enter a wrong code five times — it must lock out and ask for a new one.
5. Talk to the assistant: give it a business name and a website. It should read
   the site, show colour options as cards, and build a catalog.
6. Approve the build; watch the log stream, then install the APK.
7. Back on `mobstep.com`, `/dashboard` is now reachable — the redirect gate
   releases when `android_package_name` is written.

---

## Operating notes

- **Logs:** `journalctl -u mobstep-onboarding -f`. Handoff tokens and OTP codes
  are redacted at the logger.
- **A stuck conversation** can be reset without losing verification:
  `DELETE FROM checkpoints WHERE thread_id = 'onboarding-<session_id>';`
  The `onboarding_facts` row survives, so the agent picks up what it knew.
- **The transcript** is in `onboarding_messages`; the structured result is in
  `onboarding_facts`. Support questions are answerable from those two tables
  without touching an agent checkpoint.
- **Costs** are Vertex per-token plus one Android build slot per app. The OTP
  send-rate cap (3 per 15 min per number) is the main abuse control on signup.
