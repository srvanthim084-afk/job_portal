# Deployment runbook

Target: a Linux VPS you control, running Docker.

## What actually gets deployed

```
                      :80 / :443
                          │
                      ┌───▼────┐   TLS, rate limiting, gzip
                      │ nginx  │
                      └───┬────┘
                          │  edge network
                      ┌───▼────┐   Express API  +  the prototype as
                      │  api   │   static files (same origin, so the
                      └───┬────┘   session cookie needs no relaxation)
                          │  internal network (no route out)
                      ┌───▼────┐
                      │   db   │   Postgres 16 — NO published port
                      └────────┘
```

A one-shot `migrate` container runs before the API starts, so the app can
never serve traffic against an old schema.

### A note on Supabase

You chose Supabase, and the schema was written so that **nothing depends on
it**: no `auth.uid()`, no `storage.*`, no Supabase extensions. It needs
PostgreSQL 13+ and optionally `pg_trgm`.

That means this stack runs entirely on your own box, and if you later want
Supabase Cloud you point `DATABASE_URL` at it and set
`STORAGE_DRIVER=supabase` — no migration rewrite. The choice stays open.

---

## First deployment

### 1. Prepare the server

```bash
# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"   # log out and back in

# Firewall: only 22, 80, 443. Postgres is never exposed.
sudo ufw allow 22,80,443/tcp && sudo ufw enable
```

Point your domain's A record at the server before continuing — certificate
issuance checks it.

### 2. Get the code and configure

```bash
sudo mkdir -p /srv/teamlink && sudo chown "$USER" /srv/teamlink
cd /srv/teamlink
# copy this project here (git clone, scp, rsync — whatever you use)

cp .env.example .env
chmod 600 .env
```

Fill in `.env`. Generate every secret; do not invent them by hand:

```bash
openssl rand -base64 48                  # AUTH_SECRET
openssl rand -base64 32 | tr -d '/+='    # POSTGRES_PASSWORD
openssl rand -base64 32 | tr -d '/+='    # APP_DB_PASSWORD
```

| Variable | Notes |
|---|---|
| `PUBLIC_ORIGIN` | `https://jobs.yourdomain.com` — must be https, cookies are Secure |
| `POSTGRES_PASSWORD` | superuser; used by migrations and backups only |
| `APP_DB_PASSWORD` | the `app_api` role the API runs as; ≥16 chars, no quotes/backslashes |
| `AUTH_SECRET` | ≥32 chars; rotating it signs everyone out |
| `LOAD_SEED` | **leave `false`** unless you want the demo content |
| `SHOW_LOGIN_HINTS` | `false` removes the account list from the login screen |

### 3. Set your domain in nginx

```bash
sed -i 's/jobs.example.com/jobs.yourdomain.com/g' deploy/nginx/teamlink.conf
```

### 4. Build and issue the certificate

```bash
docker compose build
chmod +x deploy/*.sh

# --staging first: Let's Encrypt rate-limits failed attempts to 5/hour.
./deploy/init-letsencrypt.sh jobs.yourdomain.com you@yourdomain.com --staging
# happy with the output? re-run without --staging:
./deploy/init-letsencrypt.sh jobs.yourdomain.com you@yourdomain.com
```

### 5. Start

```bash
docker compose up -d
docker compose logs -f api      # watch it come up, then ctrl-c
```

The API prints its database role on boot. It must say:

```
db user  app_api (unprivileged — RLS enforced)
```

If it says `postgres`, **stop**. Every access policy is disabled. The server
normally refuses to start in that state; seeing it means `DATABASE_URL` is
wrong.

### 6. Create the first administrator

Migrations create no users. Make one:

```bash
docker compose exec -T db psql -U postgres -d teamlink -c \
  "insert into admins (id,name,email,title,initials)
   values ('a1','Your Name','you@yourdomain.com','Platform Administrator','YN')"

docker compose exec -e SEED_ADMIN_PASSWORD='<a strong password>' \
  api node src/scripts/seed-auth.js
```

`seed-auth.js` bcrypt-hashes the password and prints each account once. If
you omit `SEED_ADMIN_PASSWORD` it generates a strong one and shows it —
**that is the only time it is ever displayed.**

### 7. Verify

```bash
curl -fsS https://jobs.yourdomain.com/api/health

# a draft job must NOT be visible to an anonymous caller
curl -s https://jobs.yourdomain.com/api/bootstrap | head -c 300
```

Then sign in through the UI and confirm the dashboard loads.

---

## Deploying a change

```bash
cd /srv/teamlink
./deploy/backup.sh            # always, before anything else
git pull
docker compose build
docker compose up -d          # migrate runs first, then api restarts
docker compose logs --tail=50 api
```

`migrate` is idempotent, so a deploy with no schema change applies nothing.

### Before you deploy a frontend change

The UI must stay identical to the prototype. Run the comparison locally:

```bash
# terminal 1 — the baseline prototype
npx http-server baseline -p 4321 -c-1 --silent

# terminal 2 — the real stack (Postgres + API + the app)
node tools/dev-server.mjs 4323

# terminal 3 — compare them
npm run ui:capture baseline
TL_URL=http://127.0.0.1:4323/ node tools/ui-snapshot.mjs capture integrated
npm run ui:compare baseline integrated
```

Ship only if it reports `UI UNCHANGED`, or if every difference is one you
intended. `docs/INTEGRATION.md` lists the ones that already exist and why.

---

## Backups

```bash
./deploy/backup.sh                      # database + uploaded resumes
crontab -e
0 3 * * * cd /srv/teamlink && ./deploy/backup.sh >> var/backup.log 2>&1
```

Both are captured together. Backing up only Postgres is the trap here:
resume **files** live on a docker volume, so a database-only restore brings
back every candidate with a dead file reference.

Copy them off the box — a backup on the same disk is not a backup:

```bash
rsync -az var/backups/ you@elsewhere:/backups/teamlink/
```

### Restoring

```bash
./deploy/restore.sh var/backups/db-20260921T030000Z.dump
```

It stops the API, restores both the database and the uploads, re-applies
migrations, and waits for health. **Practise this on a staging box before
you need it.** A backup you have never restored is not a backup.

---

## Operations

```bash
docker compose ps                      # what is running
docker compose logs -f api             # application logs
docker compose logs --tail=100 nginx   # access / TLS
npm run migrate:status                 # what schema is applied

docker compose restart api             # restart just the API
docker compose exec db psql -U postgres -d teamlink   # a SQL prompt
```

### Certificates

Renewal is automatic — the `certbot` service checks twice a day. To confirm:

```bash
docker compose run --rm certbot certificates
docker compose run --rm certbot renew --dry-run
```

### Rotating the application database password

```bash
# 1. put the new value in .env (APP_DB_PASSWORD)
# 2. apply it and restart
docker compose run --rm migrate
docker compose up -d api
```

### Signing everyone out

Rotate `AUTH_SECRET`, or clear the table:

```bash
docker compose exec -T db psql -U postgres -d teamlink -c 'delete from sessions'
```

---

## Security checklist

Confirm each before going live:

- [ ] `docker compose ps` shows **no published port** for `db`
- [ ] The API logs `app_api (unprivileged — RLS enforced)` on boot
- [ ] `.env` is `chmod 600` and is not in version control
- [ ] `AUTH_SECRET`, `POSTGRES_PASSWORD`, `APP_DB_PASSWORD` are all generated, all different
- [ ] `PUBLIC_ORIGIN` is `https://…`
- [ ] `https://jobs.yourdomain.com` redirects from http and shows a valid certificate
- [ ] `LOAD_SEED=false` unless you deliberately want demo content
- [ ] `SHOW_LOGIN_HINTS=false` for a real production instance
- [ ] Firewall allows only 22, 80, 443
- [ ] A backup has been taken **and restored** at least once
- [ ] `npm run verify:all` passes on the build you are shipping

---

## Troubleshooting

**API will not start, logs mention superuser or bypassrls**
`DATABASE_URL` points at `postgres`. It must be `app_api`. This is a refusal
to start, not a crash — the alternative is running with every access policy
silently switched off.

**`migrate` exits 1 with "edited AFTER being applied"**
A migration file changed after it was applied. Do not edit applied
migrations — add a new one. To see the state: `npm run migrate:status`.

**nginx will not start: cannot load certificate**
Certificates were never issued. Run `deploy/init-letsencrypt.sh`.

**Uploads fail with 413**
The file exceeds `MAX_UPLOAD_BYTES` (5MB default). nginx allows 8MB so the
API can return a clean `FILE_TOO_LARGE` rather than dropping the connection.
Raise both if you need to.

**Login always fails after a restore**
The restore brought back an older `users` table. Password hashes are in
there, so old passwords apply. Reset with `seed-auth.js`.
