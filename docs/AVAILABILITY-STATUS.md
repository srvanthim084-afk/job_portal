# Candidate availability status

Migration `0092_availability_status.sql`, API `api/src/routes/availability.js` and
`api/src/notify/availability-checks.js`, UI `web/teamlink-availability.js`.

The candidate says whether they are looking; recruiter search filters and ranks by it; it is
re-confirmed automatically so it never goes stale.

| Status | Means | Recruiter search | Contact |
|---|---|---|---|
| Actively looking | wants a job now | first, green badge | free |
| Open to offers | has a job, would move for a good offer | second, yellow | free |
| Not looking | not now | hidden by default ("Show all" shows it), grey | warning first: "This candidate said they are not looking (12 Aug)" — continue allowed |
| Placed (automatic) | joined through TeamLink | hidden by default, blue | blocked for other roles for 90 days (replacement period); admin override logged |
| Unknown | never said | after the two above | free |
| Not confirmed | did not answer a re-confirmation in 14 days | ranked below unknown, grey | free |

## Who sets it

**Only the candidate** (or their reply link). A recruiter cannot change it — not through any
route (`PUT /api/candidates/:id/availability` answers 403 for anybody but the candidate) and
not in the database: a trigger refuses any direct write of these columns by the API's role,
including an owning recruiter whose UPDATE would otherwise pass row level security. Every
write goes through definer functions:

| Source | When |
|---|---|
| `register` | the registration form asks "Are you looking for a job?" (default Actively looking) |
| `candidate` | the status bar on the candidate's profile: one tap, plus "can join in", preferred roles, preferred cities |
| `reply_link` | the "Still looking?" message's links — no login |
| `apply` | applying while Not looking or Unknown → Actively looking (applying while looking counts as a confirmation) |
| `system` | joined → Placed; Placed for 90 days → Not looking (+ one "Looking for a new role?" message); the backfill |

A recruiter who hears something different on a call writes it in **Log call**.

**Can join in** (Immediate / 15 / 30 / 60 / 90 days) is the notice period said the other way:
editing either updates the other.

`candidates.availability` already existed (0057: free text on the manual entry form), so the
new column is `availability_status`; the others are `availability_updated_at`,
`availability_confirmed_at`, `availability_source`, `availability_stale_at` (set = "Not
confirmed"), `availability_placed_at`, `can_join_in`, `preferred_roles`, `preferred_cities`.
History: `candidate_availability_history`. Re-confirm messages: `availability_checks`.

Backfill: candidates who signed in or applied in the last 30 days → Actively looking
(source `system`); joined in the last 90 days → Placed; everyone else Unknown.

## Re-confirmation ("Are you still looking for a job?")

The hourly sweep (`startAvailabilitySweep`, started with the other background work):

* Actively looking not confirmed for **30 days**, Open to offers for **60 days** → asked.
* **At most one message per candidate per 30 days**, nothing to do-not-contact.
* **Never 21:00–08:00 IST** — a night run sends nothing; the next day picks the same people up.
* One channel: **WhatsApp** when an approved template is configured and they opted in, else
  **SMS**, else **email** (the next is tried only if the previous did not send) — and an
  **in-app** notification always. Every channel's own answer is stored on the check.
* Three links: Yes, actively / Open to offers / Not now. Each is a random token with an HMAC;
  only its SHA-256 is stored. The link opens a page served by the API that asks to confirm
  (mail scanners and chat previews open links by themselves; a one-tap confirm keeps them from
  answering for the candidate). **Single-use, 14 days, only that candidate.**
* No answer in **14 days** → "Not confirmed" (the status stays; it shows grey and ranks lower)
  until any answer.
* Placed for **90 days** → Not looking and one friendly "Looking for a new role?" message.
* The messages never name a client.

`POST /api/admin/availability/run` (Admin → Availability → "Run re-confirmation now") runs the
same sweep on demand; it respects quiet hours too.

## Recruiter side

* Badge on Talent Pool rows, Find Candidates cards and the candidate profile, with "can join
  in 15 days" and "updated 3 days ago".
* **Availability** filter on both screens (multi-select: Actively looking, Open to offers,
  Unknown, Not confirmed, Not looking, Placed). With nothing picked the server hides Not
  looking and Placed; **Show all** shows them. The filter runs in SQL
  (`GET /api/candidates?availability=…` / `availabilityAll=true`). A requirement's own list
  (`jobId`) or a stage filter is never filtered by default — that is the pipeline.
* Ranking: with the default (Relevance) sort, `availability_rank()` orders actively looking
  (confirmed) > open to offers > unknown > not confirmed > not looking > placed, then the
  existing order.
* Bulk message skips Not looking by default (a checkbox includes them) and Placed always.
* Placed blocks call / message / add-to-job for another role on the server, through the same
  `can_engage()` as the shared-candidates hold (a joining holds every role for 90 days).

**Clients never see it**: the fields are attached only to recruiter / BDE / admin responses,
and no client route or view reads them.

## Admin report

`GET /api/admin/availability/report` — counts per status (with Not confirmed separated),
re-confirmations sent / answered / unanswered / waiting, by channel and by answer, and the
changes by source, over the last 30 days. Shown on Admin → Availability.

## API

| Method | Path | Who |
|---|---|---|
| GET | `/api/candidate/availability` | candidate |
| PUT | `/api/candidate/availability` `{status?, canJoinIn?, preferredRoles?, preferredCities?}` | candidate |
| PUT | `/api/candidates/:id/availability` | the candidate themselves only (403 for staff) |
| GET | `/api/availability/reply?t=&a=` | anyone with the link (confirm page) |
| POST | `/api/availability/reply` `{t, a}` | anyone with the link |
| GET | `/api/admin/availability/report?days=` | admin |
| POST | `/api/admin/availability/run` | admin |
| POST | `/api/auth/register` gains `availability` | anonymous |
| GET | `/api/candidates` (and `/api/candidates/:id`) gain the `availability` and `availabilityAll` parameters; rows carry `availabilityStatus` and `canEdit` for staff (the older free-text `availability` field from 0057 is unchanged) | recruiter, admin |

## Tests

* `api/test/availability-db.test.mjs` — the rules in Postgres as the API's role.
* `api/test/availability.test.mjs` — routes, search, the sweep with the mock SMS provider,
  the reply page, placed, bulk skips, the report, clients see nothing.
* `tools/verify-availability.mjs` — Playwright: candidate sets Not looking → recruiter search
  hides them → "Show all" shows a grey badge → candidate applies → recruiter sees green.
