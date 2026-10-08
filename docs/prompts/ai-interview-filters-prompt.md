# TEAMLINK — RECRUITER AI INTERVIEW FILTERS
## Phased Claude Code Implementation Prompt (v2)

You are a senior full-stack engineer working inside the **existing TeamLink Consultants Job Portal codebase**.
Your task: add a **filterable AI Interviews list** to the Recruiter Portal, using compact dropdown/popover multi-select filters, with fully server-side search, filtering, sorting, pagination and authorization.

Work in **phases**. Do not skip ahead. Do not start coding until Phase 0 is reported and approved.

---

## 0. NON-NEGOTIABLES (read first, apply always)

1. **Compact dropdown/popover filters only.** Never render filter options as permanently expanded checkbox lists, and never build a large filter panel that pushes the table down.
2. **Two different scores, never merged.**
   - `AI Interview Score` = interview performance (0–100, new/interview data).
   - `Job Match Score` = the EXISTING Candidate Skills ↔ Job Description match. Reuse the existing field. Do NOT create, rename or duplicate it.
3. **AI Recommendation ≠ Recruiter Decision.** Separate fields, separate columns. AI output must never auto-set the recruiter's decision.
4. **Filter logic:** OR inside one filter, AND across different filters. Search ANDs with all filters.
5. **Everything server-side:** search, filter, sort, pagination. Filter → sort → paginate, in that order, in the database query. Never load all rows to the browser.
6. **Filters are not security.** Authorization is enforced server-side on every request, regardless of query params.
7. **Reuse, don't reinvent.** Use existing components, styles, API patterns, auth, ORM and table. No `FilterV2`, `AdvancedFilter2`, or duplicate systems. No redesign of unrelated pages. Keep TeamLink branding.
8. **No fake data, no guessing.** If a field/table does not exist, say so, propose a migration, and wait for approval. If this prompt conflicts with the existing code, STOP and ask.
9. **Never auto-penalize.** Short duration, a single uncertain audio/video detection, or a technical issue must not automatically classify a candidate as suspicious or rejected. Duration is only a filter.
10. **Do not touch unrelated files.** List every file you change.

---

## PHASE 0 — INSPECT AND REPORT (no code changes)

Inspect the entire project and produce a written report. **Make no changes.** Then STOP and wait for my approval.

Report on:

1. **Stack:** framework, language, UI library, state management, router, ORM/DB, auth method, test framework, lint/type-check/build commands.
2. **Existing UI to reuse:** recruiter layout, table component, dropdown/popover/multiselect/checkbox/date-picker components, search input, chips/badges, status styling, skeleton/loading, empty state, pagination, toast.
3. **Existing filter patterns:** how ATS/candidate filters work. Is filtering immediate or Apply-button based? Is state in URL, local state or store?
4. **Data model:** exact tables/fields for applications, candidates, jobs, requirements, clients, recruiters, Job Match Score, and anything AI-interview-related (status, score, integrity events, recommendation, recruiter decision, duration, timestamps).
5. **Authorization model:** roles, how recruiter ↔ client/requirement/department/candidate access is determined, where the check lives today.
6. **Config:** timezone handling, date library, pagination style (offset vs cursor).
7. **Gaps:** for every field required below, mark `EXISTS` (with exact name), `PARTIAL`, or `MISSING`.
8. **Proposed plan:** file-by-file list of changes, migrations needed, and risks.

Output the Phase 0 report in a clear table format. Ask me to approve before Phase 1.

---

## DATA CONTRACT (canonical values)

Store/transmit **canonical enum values**; the UI maps them to labels. Use existing enums if equivalents already exist (map, don't duplicate).

**Each filter maps to ONE field. Do not mix them.**

| Filter | Field | Allowed values |
|---|---|---|
| Status | `interview_status` | NOT_STARTED, SCHEDULED, SYSTEM_CHECK_PENDING, READY, IN_PROGRESS, COMPLETED, UNDER_REVIEW, SUSPENDED, DISQUALIFIED, TECHNICAL_ISSUE, ABANDONED, REINTERVIEW_REQUIRED |
| Integrity | `integrity_status` (a candidate may have several flags; filter matches ANY selected) | NO_ISSUES, WARNING_ISSUED, UNDER_REVIEW, INTEGRITY_ALERT, MULTIPLE_PERSON_DETECTED, ADDITIONAL_VOICE_DETECTED, CAMERA_ALERT, MICROPHONE_ALERT, IDENTITY_ALERT, UNAUTHORIZED_ASSISTANCE_SUSPECTED, REPEATED_VIOLATIONS, CONFIRMED_VIOLATION, SUSPENDED |
| Recommendation | `ai_recommendation` | PENDING_REVIEW, RECOMMENDED, NOT_RECOMMENDED, SHORTLIST, REINTERVIEW, ON_HOLD, REJECTED |
| Recruiter Decision | `recruiter_decision` (column + detail only, not a required filter) | existing decision values |

Camera sub-types (Camera Disabled, Face Not Detected, Candidate Left Frame, Camera Obstructed) are stored as event types under `CAMERA_ALERT` / `IDENTITY_ALERT`. **Do not add separate filters** for them; the Integrity dropdown can group them under Camera Alert.

**Scores and numeric fields**
- `ai_interview_score`: 0–100, **nullable** (not started / in progress). Null rows are excluded by any score filter and never treated as 0.
- `job_match_score`: existing field, same null rule.
- `duration_seconds`: nullable integer.
- `integrity_event_count`: integer, derived or stored per the existing schema.

**Ranges (inclusive lower, inclusive upper, integers):** 90–100, 80–89, 70–79, 60–69, 50–59, Below 50 (0–49). Custom min/max validated `0 ≤ min ≤ max ≤ 100`. Multiple selected ranges combine with OR; a custom range counts as one more OR range.

**Duration buckets:** Under 10 min (<600s), 10–20 (600–1199s), 20–30 (1200–1799s), 30+ (≥1800s), Custom (min/max minutes). Null durations are excluded.

**Date presets** (evaluate in TeamLink's configured timezone, on the stored interview timestamp): Today, Yesterday, Last 7 Days, Last 30 Days, This Month, Previous Month, Custom (from/to, inclusive, from ≤ to).

---

## PHASE 1 — BACKEND

### 1.1 Schema
Only after Phase 0 approval. For every `MISSING` field: write a reversible migration, backfill safely, and never overwrite existing data. Add indexes **only after checking existing ones**, for commonly filtered/sorted columns (interview_status, ai_interview_score, job_match_score, integrity_status, interview_date, application_id, candidate_id, job_id, client_id, recruiter_id) and a composite index if the existing query plan justifies it. Explain each index.

### 1.2 Endpoint
Extend the existing list API pattern (or add `GET /recruiter/ai-interviews` following existing route conventions).

**Request query parameters** (arrays accept repeated params or comma lists, per existing convention):

```
q                     string, debounced search term
status[]              interview_status enum values
ai_score_range[]      e.g. 80-89, 90-100, lt-50
ai_score_min / ai_score_max
match_range[]         same bucket keys as ai_score_range
match_min / match_max
integrity[]           integrity enum values
recommendation[]      ai_recommendation enum values
client_id[]           ids
job_id[]              ids
recruiter_id[]        ids
date_preset           today|yesterday|last7|last30|this_month|prev_month|custom
date_from / date_to   ISO date (custom only)
duration_bucket[]     lt10|10-20|20-30|gte30
duration_min / duration_max   minutes
sort                  candidate_name|application_date|interview_date|ai_score|match_score|duration|integrity_events|updated_at
order                 asc|desc    (default: updated_at desc)
page / page_size      defaults 1 / 20, page_size capped at 100
```

**Response**
```json
{
  "data": [ { "id": "...", "candidate": {...}, "job": {...}, "client": {...},
              "application_date": "...", "interview_date": "...",
              "interview_status": "COMPLETED", "ai_interview_score": 84,
              "job_match_score": 88, "integrity_status": ["NO_ISSUES"],
              "integrity_event_count": 0, "ai_recommendation": "RECOMMENDED",
              "recruiter_decision": null, "duration_seconds": 1320 } ],
  "page": 1, "page_size": 20, "total": 134, "total_pages": 7,
  "applied_filters": { ... }
}
```

Also provide **filter-option endpoints** (or one combined endpoint) for Client, Job and Recruiter dropdowns: server-side search (`?q=`), limited page size, scoped to **only the options the current user is authorized to see**. Never hard-code jobs, clients or recruiters.

### 1.3 Query rules
- OR within a filter, AND across filters, AND with search.
- Search matches: candidate name, candidate email (only if the role may see emails), application ID, candidate ID, job title, client, requirement, interview session ID. Escape input; use parameterized queries only. No raw string concatenation.
- Validate and whitelist every parameter (enum values, sort keys, ranges, dates). Invalid input → clear 400 with message, not a 500.
- Stable secondary sort (e.g. `id`) so pagination never duplicates or skips rows.
- `total` must reflect filters **and** authorization.
- No N+1 queries. Select only needed columns.

### 1.4 Authorization (server-side, mandatory)
Reuse the existing authorization layer. Apply the authorization scope **before** user filters, as a base constraint that filters can only narrow, never widen.
- Recruiter ID, client ID, job ID, etc. supplied in the request must be **intersected** with what the user is allowed to access, never trusted.
- Recruiter filter options and values are only available to roles allowed to view other recruiters; others see only themselves/their scope.
- Candidate email and sensitive fields are returned only to permitted roles.
- Unauthorized detail/ID access returns the existing 403/404 pattern.
- Recruiter actions (below) re-check permission server-side.

---

## PHASE 2 — FRONTEND (filters, table, state)

### 2.1 Layout (desktop)
```
AI INTERVIEWS
[ Search Candidate / Job / Application / Interview ID... ]

[Status ▼][AI Score ▼][Match Score ▼][Integrity ▼][Recommendation ▼]
[Client ▼][Job ▼][Recruiter ▼][Interview Date ▼][Duration ▼]   [Reset Filters]

Quick: [Suspended][Under Review][Completed][High Score][Recommended]
       [Voice Alert][Multiple Person][Camera Alert][Integrity Alert][Re-interview]

Active: [Status: Completed ×] [AI Score: 80–100 ×] ...

Table  →  Pagination
```
Rows of filters wrap; the whole control area must stay compact (target: table header visible without scrolling on a 1080p desktop when no filters are active).

### 2.2 Dropdown behavior
Every filter button opens a popover (use the existing component; if there is none, build **one** reusable `MultiSelectFilter` and reuse it for all filters).
- Checkbox multi-select; "All" clears the selection (it is a reset, not a stored value).
- Search box inside long lists (Client, Job, Recruiter); server-side search with debounce and virtualized or scrollable list; "Select all (visible)" and "Clear".
- Range filters (AI Score, Match Score, Duration, Date) show presets + Custom inputs with validation and inline error messages.
- Button label shows state: `Status` → `Status (2)`; Apply/immediate behavior follows the **existing TeamLink pattern found in Phase 0**, applied consistently to every filter.
- Selections persist when reopened.
- Closes on outside click and Escape; stays inside the viewport (flip/shift); long lists scroll inside the popover.

### 2.3 Chips, reset, quick filters
- Chips for each active filter, individually removable; range/date chips show readable text ("AI Score: 80–100").
- **Reset Filters** clears search, all filters, quick filters and chips, resets sort and page to defaults, and refetches. No full page reload if the app supports client-side updates.
- Quick filters are shortcuts that write into the same filter state and show as chips (never a separate hidden state). Mapping:

| Quick filter | Applies |
|---|---|
| Suspended | status = SUSPENDED |
| Under Review | status = UNDER_REVIEW |
| Completed | status = COMPLETED |
| High Score | ai_score_min = 80 |
| Recommended | recommendation = RECOMMENDED |
| Voice Alert | integrity includes ADDITIONAL_VOICE_DETECTED, MICROPHONE_ALERT |
| Multiple Person | integrity includes MULTIPLE_PERSON_DETECTED |
| Camera Alert | integrity includes CAMERA_ALERT |
| Integrity Alert | integrity includes INTEGRITY_ALERT |
| Re-interview | status = REINTERVIEW_REQUIRED OR recommendation = REINTERVIEW |

Clicking a quick filter **adds to** the matching dropdown selection; clicking again removes it. (Use existing behavior if different, and state it in the report.)

### 2.4 State, URL, navigation
- Persist filters, sort, page and search in URL query params using readable keys (e.g. `?status=COMPLETED&ai_score_min=80&integrity=NO_ISSUES`). Do not put sensitive data (emails, tokens) in URLs.
- Browser refresh, back/forward and shared (authorized) links restore the same view.
- Returning from a detail page restores filters, sort and page.
- Any filter/search change resets to page 1.
- Ignore stale responses (cancel or sequence in-flight requests) so a slow earlier request never overwrites a newer result.

### 2.5 Table
Columns: Candidate, Job, Client, Application Date, Interview Date, AI Interview Status, **AI Interview Score** (`84/100`), **Job Match Score** (`88%`), Integrity Status, Integrity Events, AI Recommendation, Recruiter Decision, Actions. Use the existing table style; keep both scores in separate, clearly labeled columns. Status badges always include a **text label** plus color/icon (e.g. `🔴 Suspended`, `🟠 Under Review`), never color alone. Sorting via column headers/sort control for all sort keys listed above. Null score shows "—".

### 2.6 States
- Loading: existing skeleton/spinner, do not block the page; keep previous results visible with an inline loading indicator when refetching.
- Empty: "No AI Interviews Found — No candidates match the selected filters." with a **Clear Filters** button.
- Error: friendly message with Retry; no technical details exposed.

### 2.7 Responsive
- Desktop: compact filter bar as above. Tablet: wrapping or horizontally scrollable bar.
- Mobile: one **[Filters (n)]** button opening a drawer/bottom sheet with all filters as collapsible sections plus Apply / Clear; quick filters in a scrollable chip row. Table follows the existing responsive behavior.

### 2.8 Accessibility
Filter buttons use `aria-haspopup`/`aria-expanded`; popovers are focus-managed (focus moves in, returns to trigger on close); Arrow keys move through options, Space toggles, Enter applies, Escape closes; every checkbox, input and chip-remove button has an accessible label; selected count and result count changes announced via a polite live region; visible focus styles; contrast meets WCAG AA.

---

## PHASE 3 — DETAIL PAGE AND RECRUITER ACTIONS (only where interview data already exists)

Do this phase **only** if Phase 0 shows the AI interview data/events already exist. Do **not** build or alter proctoring/detection logic (voice, camera, multi-person); this task consumes existing events only. If data is missing, list it as a limitation and skip.

- View/Review opens the existing candidate/interview detail page or an integrated one showing: candidate, job, application, interview status, AI Interview Score, Job Match Score, AI recommendation, recruiter decision, integrity status, duration, interview date, question count.
- **Integrity timeline:** chronological events (timestamp, event, question number where available).
- **Suspended interview:** show `🔴 AI INTERVIEW SUSPENDED`, status "Under Recruiter Review", reason, detection count, last detection (question and timestamp). **Never display "Rejected"** unless the recruiter actually rejects/disqualifies.
- **Actions** (permission-gated, server-checked, audit-logged with who/when/why): Keep Under Review, Clear Suspension, Request Re-interview, Shortlist, Reject, Disqualify. Reject/Disqualify require confirmation and a reason.

---

## PHASE 4 — TESTS AND ACCEPTANCE CRITERIA

Add automated tests (API/integration and component level) following the project's existing test setup. Seed this dataset (dates relative to "now", timezone per app config) and assert **exact** results.

| # | Candidate | Status | AI | Match | Integrity | Recommendation | Client | Job | Recruiter | Date | Dur (min) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Rahul | COMPLETED | 84 | 88 | NO_ISSUES | RECOMMENDED | A | Java | R1 | −1d | 22 |
| 2 | Priya | UNDER_REVIEW | 79 | 81 | ADDITIONAL_VOICE_DETECTED | PENDING_REVIEW | A | Java | R1 | −2d | 18 |
| 3 | Anil | SUSPENDED | 72 | 65 | MULTIPLE_PERSON_DETECTED | PENDING_REVIEW | B | Professor | R2 | −3d | 9 |
| 4 | Sneha | COMPLETED | 91 | 92 | NO_ISSUES | SHORTLIST | A | Java | R1 | −5d | 31 |
| 5 | Kiran | COMPLETED | 55 | 70 | WARNING_ISSUED | NOT_RECOMMENDED | B | Professor | R2 | −10d | 14 |
| 6 | Meena | IN_PROGRESS | null | 77 | NO_ISSUES | PENDING_REVIEW | B | Professor | R3 | 0d | null |
| 7 | Vikram | DISQUALIFIED | 40 | 48 | CONFIRMED_VIOLATION | REJECTED | C | Data | R3 | −40d | 12 |
| 8 | Divya | COMPLETED | 88 | 85 | NO_ISSUES | RECOMMENDED | C | Data | R3 | −8d | 27 |
| 9 | Ravi | NOT_STARTED | null | 90 | NO_ISSUES | PENDING_REVIEW | A | Java | R1 | null | null |
| 10 | Lakshmi | COMPLETED | 66 | 59 | CAMERA_ALERT | REINTERVIEW | B | Professor | R2 | −20d | 21 |

**Expected results (as admin with full access):**

| Filter(s) | Expected IDs / count |
|---|---|
| Status = COMPLETED | 1,4,5,8,10 → 5 |
| Status = COMPLETED OR UNDER_REVIEW | 1,2,4,5,8,10 → 6 |
| COMPLETED + AI ≥ 80 | 1,4,8 → 3 |
| COMPLETED + NO_ISSUES + AI ≥ 80 | 1,4,8 → 3 |
| Integrity = ADDITIONAL_VOICE OR MULTIPLE_PERSON | 2,3 → 2 |
| SUSPENDED + MULTIPLE_PERSON | 3 → 1 |
| AI Score 70–79 | 2,3 → 2 (null scores excluded) |
| AI Score Below 50 | 7 → 1 |
| Match Score ≥ 80 | 1,2,4,8,9 → 5 |
| Client A + Job Java | 1,2,4,9 → 4 |
| Client A OR Client C | 1,2,4,7,8,9 → 6 |
| Duration Under 10 min | 3 → 1 (null excluded) |
| Duration 20–30 min | 1,8,10 → 3 |
| Duration 30+ | 4 → 1 |
| Search "Rahul" | 1 → 1 |
| Search "Rahul" + COMPLETED + AI 80–100 | 1 → 1 |
| COMPLETED, page_size 3 | page 1 = 3 rows, page 2 = 2 rows, total = 5, total_pages = 2 |
| Sort AI Score desc (no filter) | 4,8,1,2,3,10,5,7 then nulls last (6,9) |
| Date: Last 7 Days | 1,2,3,4,6 → 5 (verify timezone boundary cases) |
| Reset after any combination | all 10 returned, no filter chips, URL clean |

**Security tests (must all pass):**
- Recruiter R2 (authorized for clients B only) never receives rows 1,2,4,9 even when sending `client_id=A`, forged `recruiter_id=R1`, or `job_id` of a Java job; result is empty or scoped, never leaked.
- Direct API calls without auth → existing 401/403 pattern.
- Invalid enum, negative score, `min > max`, bad dates, oversized `page_size`, SQL-injection strings in `q` → safe 400 or empty result, no server error.
- Client/Job/Recruiter option endpoints return only authorized options.
- `total` count never reveals unauthorized records.
- Recruiter actions rejected server-side without permission.

**UI tests:** popover opens/closes (outside click, Escape), multi-select, selected count, chip removal removes only that filter, quick filter ↔ chip ↔ dropdown stay in sync, Reset clears everything including search/sort/page, URL restores state on reload and Back, empty state shows Clear Filters, mobile drawer works, keyboard-only operation works.

**Performance:** with ≥50,000 seeded rows, the list endpoint with typical filter combinations should respond in under ~1 second on the project's dev setup; include `EXPLAIN` evidence that the common filters use indexes, or report honestly if not.

---

## PHASE 5 — VERIFICATION AND FINAL REPORT

Run, fix and report results of: **build, lint, type check, full test suite**. Manually verify the final UI in the browser (desktop, tablet, mobile widths) and confirm nothing in existing recruiter/ATS/job-portal functionality regressed.

Final checklist (all must be true before you finish):
- [ ] Filters are compact dropdowns/popovers, never permanently expanded
- [ ] Multi-select, in-dropdown search, selected counts, chips (individual remove), Reset, quick filters all work
- [ ] OR within a filter, AND across filters, AND with search
- [ ] Server-side search, filter, sort, pagination; filter happens before pagination
- [ ] AI Interview Score and Job Match Score are separate; no duplicate match score exists
- [ ] AI Recommendation and Recruiter Decision are separate
- [ ] Authorization enforced server-side; tampered params cannot leak data
- [ ] URL state, back navigation, refresh restore the view
- [ ] Responsive drawer and accessibility requirements met
- [ ] Existing design/functionality preserved; no duplicate filter system
- [ ] All seeded expected-result tests pass

**Final output format:**

### Implementation Summary
- Files changed (grouped: backend / frontend / migrations / tests)
- Components and APIs added or changed
- Database changes and indexes (with reasons)
- Filters implemented and their field mappings
- Security measures implemented
- Tests added and results (build / lint / types / tests)
- Deviations from this prompt (with reasons)
- Known limitations and anything skipped (e.g. missing data in Phase 3)

---

## RULES FOR HOW YOU WORK
- At each phase end, summarize what you did, then proceed to the next phase **only** after Phase 0 approval; after that continue through phases without stopping unless blocked or a decision is needed.
- When blocked or uncertain, ask one precise question instead of guessing.
- Prefer small, reviewable changes; do not refactor unrelated code.
- Never commit secrets, never disable tests/lint to make them pass, never use mock data in production code paths.
