# Job portal upgrades

Five upgrades to the candidate job portal, plus the urgent-hiring and
last-date alerts that go with them. (The sixth item of the build prompt,
resume score + tips, is built separately.)

| | What the candidate gets | Where it is decided |
|---|---|---|
| 1 | Quick filter chips above the results | `CHIP_SQL` in `api/src/portal/core.js`, `app_settings.quick_filters` |
| 2 | "82% match · ✓ Java, Spring · ✓ 3 yrs · ✗ AWS" on cards, the full breakdown on the job page | `explainMatch()` = the screening score |
| 3 | Share (phone share sheet, WhatsApp, Copy link, Email, LinkedIn), link previews | `job_shares`, `GET /job/:id` |
| 4 | One-tap apply on every open job, 10-second Undo | `POST /api/applications/one-click`, `application_undo()` |
| 5 | Last date + Urgent hiring badges, "Applications closed" | `jobs.expires_at`, `jobs.urgent`, `jobs.urgent_until` |
| + | Urgent-hiring / last-date alerts by inbox and email | `api/src/portal/alerts.js`, `notification_log` |

Files: `supabase/migrations/0095_portal_upgrades.sql`, `api/src/portal/core.js`,
`api/src/portal/alerts.js`, `api/src/routes/portal-upgrades.js`,
`web/teamlink-portal-upgrades.js`, `api/test/portal-upgrades.test.mjs`,
`tools/verify-portal-upgrades.mjs`; the Undo hold (0104):
`supabase/migrations/0104_screening_calls_and_undo.sql`,
`api/src/notify/apply-hold.js`, `api/src/notify/apply-messages.js`,
`api/test/screening-calls-and-undo.test.mjs`. Small anchored edits: `api/src/app.js`
(mount + sweep + `/job/:id`), `api/src/shapes.js` (`toJob` carries
`expiresAt`, `urgent`, `urgentUntil`), `web/index.html` (one `<script>` line).

## 1. Quick filter chips

Fresher · Work from home · Immediate joining · Near me · Posted today ·
Urgent hiring · Salary 3 LPA+ · Walk-in — a horizontally scrolling row above
the results on Home / Find Jobs (signed out too) and on the candidate's
Search Jobs page. One tap toggles a chip; chips combine with AND.

**What each chip means** (one definition, in SQL, `CHIP_SQL`):

| Chip | Rule |
|---|---|
| Fresher | the experience band starts at 0 (`Fresher`, `Entry level`, `0-2 yrs`) |
| Work from home | mode is Remote / Work from home / WFH |
| Immediate joining | the title, description or requirements say "immediate join/start" — there is no column for it, so the advert has to say so |
| Near me | the job is in, inside, or within 50 km of the candidate's location (place tree), or of the browser's location when signed out; remote jobs are not "near" |
| Posted today | published since midnight IST |
| Urgent hiring | `urgent` and `urgent_until > now()` |
| Salary 3 LPA+ | `salary_max` (or `salary_min`) ≥ 3 |
| Walk-in | employment type Walk-in, posting kind walkin, or a walk-in date |

**Server side.** `GET /api/jobs?quick=fresher,urgent` answers the job board
with the chips applied in SQL (`&ids=1` returns only ids; `near`, `lat`/`lon`,
`km` for Near me). Without `?quick=` the ordinary `GET /api/jobs` answers,
unchanged. The browser asks the server which jobs pass the chips the sidebar
has no control for, so the page and the API cannot disagree.

**In step with the sidebar and the URL.** A chip the sidebar already has is
that sidebar control: Salary 3 LPA+ is "₹3+ LPA" on Home and "Min CTC 3" on
Search Jobs; Fresher and Work from home are the Experience/Work Mode boxes
on Search Jobs. Server-only chips appear in the sidebar's applied-filter
list (removable there) and Clear all clears them. The URL carries the
active chips as `?qf=fresher,urgent` (`#/?qf=…`, `#/jobs?qf=…`,
`#/candidate/search?qf=…`), so a reloaded or shared search keeps them.
State: `STATE.search.quick` (Home) and `STATE.rj.quick` (Search Jobs).

**Admin.** `#/admin/quick-filters` (menu: Quick Filters): reorder, rename,
hide. Stored in `app_settings` key `quick_filters`; `GET /api/quick-filters`
(public), `PUT /api/admin/quick-filters` (admin).

## 2. Match reasons

`GET /api/job-matches/explain?jobIds=a,b,…` — candidate only, at most 50 ids.
Per job: `score`, `matchedSkills`, `impliedSkills` (found in the resume
text), `missingSkills`, `experience` {fit, ok, years, required},
`location` {ok, reason}, `salary` {fit, ok}, `education`, and `line` — the
card line as parts.

**One number.** `explainMatch()` builds its inputs exactly as
`screenApplication()` does (toJob + company, toCandidate + resume text) and
scores them with `scoreApplication()` and the admin's AI settings — the
function screening uses. The percentage on the card is the percentage the
application gets when it is screened (tested), and the one the alerts below
quote. In the browser, `computeMatchScore`, `recRecommendation` and
`matchExplanation` return the server's score once it has arrived, so every
existing badge shows it too.

Job page: a "Your match · N%" panel with skills, experience, location and
salary, and "Improve your match" (one button per missing skill, opening the
profile). Signed out: "Log in to see your match" on cards and the job page.

## 3. Share

A "↗ Share" button on every card and on the job page. On a phone with a
native share sheet (`navigator.share`) that is used; otherwise a sheet with
WhatsApp (wa.me), Copy link, Email and LinkedIn.

- `POST /api/jobs/:id/share {channel}` (anyone, signed out included; open jobs
  only) → `{code, url, text, links}`. Every share is a `job_shares` row
  (job, who shared or NULL, channel, code).
- Message (WhatsApp, the phone's share sheet, email), the owner's format:

  ```
  🌟 *TeamLink Consultancy*

  📢 *Job Opportunity*

  👨‍⚕️ *<title>*

  I thought this job opportunity might be relevant for you.

  📍 *Location:* <location>          (left out when the job has none)
  💼 *Job Type:* <employment type>   (left out when the job has none)

  👉 *View Job & Apply:*
  <link>

  Please check the job details and apply if interested.

  *TeamLink Consultancy*
  ```

  Blank, `undefined`, `null` and `[object Object]` values are never printed.
  **No company field is read**, so a client's name cannot reach a share, a
  message or a preview (tested).
- Link: `/job/<id>?ref=<code>` on the address the PUBLIC can open.
  **Set `PUBLIC_SHARE_URL`** (e.g. `https://jobs.your-domain.in`) to the
  portal's public https address: only the origin is swapped, the path and
  `?ref=` stay. Without it the link uses `PUBLIC_ORIGIN` when that is a real
  address, otherwise the address the page was opened on - a `localhost` link
  opens only on that computer, and the share response says so
  (`publicLink: false`). The Open Graph `og:url` / `og:image` use the same.
- `GET /job/:id` serves the application with Open Graph tags (title +
  location, pay/experience/mode, the TeamLink icon) for WhatsApp and other
  previews, and a first-line script that turns the address into
  `/?ref=<code>#/job/<id>` before anything loads — so `#/job/<id>` keeps
  working exactly as before and every relative URL resolves as it always has.
  A browser opening it counts a click (link-preview robots do not) and keeps
  the code in an httpOnly cookie for that job for 7 days; an application to
  that job, including one made after registering, is credited to the share
  (`job_share_applications`, one per application).
- `GET /api/jobs/:id/share-stats` (the job's recruiter or an admin) →
  shown on the job page as "Shared 23 times · 9 applies".

## 4. One-click apply

> **0118:** no profile field is required any more, and Apply Now shows the
> confirmation at once. The "Fill N things" sheet and the 422 below are
> gone. See `docs/ONE-CLICK-APPLY.md`.

A signed-in candidate applies to **any** open job in one tap (not only
`easy_apply` ones — that flag is now only "the recruiter wants quick
applies"). The Apply buttons on cards, on the Search Jobs cards and on the
job page all go this way.

- `POST /api/applications/one-click {jobId, answers?}`: never refused for
  an incomplete profile (0118); the missing fields come back as
  `profileMissing`. **Idempotent** — an
  existing application is returned (200, `existing: true`), and two taps
  racing each other also get the one application. The application itself is
  made by the ordinary `POST /api/applications` (the request is handed on),
  so screening, notifications and the AI interview follow as for any apply.
- After the tap: "Applied ✓" with **Undo (10)**. `DELETE /api/applications/:id`
  withdraws it — only the applicant, only within 10 seconds of `applied_at`
  (`application_undo()`, 409 `UNDO_EXPIRED` after). There is no candidate
  withdraw after that, as before.
- **Nothing goes out that Undo cannot take back (0104).** For an
  application made by one-click apply, the candidate's outbound messages
  wait until the Undo window has passed: the interview invitation /
  "Application received" (email, SMS, WhatsApp, IVR, Naukri) and the AI
  interview invitation. They are sent only if the application still exists.
  Undo deletes the application, and its hold goes with it, so nothing is
  sent.
  - The hold is a row (`application_outbound_holds`), written in the
    application's own transaction. It falls due at `applied_at` + 10 s +
    a margin (`ONE_CLICK_HOLD_MARGIN_SECONDS`, default 5, so 15 s; never
    less than 11 s).
  - Two ways it is sent, both through one `UPDATE … RETURNING` claim
    (`application_outbound_claim()`), so it is sent once whichever gets
    there first: a timer in the process that took the application (the
    prompt path), and a sweep (`startOutboundHoldSweep`, first pass 5 s
    after boot, then every 30 s, `OUTBOUND_HOLD_SWEEP_MS`) that sends any
    hold that is due and unsent. That sweep is what a restart in between
    relies on. A claim older than 10 minutes without a "sent" mark is
    claimable again.
  - The messages are the same code as an ordinary apply
    (`api/src/notify/apply-messages.js`, moved out of the route unchanged).
    Each channel's outcome is in `notification_deliveries`, as before, and
    the existing retry sweep handles a failed channel.
  - The response says so: `notify` and `aiInterview` are
    `{held: true, sendsAt, reason: 'undo_window'}` for a one-click apply.
  - Not held: the in-app notification (it appears at once and Undo removes
    it, as before), everything recruiter-facing, and every other way of
    applying. The hold is set by the one-click route on the request itself
    (`req.oneClickApply`), never by a body field, so an ordinary
    `POST /api/applications` cannot ask for it (tested).
  - The screening-questions sweep does not send its no-password link to an
    application whose hold is still unsent.
  - In the browser, Undo now remembers the ids it withdrew and drops them
    from any refresh that was already in flight when Undo was pressed.
    Applying returns sooner now that no message is sent inline, and such a
    late refresh used to put "✓ Applied" back on the card.
- Incomplete profile (0118): applies the same way. The confirmation offers
  **Complete Profile**; the "Fill N things to apply" sheet is no longer shown
  before applying.
- Screening questions: if `window.TLScreening.beforeApply(jobId)` exists it is
  awaited first; `{answers}` is sent with the application, `null` means no
  questions, `{cancelled:true}` or a rejection stops the apply.
- Limit: 30 applications an hour per candidate, for every way of applying
  (`APPLY_RATE_PER_HOUR`), 429 `RATE_LIMITED`.
- Signed out (0118): a one-field "Email / Mobile Number" box, then sign in
  or register; the application continues after sign-in
  (`teamlink-apply-auth.js`). External (`xjob_`) jobs keep their own flow.
  The home page "⚡ Easy Apply" is one click too.

## 5. Last date + urgent hiring

Every posting form (Post a job, Edit, Walk-in, Internship, Bulk) gets
**Last date to apply** and **🔴 Urgent hiring**, saved with
`PUT /api/jobs/:id/deadline {lastDate:'YYYY-MM-DD'|null, urgent}`.

- The last date is stored in `jobs.expires_at` as **the end of that day in
  Asia/Kolkata** (23:59:59.999 IST).
- Urgent: `jobs.urgent` + `jobs.urgent_until`, set to now + 14 days when it is
  switched on (trigger `jobs_urgent_window`). The API stops calling a job
  urgent the moment `urgent_until` passes, and the sweep switches the flag off.
- Badges on cards and the job page: **Urgent hiring** (red), **N days left** /
  **Last day today** (amber), nothing when there is no date.
- After the last date: Apply buttons read "Applications closed" and are
  disabled; the server refuses every apply with "Applications closed on …"
  (409). Candidates stop seeing the job (row level security already hid it).
  The sweep sets `status = 'closed'` and tells the recruiter (in-app,
  `JOB_CLOSED_EXPIRED`).
- Recruiter reminder two days before: "Applications for X close on … Extend
  the last date or let it close?" (`JOB_DEADLINE_REMINDER`), once per date.
- Relevance: urgent jobs rank higher by at most **+10 points** of match, so
  they never pass a job that is a better match by more than 10.

## Candidate alerts: urgent hiring and the last date

| Event | When | In-app title | Email subject |
|---|---|---|---|
| A `urgent_hiring` | a job is published or updated with Urgent hiring on | Urgent hiring | `Urgent hiring: {jobTitle} at {company}` |
| B `deadline_2d` | the last date is two days away (daily, 09:00 IST) | Last date to apply is approaching | `Last date to apply: {jobTitle} – {date}` |
| C `deadline_today` | the last date is today (daily, 09:00 IST) | Last day to apply | `Last date to apply: {jobTitle} – {date}` |

**Recipients.** Every candidate whose match with the job (`explainMatch`,
the screening score) is **above `NOTIFY_MATCH_THRESHOLD`** (env, default 60):
60 exactly gets nothing, 60.01 and up does (`aboveThreshold`). Candidates who
already applied are skipped. For B and C the match is **recomputed at send
time**. The threshold is the match alone — the profile-alert gates in
`ai/match.js` (`notify`) are not applied.

**Channels — both, always.** An entry in the candidate's inbox (the bell in
the candidate header now lists these with title, job, company, "82% match",
the short line and **Apply now**) and an email in the TeamLink layout
(`notify/layout.js`): match %, job summary, last date, an **Apply now**
button. Each channel is attempted on its own; if one fails the other is
still delivered and the failed one is retried by the sweep (up to 5
attempts, 15 min × attempt apart), rebuilt from the current job and
candidate with the match recorded at first send; a job that has closed, or
a candidate who has applied since, is marked skipped instead of sent late.
An email channel with no provider records `not_configured` and is retried
once one is configured.

**Once.** `notification_log` (extended by 0095 with `candidate_id`, `job_id`,
`event_type`, `match_percent`, `sent_at`, `attempts`, `next_retry_at`) has a
unique index on (candidate, job, event, channel); the row is claimed before
anything is sent, so re-runs and restarts never send twice (tested). The
inbox side is also deduplicated by `notifications_dedupe`.

**Company.** `{company}` is exactly the label the candidate already sees on
that job's card and page — the company name the card prints beside the
title (`companies.name`). Nothing else is ever used, and if that label would
contain the word "Client" it is replaced by "TeamLink".

**Respected.** Do-not-contact and email opt-out: the email is recorded
`skipped` (the inbox entry, which is not outreach, is still written). Quiet
hours do not apply to email or in-app. Nothing is sent to reserved test
domains (the provider refuses them).

**Schedule.** `startPortalSweep()` (started with the other background work)
runs every 5 min (`PORTAL_SWEEP_MS`): urgent auto-off, closing expired jobs,
pending urgent announcements, the once-a-day pass (B, C, recruiter reminders;
recorded in `portal_daily_runs` per IST day; hour `PORTAL_DAILY_HOUR_IST`,
default 9) and retries. Saving a job with Urgent on also starts the
announcement straight away.

## Configuration

| Variable | Default | |
|---|---|---|
| `NOTIFY_MATCH_THRESHOLD` | 60 | alerts go to matches strictly above this |
| `APPLY_RATE_PER_HOUR` | 30 | applications per candidate per hour |
| `PORTAL_SWEEP_MS` | 300000 | the sweep interval |
| `PORTAL_DAILY_HOUR_IST` | 9 | when the daily pass runs |
| `PORTAL_ALERT_MAX_ATTEMPTS` | 5 | delivery attempts per channel |
| `PORTAL_ALERT_RETRY_MS` | 900000 | retry spacing (× attempt) |
| `PORTAL_ALERT_MAX` | 500 | candidates alerted per job per event per run |
| `ONE_CLICK_HOLD_MARGIN_SECONDS` | 5 | one-click candidate messages wait 10 s (Undo) + this (1–120) |
| `OUTBOUND_HOLD_SWEEP_MS` | 30000 | how often held messages left by a restart are looked for |

## Tests

- `api/test/portal-upgrades.test.mjs` (ports 5465 / 9985, mock 9863), in
  `npm test`: chips in SQL and the admin list; explain = screening; one-click
  missing fields, idempotency, Undo within 10 s by the owner only; the rate
  limit; the IST last date and the expired refusal; urgent auto-expiry;
  closing + recruiter notice; the 2-day reminder; share text / OG tags
  without the client name, clicks and applies counted; alerts — 60 gets
  nothing, 80 gets both channels, applied skipped, DNC email skipped, no
  duplicates on re-run, B/C recomputed at send time, email failing → inbox
  delivered and the email retried, inbox failing → email delivered and the
  inbox retried.
- `api/test/screening-calls-and-undo.test.mjs` (ports 5466 / 9986, mock 9974)
  covers the Undo hold. Undone inside the window: no email or SMS reaches the
  mock provider, even after the window. Not undone: after the window, exactly
  the emails and SMS an ordinary apply sends, once. Timer lost (a restart):
  nothing until the sweep, then once; two sweeps racing still send once. Also:
  an ordinary apply and a body `oneClick` flag hold nothing; only the engine
  can claim or list holds, and only the applicant can create one.
- `tools/verify-portal-upgrades.mjs` (Playwright, 390×844 phone), against an
  isolated instance with `PUBLIC_ORIGIN` set to it. WhatsApp and LinkedIn are
  stubbed in the browser; nothing external is reached.
