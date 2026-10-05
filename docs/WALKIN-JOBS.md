# Walk-in jobs and the application form (0106)

**Walk-in is a job type, not a section.** A walk-in interview is a job
(`jobs.posting_kind = 'walkin'`) in the same Jobs section, on the same card,
found by the same search, applied to through the same Apply Now. There is no
separate walk-in page, navigation item or database. The old Walk-in Drives
module was retired into this (see [WALKIN-DRIVES.md](WALKIN-DRIVES.md)).

The recruiter side of walk-ins — the walk-in stage machine (Registered →
Attended → Interviewed → Selected / Rejected / No Show), check-in, bulk
updates, notes, ratings, reminders, reschedule messages, exports — is
Section 23 (migration `0107`, agent W2) and is not described here.

## Where things are

| Piece | File |
|---|---|
| Columns, IST end-time rule, listing rule, capacity lock, identity checks, form details, identity reviews, cancellation outbox, drive move | `supabase/migrations/0106_walkin_job_type.sql` |
| The job shape (`jobType`, `walkin*`, `walkinStatus`) | `api/src/shapes.js` `toJob()` / `walkinShape()` |
| Walk-in rules on save, message facts, IST helpers | `api/src/portal/walkin-jobs.js` |
| Job routes calling them | `api/src/routes/jobs.js` (POST / PUT) |
| The application form route | `api/src/routes/apply-form.js` |
| Duplicate + capacity at save time | `api/src/routes/applications.js` (POST) |
| Confirmation with walk-in details | `api/src/notify/templates.js` `buildMessages()`, `api/src/notify/messages.js` `APPLICATION_SUBMITTED`, `events.js`, `dispatch.js` |
| Cancellation notice, the drive move at boot | `api/src/notify/walkin-jobs.js` |
| Quick filter chips (Walk-in today / this week, Internship) | `api/src/portal/core.js` `QUICK_CHIPS`, `CHIP_SQL` |
| Everything in the browser | `web/teamlink-walkin-jobs.js` |
| API tests | `api/test/walkin-jobs.test.mjs` |
| Browser check | `tools/verify-walkin-jobs.mjs` (helper for other scripts: `tools/lib/apply-form.mjs`) |

## Data

`jobs` (0083 + 0106, the shared contract with 0107):

| Column | Job shape | |
|---|---|---|
| `posting_kind` | `jobType` | `'walk-in'` when `walkin`, `'internship'`, else `'regular'` (every job saved before job types existed is Regular) |
| `walkin_date` | `walkinDate` | `YYYY-MM-DD`, IST |
| `walkin_from` / `walkin_to` | `walkinStartTime` / `walkinEndTime` (and the older `walkinFrom` / `walkinTo`) | `HH:MM`, IST |
| `walkin_venue` | `walkinVenue` | |
| `walkin_address` | `walkinAddress` | new |
| `walkin_map_link` | `walkinMapLink` | `https://` only |
| `walkin_contact` / `walkin_phone` | `walkinContactPerson` / `walkinContactNumber` (and `walkinContact` / `walkinPhone`) | |
| `walkin_documents` | `walkinDocumentsToCarry` | one item per line |
| `walkin_instructions` | `walkinInstructions` | |
| `walkin_capacity` | `walkinSlotCapacity` | optional; null = no limit |
| — | `walkinStatus` | `open` / `closed`, **derived at read time**: closed once the date and end time have passed in IST, or when the job is not open. No cron. Reopening = editing the date. |
| — | `walkinRegistered`, `walkinSlotsLeft`, `walkinFull` | only when a capacity is set; counted by `walkin_registered_count()` (a candidate's own RLS would count only themselves) |

`walkin_starts_at(date, from)` / `walkin_ends_at(date, to)` give the IST
instants. A date that is not a calendar date (typed as free text by an older
form) has no end and is never closed by the clock.

`application_form_details` — what the candidate typed, one row per
application (job type, name, mobile, email, current / preferred location,
qualification, specialization, years of experience, current / expected
salary, notice period, resume file name). Readable by whoever can read the
application (RLS through `applications`). Written by
`application_form_save()`.

`candidate_identity_reviews` — the typed mobile and email point at
different candidate records. Never merged; a recruiter (who can see the
application) or an admin reads them at
`GET /api/candidate-identity-reviews?applicationId=&status=open`.
Candidates never read this table.

`walkin_job_outbox` / `walkin_job_notices` — the cancellation notice: one
outbox row per early closing (trigger `walkin_job_close_watch`), one claimed
row per (outbox, application, channel).

## Rules (all enforced on the server)

**Saving a walk-in job** (`checkWalkin()`, every way a job is saved):
a real calendar date, `HH:MM` times, end after start, a valid 10-digit contact
number, an `https://` map link, a whole-number capacity. When it is published
and new or its details were edited: date, start, end, venue, full address,
contact person and number are required, and the date / end time may not
already be past. Closing, pausing or relabelling an older walk-in is not held
to rules it predates. Capacity can never go below the people already
registered. A draft (a clone) may keep an old date until it is published.

**Listing**: `jobs_open` (the candidate / public board) leaves out a walk-in
whose end has passed. The job page still opens and says **Closed** with Apply
disabled. Staff screens read `jobs` / `jobs_with_counts`, so recruiters and
admins keep seeing closed walk-ins and their applicants.

**Applying** — `POST /api/applications/form` (signed-in candidate only):

1. honeypot (`website`), per-IP limit (`APPLY_FORM_IP_PER_10MIN`, default 40
   per 10 min), per typed mobile / email limit (`APPLY_FORM_CONTACT_PER_HOUR`,
   default 20) — plus the existing 30 an hour per candidate (0095);
2. every field: name, a 10-digit Indian mobile, email, current location,
   highest qualification, years of experience, notice period; a resume on
   file (the form uploads it first through `POST /api/uploads/resume` with
   `purpose=apply`: PDF / DOC / DOCX only, 5 MB, bytes checked against the
   name, so a renamed executable is refused);
3. the typed mobile and email (`apply_identity_check()`, counts only — no
   other candidate's id or details leave): both belong to one other account →
   `409 IDENTITY_OTHER_ACCOUNT`, "log in with that account"; they point at
   different people → the application is saved against the signed-in
   candidate and a review is opened;
4. handed on to the ordinary `POST /api/applications`: last date, hourly limit,
   **duplicate** (`409 DUPLICATE_APPLICATION` "You have already applied for
   this position." with `details.applicationId` = the existing TL-APP id),
   **walk-in closed / full** decided under a row lock on the job
   (`walkin_apply_check()`: `409 JOB_UNAVAILABLE` / `409 WALKIN_FULL`
   "Registrations full"), screening answers, the application, notifications,
   AI screening — exactly once;
5. after it exists: the form is stored, and the profile is updated with the
   **non-empty** values only (an empty box never wipes a saved value; another
   person's mobile is never copied onto this profile; the login email is not
   changed, only filled when the profile has none).

The Application ID is the existing reference `TL-APP-YYYY-NNNNN` (0019). The
application stores `posting_type` (`walkin` / `job` / `internship`) and its
date; its first stage comes from 0107 (`registered` for a walk-in).

**Messages**: the confirmation (interview invitation, or Application Received
when that was not sent) now carries the Application ID and, for a walk-in,
date, time, venue, address, map link, documents to carry, contact and
instructions — the company is not added to any walk-in line. A walk-in
closed early (status closed / draft or archived, before its end) tells
everyone who applied and was not rejected: portal, email, SMS, WhatsApp
(opt-in, approved template), once; SMS and WhatsApp wait for the end of
quiet hours (21:00–08:00 IST) rather than being dropped. Every outcome is
recorded with the provider's answer.

**Share** (Section 15) is not part of this change: the lead owns the share
message (`api/src/portal/core.js` `shareText()`), which reads the walk-in
columns above by these exact names.

## In the browser (`web/teamlink-walkin-jobs.js`)

- **Cards** (home / Find Jobs rows, Search Jobs, candidate home): a
  `🚶 Walk-in Interview` badge (`badge badge-brand`) and Date / Time / Venue
  lines; Closed / Registrations full disable Apply. Regular cards unchanged.
- **Job page**: a Walk-in Interview panel with every detail and View on Map.
- **Apply Now** on any TeamLink job (`applyToJob`, `easyApply`, `capApply`,
  `cpEasyApply`) opens **one** form in the portal's modal (`fcrModal`):
  company, job title, ID and type read-only; the walk-in block for walk-ins;
  prefilled from the profile — when the profile already has everything, a
  summary and only the missing fields (one-click), with "Edit my details";
  resume on file with Replace; the job's screening questions as a section of
  the same form (`TLScreening.questionsFor` / `mountForm`); the resume-score
  tip as one line; a draft per candidate + job on this device
  (`tl_apply_draft_v1:*`, text only, kept out of `/api/prefs`), restored after
  a refresh and cleared on success; one submission at a time (double clicks and
  Enter ignored); every refusal shown in the form with the data kept. Success:
  the Application ID, and for a walk-in the details, View on Map, Add to
  Calendar (`.ics`) and Google Calendar. Already applied: "You have already
  applied for this position." with the ID. External jobs keep their own flow.
  Signed out: register / log in (teamlink-apply-auth.js), then the same job's
  form opens.
- **Listing**: a finished walk-in leaves the candidates' default lists
  (`DATA.openJobs`), staff keep it.
- **Recruiter**: Job Type (Regular / Walk-in) on AI Job Creation and Edit job,
  the walk-in fields with the server's rules; Post A Walk-in Job brought up
  to the same fields (calendar date, real times, full address, map,
  documents, instructions, capacity); **Clone** on the Jobs table (the
  existing Copy: a new Job ID, a draft, then its editor opens).
- **Filters**: the existing Walk-in chip, plus Walk-in today, Walk-in this
  week and Internship chips; the existing Job Type / Education / Company
  sidebar filters already cover the rest.

## Not here / known limits

- Admins have a job list but no job form in this portal, so Job Type and
  Clone are on the recruiter's screens only (an admin can still change a job
  through `PUT /api/jobs/:id`).
- `POST /api/jobs/:id/publish` does not re-check the walk-in date (the
  ordinary save does); a walk-in published with a past date reads as Closed
  at once.
- One-click apply's 10-second Undo is not offered after the form: the form is
  a deliberate submit and its messages go out at once.
