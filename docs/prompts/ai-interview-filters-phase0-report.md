# Recruiter AI Interview Filters — Phase 0 report

Inspection only. No code was changed. Produced against the prompt in
`ai-interview-filters-prompt.md`; Phase 1 starts only after the questions at
the end are answered.

## 1. Stack

| Item | What exists |
|---|---|
| Framework | Node.js + Express 4 API (`api/src`), no frontend framework |
| Language | Plain JavaScript (ESM in the API, browser JS in the frontend). No TypeScript |
| UI | Single-file prototype `baseline/prototype.html` (22,935 lines, frozen: `web/build.mjs` checks its SHA-256) plus override files `web/teamlink-*.js` appended at build. Every UI change lives in a new `web/teamlink-*.js` file |
| State | Global `STATE` / `DATA` objects; `render()` re-renders the page; `TL` namespace in the integration layer |
| Router | Hash router `#/recruiter/<section>` → `navigate()` (`prototype.html:1248`); `dashShell(role, section)` reads `NAV_CONFIG` |
| ORM / DB | No ORM. Parameterised SQL via `pg`; every query runs inside `withUser(session, fn)` (`api/src/db.js`), which sets the DB role so PostgreSQL RLS enforces access. Dev uses embedded PGlite (`var/dev-db`); production Postgres via `DATABASE_URL` |
| Auth | Session cookie + CSRF token; `requireAuth()` / `requireRole()`; roles `candidate / recruiter / bde / client / admin` |
| Validation | `zod` |
| Tests | `node --test` (`api/test/api.test.mjs`, 75 tests against real Postgres with RLS and mock providers); Playwright scripts in `tools/verify-*.mjs` (Chromium at `/opt/pw-browsers`) |
| Lint / typecheck | None configured |
| Build / checks | `node web/build.mjs`, `npm run test:api`, `npm run verify:db`, `npm run ui:compare` |

## 2. Existing UI to reuse

| Need | Found | Verdict |
|---|---|---|
| Recruiter layout | `dashShell('recruiter', …)`, `pageRecruiterDash(section)` | EXISTS |
| Table | `<table class="data">` in `.tbl-wrap` / `.panel.pad0` (recruiter Interviews screen, `:4765`) | EXISTS |
| Badges | `.badge-ok / -warn / -bad / -neutral / -brand / -ai`, `.badge-match-hi/mid/lo` | EXISTS |
| Search input | `.fc-shot-field` inputs | EXISTS |
| Chips | `.chip-row` + `.filter-chip` with ✕ (`:1767`, `activeFilterChips()` / `removeFilterChip()`) | EXISTS |
| Dropdown / popover multi-select | Only native `<select>`, the hover nav menu `.rec-find-menu`, and permanently expanded `sidebarCheckGroup()` lists | MISSING — build one reusable `MultiSelectFilter` |
| Date picker | None | MISSING — native `<input type="date">` |
| Skeleton / loading | None | MISSING — inline "Loading…" that keeps previous rows |
| Empty state | `.empty-note` | EXISTS |
| Pagination | Browser-side `paged()` slice; API uses `limit`/`offset` | PARTIAL — server-side pager for this screen |
| Toast | `toast(msg, icon)` | EXISTS |
| Modal | `fcrModal()` | EXISTS |
| Existing AI-interview screens | Recruiter `ai-interview` cards (`:4776`); integrity list in `web/teamlink-interview-integrity.js:664` (`GET /ai-interviews/integrity`, limit 100, no filters) | PARTIAL — new list links to their detail views |

## 3. Existing filter patterns

| Aspect | Current behaviour |
|---|---|
| Find Candidates | Immediate (change → `render()` → fetch); server-side `GET /api/candidates?…` |
| Job search | Immediate, client-side `filterJobsAdvanced()` |
| State | `STATE.candidateSearch` / `STATE.search`; not in the URL |
| Logic | Arrays → `= any($n)` (OR inside a filter), AND across filters, search ANDed |
| Pagination | `limit` (max 500) / `offset`; response `{ rows, total }` |
| Sort | Fixed `order by`; no header-sort component |

Decision for consistency: immediate apply on desktop, Apply button only in the
mobile drawer. State mirrored into the hash query
(`#/recruiter/ai-interviews?status=COMPLETED&…`).

## 4. Data model

| Entity | Table / fields |
|---|---|
| AI interview | `ai_interviews`: `id, application_id, candidate_id, job_id, interview_id, recruiter_id, status, mode, technical_score, behavioral_score, communication_score, overall_percentage (0–100, nullable), content_scored, questions_asked, questions_answered, question_count, duration_minutes (config), duration_seconds (actual, nullable), jd_relevance, resume_relevance, scheduled_at, started_at, completed_at, expires_at, session_id, integrity_status, integrity_strikes, suspended_at, suspend_reason, reopened_at, reopened_by, reopen_reason, confidence, confidence_reason, created_at` |
| Status enum (actual) | `draft, scheduled, invited, in_progress, completed, evaluating, evaluated, abandoned, expired, cancelled, warning_issued, suspended, under_review, rescheduled` |
| Integrity status (actual) | `none, warning, suspended, under_review, cleared` (single value) |
| Integrity events | `ai_interview_flags`: `interview_id, candidate_id, application_id, job_id, flag_type (free text; seen: additional_person, additional_voice), description, evidence, severity, strike_no, confidence, confidence_band, detector, review_status (open/reviewed/dismissed/upheld), reviewed_by, reviewed_at, recruiter_notes, occurred_at` |
| Application | `applications`: `id, job_id, candidate_id, recruiter_id, stage, match_score, ai_score, applied_at, …` |
| Job / client | `jobs` (`company_id`, `recruiter_id`, `title`) → `companies` |
| Recruiter | `recruiters` (`id, name, company_id`) |
| Recruiter decisions today | `applications.stage` via `PUT /applications/:id/status`; flag review `POST /ai-interviews/:id/integrity/:flagId/review`; `POST /ai-interviews/:id/reopen` |

## 5. Authorization model

| Role | AI interviews read | Enforced by |
|---|---|---|
| admin | all | RLS `app_is_admin()` |
| recruiter | all interviews of jobs at the recruiter's company (`ai_interviews_read`, migration 0005) | RLS |
| bde | all (`ai_interviews_read_bde`, 0010) | RLS |
| client | interviews of their company's jobs | RLS |
| candidate | own only | RLS |

Conflict: migration 0031 made the recruiter the boundary for jobs,
applications and candidates but did not touch `ai_interviews`, so one
recruiter can still read another recruiter's interviews. The prompt's
security test (R2 never receives R1's rows) fails under the current policy.
No role-based masking of candidate email exists today.

## 6. Config

| Item | Finding |
|---|---|
| Timezone | No app setting; templates use UTC, browser uses local time. Propose `APP_TIMEZONE` (default `Asia/Kolkata`) |
| Date library | None (native `Date`) |
| Pagination | Offset (`limit`/`offset`); `page`/`page_size` will map onto it |

## 7. Gaps

| Required | Status | Exact name / note |
|---|---|---|
| `interview_status` | PARTIAL | `ai_interviews.status`, different enum. Mapping: draft→NOT_STARTED; scheduled/invited→SCHEDULED; in_progress/warning_issued→IN_PROGRESS; completed/evaluating/evaluated→COMPLETED; abandoned/expired→ABANDONED; suspended→SUSPENDED; under_review→UNDER_REVIEW; rescheduled→REINTERVIEW_REQUIRED; cancelled→open. No source for SYSTEM_CHECK_PENDING, READY, DISQUALIFIED, TECHNICAL_ISSUE |
| `ai_interview_score` | EXISTS | `overall_percentage` (nullable) + `content_scored` |
| `job_match_score` | EXISTS | `applications.match_score` (skills ↔ JD). `applications.ai_score` is the screening score and is not used |
| `integrity_status` (multi) | PARTIAL | `ai_interviews.integrity_status` + `ai_interview_flags.flag_type`. Mapping: none/cleared→NO_ISSUES; warning→WARNING_ISSUED; under_review→UNDER_REVIEW; suspended→SUSPENDED; additional_person→MULTIPLE_PERSON_DETECTED; additional_voice→ADDITIONAL_VOICE_DETECTED; strikes≥2→REPEATED_VIOLATIONS; flag upheld→CONFIRMED_VIOLATION. No source for CAMERA_ALERT, MICROPHONE_ALERT, IDENTITY_ALERT, INTEGRITY_ALERT, UNAUTHORIZED_ASSISTANCE_SUSPECTED |
| `ai_recommendation` | MISSING | New nullable column (null = PENDING_REVIEW); set only by the evaluation step, never derived from the score |
| `recruiter_decision` | EXISTS (indirect) | `applications.stage` + flag `review_status` + `reopened_at` |
| `duration_seconds` | EXISTS | nullable |
| `integrity_event_count` | PARTIAL | `count(ai_interview_flags)` per interview |
| interview timestamp | EXISTS | `coalesce(started_at, scheduled_at, created_at)` |
| application date | EXISTS | `applications.applied_at` |
| client / job / recruiter | EXISTS | `jobs.company_id`, `jobs.id`, `coalesce(ai_interviews.recruiter_id, jobs.recruiter_id)` |
| session id / question count | EXISTS | `session_id`, `question_count` / `questions_asked` |
| candidate email by role | PARTIAL | return only to recruiter / bde / admin |
| Indexes | PARTIAL | have `candidate_id, job_id, application_id, (candidate_id, question_set_hash), expires_at (partial), session_id`; missing `status, overall_percentage, integrity_status, started_at, recruiter_id` |
| Timezone config | MISSING | `APP_TIMEZONE` |
| Popover multi-select | MISSING | build one component |
| Server-side pager | MISSING | build |

## 8. Proposed plan

| Area | File | Change |
|---|---|---|
| Migration | `supabase/migrations/<next>_ai_interview_list.sql` (reversible) | `ai_recommendation` column; indexes on `status`, `overall_percentage`, `integrity_status`, `started_at`, `recruiter_id`; composite `(job_id, status)` only if EXPLAIN justifies it; recruiter-scoped read policy if approved |
| Config | `api/src/config.js`, `.env.example` | `APP_TIMEZONE` |
| Backend | `api/src/ai/interview-list.js` (new) | enum maps, bucket / date / duration SQL, sort whitelist, zod query schema |
| Backend | `api/src/routes/ai-interviews.js` | `GET /ai-interviews/list` (filter → sort → paginate in SQL, stable `id` tiebreak, `total` under RLS); `GET /ai-interviews/filter-options?type=client\|job\|recruiter&q=` (RLS-scoped). Existing routes untouched |
| Frontend | `web/teamlink-ai-interview-filters.js` (new) | nav item, screen, `MultiSelectFilter` popover, presets + custom ranges, chips, quick filters, Reset, header sort, pager, hash-query URL state, stale-response guard, mobile drawer, ARIA / keyboard |
| Build | `web/build.mjs` | include the file; document the `ui:compare` diff |
| Tests | `api/test/api.test.mjs` | the 10-row dataset, every expected-result row, security cases |
| Tests | `tools/verify-ai-interview-filters.mjs` (new) | Playwright UI checks |
| Docs | `docs/AI-INTERVIEW-FILTERS.md` | mappings and limits |
| Phase 3 | existing detail views + `reopen` / flag review / `PUT /applications/:id/status` | Keep Under Review, Clear Suspension, Re-interview, Shortlist, Reject; Disqualify needs a decision |

Risks: enum mismatch (handled by mapping, not renaming); company-wide RLS;
frozen prototype (screen built by override, like every other feature);
hash-based URL state is new here; the 50k-row performance test is slow on
PGlite.

## Questions before Phase 1

1. Status / integrity values with no data source: show them (match 0 rows) or omit until the proctor writes those flags? Recommendation: omit.
2. Recruiter scope: keep company-wide visibility, or add an RLS policy limiting a recruiter to their own jobs / assigned applications (consistent with 0031)? Recommendation: tighten.
3. `ai_recommendation`: nullable column, set only by the evaluation step, no score-threshold auto-fill. OK?
4. Disqualify: add `disqualified` to the `ai_interviews.status` enum, or map to application stage `rejected` with a reason? Recommendation: add the status.
5. `APP_TIMEZONE=Asia/Kolkata` default. OK?
6. Performance test: PGlite (dev) or a Postgres `DATABASE_URL`?
