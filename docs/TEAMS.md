# Teams, who sees whose work, and the contact cooldown (0118)

Three things, one migration (`supabase/migrations/0118_teams_scope_contact_cooldown.sql`),
because each needs the others.

| Piece | Where |
|---|---|
| Schema, scope helpers, policies, admin functions, the contact gate | `0118_teams_scope_contact_cooldown.sql` |
| Admin and team lead routes | `api/src/routes/teams.js` |
| The one door for contacting a candidate | `api/src/contact/service.js` |
| 403 for "exists, not yours" | `api/src/scope.js` |
| Admin **Teams** page and team lead **My Team** page | `web/teamlink-teams.js` |
| Cooldown badge, override box, Find Candidates job bar | `web/teamlink-shared-candidates.js` |
| Server tests | `api/test/teams.test.mjs` (29) |
| Browser check | `tools/verify-teams.mjs` |

## 1. Roles and teams

There are three roles: **Admin**, **Team Lead (TL)** and **Recruiter**. A TL is a
recruiter with `recruiters.is_team_lead = true`. The portal already treated "Team
Lead" as a flavour of recruiter (`recruiters.recruiter_role` held that free text),
and every recruiter route, policy and session works for a recruiter, so a second
login role would only have forked them. `app_is_tl()` answers it in the database;
`req.session.isTeamLead` carries it to the API and `/api/bootstrap` to the page.
The migration sets the flag once for the recruiters whose `recruiter_role` already
said "Team Lead", "Team Leader" or "TL"; an admin can clear it.

A recruiter belongs to **at most one TL and one department at a time**:
`recruiter_assignment_history` has one row per assignment, the current one has
`ended_at is null`, and a partial unique index makes a second current row
impossible. Reassigning ends one row and starts another. Removing ends the row.
Nothing else changes: jobs, applications, candidates, contacts, interviews and
offers keep their original `recruiter_id`. Visibility follows the **current**
assignment; history shows the rest (`GET /api/admin/recruiters/:id/assignments`).

Rules (all in `staff_assign_recruiter`, so they hold for any caller):
the person assigned must not be a TL; the TL must be one; both must be active;
the department defaults to the TL's and, when the TL has one, must equal it.
A TL with recruiters cannot stop being a TL until they are reassigned.

## 2. Who sees what

| | own jobs | team's jobs | other teams' | all |
|---|---|---|---|---|
| Recruiter | yes | no | no | no |
| TL | yes | yes (current team) | no | no |
| Admin | yes | yes | yes | yes |

This is in the policies, not the screens. `app_recruiter_in_scope(recruiter_id)` and
`app_job_in_scope(job_id)` (SECURITY DEFINER, so the policies can read what they
govern) decide, and these policies use them: `jobs`, `applications`, `interviews`,
`offers`, `ai_interviews`, `application_events`, `ai_call_sessions` (turns and
events follow), `ai_call_campaigns`, `job_view_daily`, `candidate_contact_history`.
Before 0118 a recruiter read every open job on the board and every interview,
offer and AI interview of their company; neither is true now. The public board for
candidates and visitors is unchanged.

Because the policies decide, every list, count, search, export and dropdown the API
builds from those tables is already scoped. A recruiter's job dropdowns hold their
own jobs; a TL's hold the team's.

**Jobs are posted as the session.** The owner is the signed-in recruiter; a
`recruiterId` in the request is ignored, and the insert policy refuses any other.

**Direct IDs.** A job, application or recruiter that exists and is not yours is
**403** with nothing from the record in the answer; one that does not exist is 404
(`app_row_exists` answers yes/no for staff; `scope.js` turns it into the error).
This covers `GET/PUT /jobs/:id`, publish, screening questions, applications
(status, history, screen, notifications), the walk-in ATS, and team routes.
Candidates and visitors still get 404.

**Candidates are shared** and are not narrowed by team or department. What follows
a team is the job, the application and the contact log.

## 3. Admin: Teams

`#/admin/teams` (sidebar **Teams**): the Candidate Contact Cooldown setting; team
leads with their recruiters (expand / collapse); search by TL, recruiter, email or
phone; filters for department, TL and status; per recruiter an editable login email
and department, an Activate / Deactivate button, a team lead selector, Remove from
team, Make team lead and Assignment history. Recruiters not on a team are listed
below.

**Email change** (`PATCH /api/admin/recruiters/:id {email}`) is one function,
`staff_recruiter_email_change`: format check; unique case-insensitively across every
account (409 `EMAIL_TAKEN`, and `users_email_lower_key` holds it whatever the route
does); updates the sign-in record and the recruiter record; **deletes the
recruiter's sessions** (the old address stops working at once) and retires unused
password-reset links; audits `RECRUITER_EMAIL_CHANGED` with old and new email.
Notifications, password reset and portal emails read the same address.

**Status.** `staff_recruiter_status` (0035) now also deletes sessions when it turns
a login off, so re-activating the account does not bring an old session back.
Deactivating keeps every record and the assignment row.

**Audit** (`audit_log`, admin-readable): `RECRUITER_ASSIGNED`, `RECRUITER_REASSIGNED`,
`RECRUITER_UNASSIGNED`, `RECRUITER_DEPARTMENT_CHANGED`, `RECRUITER_EMAIL_CHANGED`,
`RECRUITER_STATUS_CHANGED`, `TL_ROLE_CHANGED`, `CONTACT_COOLDOWN_OVERRIDDEN`,
`CONTACT_COOLDOWN_CHANGED`. Each carries who, old and new values and the reason.

## 4. Team lead: My Team

`#/recruiter/team`, in the menu of a TL only (a recruiter who opens it sees a
refusal, and the API answers 403).

* **Cards:** Total Recruiters (the current team), Total Jobs (posted in the range),
  Total Applied (applications received in the range on the team's jobs), Candidates
  Contacted (distinct candidates the team contacted in the range).
* **Range:** Today / 7 Days / 30 Days / Custom (dates in India time, inclusive).
  The recruiter count is the current team whatever the range.
* **My Recruiters:** name, email (`mailto:`), phone (`tel:`), department, status,
  jobs posted, candidates contacted, total applied, last contacted.
* A recruiter expands to their jobs (Job ID, title, status, posted date,
  applications; a job links to its normal page; the applications number opens the
  applicants) and their contact activity.

Every figure is a database aggregate (`GET /api/team/summary`,
`/team/recruiters/:id`, `/team/recruiters/:id/jobs/:jobId/applicants`) over rows the
caller's policies allow *and* the caller's current team. A recruiter of another team
is 403; one that does not exist is 404. The TL's own jobs are not part of the team's
totals; they are on the normal Jobs pages.

## 5. Find Candidates: the chosen job

The candidate list is not narrowed. The screen gets a **Selected job** menu (the
caller's own jobs) and, once one is chosen, **Applied for this job: Any / Yes / No**.
`GET /api/candidates?forJob=<id>&appliedForJob=yes|no` marks every row
`appliedForJob` from the real applications and narrows the list for Yes / No. The job
must be one the caller may use (403 otherwise, 404 if unknown).

## 6. The contact cooldown

A candidate contacted by one recruiter is not contacted by another, on any channel
and for any job, for **N days** (admin setting `app_settings.contact_cooldown`,
default **7**, 1 to 90; changing it moves future checks only). Every row is judged
on its own timestamp, not on calendar dates.

* The holder is the **latest** contact inside the window, if somebody else made it
  (`contact_holder`). A recruiter's own earlier contact never holds them back, so
  a follow-up is always allowed, and **every** contact is logged.
* A contact that failed to go out (`outcome = 'failed'`) stops holding anybody.
* **Override:** an admin or a TL, with a reason of at least five characters, which is
  recorded on the row (`override_used`, `override_by`, `override_reason`) and audited.
  A recruiter's attempt is 403. After an override the overrider's row is the latest,
  so they are not asked again for the next message. A TL cannot use a job outside
  their team to contact (403).
* Channels are stored as `phone` (Call), `whatsapp`, `email`, `sms`, `ai_call`, in
  the existing `candidate_contact_history` (no parallel table). There is one
  cooldown, not one per channel.

**The door** is `contact_begin` (SQL), called through `contact/service.js`. In one
transaction it takes a lock on the candidate (`pg_advisory_xact_lock`), checks the
cooldown, checks the override, and writes the log row; the send comes after.
Two recruiters pressing Send at once: the second waits for the lock, then sees the
first one's row and is refused (tested). `contact_begin_many` judges each candidate
alone, in id order, so a held one never stops the rest.

Where it is wired:

| Contact | How |
|---|---|
| Bulk WhatsApp / email / SMS (server queue) | `contact_begin` per candidate before queueing; held ones come back as `cooldownCandidates` (who, date, time, channel); `override` + `overrideReason` for a TL or admin |
| AI call and AI campaign | `contact_begin` before `queueCall`; a campaign skips held candidates and reports them |
| Find Candidates / Talent Pool WhatsApp, email, SMS | `/engagement/check` with `record` is the gate and the log row; `/engagement/record` then adds how it went (`contactId`) |
| Call (tel:) | checked at the dial; logged by **Log call** |

The role holds of 0091 (another recruiter is *processing* them for a role; a
placement's replacement period) are unchanged and are checked first, in their own
words.

**What the server cannot stop:** WhatsApp, the mail client and SMS from a recruiter's
own browser or phone leave on their device. The server refuses to check and log
them (and the screen says so), but cannot stop the device; and a phone call is
logged when **Log call** is saved. Everything the server sends itself cannot leave
without passing the door.

**Not gated:** the "send login" invitation to a new candidate (`/candidates/:id/invite`)
is logged as a contact but not held by the cooldown; system messages about an
application (stage changes, interview invitations) are not recruiter outreach.

## 7. Checks

```
npm --prefix api test                                   # includes api/test/teams.test.mjs
TL_URL=http://127.0.0.1:4424/ node tools/verify-teams.mjs   # an isolated instance; refuses :4323
```

`teams.test.mjs` covers: team building and its rules, 403 for non-admins, the job
visibility matrix, search and counts, direct IDs, applications, My Team aggregates,
the email change (old address and old session rejected, audited, case-insensitive
conflict), deactivation, the cooldown (block, follow-up, override with and without a
reason, a recruiter's override refused, admin override, the setting, expiry on the
real timestamp, a failed send, a race, bulk), Find Candidates' job flag and filter,
reassignment (history kept, nothing deleted) and removal.
