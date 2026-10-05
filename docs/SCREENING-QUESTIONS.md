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
- **AI calls ask the pending questions** (optional, off by default). See the next section.

## Screening questions on AI calls (0104)

When AI calling is set up and the admin switches on **AI Settings → Screening questions → AI calls ask the pending screening questions** (`app_settings.screening.askOnAiCalls`, default `false`, `PUT /api/screening/settings {askOnAiCalls}`, admin only), a call that the AI calling agent is **already making** about a job also asks that application's unanswered questions.

- **Who is called, and when, does not change.** Nothing queues, dials or retries because of this setting. It only changes what a call asks. Turning it on calls nobody (tested).
- **Only pending applications.** The agent gets the questions when the call starts, and only if the application is `pending` and its job has questions. An application that is already answered, knocked out or `not_required` is not asked anything new.
- **What the agent may say.** The agent sees the public question (text, type, choices, unit), the same thing the candidate sees on the form. It never gets the must-have rule, the weight or the job's budget. Question texts were already checked at save time, so they never contain the client's name or the word "client". Hindi and Telugu calls use the agent's own lines around the question; the question text stays in English, like every technical word on these calls.
- **How it asks** (`api/src/ai/call/agent.js`):
  - The job's questions come after everything the call already asks, one at a time, and before "shall we take this forward?".
  - A question the call has already settled is filled from what the candidate said rather than asked twice: notice period from "How soon could you join?", expected CTC from the salary question, and relocation from "Would <city> work for you?".
  - A question with a saved answer or a profile value (the same pre-fill as the apply form) is confirmed in one line: "Where are you currently located? I have Hyderabad on record - is that still right?". "Yes" keeps it. An answer given straight away ("No, I'm in Pune now") is taken. "No" asks the question.
  - Spoken answers are read by type: yes/no in English, Hindi or Telugu; amounts like "6 lakhs" go to LPA; notice periods map to the choices, and a date counts as "Serving notice" with that last working day; choices are matched by name; dates are read from forms like "15 March", "15/03/2027" or "in 20 days". Follow-ups are asked: the last working day, and which company for "another consultancy".
- **Same validation.** Every answer goes through `normaliseAnswer()` during the call. An answer that would be refused (for example a CTC above the question's maximum) is asked once more, then left for the no-password link. At the end of the call the set is stored with `prepareAnswers()` → `screening_record_answers()`, source `ai_call`, "Answered on an AI call". That is the same path the form, the link and "answered on call" use. The application is then screened again (`screenApplication(force)`), so must-haves, the answer score and the combined score work exactly as for any other answer.
- **Complete sets only, and never over newer answers.** The answers are stored only when every question was answered **and** the application is still `pending`. This is checked under a row lock, so answers that arrived by the link during the call are never overwritten (tested). A partial set is recorded on the call (event `screening.answers` in `ai_call_events`, with the answers and the reason). The application then stays pending, and the link and its reminder carry on.
- The call summary says "Answered N of M screening questions on the call." It never mentions a must-have result, because that summary also reaches the candidate's inbox.
- `GET /api/ai-calling/plan` shows the questions the call would ask (`plan.screening`) before anybody is dialled.
- After a restart mid-call, the conversation is rebuilt with the same questions and pre-fill, so answers already given are not asked again.

## "Current location" uses the places search

On the apply step, the no-password link page and the recruiter's **Answered on call** form, the current-location question (`std_key = current_location`, or any short-text question with `options.places`) suggests places as the person types. Free text is still accepted.

- The suggestions come from the same in-memory place index as every other location field (`treeSearch`, states down to villages). Signed in, the form uses `GET /api/places/search`. The no-password page has no session, so it uses `POST /api/screening/link/places {token, q}`. That route answers only for a live link token (invalid, expired, replaced or used → the same 410/409 as the link itself), and the token travels in the body. Without a place index on the server it answers `{results: [], unavailable: true}` and the field stays a plain text box.
- A pick fills "Name, State", for example "Nellore, Andhra Pradesh", so two places of the same name can be told apart. Each suggestion shows its kind and path, for example "Mandal · NTR · Andhra Pradesh". Arrow keys, Enter and Escape work, and the list is a `combobox`/`listbox` for screen readers.

## The screening link and one-click Undo

A one-click application can be undone for 10 seconds (see PORTAL-UPGRADES.md). The sweep does not send the no-password link to an application whose candidate messages are still held for that window (`application_outbound_holds`, 0104). It sends the link on its next pass after the hold has gone out. An undone application never gets one.

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
GET  /api/screening/settings                    PUT (admin) {standard, answerWeight, askOnAiCalls}
GET  /api/screening/applications?jobId=&ids=    list badges
GET  /api/screening/applications/:id            answers panel (client/candidate get their own views)
POST /api/screening/applications/:id/answers    answered on call
POST /api/screening/applications/:id/reopen     new link, sent now
POST /api/screening/send                        {applicationIds} bulk
POST /api/screening/link/view                   {token}
POST /api/screening/link/submit                 {token, answers, saveDefaults}
POST /api/screening/link/places                 {token, q, limit?}  place suggestions for the link page
GET  /api/ai-calling/plan?candidateId=&jobId=   + plan.screening when the AI-call switch is on
POST /api/applications                          + answers, saveScreeningDefaults
```

## Tests

- `api/test/screening-questions.test.mjs` (DB 5467, API 9987, mock 9864) covers: the six-question limit (route and SQL), validation per type, apply-plus-answers atomicity, knock-out rules (≤, ≥, equals, in, days), knocked-out never shortlisted, the combined score, RLS (candidate A/B, another company's recruiter, client stage and sharing), the client name never appearing in questions or messages, the link (once only, only its own application, 7-day expiry, replaced on re-open), the 48-hour reminder, re-screening, exports, admin settings and suggestions.
- `api/test/screening-calls-and-undo.test.mjs` (DB 5466, API 9986, mock 9974) covers the AI-call questions: off by default; an admin-only switch that survives a save of the questions and calls nobody; a call that asks and stores all six as `ai_call` (notice taken from earlier in the call, never asked twice; no rule or weight reaches the agent; no client name spoken); a refused answer asked twice and then left pending with nothing stored; link answers arriving mid-call not overwritten. It also covers the link page's place route (token-gated, the same results as `GET /api/places/search`, refused once the link is used) and the screening link waiting for the Undo window. Calls use the local telephony driver only. The engine's date reader and answer parser are exported (`parseSpokenDate`, `parseScreeningAnswer`).
- `tools/verify-screening-questions.mjs` is the browser check. It now also picks a place from the suggestions on the apply step (phone and desktop), the link page and the "Answered on call" form, and checks the admin AI-call switch. Run it against an isolated instance whose SMTP points at the script's own sink:

  ```
  TL_URL=http://localhost:4424/ TL_SINK_PORT=2604 node tools/verify-screening-questions.mjs
  ```
