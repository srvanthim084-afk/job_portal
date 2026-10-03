# Screening questions

Candidates answer a few questions when they apply. Recruiters see the answers next to the AI score, and the answers go into the client submission. Migration `0097_screening_questions.sql`.

## What a job asks

- **At most six questions per job.** A trigger enforces the limit in SQL (`screening_question_limit`), so neither the page nor a direct insert can go over it. The editor warns when a job has six questions, or more than two must-haves, with "Too many questions lowers applications".
- **Standard questions.** New jobs get the admin's standard questions automatically (trigger on `jobs` insert). Open jobs that already existed get them once, from the migration. The admin edits the set on **AI Settings → Screening questions** (stored in `app_settings.screening`):

  | key | question | type | default weight |
  |---|---|---|---|
  | `notice_period` | What is your notice period? (Immediate / 15 / 30 / 60 / 90 days / Serving notice → last working day) | single choice + date | 5 |
  | `current_ctc` | Current CTC (LPA) | number | 0 |
  | `expected_ctc` | Expected CTC (LPA) | number | 5 |
  | `current_location` | Where are you currently located? | short text | 0 |
  | `relocate` | Are you willing to work at {location} ({mode})? | yes/no | 5 |
  | `other_consultancy` | Interviewed for a similar role with any company in the last 6 months through another consultancy? (if yes: which company) | yes/no + text | 0 |

  `{location}` and `{mode}` come from the job. Internships skip the two CTC questions. The "another consultancy" question asks about *any company*. It never names our client.
- **Job-specific questions.** In the editor, the recruiter adds the AI JD Generator's questions (`api/src/ai/jd.js`, typed by `suggestQuestions()`, e.g. "Years of hands-on Java experience?" as a number in years) or writes their own. The editor also lets them reorder, delete, set a weight (0–10) and mark a question as a **Must-have** with a simple rule:
  - yes/no: must be Yes (or No)
  - notice period: ≤ N days (Immediate, 15, 30, 60, 90; "Serving notice" is measured to the last working day)
  - number: ≥ and/or ≤ a value (e.g. expected CTC ≤ 12 LPA)
  - choice: the allowed choices
- **Where the editor opens.** The **❓ Screening (n)** button beside every job's **Edit** button. In **AI Job Creation**, **Choose screening questions** opens it before the job exists, and the chosen set is saved when the job is published.
- **Changing a live job affects new applications only.** Each answer keeps a copy of the question text it was given.
- The server refuses a question that contains the job company's name, or the word "client". Candidates read the questions.

## Applying

1. The candidate taps **Apply Now** (or Easy Apply). A screen titled "A few quick questions" opens: one screen, pre-filled from the candidate's saved answers or their profile, with a progress line such as "3 of 5 answered". **Back** keeps the answers. A **Use these answers for my next applications** checkbox saves them to `candidate_screening_defaults`, only when ticked.
2. `POST /api/applications` takes `answers: [{questionId, answer}]` and `saveScreeningDefaults`. The server checks every answer against its question's type and options before anything is written, so a refused submission leaves no application. The application and its answers are created in **one transaction**.
3. **Must-haves never reject anybody and are never shown to the candidate.** A failed must-have sets `screening_status = 'knocked_out'`, and the candidate sees the normal "Application submitted". The recruiter decides. The optional per-job **Auto-reject must-have failures** setting is off by default. When it is on, the existing polite rejection message goes out after 24 hours, never instantly. The stage-history note that goes with it, which the candidate can read, says only "Closed after screening review".

Other apply paths, such as one-click apply, call `window.TLScreening.beforeApply(jobId)` first. It returns `null` when the job asks nothing, `{answers, saveDefaults}` when the candidate answered, or `{cancelled:true}`. The next `POST /api/applications` for that job then carries the answers automatically.

## Applications that arrive without answers

This covers Naukri/Shine intake, imports, a recruiter adding a candidate, and any apply path that sent no answers. A trigger starts the application as `pending` when its job has questions, or `not_required` when it has none.

- A sweep (every 5 minutes) sends each new pending application a **no-password link** by email, SMS and WhatsApp. The link goes to `#/screening-answers/<token>`. The token is an HMAC (`AUTH_SECRET`) over the application id, a nonce and the expiry. It belongs to **one application**, is valid for **7 days**, and **works once**: the nonce is cleared when the answers are stored. **Re-open answers** issues a new nonce, which retires the old link. The token travels in the URL fragment and in the request body, never in a path or query string.
- **One reminder after 48 hours** if the application is still pending. The reminder is claimed in SQL (`screening_reminder_claim`), so two sweeps cannot both send it.
- **Answered on call.** The recruiter opens the answers panel, chooses **📞 Answered on call** and types the answers. They are stored with source `recruiter_call` and "Answered on call by <recruiter>".
- Answers arriving by link or by phone re-run the screening (`screenApplication(force)`).
- Every message is recorded in `screening_link_deliveries` with the provider's own answer. SMS and WhatsApp are not sent between 21:00 and 08:00 IST. WhatsApp is `not_configured` until an approved template name is set. Do-not-contact and opt-outs are respected. Messages name the role and never the company. Templates live in `api/src/notify/templates-screening.js` and are listed on Notification Settings as "Screening Questions — Answer Link / Reminder".
- The optional "AI call asks the pending questions" (source `ai_call`) has a source value reserved but is **not** wired to the AI calling agent.

## Scoring (`api/src/ai/screening.js`)

- The resume score is unchanged and is still `ai_score`.
- `screening_answer_score` (0–100) is the weighted average of the answers that can be judged:
  - a must-have scores pass 1 / fail 0
  - notice: Immediate 1, ≤15 days 0.9, ≤30 0.75, ≤60 0.45, ≤90 0.25
  - expected CTC: ≤ the job's maximum salary 1, ≤ 15 % over 0.6, more 0.2
  - relocate: yes 1 / no 0
  - other yes/no questions: yes 1 / no 0
  - current CTC, location, free text and dates are left out rather than counted as a zero
- `screening_combined_score = resume × (100 − W)/100 + answers × W/100`. W is the admin's **Screening answers weight** (`app_settings.ai.weightScreeningAnswers`, default 20). The resume weights scale to fill the rest. Until the answers arrive, combined = resume score and the list says "Answers pending".
- The combined score decides the auto-shortlist verdict. A `knocked_out` application is **never auto-shortlisted**, whatever the score.

## Recruiter screens

- **Applications list.** Each row gets badges: **⚠ Must-have not met** (red, with the failed questions on hover), **Answers pending** (grey), ✓ Answers in, and **Combined n%**. It also shows a "Notice · Exp. CTC · Relocate" line and a **📋 Answers** button. Above the table there are filters (must-have not met / met / pending, notice ≤ N days, expected CTC ≤ X LPA) and a bulk **✉ Send screening questions** button for the ticked rows.
- **Answers panel.** It shows the resume, answers and combined scores, every answer with who answered and when, the failed must-haves, **Re-open answers** (sends a new link) and **Answered on call**.

## Privacy and access (RLS)

| who | questions | answers |
|---|---|---|
| candidate | `job_screening_questions_public_v`: open jobs and jobs they applied to, **without** must-have flags, rules or weights | `candidate_screening_answers_v`: their own, **without** the knock-out flag. Written only through `screening_record_answers()`, and only while `pending` (once, unless re-opened) |
| recruiter | their own jobs (owner may edit) and jobs they handle applications for | on every application they can already see |
| BDE | jobs they handle applications for | on applications they can see |
| admin | all | all |
| client | none | `client_screening_answers_v`: only client-visible stages of their own company. No knock-out flag, no weights, no "who answered", and no "another consultancy" answer unless the recruiter ticked **Share answer with client** |

The candidate's API responses never contain a must-have flag, rule, weight or the job's budget.

## Client submission and exports

- `buildExport()` (`api/src/ats/push.js`) adds `screening: {noticePeriod, lastWorkingDay, currentCtcLpa, expectedCtcLpa, currentLocation, willingToRelocate, answers:[{question, answer}]}`.
- The Excel/CSV export (`api/src/routes/exports.js`) gains the columns Notice (screening), Current CTC (screening), Expected CTC (screening), Current Location (screening), Willing to Relocate, and Screening Answers. These are taken from the candidate's latest application.
- Both exports apply the same exclusions as the client view.
- The export aliases are now quoted, which also fixes the existing camelCase columns ("Applied For", "Notice Period", …), which used to export blank.

## API

```
GET  /api/jobs/:id/screening-questions          staff: full set + editable; others: public set (+ pre-fill)
PUT  /api/jobs/:id/screening-questions          {questions, autoRejectKnockouts}
POST /api/screening/suggestions                 {jobId} or {title, skills, location, postingKind}
GET  /api/screening/settings                    PUT (admin) {standard, answerWeight}
GET  /api/screening/applications?jobId=&ids=    list badges
GET  /api/screening/applications/:id            answers panel (client/candidate get their own views)
POST /api/screening/applications/:id/answers    answered on call
POST /api/screening/applications/:id/reopen     new link, sent now
POST /api/screening/send                        {applicationIds} bulk
POST /api/screening/link/view                   {token}
POST /api/screening/link/submit                 {token, answers, saveDefaults}
POST /api/applications                          + answers, saveScreeningDefaults
```

## Tests

- `api/test/screening-questions.test.mjs` (DB 5467, API 9987, mock 9864) covers: the six-question limit (route and SQL), validation per type, apply-plus-answers atomicity, knock-out rules (≤, ≥, equals, in, days), knocked-out never shortlisted, the combined score, RLS (candidate A/B, another company's recruiter, client stage and sharing), the client name never appearing in questions or messages, the link (once only, only its own application, 7-day expiry, replaced on re-open), the 48-hour reminder, re-screening, exports, admin settings and suggestions.
- `tools/verify-screening-questions.mjs` is the browser check. Run it against an isolated instance whose SMTP points at the script's own sink:

  ```
  TL_URL=http://localhost:4424/ TL_SINK_PORT=2604 node tools/verify-screening-questions.mjs
  ```
