# Shared candidates and "Already contacted"

Migration `0091_shared_candidates.sql`, API `api/src/routes/shared-candidates.js` and
`api/src/candidates/engagement.js`, UI `web/teamlink-shared-candidates.js` (plus the bulk
message compose box in `web/teamlink-bulk-message.js`).

## What changed

Until 0091 a recruiter saw only the candidates they added and the ones who applied to their
own jobs (0031). Now **every recruiter (and BDE) sees every candidate in TeamLink** — profile,
resume, skills, contact details — except candidates marked private. **Applications stay
private to the job's recruiter**: stages, screening, interviews, offers, AI scores and stage
notes are exactly as before. No applications policy was changed.

To stop two recruiters working the same person for the same role, every engagement is
recorded and checked:

| Situation (same candidate, same role) | What another recruiter gets |
|---|---|
| Holder only **contacted** them (call / message / interested) | **Warning**. "Contact anyway" continues and is logged. |
| Holder has them **in process** (applied → offered, incl. interview) | **Blocked**: call, WhatsApp, SMS, email, add-to-job, submission. Only "Message &lt;holder&gt;" and "Request admin override". |
| They **joined** through TeamLink in the last 90 days | **Blocked for every role** (replacement period). The placing recruiter is blocked for other roles too. |
| A **different** role | Allowed. An info badge only. |
| Same client, same role, **second submission** | **Always blocked**, even for the same recruiter. Admin override with a reason, logged. |

* **Role** = the job title normalised by `app_role_key(title, department)`: lower case,
  punctuation and seniority words removed (senior, junior, sr, jr, lead, trainee, associate,
  executive, i, ii, iii). "Senior Medical Coder" = "Sr. Medical Coder II" = "medical coder";
  "Medical Representative" is a different role.
* **Holder** = the recruiter with the most recent contacted / in-process activity for that
  candidate and role (a joining in the last 90 days holds every role).
* **Hold ends** 30 days after the last activity if nothing new happens, at once when the
  engagement closes (rejected, not interested, wrong number), and 90 days after a joining.
* A recruiter with their own live application for the role (e.g. the candidate applied to
  their job) is not blocked by somebody else's hold; the admin Conflicts view shows it.
* With no job/role chosen (a message that names no role), the strongest active engagement of
  any other recruiter decides. Choosing the role narrows the check to that role.

## Visibility

"Own recruiter" = the recruiter who added the candidate, or whose job they applied to.

| What | Own recruiter | Other recruiter | Admin |
|---|---|---|---|
| Candidate profile, resume | read + edit | read only | all |
| Job applications, stages, scores, interviews | yes | no | all |
| Private notes (comments) | yes | no | all |
| Team notes (comments marked "team") | yes | read | all |
| Notes typed on the add form (recruiter notes, internal remarks) | yes | no | all |
| Messages sent (Communication panel) | yes | only the ones they sent | all |
| Contact summary (who, which role, when, channel, outcome, level) | yes | yes | all |
| Same role, only contacted | – | warning, may continue | all |
| Same role, in process | – | blocked, may ask for an override | all |
| Different role | – | allowed | all |
| Private candidate | yes | hidden | all |

Clients and candidates see nothing new. The client rule (their own pipeline at client-visible
stages) and the "candidate never sees the client" rule (0051) are untouched.

## Where it is enforced

The database is the rule; the screens only say it sooner.

* `candidates_read` — non-private candidates readable by every recruiter.
* `candidates_self_write` — unchanged in effect. The 0031 branch "a recruiter may edit a
  candidate with no owner" is removed: it was only ever reachable for a candidate who had
  applied to that recruiter's job (still allowed through `app_candidate_is_mine`), and with
  everybody visible it would have let every recruiter edit every self-registered candidate.
  The education / experience / documents write policies, `candidate_records_replace` and
  `candidate_source_set` ask the same question (`app_candidate_editable`).
* `candidate_contact_history`, `message_logs` — a recruiter reads their own rows (and rows on
  their own jobs / candidates); everything else arrives summarised.
* `can_engage(candidate, job, role)` → `allowed | warn | blocked` plus the holder.
* Triggers: `applications_engagement_guard` (add-to-job and first submission by a recruiter;
  duplicate client submission for everybody), `ai_call_engagement_guard` (AI calls). They raise
  `TLB01` (held) / `TLD01` (duplicate submission); the API maps them to `409
  ENGAGEMENT_BLOCKED` / `409 DUPLICATE_SUBMISSION` with the holder in `details.engagement`, and
  writes `blocked` to `engagement_audit` after the rollback.
* The API calls `requireEngage()` before every contact it carries out or records: Log call,
  the contact check for Call / WhatsApp (wa.me), bulk WhatsApp / SMS / email.

## Every contact is recorded

`candidate_contact_history` gained `recruiter_id`, `role_key`, `source` and `stage`. Rows are
written for: Log call (`phone`), WhatsApp / SMS / email from TeamLink (`whatsapp`, `sms`,
`email`, `bulk_message`), AI calls (`ai_call`, trigger), invitations (`invite`), and every
application event (`application`, `stage_change`, `submission`, `interview` — triggers on
`applications` and `interviews`). The "last contacted" search filters count only real
contacts, from every recruiter (`candidate_last_contacted_at`, a date and nothing else).

## Screens

* **Talent Pool / Find Candidates** — one badge per candidate (about *other* recruiters):
  red "In process · Medical Coder · Priya", orange "Contacted 5 days ago · Medical Coder ·
  Ravi", grey "Worked before · other roles" (tap for the list). When the Talent Pool is
  filtered to one of your jobs, the badge compares against that job's role.
* **Candidate profile → TeamLink activity** — every engagement (recruiter, role, last
  contact, channel, outcome, status, hold end), who holds the candidate, a role selector,
  Call / WhatsApp / Log call. Blocked: the buttons are disabled with "Priya is processing
  this candidate for Medical Coder (Interview Scheduled). Hold ends 2 Nov 2026 if no
  activity." and [Message Priya] [Request admin override]. Someone else's candidate shows
  "Read-only" and loses the Edit button.
* **Warning** — "Ravi contacted this candidate for Medical Coder 5 days ago (Interested).
  Contact anyway?" [Contact anyway] [Message Ravi] [Cancel].
* **Log call** — outcome (Interested / Not interested / No answer / Call back / Wrong
  number), optional job, note (saved as a comment, private or shared with the team).
* **Bulk message** — held candidates always skipped, contacted-by-others skipped unless
  ticked (logged as "contact anyway"), counts shown before and after sending. Find
  Candidates' own browser-side Email / WhatsApp / SMS buttons apply the same rules to the
  selection and record what was sent.
* **Admin → Shared candidates** — Override requests (approve / deny with a reason) and
  Conflicts (2+ recruiters on one role in 90 days, "contact anyway", overrides).

## API

| Method | Path | Who |
|---|---|---|
| GET | `/api/candidates/:id/engagements?jobId=` | recruiter, BDE, admin |
| POST | `/api/engagement/badges` `{candidateIds, jobId?}` | recruiter, BDE, admin |
| POST | `/api/engagement/check` `{candidateId, jobId?, action, acknowledge?, dryRun?, record?}` | recruiter, BDE, admin |
| POST | `/api/engagement/record` `{candidateId, channel, outcome}` | recruiter, BDE, admin |
| POST | `/api/candidates/:id/call-log` `{outcome, jobId?, note?, noteVisibility?, acknowledge?}` | recruiter, admin |
| POST | `/api/engagement/message-holder` `{candidateId, recruiterId, message}` | recruiter, admin |
| POST | `/api/engagement/overrides` `{candidateId, jobId?, roleKey?, kind, reason}` | recruiter (hold, placed), admin (any; approved at once) |
| GET | `/api/engagement/overrides?status=` | own requests / admin all |
| POST | `/api/engagement/overrides/:id/decide` `{approve, reason, days?}` | admin |
| GET | `/api/engagement/conflicts?days=` | admin |
| POST | `/api/candidates/:id/comments` gains `visibility: 'private' \| 'team'` | recruiter, admin |

## Tests

* `api/test/shared-candidates-db.test.mjs` — the rules, in Postgres, as the API's role.
* `api/test/shared-candidates.test.mjs` — the routes end to end.
* `tools/verify-rls.mjs`, `tools/verify-isolation.mjs` — expectations changed on purpose
  (candidates shared read-only, private ones hidden, notes and applications private).
* `tools/verify-shared-candidates.mjs` — Playwright: A logs a call → B sees the orange badge
  and the warning → A moves the candidate to Interview → B sees red and disabled buttons →
  B requests an override → admin approves → B proceeds.

## Known limits

* Phone numbers are visible to every recruiter (the business decision), so a call made from a
  personal phone cannot be stopped — the Call button and Log call are gated, and a call that
  happens anyway is visible as soon as it is logged.
* A recruiter importing a spreadsheet that matches another recruiter's candidate no longer
  creates a duplicate (the import now finds them). Its gap-fill on that candidate is not
  applied - row level security leaves someone else's record alone - but the import summary
  still lists the row as "matched". Worth a follow-up in `api/src/routes/spreadsheet.js`.
* The recruiter bootstrap now carries every non-private candidate; Find Candidates and the
  Talent Pool page in SQL as before.
