# Walk-in ATS (recruiter side) — owner's Section 23

Walk-in is a **job type** (`jobs.posting_kind = 'walkin'`). Its applications are ordinary rows in
`applications`, moved through the existing stage mechanism (`stages`,
`application_stage_history`, `log_stage_change`). This feature extends that mechanism; there is
no second ATS, no walk-in database and no new navigation item.

| Piece | File |
|---|---|
| Schema, stage machine, RLS, definer functions, No Show | `supabase/migrations/0107_walkin_ats.sql` |
| Routes (applicants, details, stages, check-in, notes, ratings, resume, export, history, settings, candidate status) | `api/src/routes/walkin-ats.js` |
| The clock: No Show, reminders, reschedules, recruiter alerts, decision messages | `api/src/notify/walkin-ats.js` |
| Screens (inside Manage Jobs → View Applicants, admin All jobs, candidate My Applications) | `web/teamlink-walkin-ats.js` |
| Small anchored edits | `api/src/app.js` (mount + sweep), `api/src/errors.js` (TLW codes), `api/src/routes/applications.js` (PUT status: version, reason, no auto-message for walk-ins), `api/src/routes/bootstrap.js` (walk-in-only stages kept out of `DATA.stages`), `api/src/shapes.js` (application fields; candidate-level stage equivalents), `api/src/routes/uploads.js` (resume download log), `web/index.html` (one script line) |
| API tests | `api/test/walkin-ats.test.mjs` |
| Browser check | `tools/verify-walkin-ats.mjs` |

## Screens

* **Recruiter → Manage Jobs → "View Applicants"** (any job) opens
  `#/recruiter/manage-jobs?applicants=<jobId>`: dashboard tiles, then tabs **Applicants**,
  **Check-in** (walk-in jobs only) and **Update history**. Opening an applicant is
  `…&app=<applicationId>`; *Back* returns with the search and filters intact (kept per job in
  `sessionStorage`, a per-viewer convenience).
* **Admin → All jobs**: the Applicants count is a link to the same page (`#/admin/jobs?applicants=…`).
* **Candidate → My Applications** (existing screen, minimal change): a walk-in application's rail
  reads *Registered → Attended → Under review → Selected* with neutral banners for *Not selected*
  and *Missed*; while the drive is upcoming it shows the Application ID, date, time, venue,
  address, contact, documents, map link and a **QR code of the Application ID**. The QR code is
  drawn by `qrcode-generator@1.4.4` loaded lazily from `cdn.jsdelivr.net` (the one CDN the CSP
  already allows); if it cannot load, only the ID text is shown. `TLWalkinAts.qrDataUrl(ref)` is
  exposed for the confirmation screen (W1) to reuse.

## 23.21 Deliverables

### New data fields / collections (all in 0107)

| Where | What |
|---|---|
| `jobs` | shared contract with 0106: `walkin_address`, `walkin_map_link`, `walkin_documents`, `walkin_instructions`, `walkin_capacity`; functions `walkin_starts_at()`, `walkin_ends_at()` (IST) |
| `stages.applies_to` | `regular` / `walkin` / `all`. New rows `registered`, `attended`, `interviewed`, `no_show` (`walkin`, `notify_candidate=false`, `candidate_label` Registered / Attended / Under review / **Missed**). `selected`, `rejected` → `all`. Regular stages untouched. |
| `stage_transitions` | the walk-in transition table (below) |
| `applications` | `version` (concurrency), `updated_by`, `checked_in_at/_by`, `attended_at/_by`, `interviewed_at/_by`, `no_show_at`, `application_status` (**generated** from the stage: Active / On hold / Closed — it cannot contradict the stage) |
| `application_stage_history` | `reason`, `source` (recruiter / system / candidate), `is_override`, `action` (applied / stage / checked_in / message_sent). Append-only: an UPDATE by any signed-in identity is refused by a trigger; there is no update/delete grant. |
| `application_notes` | noteId, applicationId, candidateId, jobId, note, createdBy, createdAt, updatedAt (23.11). `candidate_comments` did not fit: it is per candidate and per recruiter, with no job or application. |
| `application_ratings` | one 1–5 rating per recruiter per application (ratedBy, ratedAt); screens show the average |
| `resume_access_log` | every resume view / download: who, role, which application / candidate, file, when |
| `job_update_history` | field, oldValue, newValue, updatedBy, updatedAt for walk-in date / start / end / venue / address / map link / contact person / contact number / capacity / status / paused / archived, plus a `reschedule_notification` row per notification sent |
| `walkin_reschedules` | one pending reschedule per job (quick successive edits merge into it), then sent / partial / failed / cancelled / no_recipients with counts |
| `walkin_ats_messages` | candidate message claims (reminders, reschedule, decision) per channel, with the provider's answer — never twice |
| `ats_recruiter_alerts` | recruiter alert claims (new application, digest, capacity full, walk-in tomorrow, post-drive, reschedule saved) |
| `job_ats_settings` | per job: new-application alerts `auto` (instant; daily digest once the job gets ≥ N a day) / `instant` / `digest` / `off` |
| `walkin_ats_settings` | `no_show_grace_minutes` (60), `high_volume_per_day` (20), `installed_at` |

### Stages and transitions

Regular jobs: the existing stages and free movement, unchanged (a walk-in-only stage is refused).

Walk-in jobs — initial stage **Registered**, set by a `BEFORE INSERT` trigger whoever inserts:

| From | To | Override (reason required) |
|---|---|---|
| Registered | Attended, Rejected, No Show | – |
| Attended | Interviewed, Rejected | – |
| Interviewed | Selected, Rejected | – |
| No Show | Attended | yes |
| Selected | Rejected | yes |
| Rejected | Attended, Interviewed | yes |

Enforced by `walkin_ats_before_update()` on every UPDATE of `applications.stage`, whichever route
makes it (the new endpoints, the existing `PUT /applications/:id/status`, SQL). An automatic
regular-pipeline move nobody asked for (scheduling an interview, an AI interview finishing) is
ignored on a walk-in application instead of breaking that feature; an explicit one is refused.
Applications already on walk-in jobs at Applied / AI Screening / Shortlisted were moved to
Registered by the migration (logged as System); later legacy stages may move to any walk-in stage.

Candidate wording (`candidate_status_label`): Registered, Attended, Under review, Selected,
Not selected, **Missed** (never "No Show").

### How access scope is enforced, and where (23.2)

* **Reads** run as the caller (`withUser`) under the existing RLS: a recruiter sees applications
  of jobs they own (`jobs.recruiter_id`) or applications assigned to them
  (`applications.recruiter_id`); admins see all. Candidate *profiles* stay visible to every
  recruiter (0091, the owner's earlier decision); applications, application resumes, notes and
  ratings follow the application scope.
* **One job** (`/jobs/:id/...`): `ats_job_is_mine()` is checked first — any other job answers
  **404**, by URL or by ID. The list for one job is read by `ats_job_applicant_page()` (definer,
  scope decided once for the job, not row by row).
* **Writes** go through definer functions that check `ats_can_manage()` themselves:
  `ats_move_stage`, `ats_bulk_move`, `ats_check_in`, `walkin_reschedule_request`.
* **Notes / ratings / message ledger / job history**: RLS policies (`ats_can_manage` /
  `ats_job_is_mine`, recruiter or admin only — never candidate, client or BDE). Note edit: author
  only; delete: author or admin (policy).
* **Exports** read through the same scope and are written to `export_audit` first.
* Tested: recruiter B against recruiter A's applicants, details, notes, ratings, stage, check-in,
  export, history, resume and bulk (names of out-of-scope applicants are not even returned).

### How resume access is secured (23.10)

Before this change: resume files were **never public**. Bytes are in object storage (local disk in
development) and served only by `GET /api/files/:key`, which requires a session and re-checks the
candidate row through RLS; `GET /api/candidates/:id/resume` returns a 120-second link (with the local
driver the "signed" link is that same authenticated route; with Supabase Storage a real signed URL).
Two things were weaker than 23.10 asks: no view/download was logged, and since 0091 every recruiter
may open a (non-private) candidate's **profile** resume — that is the owner's shared-candidates
decision and is kept. Also, the application's own resume snapshot path (`applications.resume_path`)
arrives from the browser at apply time.

Now: `GET /api/ats/applications/:id/resume[?download=1]` is an authenticated fetch that serves the
file only to the candidate themselves, a recruiter who manages that application, or an admin
(404 for anybody else, 401 signed out); it uses the snapshot path only when it lies inside that
candidate's own folder; inline only for PDF / JPEG / PNG (`nosniff`, `no-store`), everything else
as an attachment; and every view / download is written to `resume_access_log` **before** the file
is sent. `/api/files/:key` now logs every download too. Exports never contain resume links (file
names only, as before).

### How No Show automation is scheduled (23.16)

`startWalkinAtsSweep()` (Node timer, every `WALKIN_ATS_SWEEP_MS` = 60 s, started with the other
sweeps in `app.js`) calls `walkin_mark_no_shows(grace, now)` as the engine. It moves to No Show
every application still **Registered** with no check-in and no attendance once
`walkin_ends_at(date, to)` (IST) + grace (`WALKIN_NO_SHOW_GRACE_MINUTES`, else
`walkin_ats_settings.no_show_grace_minutes`, default 60) has passed. Idempotent (nothing is left
Registered to move again; one history row each, source System, `changed_by` null); reschedule-aware
(the end time is read from the job as it is now); a drive closed / archived **before** it ended is
treated as cancelled and skipped; drives that ended before 0107 was installed are never swept. No
candidate message is sent for No Show. The same sweep sends the post-drive summary afterwards.

### Reschedules (23.15)

A trigger on `jobs` writes `job_update_history` and, for a walk-in whose date / start / end / venue /
address changed, creates or **merges into** the job's one pending `walkin_reschedules` row (old
details = before the first edit). The sweep sends it once the edits have stopped for
`WALKIN_RESCHEDULE_MERGE_MS` (default 2 min): one combined message per **Registered** applicant
(portal + email + SMS + WhatsApp where configured; quiet hours / opt-outs respected) with Job Title,
Job ID, old and new values, contact person / number and the map link; then a history row and a
recruiter alert ("sent" or "sending failed for N"). Update history shows each notification with
**Send now** (while pending) and **Retry** (failed channels only). Moving the date/time into the
past is refused (`WALKIN_DATE_IN_PAST`) — close the job instead. A failed send never blocks saving.

### Other behaviour

* **Check-in (23.6)**: search by name / mobile / Candidate ID / Application ID; Check In,
  Mark Attended, or both; quick check-in by the Application ID (typed, pasted or scanned from the
  QR). Window = 1 h before start → end; outside it a reason is required and logged. A second
  check-in changes nothing ("Already checked in").
* **Bulk (23.7)**: ≤ 200, every item validated on its own, one history row each, result
  "N updated, M skipped (reason)" with names and Application IDs; one transaction.
* **Concurrency (23.8)**: every save sends the `version` it showed; a stale one gets
  *"This applicant was updated by someone else. Refresh to see the latest."* and nothing is saved
  (new endpoints and the existing `PUT /applications/:id/status`).
* **Reminders (13.2)**: day before (from 10:00 IST) and morning of (from 07:00 IST, until the
  drive ends), Registered only, open jobs only, once per drive date/time.
* **Recruiter alerts (23.17)**: new application (instant, or daily digest at 19:00 IST for busy /
  digest jobs), capacity reached (once per capacity value), walk-in tomorrow (from 18:00 IST the
  day before: registered count, remaining capacity), post-drive summary (after end + grace), reschedule
  sent / failed. In the bell and by email; failures recorded, never blocking.
* **Decision messages (23.18)**: on a Selected / Rejected applicant, *Send Selected / Not selected
  message* opens an editable template; recruiter-triggered only, logged in the timeline. Walk-in
  stage moves never message the candidate by themselves.
* **Export (16 + 23.19)**: Application ID, Candidate ID, Name, Mobile, Email, Job ID, Job Title,
  Job Type, Application Date, Stage, Status, Attended, Rating, Checked-in time, Attended time,
  Interviewed time, Walk-in status, Application Source; *Recruiter notes* only when the
  "include notes" box is ticked. CSV or Excel (existing `xlsx.js`), audited in `export_audit`.
* **Section 14**: closing a walk-in never hides its applicants — the applicant page reads the job
  regardless of status.

### Not done / limits, with the smallest next step

* **Stage id `registered` collides with the prototype's candidate-level "Not applied yet"**
  (`stageBadge('registered')`). The contract fixes the id. Candidate-level stages are mapped to
  regular equivalents in `attachPrimary`, and every walk-in screen draws its own badge, but an
  older screen that calls `stageBadge(app.stage)` for a walk-in application (e.g. Admin → All
  applications) still prints "Not applied yet". Next step: make `stageBadge` take the application
  (or a `kind`) and distinguish the two.
* **Old Walk-in Drives data**: W1 migrates registrations into applications in 0106, which runs
  before the walk-in stages exist; any migrated application at Applied becomes Registered here.
  An ATTENDED / NO_SHOW status from `walkin_registrations` is not carried over (the mapping between
  W1's rows and the old registrations is W1's); next step: after both merge, one UPDATE joining
  `walkin_registrations` to the migrated applications.
* **Application form fields** (current salary, qualification, specialization…) are read from the
  candidate record and `candidate_education`. If W1 stores per-application snapshots elsewhere,
  `APPLICANT_BODY` in `routes/walkin-ats.js` should prefer them.
* The 0091 engagement summary treats No Show as "in process" (its stage list predates it); the
  hold still lapses 30 days after the last activity. Next step: add `no_show` to the "closed"
  branch of `engagement_rows()`.
* The Job Type filter on a single job's page is the job's own type (it matters on the cross-job
  `GET /api/ats/applicants`, which has no screen of its own yet).
