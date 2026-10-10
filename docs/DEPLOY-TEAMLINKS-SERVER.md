# Deploying the Job Portal to teamlink.teamlinks.in (server 72.61.233.104)

This guide is for whoever manages the TeamLink server.

## What is there today

`https://teamlink.teamlinks.in/jobs/` serves a single static HTML file. It is the original prototype from
19 Sep 2026 (`baseline/prototype.html`, 1,587,110 bytes, identical byte for byte):

- It has no server and no database.
- Data lives in each visitor's browser.
- None of the portal's features since then are in it: registration with a real database, applications
  into the ATS, the AI interview, the admin panel, emails, the Naukri/Shine import, and so on.

The same server runs TeamLink Enterprise (port 4010) and HRMS (port 4000). Nothing in this guide touches
either of them.

## The plan

```
https://jobs.teamlinks.in            ──►  server nginx  ──►  127.0.0.1:4323  (job portal, Docker: api + Postgres)
https://teamlink.teamlinks.in/jobs/  ──►  302 redirect to https://jobs.teamlinks.in/
```

The portal gets its own subdomain. It uses `/api`, `/job/<id>` and `/feeds/...` at the root of its domain,
and on teamlink.teamlinks.in, `/api` already belongs to Enterprise. The old `/jobs/` link keeps working
through the redirect.

## Steps

### 1. DNS

Add an **A record** `jobs.teamlinks.in → 72.61.233.104`, and wait until `ping jobs.teamlinks.in` answers
with that IP.

### 2. Get the code onto the server

```bash
sudo mkdir -p /opt/teamlink-jobs && cd /opt/teamlink-jobs
git clone https://github.com/srvanthim084-afk/job_portal.git .
```

Docker with the compose plugin must be installed (`docker compose version`).

### 3. Settings: `/opt/teamlink-jobs/.env`

Start from the owner's working `.env` on the office PC (`C:\Users\user\Desktop\job portal\.env`).
Copy it over securely, for example with `scp`; never through chat or email. Then set or add:

| Setting | Value |
|---|---|
| `PUBLIC_ORIGIN` | `https://jobs.teamlinks.in` |
| `POSTGRES_PASSWORD` | a new strong password (the database superuser) |
| `APP_DB_PASSWORD` | a new strong password (the portal's own database login) |
| `AUTH_SECRET` | a long random string, e.g. `openssl rand -hex 32` |
| `INTEGRATION_SECRET_KEY` | **keep the PC's value unchanged**: saved integration passwords (Naukri/Shine mailboxes, partners) are encrypted with it |

Keep the email settings from the PC's `.env` as they are (`EMAIL_SMTP_*`, `EMAIL_FROM*`, `EMAILJS_*`), and
likewise `AI_API_KEY`. The compose file passes every `.env` setting to the API.

### 4. Start the portal, without its own nginx

```bash
docker compose -f docker-compose.yml -f deploy/host-nginx.override.yml up -d --build db migrate api
docker compose ps                          # api: healthy
curl -s http://127.0.0.1:4323/api/health   # {"ok":true,...}
```

- The `migrate` step creates the schema.
- The bundled nginx/certbot are **not** started, because the server's own nginx already owns ports 80/443.
- The API listens on the server's `127.0.0.1:4323` only.

### 5. nginx: the new subdomain, and the redirect

```bash
sudo cp deploy/nginx/jobs.teamlinks.in.conf /etc/nginx/sites-available/jobs.teamlinks.in
sudo ln -s /etc/nginx/sites-available/jobs.teamlinks.in /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d jobs.teamlinks.in          # free HTTPS certificate
```

Then, in the existing **teamlink.teamlinks.in** server block, comment out whatever serves `/jobs/` today and
add the redirect from the bottom of `deploy/nginx/jobs.teamlinks.in.conf`. Reload:
`sudo nginx -t && sudo systemctl reload nginx`.

### 6. Bring over today's data (candidates, applications, jobs, settings, resumes)

The data is on the owner's office PC. Follow **"2. Copy today's data from this PC to the server"** in
`docs/WEBSITE-JOBS.md`, which uses `tools/copy-live-to-postgres.mjs` with a dry run first, plus an SSH
tunnel. Two server-specific details:

- **Open the database port** for the copy:
  ```bash
  docker compose -f docker-compose.yml -f deploy/host-nginx.override.yml -f deploy/db-tunnel.override.yml up -d db
  ```
  Close it again afterwards with the same command without the tunnel file.
- **Copy the uploads:** `docker compose cp <copied var/uploads folder>/. api:/app/var/uploads/`

The copy refuses to run unless the server's code is the same version as the PC's (the same migrations).
Deploy first, copy second.

Without the copy, the portal starts empty. Create the first administrator as in `docs/DEPLOYMENT.md`, step 6.

### 7. Check

- `https://jobs.teamlinks.in` opens the portal.
- `https://teamlink.teamlinks.in/jobs/` redirects there.
- Sign in as an existing user. If the data was copied, the same passwords work.
- Post a test job, apply as a test candidate, and check that it appears under Applications in the ATS.
- Enterprise (`https://teamlink.teamlinks.in`) and HRMS still work as before.

## Rollback

1. Put the old `/jobs/` block back in the teamlink.teamlinks.in server block and reload nginx. The old page
   is back.
2. Stop the portal with `cd /opt/teamlink-jobs && docker compose stop api`. Its data stays in the Docker volumes.

## Updating later

```bash
cd /opt/teamlink-jobs && git pull
docker compose -f docker-compose.yml -f deploy/host-nginx.override.yml up -d --build db migrate api
```

`migrate` runs before the API restarts.
