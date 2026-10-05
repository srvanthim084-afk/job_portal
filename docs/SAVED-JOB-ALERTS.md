# "New job like one you saved" (0110)

The owner's request: *if a candidate saves a job, and other jobs related to that
saved job are posted, the candidate should receive a notification and a mail.*

When a job is published, every candidate who saved a job **like it** gets an entry
in their TeamLink inbox (the bell) and an email that names the saved job it is
like. One message per candidate per job, across every "new job for you" alert the
portal has.

## Where things are

| Piece | File |
|---|---|
| Tables, the shared ledger, the claim function, the two templates | `supabase/migrations/0110_saved_job_alerts.sql` |
| The engine: relatedness, instant alert, cap, digest, sweep, stop token | `api/src/notify/saved-job-alerts.js` |
| The shared "one new-job message" ledger helpers | `api/src/notify/new-job-notice.js` |
| Email text (instant and digest) | `api/src/notify/templates-saved-jobs.js` |
| Routes: the switch, the unsubscribe link | `api/src/routes/saved-job-alerts.js` |
| The publish hook (chained) | `api/src/notify/job-alerts.js` `runJobAlertsInBackground()` |
| Browser: saving through the API, the switch, the bell | `web/teamlink-saved-job-alerts.js` |
| API tests | `api/test/saved-job-alerts.test.mjs` |
| Browser check | `tools/verify-saved-job-alerts.mjs` |

## Saving a job now reaches the server

`saved_jobs` (0001) and `POST/DELETE/GET /api/saved-jobs` (misc.js) existed, but the
star on a job card only changed `STATE.savedJobs` in memory - nothing ever wrote the
table, so a saved job was gone on the next visit and the server could not know what
anybody saved. `web/teamlink-saved-job-alerts.js` wraps `toggleSaveJob` (every star /
Save / Remove button calls it) to `POST` or `DELETE /api/saved-jobs/:id`, reverts the
star and says so if the server refuses, loads the list from `GET /api/saved-jobs`
when a candidate signs in (the server is the record), and removes a job from the
saved list when it is hidden ("Not interested", `hideJob`). Only jobs the server has
(`TL.knownJobIds`) are synced; external listings keep their own save path.

## What counts as related

Against each of the candidate's saved jobs, using the match engine's own scorers
(`scoreRole`, `scoreSkills` from `api/src/ai/match.js`) and the role key from 0091
(`app_role_key(title, department)`) - no new matcher:

| Reason | Rule | Example |
|---|---|---|
| same role | `app_role_key` of both titles is equal (seniority words removed) | Senior Java Developer ~ Java Developer |
| similar role | the distinctive title words overlap by half or more both ways, **or** one title is wholly inside the other; the shared words include one that is more than a level/shift word (manager, officer, technician, night, shift, ...); and when both jobs list skills they share at least one | ICU Staff Nurse (Night Shift) ~ Staff Nurse |
| shared skills | 2+ skills in common covering 60% of the shorter list with some title overlap, or 3+ in common on their own | Backend Engineer (Java, Spring Boot, SQL, Kafka) ~ Java Developer (Java, Spring Boot, SQL) |

Not related: Python Developer ~ Java Developer (one shared skill), Store Manager ~
Sales Manager (only "manager" in common), Delivery Executive ~ Sales Executive,
Cardiologist ~ Emergency Physician. When several saved jobs relate, the strongest
one is the one the message names.

## Who is told, and who is not

Only a **live** job alerts: `status = 'open'`, not paused, not archived, not past its
last date (`expires_at`), and for a walk-in (0106) not past its day and end time. A
draft never alerts. Never sent:

- the saved job itself, or a job the candidate also saved, applied to or hid;
- a job like a saved job they have since hidden;
- a job published **before** they saved the job it is like (not new to them);
- anything to a **do-not-contact** candidate (recorded as skipped);
- anything to a candidate who switched **"Tell me about similar new jobs"** off, on
  the page or with the email's link (recorded as skipped);
- **email** to a candidate who opted out of email (`email_opt_in = false`) or has no
  address - the inbox entry still goes (`email_status = skipped_opted_out` /
  `skipped_no_address`);
- the same job twice: `(candidate_id, job_id)` is the primary key of
  `candidate_saved_job_alerts`;
- a job the candidate already heard about from another alert - see below.

## One "new job for you" message per candidate per job

Four systems decide on their own that a new job is for somebody: the profile-match
job alert (0017, `job-alerts.js`), saved-search alerts (0086), urgent hiring (0095,
`portal/alerts.js`) and this one. Each had a "never twice" guard only for itself
(`job_matches.notified`, `candidate_saved_search_hits`, the `notification_log` unique
index), so one job could arrive three times.

`candidate_new_job_notices (candidate_id, job_id, source)` is now the guard they
share. Before sending, each system **claims** the pair (`new_job_notice_claim()`,
true only for the caller that created the row); whoever is first is the only one
that speaks, and everybody after it - including a second run, or a second saved
search of the same candidate - skips. A message that reached nobody (every channel
skipped / not configured / failed) **releases** its claim, so another alert can still
try. The migration back-fills the ledger from what the three older alerts already
sent. Changes to the older systems are small and anchored:

- `job-alerts.js`: claim `profile_match` before `sendAlert`, release when nothing was
  delivered.
- `saved-search-alerts.js`: the ledger joins the "do not tell" set; instant alerts
  (hook and sweep) claim before sending; a digest claims each job and leaves out the
  ones it could not claim; release when nothing was delivered.
- `portal/alerts.js`: **urgent hiring** claims `urgent_hiring` (it announces a job, so
  a candidate told about the job by any of the others is not told again when it is
  marked urgent later). The last-date alerts (`deadline_2d`, `deadline_today`) are
  reminders about a job the candidate already knows and do not take part.

On publish the order is profile match -> saved searches -> saved jobs (one chain in
`runJobAlertsInBackground`); urgent hiring runs beside it. Whichever claims first wins.

## When: instant, the sweep, the cap and the digest

- **Instant.** `runSavedJobInstant(jobId)` is chained after the saved-search instant
  run in `runJobAlertsInBackground`, i.e. on `POST /api/jobs` with status open
  (walk-in jobs included) and on `POST /api/jobs/:id/publish` (a draft published
  later).
- **Sweep.** `startSavedJobAlerts()` (from `app.js`, every 10 min,
  `SAVED_JOB_ALERT_SWEEP_MS`) processes every live job published in the last
  `SAVED_JOB_ALERT_LOOKBACK_DAYS` (3) whose publication `saved_job_alert_jobs` has not
  recorded - a job opened by `PUT /jobs/:id`, the intake mailbox, or anything else
  that runs no hook - then sends the digest.
- **Cap.** At most `SAVED_JOB_ALERT_DAILY_CAP` (3) instant alerts per candidate per IST
  day. `saved_job_alert_claim()` takes a per-candidate advisory lock, so the count and
  the insert are one step.
- **Digest.** The rest are queued (`kind = 'digest'`, `status = 'queued'`, their
  ledger claim held) and go out together at `SAVED_JOB_DIGEST_HOUR_IST` (19:00): one
  inbox entry (`SAVED_JOB_DIGEST`, listing the jobs) and one email, per candidate.
  Rows queued after the day's slot wait for the next one. Before sending, each job is
  checked again: closed, applied or hidden meanwhile -> dropped (skipped, claim
  released). Rows move `queued -> sending` before anything is sent, so two runs
  cannot send one digest twice.

Every run is idempotent; a restart sends nothing twice.

## What the candidate sees

- **Bell** (`notifications`, type `SAVED_JOB_SIMILAR`, job_id = the new job):
  title "New job like one you saved", message
  `New job like one you saved: <title> · <location>`, metadata with the saved job's
  title and `applyUrl #/job/<id>`. Shown in the candidate portal's bell
  (`cpNotifications`, as "...(like "<saved title>", which you saved)") and in the
  dashboard bell (`candidateBellHtml`); tapping it opens the job and marks it read on
  the server.
- **Email** (subject `New job like one you saved: <title> · <location>`): "You saved
  "<saved title>" (<company> · <location>) on TeamLink. A new job like it has just
  been posted", the facts (role, company, location, pay, experience, *Like the job you
  saved*), why it is similar, **View job & apply**, and **Stop similar-job emails**.
- **Digest** (subject `N more new jobs like ones you saved`).
- **Saved Jobs page**: the switch **"Tell me about similar new jobs"**, ON by default,
  stored on the server.

**Company.** Only the label the candidate already sees on the job's card
(`companies.name`), through `companyLabel()` (portal/alerts.js) - which turns any
name containing "Client" into TeamLink. No description, no hidden name, never the
word "Client".

## Templates

`notification_templates` gains `saved_job_alert` ("Saved Job — Similar New Job") and
`saved_job_digest` ("Saved Job — Daily Digest"), so they appear on Notification
Settings and an EmailJS template id can be attached to each, like the saved-search
ones (0086). Without one, the built-in HTML/text above is sent through the
configured transport (SMTP / EmailJS / HTTP API). Channels without credentials record
`not_configured`; nothing is called "sent" that the provider did not accept.

## API

| Method | Path | Who | |
|---|---|---|---|
| GET | `/api/saved-job-alerts/settings` | candidate | `{ settings: { enabled, changedVia, updatedAt, dailyCap } }` |
| PUT | `/api/saved-job-alerts/settings` | candidate | `{ enabled: boolean }` |
| GET | `/api/saved-job-alerts/stop?token=` | anyone with the link | HMAC-signed token naming the candidate (`AUTH_SECRET`, like the saved-search stop links); turns the switch off (`changed_via = 'email_link'`) and shows a page |

Existing: `GET/POST/DELETE /api/saved-jobs[/:jobId]` (misc.js), now actually called.

## Data (0110)

| Table | |
|---|---|
| `candidate_saved_job_alert_settings` | the switch; candidate reads/writes own row, the engine reads it |
| `candidate_saved_job_alerts` | one row per (candidate, new job): saved job, reason, kind (instant / digest), status (sending / queued / sent / failed / skipped), skip reason, IST day, inbox id, email status / ref / error |
| `saved_job_alert_jobs` | publications processed (job, published_at) - what the sweep skips |
| `candidate_new_job_notices` | the shared ledger: (candidate, job) -> first source |

RLS: a candidate reads their own alert rows; staff have no policy on any of these;
the engine (role admin with no user id, `saved_search_engine_ok()`) writes them, and
the ledger is reachable only through `new_job_notice_claim/release()` and
`saved_job_alert_claim()`, which refuse any signed-in caller.

## Configuration

| Variable | Default | |
|---|---|---|
| `SAVED_JOB_ALERT_DAILY_CAP` | 3 | instant alerts per candidate per IST day |
| `SAVED_JOB_DIGEST_HOUR_IST` | 19 | when the digest of the rest goes |
| `SAVED_JOB_ALERT_LOOKBACK_DAYS` | 3 | how far back the sweep looks for unprocessed jobs |
| `SAVED_JOB_ALERT_SWEEP_MS` / `SAVED_JOB_ALERT_FIRST_MS` | 10 min / 100 s | the timer |

## Tests

- `api/test/saved-job-alerts.test.mjs` (ports 5469 / 9989 / mock 9865): related vs
  unrelated; every exclusion (saved job itself, applied, hidden, also saved, hidden
  saved job, closed, expired, draft, paused, past walk-in, published before saving,
  do-not-contact); email opt-out keeps the inbox entry; dedupe with saved-search
  alerts both ways, with the profile-match alert and with urgent hiring; never twice
  (re-run, sweep, republish); the daily cap and one evening digest (closed job
  dropped, sent once, next day's cap); the switch (default on, off stops, on again,
  per candidate, validation, roles); the unsubscribe link (signed out, forged and
  garbage tokens refused); no client name and never "Client"; the sweep catching a
  job no hook saw, once; the real publish hook chain; the save API; RLS on the ledger;
  the two templates. Email goes only to the mock provider.
- `tools/verify-saved-job-alerts.mjs`: in a phone-sized browser against an isolated
  instance whose SMTP is the script's own sink - star a job -> server has it; Saved
  Jobs shows it with the switch on; a related job -> bell entry + email at the sink
  naming the saved job; the bell shows it and tapping marks it read; an unrelated job
  -> nothing; the switch turns off and survives a reload; the email's unsubscribe link
  works signed out.
