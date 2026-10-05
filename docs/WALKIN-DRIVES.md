# Walk-in drives

A **walk-in drive** is an event: a date, a time window, a venue and a list of
who is coming. Anyone can browse the upcoming drives on the public site;
candidates register (signing up or logging in first when they are signed
out); the recruiter who runs the drive sees who registered, marks attendance
on the day and exports the list; admins manage every recruiter's drives. Registered candidates get a confirmation, a reminder the day
before and on the morning of the drive, and a message if the drive is changed
or cancelled.

## How a drive relates to a walk-in job posting

Walk-in **job postings** already existed (`jobs.posting_kind = 'walkin'`,
migration `0083`: `walkin_date`, `walkin_venue`, `walkin_contact`, ...). That
is an advert, applied to like any job, and it is left exactly as it was.

A drive is its own record (`walkin_drives`) and **may point at a walk-in job
posting** through `job_id`. When a recruiter picks a posting on the create
form, anything they left blank is filled from it: company, skills, salary
(`pay_label`), experience (`exp_label`), qualification (`education`), date
and times (`walkin_date`, `walkin_from`, `walkin_to`), contact person and
phone. Only the recruiter's own postings can be linked. Nothing on the job
side changes when a drive is created, edited or cancelled.

## Company name (what a candidate sees)

A drive carries `company_id`, like a job. A candidate sees that company's name
on the drive card and page **exactly where a candidate job card shows it
today** (`jobCard()` prints `DATA.companyById(job.companyId).name`), so a
drive discloses nothing a job page does not. The company is optional; a drive
without one shows only the role. The word "Client" never appears in anything a
candidate is sent (migration `0051`): the messages say "walk-in drive", the
company's name and nothing about the commercial arrangement.

The **public** drive pages (signed-out visitors, 0103) follow the same rule
as the public job board: `#/jobs` shows every visitor the company's name on a
job card (`companies` is readable by anyone since `0002`), so a public drive
card shows the same name in the same place, and nothing more about the
company.

## Where things are

| Piece | File |
|---|---|
| Tables, RLS, register/cancel functions, seat count, status refresh | `supabase/migrations/0099_walkin_drives.sql` |
| The public (signed-out) view: `walkin_public_drives()` | `supabase/migrations/0103_walkin_public_and_admin.sql` |
| Routes (public + candidate + recruiter/admin) | `api/src/routes/walkin-drives.js` |
| Messages, reminders, the sweep, never-twice claims | `api/src/notify/walkin.js` |
| Candidate pages, recruiter and admin sections, public pages, register-after-sign-in, nav entries, bell links | `web/teamlink-walkin-drives.js` |
| API tests | `api/test/walkin-drives.test.mjs` |
| Browser check | `tools/verify-walkin-drives.mjs` |

## Data

- `walkin_drives` — title, company, linked job, role, description, date,
  start/end time (IST), venue, address, city, Google Maps link (`https://`
  only), salary, experience, qualification, skills, documents to carry,
  contact person and phone, max seats (optional), status
  (`UPCOMING / ONGOING / COMPLETED / CANCELLED`), cancel reason, `version`
  (bumped by an edit a registered candidate needs to know about), owner
  (`created_by_recruiter_id`).
- `walkin_registrations` — one row per **(drive, candidate)** (unique). Status
  `REGISTERED / ATTENDED / NO_SHOW / CANCELLED`. Cancelling and registering
  again reuses the row with a fresh `registered_at`.
- `walkin_notifications` — one row per message per channel, with the
  provider's answer. The unique key `(registration, kind, dedupe_key, channel)`
  is the claim that stops a message going twice.

**Time.** Dates and times are India Standard Time as the recruiter typed
them. `walkin_live_status()` computes the real status from the clock (a drive
whose end time has passed is `COMPLETED` even before the sweep has run); the
sweep (`walkin_refresh_statuses()`, engine only) then stores it.

## Who sees what (row level security)

| | Drives | Registrations |
|---|---|---|
| Signed-out visitor | nothing directly (the policy has no anonymous branch); `UPCOMING`/`ONGOING` drives through `walkin_public_drives()` only, with public-safe columns | none (a seat count only) |
| Candidate | `UPCOMING`/`ONGOING` drives, plus any drive they registered for (so My Registrations can show past and cancelled ones) | their own only |
| Recruiter | the drives they created | the registrations on those drives |
| Admin | all | all |

A candidate never writes a registration row directly. `walkin_register()` and
`walkin_cancel()` (security definer) check the role, lock the drive row, and
refuse a past, cancelled, full or duplicate registration — so two candidates
pressing Register for the last seat at the same moment cannot both get it.
`walkin_drive_registrations()` gives the drive's owner the candidate's name,
phone, email and headline profile (a candidate who registered for a drive has
not necessarily applied to one of the recruiter's jobs, so the candidates
policy alone would hide them). Seats taken are counted by
`walkin_seats_taken()`; candidates see the number, not the people.

## API

Public (anyone; a signed-out visitor included):

| Method | Path | |
|---|---|---|
| GET | `/api/public/walkin-drives?city=&role=&date=YYYY-MM-DD&q=` | Upcoming and ongoing drives, nearest first, plus `cities`. |
| GET | `/api/public/walkin-drives/:id` | One upcoming or ongoing drive; `404` for a past, cancelled or unknown one. |

**What is public, decided once.** Both routes read only
`walkin_public_drives()` (0103, `SECURITY DEFINER`, granted to the API role),
whose column list is the decision, and `shapePublicDrive()` copies those
fields one by one (never a spread of the row): title, company name, role,
description, date and times with their labels, days left, venue, full
address, city, map link, salary, experience, qualification, skills,
documents to carry, max seats, seats taken / left, status.
**Not public:** the contact person and **contact phone** (shown to a
signed-in candidate on the drive page and in every message they are sent; a
public page would hand recruiters' mobile numbers to scrapers), the
recruiter who owns the drive, the linked job id, version, cancel reason, and
any registration or registrant. The answer is the same whoever asks: a
signed-in recruiter gets nothing extra from the public routes.

Registering stays where it was: `POST /api/walkin-drives/:id/register`
needs a signed-in candidate (`401` signed out) and still refuses duplicates,
full, past and cancelled drives.

Candidate (signed in as a candidate):

| Method | Path | |
|---|---|---|
| GET | `/api/walkin-drives?city=&role=&date=YYYY-MM-DD&q=` | Upcoming and ongoing drives, nearest first, each with `daysLeft`, seats, `myRegistration` and `match` (or `null`). Also returns `cities` and the candidate's own city. |
| GET | `/api/walkin-drives/:id` | One drive. |
| GET | `/api/walkin-drives/:id/calendar.ics` | Add to Calendar (iCalendar, UTC times, a 2-hour alarm). |
| POST | `/api/walkin-drives/:id/register` | `201`. `409 WALKIN_ALREADY_REGISTERED`, `409 WALKIN_FULL`, `409 WALKIN_CLOSED` (past or cancelled), `404`. |
| DELETE | `/api/walkin-drives/:id/register` | Cancel. `409 WALKIN_NOT_REGISTERED` when there is nothing to cancel. |
| GET | `/api/my-walkin-registrations` | `{ upcoming, past }` (past includes cancelled registrations and cancelled drives). |

Recruiter (own drives) and admin (all):

| Method | Path | |
|---|---|---|
| GET | `/api/recruiter/walkin-drives?status=&city=&recruiterId=&from=&to=&q=` | Drives with per-status counts, plus the recruiter's jobs (walk-in postings first) and companies for the form. Filters: live `status`, `city` (contains), `recruiterId` (`none` = created by an admin), drive date `from`/`to`, keyword (title, role, venue, city, company). For an **admin** each drive also carries `recruiterId` and `recruiterName`, and the answer adds `recruiters` and `cities` for the filter lists; a recruiter's answer is unchanged (RLS already limits it to their own drives, so the filters cannot widen it). |
| POST | `/api/recruiter/walkin-drives` | Create. Every field validated on the server (zod + table checks): a real date, not in the past, at most a year ahead, end after start, `https://` map link, phone pattern, seats 1–100000, unknown fields refused. |
| GET | `/api/recruiter/walkin-drives/:id` | |
| PUT | `/api/recruiter/walkin-drives/:id` | Edit. Not allowed once `COMPLETED` or `CANCELLED`; seats cannot go below the people already registered. A change to the date, times, venue, address, city, map link, documents, contact, title or role bumps `version` and tells everyone registered (`notified: true`). |
| DELETE | `/api/recruiter/walkin-drives/:id?reason=` | Cancel (the row stays). Everyone registered is told, with the reason. |
| GET | `/api/recruiter/walkin-drives/:id/registrations?q=&status=` | Registrations with name, contact, title, skills, resume present; totals per status. For an admin the drive carries `recruiterName`. |
| PATCH | `/api/recruiter/walkin-drives/:id/registrations/:regId` | `{ status: ATTENDED | NO_SHOW | REGISTERED }` (`REGISTERED` undoes a mark). Only once the drive has started: `409 WALKIN_NOT_STARTED` before. |
| GET | `/api/recruiter/walkin-drives/:id/registrations/export?format=csv|xlsx&q=&status=` | CSV (with BOM; cells that look like formulas are neutralised) or a real `.xlsx` from `api/src/xlsx.js`. Same filters as the screen. |

Another recruiter's drive answers `404`, never `403`, so its existence is not
confirmed.

## AI match %

`api/src/ai/match.js` `matchCandidate()` — the same engine as screening and
alerts — scores the candidate against the drive read as a job (role as title,
skills, experience, city, qualification). The number is shown **only where the
role matches the candidate's profile** (the role score is non-zero, or at least
one skill matches); otherwise the card shows no number rather than a low one
that reads as a verdict.

## Notifications

| When | Kind | Key (what makes it a new message) |
|---|---|---|
| Registered (also re-registered after cancelling) | `registered` | the registration time |
| From 10:00 IST on the day before | `reminder_day_before` | drive date + start time |
| From 07:00 IST on the day, until it ends | `reminder_morning` | drive date + start time |
| A material edit | `updated` | the drive's `version` |
| Cancelled | `cancelled` | — |

- One builder (`buildWalkinMessages`) writes the portal message, the email
  (TeamLink layout), the SMS and the WhatsApp text from the same lines, so they
  cannot disagree: drive, role, date and time, venue, documents to carry,
  contact, map, and the link to the drive page.
- Channels: **portal** (the bell, always), **email** unless opted out,
  **SMS** unless opted out, **WhatsApp** only when opted in *and* an approved
  template is set in Notification Settings. Nothing outside the portal for
  somebody marked do-not-contact. No SMS or WhatsApp between 21:00 and 08:00
  IST (`skipped_quiet_hours`, the email still goes). Channels without
  credentials record `not_configured`. Every outcome is the provider's own
  answer.
- Reminders are not sent to a registration made in the last three hours, nor
  for a cancelled drive or a cancelled registration.
- Confirmation and change messages go out after the database commit, in the
  background (`background()`), never inside the transaction. The sweep also
  sends any confirmation a crash interrupted — the claim table says what went.
- The sweep runs every 10 minutes (`WALKIN_SWEEP_MS`), first after 60 s
  (`WALKIN_FIRST_MS`), started with the other background work in `app.js`.
  Every run is idempotent.
- The bell entry type is `WALKIN_<KIND>#<claim id>` (the existing
  `notifications_dedupe` index is keyed on type + job + application, so a
  per-message type is what lets a second drive's reminder through);
  `metadata.driveId` lets the bell open the drive.
- Four rows are added to Notification Settings (`notification_templates`):
  `walkin_registered`, `walkin_reminder`, `walkin_updated`, `walkin_cancelled`.

## Screens

Candidate — **Walk-in Drives** in the header nav, the profile menu and the
mobile drawer:

- `#/candidate/walkins` — filters (city, role, date, keyword), vertical cards
  with title, company, role, date and time, venue/city, salary, experience,
  seats left, "X days left" / "Happening now", AI match, Register. The city
  starts as the candidate's own when drives exist there. Empty state: "No
  upcoming drives in <city>".
- `#/candidate/walkins?id=<id>` — full details, documents to carry, Open in
  Google Maps (the recruiter's link, or a Maps search for the address),
  contact with a `tel:` link, Register / Cancel registration, Add to Calendar.
- `&done=1` — the confirmation, with Add to Calendar and My Registrations.
- `#/candidate/walkins?tab=mine` — My Registrations: upcoming, then past and
  cancelled.

Recruiter — **Walk-in Drives** in the sidebar (`#/recruiter/walkins`): the
drive list with counts, create / edit / cancel, and per drive the
registrations table with search, status filter, Attended / No-show / Undo,
and Export CSV / Excel.

Admin — **Walk-in Drives** in the admin sidebar (`#/admin/walkins`): every
recruiter's drives with totals (drives, upcoming or running, registrations,
attended), filters for status, city, recruiter (or "Created by an admin"),
date from / to and keyword, and a Recruiter column. Registrations, Edit and
Cancel are the recruiter screens and API, unchanged: an admin's edit or
cancel sends registered candidates the same messages as the recruiter's
(the drive keeps its owner). `#/admin/walkins?id=<id>` is the registrations
screen (search, status filter, attendance, CSV / Excel), headed "Run by
<recruiter>". Admins do not create drives from this screen (a drive belongs
to the recruiter who runs it).

Public (signed out) — **Walk-ins** in the site header (shown on screens
1280 px and wider, where the header has room) and a **Walk-in Drives**
entry under "Find your next role" on the home and `#/jobs` pages (every
width, phones included):

- `#/walkins` — the same filters (city, role, date, keyword) and cards as the
  candidate list, without a match % or registration badge, and a note that
  registering needs a free candidate profile.
- `#/walkins?id=<id>` — details: venue, address, map, documents, skills,
  seats. The contact card says the recruiter's contact is shown once you
  register.
- **Register while signed out** (same pattern as `teamlink-apply-auth.js`
  for jobs): the drive id is remembered in `sessionStorage`
  (`tl_walkin_intent_v1`, this tab only, at most an hour; never a copy of
  the drive, and any job application waiting for sign-in is dropped), and
  the visitor goes to the registration form, headed **"You're registering
  for: <drive> · <company> · <date> · <city>"** with *Log in to register* and
  **Cancel** (Cancel forgets it and returns to the drive). It survives a
  refresh, a refused registration and a wrong password. When registration
  or login finishes (the hand-off to the candidate dashboard), the module
  calls `POST /api/walkin-drives/:id/register` with the new session and
  opens `#/candidate/walkins?id=<id>&done=1` (the usual confirmation and
  Add to Calendar). A refusal (full, closed, already registered) is the
  server's message on that drive's page. Wandering off to an unrelated page
  while signed out forgets the drive.
- A signed-in candidate who opens `#/walkins…` is taken to the matching
  `#/candidate/walkins…` page (their registration, match and contact).

## Not done / limits

- Phone (push) notifications are not used for drives; the spec named mail,
  SMS and WhatsApp.
- The public pages are client-rendered (`#/walkins`), like the rest of the
  portal; there is no server-rendered share page or sitemap entry for a drive.
- Below 1280 px the header has no room for a fourth link, so the header
  "Walk-ins" link is hidden there; the Find Jobs / home entry is always shown.
- Admins manage but do not create drives (see Screens).
