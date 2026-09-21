# TeamLink Job Portal

The TeamLink prototype, backed by a real PostgreSQL database, API and
authentication — with the frontend left exactly as it was.

## The one rule

`baseline/prototype.html` is the visual source of truth and is **never
edited**. `web/build.mjs` verifies its SHA-256 before every build and
refuses to run if it has changed.

The shipped application is that file plus **one appended `<script>` tag**
(442 bytes). No CSS rule, HTML template or render function was modified.

```
npm run ui:compare baseline integrated     →  76/80 screens identical
```

The four that differ are deliberate and documented in
[docs/INTEGRATION.md](docs/INTEGRATION.md) — both are security fixes, not
design changes.

## Run it

```bash
npm install
npm --prefix api install
node web/build.mjs

# first run: load the prototype's demo content
LOAD_SEED=true node tools/dev-server.mjs 4323

# after that
node tools/dev-server.mjs 4323
```

Open **http://127.0.0.1:4323**. Data is written to `var/dev-db` and
survives restarts.

Sign in with `TeamLink@2026`: `admin@teamlink.com`,
`recruiter@teamlink.com`, `client@teamlink.com`,
`ananya.rao@example.com`.

### Against a real PostgreSQL server

Set `DATABASE_URL` and the same command uses it instead — identical stack
to production, and local and live can share one database:

```bash
DATABASE_URL=postgres://app_api:pw@host:5432/teamlink \
ADMIN_DATABASE_URL=postgres://postgres:pw@host:5432/teamlink \
node tools/dev-server.mjs 4323
```

## Is it actually connected?

```bash
npm run verify:stack          # 14 checks: CRUD, auth, RLS, no hardcoded URLs

npm run verify:stack -- --write
# restart the server
npm run verify:stack -- --check     # did the record survive?
```

A UI that shows a record it just created proves nothing. These re-read
from the database.

## Architecture

```
browser (the prototype, unchanged)
   │  fetch /api/…          relative — follows whatever domain serves it
   ▼
Express API                 sessions, CSRF, validation, rate limiting
   │  connects as app_api    unprivileged; the server refuses to start otherwise
   ▼
PostgreSQL                  row-level security on every table
```

`DATA` stays a synchronous in-memory cache filled once from
`/api/bootstrap`, so all ~700 synchronous call sites in the 22,935-line
prototype keep working untouched. See
[docs/INTEGRATION.md](docs/INTEGRATION.md).

## Verification

```bash
npm run verify:db      # schema 10 · RLS 29 · seed 16 · migrations 13
npm run test:api       # 63 end-to-end tests against real PostgreSQL
npm run verify:stack   # 14 live checks
node tools/verify-interaction.mjs   # clicks real buttons
node tools/verify-search.mjs        # proves search runs in SQL
```

Nothing is mocked. The API tests run against PostgreSQL over the wire with
RLS active, as an unprivileged role.

## Deploying

```bash
cp .env.example .env     # then fill it in
docker compose up -d
```

Full runbook: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

The schema has **no Supabase-specific dependencies** — it needs
PostgreSQL 13+ and optionally `pg_trgm` — so it runs on your own box or on
Supabase Cloud by changing one variable.

## Documentation

| | |
|---|---|
| [INTEGRATION.md](docs/INTEGRATION.md) | how the data source was swapped without touching the UI |
| [DATA-MAPPING.md](docs/DATA-MAPPING.md) | all 58 `localStorage` keys → tables |
| [UI-FIDELITY.md](docs/UI-FIDELITY.md) | how "visually identical" is proved |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | first deploy, TLS, backups, checklist |
| [AI-INTERVIEW.md](docs/AI-INTERVIEW.md) | voice interview scoring and visibility |
| [NOTIFICATIONS.md](docs/NOTIFICATIONS.md) | multi-channel delivery and its honest limits |
| [BASELINE.md](docs/BASELINE.md) | the prototype as supplied |

## A note on the prototype

`baseline/prototype.html` carries a Supabase **publishable** key and
project reference from an earlier integration. Publishable keys are
designed to sit in browser code and are protected by row-level security,
not by secrecy — but they are visible in this repository. That path is
disabled at runtime (`docs/INTEGRATION.md`, §15), because the application
API is the single source of truth.
