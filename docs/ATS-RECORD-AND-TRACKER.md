# Application tracker, candidate dashboard and the ATS candidate record (0111)

Owner's production spec sections 25, 26, 32, 33, 35–39, 43, 44, 46, 48, 50, 51, 52, 53.
Migration `supabase/migrations/0111_tracker_ats_record_audit.sql`, API `api/src/routes/ats-record.js`,
screens `web/teamlink-dashboard-ats.js`, tests `api/test/ats-record.test.mjs` and
`tools/verify-y2-dashboard-ats.mjs`.

Nothing here adds a page or a nav item. Everything is drawn inside the existing Candidate Home,
My Applications, Interviews, the recruiter's candidate profile, and Admin → Reports / Analytics.

## The tracker (25) — one stage column, a second name for groups of it

`stages.tracker_phase` maps every pipeline stage onto `tracker_phases`:

| phase | candidate reads | rail step | stages |
|---|---|---|---|
| applied | Applied | Applied | applied, registered (walk-in) |
| under_review | Under Review | HR Review | ai_screening, with_bde, client_review |
| shortlisted | Shortlisted | Shortlisted | shortlisted |
| interview | Interview | Interview | ai_interview_*, interview_scheduled, client_interview, attended, interviewed, no_show |
| offer | Offer | Offer | offer_extended, selected |
| hired | Hired | Hired | joined |
| rejected | Rejected | (off the rail) | rejected |
| hold | On Hold | (off the rail) | hold |

A stage added later without a phase reads as Under Review. No phase label contains "Client"
(0051); the detailed stage wording still comes from `stage_label(stage, 'candidate')`.

Decision to note: the owner's spec lists **Hold** as a tracker state, so the tracker shows
"On Hold". The existing detailed rail on My Applications (`tlCandidateStage`, 0042) still hides
Hold and With BDE, and Hold still sends the candidate no message (`notify_candidate = false`).

## Dashboard (32) and history (46)

`GET /api/candidate/dashboard` — `counts` {applications, shortlisted (current phase shortlisted,
interview, offer or hired), interviews (upcoming), savedJobs, profileStrength}, the tracker,
three recent applications, three upcoming interviews, unread + latest notifications.
Only TeamLink jobs (`jobs` / `applications`) are counted; external jobs are never mixed in.

`GET /api/candidate/applications/history?q=&phase=&page=&pageSize=` — Job Title, Company,
Application ID (TL-APP-…), Applied Date, Job Type, Current Status, next Interview, Last Updated.
My Applications searches it (debounced, 300 ms) and pages it (10 a page).

Profile Strength is computed on the server by `api/src/candidates/profile-score.js`, the same
twelve sections as the candidate's screen (`teamlink-profile-sections.js`); a test runs both on
the same input.

## Interviews (26)

`GET /api/candidate/interviews/schedule` — interviews plus walk-in interviews (a walk-in
application IS the interview: date, time and venue from the job). Mode: Walk-in / Online /
Phone / Hybrid / In person (`interview_mode_label`). State: Scheduled / Rescheduled / Completed /
Cancelled (No Show reads "Missed") from `interview_state(status, reschedule_count)`.
`reschedule_count` and `rescheduled_at` are set by a trigger when the date or time moves;
`completed_at` / `cancelled_at` when the status changes. The candidate is never handed the score,
the feedback or the interviewer's notes, and cannot change an interview (403).

## ATS candidate record (35), matching (48), timeline (37)

`GET /api/ats/candidates/:id/record` (recruiter, BDE, admin; RLS decides what they see):
Candidate ID (TL-CAN-…), name, email, mobile, profile score, resume score (0094), current stage
(the open application that moved last), source, last updated, skills, experience, applications,
interview history, assessments, referral, and the timeline.

Matching per application: Resume Score, Profile Score, Eligibility (Not eligible = a screening
knock-out; Check = experience well outside the band, or a different city with no relocation),
Match Score (the stored `match_score`). **Nothing rejects on a score.** The AI screen only ever
shortlists (`ai/screening.js`); the only automatic rejection in the product is the screening
knock-out, which runs only on jobs whose recruiter switched `auto_reject_knockouts` on (0097).

Timeline, newest first, from real rows only: Registered (candidates.created_at), Profile Updated
(audit log, edits within ten minutes merged), Resume Uploaded/Replaced, Applied, every stage move
(Shortlisted, Rejected, On Hold, Offer Released, Selected, Hired…), Interview Scheduled /
Rescheduled / Completed / Cancelled, offers.

## Source tracking (36)

The 0075 vocabulary gains Direct Registration, Referral, LinkedIn, Naukri, Indeed, Shine,
External Jobs, TeamLink Website, Walk-in Application (old values stay valid). Self-registration
is recorded as Direct Registration at insert. `applications.source_channel` is set when the
application arrives: Walk-in Application for a walk-in job, External Jobs, Referral (a referred
candidate), TeamLink Website for portal applications, otherwise the canonical value of the
application's own source. The original candidate source still never changes silently.

## Referrals (38) — optional

A candidate can ask for their link (Home → "Refer a friend (optional)"; the code is only created
when asked). Somebody who registers through `?ref=CODE` is recorded once, within 14 days of
registering, never against their own code. The referrer sees only the date and status, never the
person. Status follows the referred person: registered → applied → hired. Staff can record a
referral on the ATS record and an optional reward (amount + none/pending/approved/paid/declined).
Nothing anywhere requires a referral.

## Assessments (33) — extension point only

No assessment engine exists and none is built. `candidate_assessments` holds a result from a
test taken elsewhere (name, category Java/Python/Aptitude/Communication/Technical/Other, score,
max score, date, status, provider, external ref). Staff record and edit them
(`POST /api/ats/candidates/:id/assessments`, `PUT /api/ats/assessments/:id`); the candidate reads
their own (`GET /api/candidate/assessments`) and can never write. Recruiter filter hook:
`GET /api/candidates?assessment=<name or category>&assessmentMin=<percent>`. An assessment
platform integration would write into this table.

## Admin audit log (39)

`audit_log` (written only by definer triggers; admins read) records candidate created / updated
(field names only) / deleted, resume uploaded / changed, document uploaded / updated / deleted,
application submitted / updated, interview scheduled / rescheduled / status changed.
`admin_audit_events` adds the trails that already existed instead of copying them: status changes
(`application_stage_history`), source changes (`candidate_activity`), client logins (`staff_audit`).
`GET /api/admin/audit-log?action=&entity=&entityId=&q=&page=` — Admin → Reports.

## Analytics (43/44)

`GET /api/admin/portal-analytics?days=` — counts only, no names or contact details. Candidates
(registrations, added by staff, resume uploads, applications, profile-completion average and
buckets), jobs (views, applications, view→apply conversion over viewed jobs), the same by job type
(Regular / Walk-in: views, applications, conversion, attended, selections, selection rate), walk-in
(interview registrations, attendance, no-shows, selections), applications by source, top jobs.
Job views are `job_view_daily` (job, IST day, count) from `POST /api/jobs/:id/view`, sent once per
job per browser tab when a job page opens. Admin → Analytics.

## Data model (50)

`application_records` (security-invoker view): Application ID + reference, Candidate ID + code,
Job ID, Company ID, Job Type, Source, Applied Date, Current Stage, tracker phase, Status.

## HRMS hand-off (51) — extension point, no HRMS

There is no HRMS or employee system in this project, and none was invented. When an application
reaches **Selected** or **Joined**, a trigger queues a row in `employee_handoffs`
(status `pending`); moving it to Rejected cancels a pending one. No personal data is copied into
the queue: `employee_handoff_payload_v` maps it from the ATS record at read time (candidate code,
name, email, phone, location, job, company, employment type, offer CTC, joining date, offer status).
Admin → Reports shows the queue; `GET /api/admin/employee-handoffs` returns it with
`hrmsConfigured: false`. **Nothing reads the queue and nothing is sent.**

To connect an HRMS later: a worker reads `employee_handoff_payload_v where status = 'pending'`,
creates the employee in the HRMS, then sets `status = 'sent'`, `target` (the system) and
`external_ref` (its employee id), and `acknowledged` when the HRMS confirms. Decide first whether
every placement or only TeamLink's own hires go (filter on `company_id`).

## Responsive and performance (52/53)

Count tiles go to two columns under 900 px; every new table sits in `.tbl-wrap`; forms stack on
phones. Lists the user can grow are paged on the server (history 10/page, audit log 25/page,
timeline 15 then +30); searches are debounced; each screen reuses one cached request per view
(15 s) instead of fetching per widget.
