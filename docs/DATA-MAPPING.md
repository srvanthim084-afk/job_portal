# TeamLink Job Portal — prototype → database mapping

Every piece of state the prototype keeps in memory or in `localStorage`, and
where it goes in Postgres. Nothing is dropped; anything deliberately *not*
migrated is listed in §5 with a reason.

Source of truth for shapes: the running prototype, interrogated live — not
guessed from the source.

---

## 1. The two data surfaces

The prototype stores state in exactly two places.

**A. `DATA.*`** — one object declared at `prototype.html:898`, holding the whole
domain model in plain arrays. Every read in the app goes through it:

| Accessor | Call sites | Backing array |
|---|---|---|
| `DATA.jobById(id)` | 163 | `DATA.jobs` |
| `DATA.candidateById(id)` | 138 | `DATA.candidates` |
| `DATA.companyById(id)` | 91 | `DATA.companies` |
| `DATA.applications` | 74 | — |
| `DATA.candidates` | 73 | — |
| `DATA.jobs` | 69 | — |
| `DATA.recruiterById(id)` | 53 | `DATA.recruiters` |
| `DATA.openJobs()` | 34 | filtered `DATA.jobs` |
| `DATA.interviews` | 27 | — |
| `DATA.clientById(id)` | 6 | `DATA.clients` |

**B. 58 `localStorage` keys** — enumerated in §4. Five of them are the real
persistence layer (applications, stages, posted jobs, notifications, session);
the rest are per-user preferences and UI memory.

---

## 2. Core entity mapping

### 2.1 `DATA.companies` → `companies`

| Prototype field | Column | Type | Note |
|---|---|---|---|
| `id` (`'technova'`) | `id` | `text` PK | slug ids preserved verbatim |
| `name` | `name` | `text` | |
| `industry` | `industry` | `text` | drives the Industry filter |
| `hq` | `hq` | `text` | |
| `founded` | `founded` | `int` | |
| `size` | `size_label` | `text` | free text, e.g. `'800–1,000 employees'` |
| `color1` / `color2` | `color1` / `color2` | `text` | logo gradient — **UI-critical** |
| `about` | `about` | `text` | |

### 2.2 `DATA.jobs` → `jobs`

23 fields confirmed live. `id` values (`j1`…`j13`) are preserved — **requirement 6
says the Job ID must never change**, so `id` is `text`, not a serial.

| Prototype field | Column | Type | Note |
|---|---|---|---|
| `id` | `id` | `text` PK | `j1`…`j13`; new ones keep the generated id |
| `title` | `title` | `text` | |
| `companyId` | `company_id` | `text` FK → `companies` | |
| `location` | `location` | `text` | |
| `mode` | `mode` | `text` | Hybrid / Remote / Onsite |
| `exp` | `exp_label` | `text` | display string `'3–5 yrs'` |
| `pay` | `pay_label` | `text` | display string `'₹12–18 LPA'` |
| `salaryMin` / `salaryMax` | `salary_min` / `salary_max` | `numeric` | the *filterable* values |
| `type` | `employment_type` | `text` | Full-time / Contract / Internship / Walk-in |
| `posted` | `posted_label` | `text` | `'2 days ago'` — recomputed server-side |
| `postedDaysAgo` | — | — | **derived** from `published_at`, not stored |
| `publishedAt` | `published_at` | `timestamptz` | |
| `applicants` | — | — | **derived** `count(applications)`; see §3.2 |
| `featured` | `featured` | `bool` | |
| `status` | `status` | `text` | `open` / `closed` / `draft` |
| `paused` | `paused` | `bool` | read by `DATA.openJobs()` |
| `archived` | `archived` | `bool` | read by `DATA.openJobs()` |
| `department` | `department` | `text` | filter facet |
| `education` | `education` | `text` | filter facet |
| `easyApply` | `easy_apply` | `bool` | |
| `skills[]` | `skills` | `text[]` | GIN-indexed for search |
| `desc` | `description` | `text` | |
| `responsibilities[]` | `responsibilities` | `text[]` | |
| `requirements[]` | `requirements` | `text[]` | |
| `postingKind` | `posting_kind` | `text` | `job` / `walkin` / `internship` |
| — | `recruiter_id` | `text` FK | **new** — requirement 3 asks for `recruiter` |
| — | `source` | `text` | **new** — requirement 3 asks for `source` |
| — | `openings` | `int` | **new** — requirement 3 asks for `openings` |
| — | `hiring_type` | `text` | **new** — requirement 3 asks for `hiring_type` |

> `DATA.openJobs()` filters on `status`, `paused`, `archived` **and** a
> `jobIsExpired()` hook. The server-side equivalent is a `jobs_open` view so the
> browser never re-implements this rule.

### 2.3 `DATA.candidates` → `candidates`

44 fields confirmed live. The full list is preserved; grouped here by purpose.

**Identity** `id` `name` `email` `phone` `location` `gender` `title`
**Career** `exp` `ctc` `expectedCtc` `noticePeriod` `currentCompany` `previousCompanies` `careerGoal` `preferredRole` `preferredLocation` `candidateType` `preferredWorkModes[]`
**Profile** `skills[]` `technicalSkills[]` `education` `summary` `certifications[]` `languages[]` `projects[]` `linkedin` `github` `portfolio`
**Resume** `resumeFile` → plus **new** `resume_storage_path`, `resume_mime`, `resume_size` (§3.3)
**Pipeline mirror** `appliedJobId` `stage` `matchScore` — **derived from `applications`**, see §3.1
**AI** `aiInterviewScore` `qualified`
**Verification** `emailVerified` `mobileVerified` `smsVerified` `whatsappOptIn`
**Activity** `daysSilent` `followUpSent` `isPrivate` `profileActiveDaysAgo` `profileUpdatedDaysAgo`
**Recruiter-owned** `recruiterComments[]` → own table `candidate_comments` (it is
per-recruiter data and must not leak between recruiters under RLS)

Array fields become `text[]`; `projects` and `recruiterComments` become `jsonb`
and a child table respectively.

### 2.4 `DATA.interviews` → `interviews`

| Prototype field | Column | Note |
|---|---|---|
| `id` | `id` `text` PK | |
| `candidateId` | `candidate_id` FK | |
| `jobId` | `job_id` FK | |
| `type` | `type` | Technical (Human) / AI Interview / Client Round / HR Round |
| `date` / `time` | `scheduled_date` `date` / `scheduled_time` `text` | kept split — the UI renders them separately |
| `mode` | `mode` | Video Call / TeamLink AI |
| `status` | `status` | Scheduled / Completed |
| `interviewer` | `interviewer` | |
| — | `ai_score`, `feedback`, `application_id` | **new** — requirements 3 & 15 |

### 2.5 Users and roles

The prototype has four separate people-arrays (`DATA.recruiters`,
`DATA.clients`, `DATA.admin`, `DATA.candidates`) with no shared identity. The
database unifies authentication in `users` while **keeping the four
role-profile tables**, so `DATA.recruiterById('r1')` keeps working unchanged.

```
users (auth: id, email, password_hash, role, status, created_at, updated_at)
  ├── candidates   (id 'cand1' …)   user_id → users
  ├── recruiters   (id 'r1' …)      user_id → users
  ├── client_users (id 'c1' …)      user_id → users
  └── admins       (id 'a1' …)      user_id → users
```

`role ∈ {admin, recruiter, candidate, client}` — exactly the four roles
`render()` dispatches on at `prototype.html:1296-1300`. None added, none removed.

---

## 3. The three structural problems

These are real modelling faults in the prototype. Each is fixed in the database
**without changing what the UI reads.**

### 3.1 Applications are modelled twice — must normalize

`candidateApplications()` (`prototype.html:2019`) merges two different things:

```js
// a synthesized "primary" application that exists only as fields on the candidate
if(cand.appliedJobId) list.push({ id:'primary__'+cand.id, jobId:cand.appliedJobId,
                                  stage:cand.stage, matchScore:cand.matchScore, primary:true });
// plus the real records
DATA.applications.filter(a=>a.candidateId===candidateId).forEach(a=>list.push(a));
```

`DATA.hasApplication()` and `DATA.stageForCandidateJob()` both have to check
*both* places. A candidate therefore cannot have two applications tracked the
same way, and the seeded stage lives on the candidate row rather than the
application.

**Fix:** one `applications` table. Every seeded "primary" becomes a real row
with `is_primary = true`. On hydrate the client rebuilds both views from that
single table — the primary row repopulates `cand.appliedJobId` / `cand.stage` /
`cand.matchScore`, the rest fill `DATA.applications`. **Every existing call site
keeps working**, and there is now one authoritative stage per application.

`applications` columns (requirement 7):
`id` · `job_id` · `candidate_id` · `recruiter_id` · `stage` · `match_score` ·
`source` · `posting_type` · `applied_at` · `applied_on` · `resume_path` ·
`is_primary` · `ai_score` · `created_at` · `updated_at`

### 3.2 `job.applicants` is an incrementing counter — must derive

`applyToJob()` does `job.applicants = (job.applicants||0) + 1`, and the restore
code at `:11749` **re-increments it on every page load** while replaying saved
applications. The count drifts upward across refreshes.

**Fix:** `applicants` is never stored. The `jobs_with_counts` view computes
`count(applications)`. The field is still present in the hydrated object, so
every template that prints `job.applicants` is untouched.

### 3.3 Resumes are base64 in localStorage — must move to object storage

`readAsDataURL` at `prototype.html:2658` puts the whole file in memory and the
record in `localStorage`, which caps out around 5 MB total and is why
`resumeFile` is only ever a *filename* on seeded candidates.

**Fix:** Supabase Storage bucket `resumes`, private. DB keeps
`resume_storage_path` + mime + size; `resumeFile` stays the display name so the
badge at `:4592` (`📄 ${c.resumeFile} · 🤖 AI Extracted`) renders identically.
Access is via short-lived signed URLs issued by the API after a role check.

---

## 4. `localStorage` keys → destination

All 58 keys. **Five were invisible to source grep** (built by concatenation) and
were only found by reading the live app — marked ⚡.

### 4.1 Real data → tables (must migrate)

| Key | Holds | Destination |
|---|---|---|
| `teamlink_applications_v1` ⚡ | application records | `applications` |
| `teamlink_candidate_stage_v1` ⚡ | `{candidateId: stage}` | `applications.stage` |
| `teamlink_posted_jobs_v1` | recruiter-created jobs | `jobs` |
| `teamlink_registered_candidates_v1` | sign-up candidates | `candidates` + `users` |
| `teamlink_candidate_notifications_v1` | candidate feed | `notifications` |
| `teamlink_notification_history_v1` | sent-message log | `notification_log` |
| `teamlink_candidate_edits_v1` | profile edits | `candidates` |
| `teamlink_qualifications_v1` | parsed qualification | `candidates.education` |
| `teamlink_job_base_applicants_v1` ⚡ | counter baseline | **deleted** — §3.2 |
| `teamlink_app_snapshots_v1` ⚡ | application snapshots | `applications` |
| `tl_job_portal_state_v1` | export snapshot | **deleted** — replaced by the DB |
| `tl_ext_applications` | external-source apps | `applications.source` |
| `teamlink_applied_on_v1` | applied dates | `applications.applied_on` |
| `teamlink_interview_confirmation_*` | per-interview confirms | `interviews.status` |
| `teamlink_iqa_v1` | interview Q&A | `interviews.feedback` |
| `teamlink_feedback_v1` | candidate feedback | `feedback` |
| `teamlink_web_companies_v1` | companies | `companies` |

### 4.2 Recruiter-owned data → tables

`teamlink_recruiter_candidate_lists_v1` → `candidate_lists` ·
`teamlink_saved_candidate_searches` → `saved_searches` ·
`teamlink_recent_candidate_searches` + `_search_data` → `recent_searches` ·
`teamlink_bookmarked_candidates_v1` → `candidate_bookmarks` ·
`teamlink_reported_candidates_v1` → `candidate_reports` ·
`teamlink_comm_templates_v1` → `comm_templates` ·
`teamlink_recruiter_viewed_v1` / `teamlink_recruiter_notif_seen_v1` → `view_events`

### 4.3 Secrets → **server-side env vars only** (requirement 21)

These currently sit in the browser and **must not survive** there:

| Key | Moves to |
|---|---|
| `teamlink_whatsapp_api_v1` | `WHATSAPP_API_KEY` |
| `teamlink_sms_api_v1` | `SMS_API_KEY` |
| `teamlink_ivr_settings_v1` | `IVR_*` |
| `teamlink_recruiter_password` | `users.password_hash` (bcrypt) |
| `teamlink_session_v1` / `teamlink_last_hash_v1` | httpOnly session cookie |

### 4.4 Per-user preferences → `user_prefs (user_id, key, value jsonb)`

Everything else — `teamlink_job_alerts_v1`, `teamlink_career_pref_v1`,
`teamlink_profile_visibility_v1`, `teamlink_notification_settings_v1`,
`tl_cand_privacy_v1`, `tl_cand_autoapply_v1`, `teamlink_blocked_companies_v1`,
`teamlink_candidate_search_v1`, `teamlink_resume_template_v1`,
`teamlink_auto_notify_v1`, `teamlink_notify_threshold_v1`, and the remaining UI
memory keys. One row per key, read/written through the `tlStore` shim so every
existing call site keeps its signature.

### 4.5 Genuinely local — stays in the browser

`tl_ext_src_filter`, `tl_ext_match_threshold`, `tl_ai_last_qset_*`,
`teamlink_apps_cofilter_v1`, `teamlink_apps_allco_v1` — transient UI filter
state, meaningless on another device. Keeping these local is deliberate, not an
oversight.

---

## 5. Not migrated, and why

| Item | Reason |
|---|---|
| `DATA.stages`, `DATA.kanbanStages` | Fixed domain vocabulary, not user data. Becomes a `stages` reference table seeded once; ids unchanged. |
| `DATA.avgDaysInStage` | Sample analytics constants. Replaced by a real query over `application_stage_history`. |
| `DATA.aiInterviewTranscripts` | Canned demo transcripts (`:4897`). Kept as seed so the AI Interview screens still render; real transcripts write to `interviews.feedback`. Requirement 15 says do not fabricate scores — seeded rows stay flagged `is_demo`. |
| `DATA.resumeBank` | Canned parse results driving the extraction demo. Preserved as seed; real uploads write real rows. |
| `DATA.whatsappTemplates` | Message templates → `comm_templates`. |
| `ROLE_CREDENTIALS` | **Deleted.** Plain-text passwords, §6. |

---

## 6. Security defects found in the prototype

Both in the auth block at `prototype.html:1322-1341`:

1. **Plain-text credentials in shipped JavaScript.**
   ```js
   const ROLE_CREDENTIALS = {
     recruiter: { email:'recruiter@teamlink.com', password:'Recruiter@123', id:'r1' },
     client:    { email:'client@teamlink.com',    password:'Client@123',    id:'c1' },
     admin:     { email:'admin@teamlink.com',     password:'Admin@123',     id:'a1' },
   };
   ```
   → bcrypt hashes in `users.password_hash`; the constant is removed entirely.

2. **Candidate login has no authentication at all.**
   ```js
   if(role==='candidate') return loginAs('candidate','cand1');
   ```
   Anyone reaching `#/login/candidate` becomes a signed-in candidate with full
   access to `cand1`'s profile and applications.
   → real credential check against `users`.

Additionally `requireRole()` (`:1310`) is a client-side redirect only. It stays
for navigation UX, but from now on it guards nothing — the API and RLS enforce
access. This satisfies requirement 5's "not only frontend hiding".

---

## 7. Integration contract

The rule that keeps the UI identical:

> `DATA` remains a **synchronous in-memory cache**. Only how it is filled and
> flushed changes.

- **Boot** — `DOMContentLoaded → render()` becomes
  `DOMContentLoaded → await tlApi.hydrate() → render()`.
- **Reads** — unchanged. All 700+ synchronous call sites keep working.
- **Writes** — intercepted at the array-mutation seam the prototype *already*
  monkey-patches (`DATA.jobs.push` `:19011`, `DATA.candidates.push` `:16072`,
  `DATA.applications.push` `:11779`): optimistic local update → API call →
  reconcile → `render()`.
- **`localStorage`** — replaced by a `tlStore` shim with the same `get`/`set`
  signature, backed by `user_prefs`.
- **Never changed** — CSS, HTML templates, page renderers, function names,
  DOM ids, routes.
