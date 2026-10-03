# Interview prep kit

When a recruiter schedules an interview for a candidate, the candidate automatically gets a prep kit. The kit contains the interview details, likely questions with a one-line "why they ask this", tips, a bring-list they can tick off, a calendar file and reminders. Migration `0098_interview_prep_kit.sql`.

## The client is never named

Candidates must never learn the client's name from us (0051). The kit enforces this in several places:

- `candidate_interview_prep_v`, the only thing a candidate reads, has **no company column**. It also leaves out the interviewer's name, which is usually somebody at the client.
- The rules engine has no company input.
- The AI engine is sent the job title, skills, experience range, interview type and the description, with the company name, emails, phone numbers and links removed. It is never sent the client, the candidate's contact details or any id. Its answer is rejected if it names the company or uses the word "client". It is also rejected if it gives a salary figure or promises an outcome. A rejected answer falls back to the rules.
- Recruiter edits pass the same check.
- Messages (`api/src/notify/templates-interview.js`) and the `.ics` carry the role and round, never the company.
- The candidate's Interviews page now has **📘 Prep Kit** where it had "Prepare with AI". The old `interviewPrepFor()` put the company into a question ("Why … at <company>?"). It is replaced on the candidate side by the kit's questions, or by a company-free generic set.

**The one exception is the venue address or meeting link.** The recruiter types it and it stays hidden (the view returns null) until they tick **Release venue / meeting link to candidate**. The form warns "The address may reveal the company. Release only when confirmed with the client."

## Recruiter side

- **Schedule Interview** now has these fields: round (Technical / Client Round / HR Round / AI Interview), where (in person / video / phone / TeamLink AI), venue address or meeting link, duration, contact person (defaults to the scheduling recruiter) and phone, instructions for the candidate (≤ 1000 characters), the release toggle with its warning, and **Send the prep kit with the invitation** (on by default; off holds the kit back for a check first). `POST /api/interviews` accepts these fields.
- **Applications list.** Rows with an interview show **Kit sent ✓ · Viewed ✓ · Checklist n of m** and a **📘 Prep kit** button.
- **Prep kit panel.** On the left: the interview details (save, release), the kit content (edit questions, tips and bring-list), **↻ Regenerate** and **✉ Send now**. On the right: **exactly what the candidate sees**, and every message sent with each channel's result. It also shows which engine made the kit (rules / AI) and why.

## Building the kit (`api/src/interview/prep-kit.js`)

- **Triggered** when an interview is created. It is refreshed when the date, time or mode changes, and when the location type is changed in the panel. A recruiter's edits are kept on a refresh. **Regenerate** starts again from scratch.
- **Questions (6–10)** depend on the round:
  - **Technical / Client Round**: an opener, a hands-on question per key skill (basics for freshers, hands-on for mid-level, trade-offs for senior, from the job's experience band), a project walkthrough, a problem-solving question, motivation, and "your questions".
  - **HR Round**: introduce yourself, why this change, notice period and joining, current and expected CTC, strengths and weaknesses, career plans, relocation, and "your questions".
  - **AI Interview**: how it works (about 15 spoken questions, about 20 minutes, no going back), 3 practice questions, and the integrity rules the interview already enforces (single tab, camera on and uncovered, quiet room, a second person or voice is warned then suspended). The rules are taken from `teamlink-interview-integrity.js` and the AI interview docs. Nothing is invented.
- **Tips and bring-list** depend on the location type:
  - in person: 15 minutes early, 2 printed resumes, photo ID, passport photos, certificates, venue address offline, formal dress
  - video: test camera, microphone and internet 10 minutes before, quiet room with a plain background, charger, join 5 minutes early
  - phone: quiet place, charged phone, resume in front of you
  - TeamLink AI: the AI interview checklist

  The recruiter's own instructions are shown above them.
- **Rules engine**: always available.
- **AI engine**: used when `AI_API_KEY` is set. It uses the official `@anthropic-ai/sdk` and model `AI_PREP_MODEL` (default `claude-opus-5-5`), with `output_config: {effort: "low", format: json_schema {questions[], tips[]}}`, `betas: ["server-side-fallback-2026-07-01"]` and `fallbacks: "default"`. The system prompt is frozen, with `cache_control`, and there is no prefill. The engine checks `stop_reason`: refusal, max_tokens and errors fall back to the rules. The timeout is 15 seconds (`AI_PREP_TIMEOUT_MS`). `AI_API_BASE_URL` points it at a local mock in tests. The kit is first made with the rules, so scheduling never waits on a model; the AI version replaces it in the background unless a recruiter has edited the kit in the meantime. `generated_by` and `engine_note` record which engine ran and why.

## Candidate side

`#/candidate/interview-prep/<interviewId>` is mobile-first and uses the site's candidate shell. It shows:

- the role title (no company), date and time, duration, round and mode
- **Where**:
  - in person: the venue once released, with an **Open in Google Maps** link
  - video: a **Join interview** button that becomes active 15 minutes before the start
  - phone: "the interviewer will call you"
- the contact person (once released)
- the recruiter's instructions
- the likely questions; tapping one shows why interviewers ask it
- tips
- the bring-list as a checklist; ticks are saved
- **📅 Add to calendar**: `.ics` with a 2-hour alarm, no company
- **💬 Practice with AI Assistant**: calls `window.TLCareerAssistant.openWith({interviewId})` when that exists, otherwise opens `#/candidate/assistant`

Opening the kit sets `viewed_at` once.

**Language.** Candidates have no stored *preferred language*, only `candidates.languages`, the languages they speak. The kit is therefore shown in **English only**, and no Telugu or Hindi translations were added. When a preference is introduced, `candidateView()` is where to switch the tips and bring-list.

## Messages

All messages go through `api/src/notify/direct-send.js`. It follows the same rules as every TeamLink message: opt-outs, do-not-contact, WhatsApp `not_configured` until an approved template is set, and recording each provider's real answer in `interview_prep_messages`. Each message is listed on Notification Settings as "Interview Prep Kit — Scheduled / Reminder / Rescheduled / Cancelled".

| when | message |
|---|---|
| scheduled | "Interview scheduled — <role>, <date> <time>. Your prep kit: <link>" (replaces the old INTERVIEW_SCHEDULED message, which named the company) |
| Send now | the kit link again |
| day before, 18:00 IST | reminder, with the venue or link if released. Only for interviews booked before that moment |
| 2 hours before | reminder, with the venue or link if released |
| rescheduled / cancelled | at once. Reminders follow the new time, or stop |
| 2 hours after the end, still "Scheduled" | in-app notification to the **recruiter**: update the status (Completed / No Show) |

- **Quiet hours.** SMS and WhatsApp are not sent from 21:00 to 08:00 IST; email always goes. The exception is the 2-hour reminder for an interview that starts before 10:00.
- **Idempotent.** Each reminder is claimed under (interview, kind, start time) by `prep_reminder_claim`. A sweep that runs twice sends nothing twice. A reschedule changes the start time, so its reminders start afresh. A cancellation stops them, because only `Scheduled` interviews whose kit has been sent get reminders.
- The sweep (`api/src/interview/reminders.js`) runs every 5 minutes, started from `app.js`.

## Access (RLS)

- Recruiters (of the job's company, or owning the job) and admins read and write kits.
- **A client user cannot read kits at all.**
- A candidate reads their own interviews through the view, and only once the kit has been **sent**.
- Checklist ticks go through `prep_kit_candidate_ok()`.
- `viewed_at` is set through `prep_kit_mark_viewed()`.

## API

```
Candidate
GET  /api/candidate/interviews/prep
GET  /api/candidate/interviews/:id/prep-kit
POST /api/candidate/interviews/:id/prep-kit/viewed
PUT  /api/candidate/interviews/:id/prep-kit/checklist   {itemKey, done}
GET  /api/candidate/interviews/:id/prep-kit.ics
Recruiter / admin
GET  /api/interviews/prep-status?ids=
GET  /api/interviews/:id/prep-kit
PUT  /api/interviews/:id/prep-kit                        {questions, tips, bringList}
POST /api/interviews/:id/prep-kit/regenerate
POST /api/interviews/:id/prep-kit/send
PUT  /api/interviews/:id/prep                            {locationType, venueAddress, meetingLink, durationMinutes,
                                                          contactPerson, contactPhone, candidateInstructions, releaseDetails}
POST /api/interviews                                     + the same fields, sendKit
```

## Tests

- `api/test/interview-prep.test.mjs` (DB 5468, API 9988, one mock on 9976 for the providers and the Anthropic API) covers:
  - the kit is made on schedule
  - the company name (an unusual one) never appears in the kit, the messages, the `.ics` or the AI prompt
  - the venue stays hidden until it is released
  - the checklist and viewed status
  - RLS (candidate A/B, a client, another company's recruiter)
  - recruiter edits are kept on reschedule, and an edit naming the client is refused
  - day-before and 2-hour reminders, once each, including the quiet-hours exception
  - the status nudge
  - cancellation stops the reminders
  - the AI engine: request shape, a good answer used, a leaking answer rejected, timeout falls back to the rules
  - the rules engine by experience level and round
- `tools/verify-interview-prep.mjs` is the browser check. The recruiter schedules, the candidate opens the kit and ticks 2 items, the recruiter sees "Viewed ✓ · Checklist 2 of 6", the recruiter releases the venue, and the candidate sees the address and the Maps link. It also checks the `.ics` and the old `interviewPrepFor`:

  ```
  TL_URL=http://localhost:4424/ node tools/verify-interview-prep.mjs
  ```
