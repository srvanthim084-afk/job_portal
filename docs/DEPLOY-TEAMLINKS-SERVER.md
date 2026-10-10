# Putting the real Job Portal on teamlink.teamlinks.in

There are two parts: the owner prepares a data package on the office PC (one click), then whoever manages
the server runs three commands. TeamLink Enterprise (port 4010) and HRMS (port 4000) on the same server are
not touched.

## What is there today

`https://teamlink.teamlinks.in/jobs/` serves a single static HTML file. It is the original prototype from
19 Sep 2026 (`baseline/prototype.html`, identical byte for byte):

- It has no server and no database.
- Data lives in each visitor's browser.
- None of the real portal is in it: registration and applications stored in a database, the ATS, the AI
  interview, the admin panel, emails, the Naukri/Shine import, and so on.

## What it will be

```
https://jobs.teamlinks.in            ──►  server nginx  ──►  127.0.0.1:4323  (job portal in Docker: API + PostgreSQL)
https://teamlink.teamlinks.in/jobs/  ──►  redirect to https://jobs.teamlinks.in/
```

The portal gets its own subdomain, because it uses `/api`, `/job/<id>` and `/feeds/...` at the root of its
domain, and on teamlink.teamlinks.in, `/api` is Enterprise's. The old `/jobs/` link keeps working through
the redirect.

---

## Part 1 - on the office PC (the owner)

Double-click **`EXPORT-DATA-FOR-SERVER.bat`** in the portal folder.

- It stops the local portal for about a minute to take a clean copy, then starts it again.
- It leaves one file on the Desktop: **`teamlink-data-for-server-<date>.zip`**. Inside:
  - `teamlink-data.ndjson.gz`: every candidate, application, job and setting. It holds only the rows,
    so it is small.
  - `uploads.tar.gz`: resumes, documents and interview recordings.
  - `env-from-pc.txt`: the PC's settings. It **contains passwords** (email, AI, integration key).
- Send the zip to the server administrator **privately**, for example on a USB stick or through a
  password-protected share. Do not send it by public chat or email.

Make the package right before the switch, so it has the latest data. Anything added on the PC after the
export is not on the server.

## Part 2 - on the server (the administrator)

**0. DNS:** add an A record `jobs.teamlinks.in → 72.61.233.104`, and wait until it resolves.

**1. Code, the package, install**

```bash
sudo mkdir -p /opt/teamlink-jobs && cd /opt/teamlink-jobs
sudo git clone https://github.com/srvanthim084-afk/job_portal.git .
# copy the zip to /root/, then put the PC's settings next to the code:
sudo unzip -j /root/teamlink-data-for-server-*.zip env-from-pc.txt -d /opt/teamlink-jobs
sudo bash deploy/install-teamlinks.sh
```

`install-teamlinks.sh`:

- Checks Docker and nginx.
- Builds `.env` from `env-from-pc.txt`. It sets `PUBLIC_ORIGIN=https://jobs.teamlinks.in`, generates the
  database passwords and `AUTH_SECRET`, and keeps the PC's `INTEGRATION_SECRET_KEY` and email settings.
- Starts the portal: database, migrations and API only, with the API on `127.0.0.1:4323`. The project's
  bundled nginx is not started, because the server's nginx already owns ports 80/443.
- Adds the nginx site `jobs.teamlinks.in` and gets the free HTTPS certificate with certbot.
- Changes nothing else. If anything is missing, it stops with a clear message.

**2. Load the data**

```bash
sudo bash deploy/import-data.sh /root/teamlink-data-for-server-<date>.zip
```

1. It rehearses first (a dry run that writes nothing).
2. It asks you to type `COPY`.
3. It loads everything in one transaction: all or nothing, with the row counts checked table by table.
   Then it copies the uploaded files and restarts the portal.
4. Users sign in with the same email and password they used on the PC.

**3. Point the old link at the portal:** in the **existing** teamlink.teamlinks.in nginx site, comment out
the block that serves `/jobs/` today and add:

```nginx
location /jobs/ { return 302 https://jobs.teamlinks.in/; }
location = /jobs { return 302 https://jobs.teamlinks.in/; }
```

Then run `sudo nginx -t && sudo systemctl reload nginx`.

**4. Check**

- `https://jobs.teamlinks.in` opens the portal.
- `https://teamlink.teamlinks.in/jobs/#/` lands there.
- Sign in as an existing user.
- Post a test job and apply as a test candidate. It appears under Applications in the ATS.
- Enterprise and HRMS still work.

## Rollback

1. Put the old `/jobs/` block back and reload nginx. The old page is back.
2. Run `cd /opt/teamlink-jobs && sudo docker compose stop api`. The portal's data stays in its Docker volume.

## Updating later (new versions from GitHub)

```bash
cd /opt/teamlink-jobs && sudo git pull && sudo bash deploy/install-teamlinks.sh
```

Migrations run before the API restarts. The data is kept.

## How this was tested

| Area | What was checked |
|---|---|
| Data package | `EXPORT-DATA-FOR-SERVER.bat` was run against a throwaway portal on another port. It stopped the portal, copied the data, restarted the portal (which answered again), and produced the zip with the data file and the uploads. |
| Data file | A file exported from a test database (13 KB for a 68 MB folder) was loaded into a separately migrated PostgreSQL-protocol target, with a dry run and then a commit. Every table matched row for row, and the login hash, settings JSON, candidate codes and counters were identical. |
| Scripts | `install-teamlinks.sh` and `import-data.sh` pass a shell syntax check. |
| Not tested | They have not been run on the real server. There was no access to it from the office PC. |
