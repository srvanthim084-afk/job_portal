# Jobs on the company website (tmlink.in)

**Goal:** a job you tick for **TeamLink Website** when posting it appears on tmlink.in automatically, and Apply Now on the website
opens that same job in the portal. The application then lands in the portal and the ATS. There is no
second copy of the jobs and no Excel export.

How it works:

```
recruiter / admin posts a job  ──►  portal (jobs.tmlink.in)  ──►  /feeds/jobs.json  ◄──  tmlink.in jobs block
          "TeamLink Website" ticked on the form                    open jobs only       Apply Now → jobs.tmlink.in/job/<id>
```

## What already happens, with nothing to configure

- **You choose, per job.** When posting a job (Save & Post, or Admin → Jobs → Post a job), the "Post to" list
  shows TeamLink Job Portal (always on) and **TeamLink Website** (unticked to start with). Tick TeamLink
  Website and the job goes to the website; leave it unticked and it stays on the portal only.
  You can tick or untick it later by editing the job.
- **A job leaves the website automatically** when it is closed, unpublished, archived or unticked, or when a
  walk-in's dates are over.
- **The feed** (`/feeds/jobs.json`) lists only open jobs ticked for the website. It carries nothing about
  candidates or recruiters, can be read from any site, and is cached for 5 minutes. So a new job reaches
  the website within about 5 minutes.

## 1. Host the portal (once)

Follow `docs/DEPLOYMENT.md`: a Linux server with Docker, nginx, a free HTTPS certificate and Postgres.

Choose the address the portal will live at, for example `jobs.tmlink.in`, and set these in `.env`:

| Setting | Value |
|---|---|
| `PUBLIC_ORIGIN` | `https://jobs.tmlink.in` |
| `EXTRA_ORIGINS` | `https://tmlink.in,https://www.tmlink.in` (optional; the feed is open to every site anyway) |

In tmlink.in's DNS, add an **A record** for `jobs` that points to the server's IP. Do this before
issuing the certificate.

## 2. Copy today's data from this PC to the server (once)

> **Simplest way:** double-click `EXPORT-DATA-FOR-SERVER.bat` on this PC and give the zip to the server administrator, who loads it with `deploy/import-data.sh`. See `docs/DEPLOY-TEAMLINKS-SERVER.md`. The SSH-tunnel method below is for when this PC can reach the server's database directly.

Your candidates, applications, jobs and settings live in this PC's built-in database (`var/dev-db`).

1. **Stop the local portal** (close `START-TeamLink.bat`'s window), then take a copy:
   `xcopy /E /I var\dev-db var\dev-db-export`
   Never point the tool at `var\dev-db` itself while the portal is running.
2. **Start the server's stack** (`docker compose up -d`). Its `migrate` step creates the empty schema.
   The server's code must be the same version as this PC's: the tool refuses to run if the migrations differ.
3. **Open the database port** on the server's own localhost, and tunnel to it from this PC:
   - on the server: `docker compose -f docker-compose.yml -f deploy/db-tunnel.override.yml up -d db`
   - on this PC: `ssh -N -L 5433:127.0.0.1:5432 you@your-server` (leave it running)
4. **Rehearse, then copy.** From the project folder on this PC:
   ```
   node tools/copy-live-to-postgres.mjs --source var/dev-db-export --target postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5433/teamlink --dry-run
   node tools/copy-live-to-postgres.mjs --source var/dev-db-export --target postgres://postgres:<POSTGRES_PASSWORD>@127.0.0.1:5433/teamlink
   ```
   - It copies every table in one transaction, then compares the row counts table by table. On any
     difference it keeps nothing.
   - The dry run checks everything and then rolls back.
   - Passwords keep working, because the stored password hashes are copied as they are.
5. **Copy the uploaded files** (resumes, documents, interview recordings):
   `docker compose cp var/uploads/. api:/app/var/uploads/`
   You can also use `scp` to send the folder to the server and then run the same command there.
6. **Close the database port again:** `docker compose up -d db`. Then stop the SSH tunnel.

## 3. Put the jobs on tmlink.in (once)

On the website's Careers / Jobs page, wherever the list should appear, paste:

```html
<div id="teamlink-jobs"></div>
<script src="https://jobs.tmlink.in/teamlink-jobs-embed.js" async></script>
```

What visitors get:

- the portal's open jobs as cards
- search, a location filter, and All / Walk-in / Jobs buttons
- walk-in date, time and venue on walk-in cards
- **Apply Now**, which opens the job in the portal

The block draws itself in isolation, so the website's styles can't break it and it can't break the website's.
It refreshes every 5 minutes.

Optional attributes on the `<script>` tag:

| Attribute | Effect |
|---|---|
| `data-type="walk-in"` | only walk-ins (`regular` = only jobs) |
| `data-limit="6"` | at most 6 jobs, e.g. for the home page |
| `data-accent="#e11d48"` | button colour to match the website |
| `data-new-tab="false"` | Apply Now opens in the same tab |
| `data-target=".careers-list"` | draw into another element |

If the website is WordPress, paste the two lines into a **Custom HTML** block.

## 4. Check it

- Post a test job with **TeamLink Website** ticked, wait about 5 minutes, and refresh tmlink.in. The job is listed.
- Post one with it unticked. It is not listed.
- Click Apply Now. The portal opens that job and the application appears under Applications in the ATS.
- Close the job. Within about 5 minutes it is gone from tmlink.in.

## What was verified before shipping

| Area | Check |
|---|---|
| API tests (`job-publishing`, 19/19) | TeamLink Website starts unticked. A job nobody ticks stays off the website feed. A job ticked for it is listed, with a working page and entry URL. The jobs block can be loaded from another site (both compressed and plain), and no other file can. |
| Browser | A test "website" on another address showed the portal's jobs, the Walk-in filter worked, and Apply Now opened the job page. The website's own styles did not leak into the cards. |
| Data copy | Run against a seeded test database into a separately migrated Postgres-protocol target. 168 tables matched row for row, and the login hash, JSON settings, candidate codes, counters and seed record were identical. |
| Not verified here | A real server, DNS, the HTTPS certificate and tmlink.in itself. Those happen on your infrastructure. |
