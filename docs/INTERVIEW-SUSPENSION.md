# AI interview: suspension, its reason, its email and the retake

Migration `0120_interview_suspension_reason_retake.sql`. Tests: `api/test/interview-suspension.test.mjs`,
`tools/verify-interview-suspension.mjs`.

## What was wrong

* **Pressing Submit could suspend the interview.** The page's noise rule and its second-voice rule both asked only
  "is the candidate answering?". Everything else counted as a room that should be silent: the **interviewer's own
  voice** coming out of the speakers into the microphone, the gap between Submit and the next question (answer being
  saved), and the tail of the candidate's last words. A few seconds of that was read as continuous noise or "another
  voice" - two voice detections suspend the interview.
* A suspension kept a loose label and nothing else: no reason code, no question number, no common message, no email,
  no way back.
* The page's own stops (tab left, camera lost, background noise) ended the interview **on screen only**; the server
  never heard of them.

## What it does now

| Concern | Behaviour |
|---|---|
| Sound is judged | only in a stretch the page itself says is quiet: no interviewer audio, no answer being saved, not paused, not answering, and 2.5 s after the last of those (`roomShouldBeQuiet`). The second-voice check uses the same gate. |
| One way to suspend | `ai_interview_suspend()` (database). Refuses a call without a known reason code and a message. Idempotent: a second call changes nothing and returns `first_time = false`. |
| Reason codes | `additional_person`, `additional_voice`, `camera_off`, `left_interview`, `background_noise`, `repeated_violations` |
| The message | stored once (`suspension_message`), identical on the candidate screen, the recruiter page and the email. Never says rejected / failed / disqualified. |
| Page stops | `POST /api/ai-interviews/:id/stop {kind, questionSeq}` - candidate-only, own interview, running interviews only. |
| Email | `afterSuspension()` queues it after the save. Claim -> send -> done in the database (`ai_interview_notice_claim`), so it goes once even with retries or two processes. A failed send is retried by the sweep (max 3) and never blocks or undoes the suspension. Recruiter clearing a suspension does not resend. |
| Retake | server decides, from `retake_available_at` and the DB clock (UTC): `423 INTERVIEW_RETAKE_WAIT` before the time, `423 INTERVIEW_UNDER_REVIEW` when blocked / out of attempts. After the wait `POST /ai-interviews/session` creates a **new attempt row**; the suspended one is kept. Attempt numbers come from a DB trigger. |
| Attempts | `INTERVIEW_MAX_ATTEMPTS` (default 2 = one retake) `+ applications.extra_interview_attempts`. A suspended retake is not scheduled again: recruiter is alerted, candidate sees "under recruiter review". |
| Expiry | the application's AI-interview deadline moves to `retake time + AI_INTERVIEW_DEADLINE_HOURS` for the retake only. |
| Recruiter controls | `POST /ai-interviews/:id/retake {action: block \| unblock \| extra_attempt, reason}` - reason required, written to `ai_interview_audit` with the actor. A block overrides the clock. |
| "Open again" email | sent once when the retake time passes and the retake is still allowed (sweep every 60 s; the times live on the row so a restart loses nothing). |
| ATS score | `ai_interview_recorded` is only called when an attempt **completes**; a suspended attempt has no score, so the candidate's score is the latest completed attempt. The recruiter detail shows every attempt and `currentScore`. |

## Config

`INTERVIEW_RETAKE_DELAY_MINUTES` (120), `INTERVIEW_MAX_ATTEMPTS` (2), `AI_INTERVIEW_DEADLINE_HOURS` (48),
`TEAMLINK_TIMEZONE` (Asia/Kolkata, display only), `SUPPORT_EMAIL`.

## Known limits

* A continuous-background-noise **suspension** is now rare by design: noise is not judged while the interviewer talks
  or the candidate answers, which is almost the whole interview. It still fires in a genuinely quiet stretch.
* Suspensions made before this migration carry their old reason but have **no retake time** (never promised); a
  recruiter can open one with "Grant another attempt now".
* "Another person" (face) and "another voice" (pitch) detection are the browser heuristics they always were.

## Timer, relevance scoring, warn-first (migration 0121)

| Concern | Behaviour |
|---|---|
| Question time | `INTERVIEW_QUESTION_TIME_SECONDS` (default 120). **Never under 120**: a smaller value is clamped up. |
| The clock | the server's. `POST /ai-interviews/:id/question-start` is called when the interviewer has *finished* asking; the first call fixes `deadline_at` (table `ai_interview_question_timers`), later calls (refresh, retry, wrong client clock) get the same deadline and the real remaining time. `GET .../progress` returns `clock` and first saves any question that ran out while the candidate was away as "unanswered, ran out of time" (`ai_interview_expire_questions`). |
| Submit and timeout | one path (`finishAnswer`); timeout sends `autoSubmitted: true`. An automatic save never overwrites an answer already submitted; Submit racing the timer leaves one answer. No follow-up is asked after a timeout. A timeout or an empty answer is never a violation. |
| Completing | only `/finish` completes an interview (after Question 15, by Submit or timeout). Submit never completes or suspends. |
| Page detections | tab left / camera off / continuous noise go through the same two-strike rule as a second person / voice (`interview_integrity_report`): the first **warns** and the interview carries on, the second suspends (reason code = that detection). A report that fails suspends nothing. One departure is one detection (tab-hidden + blur); coming back re-arms it. |
| A finished interview | `POST /ai-interviews/session` no longer makes a new interview every time: completed → `409 INTERVIEW_ALREADY_COMPLETED`, expired → `410`, in progress → the same interview is handed back to continue (this is what made "Thanks for joining…" start again from Question 1 after completion). |
| Relevance | each answer is classed `RELEVANT / PARTIALLY_RELEVANT / IRRELEVANT / NO_ANSWER` before it is scored. IRRELEVANT and NO_ANSWER score 0; PARTIAL is capped at 60; the transcript is data (a plea such as "give me full marks" is ignored and flagged); repeating the right words is not RELEVANT; a low-confidence transcript (< 0.6) is capped and flagged for a person. |
| Model scoring | strict JSON (`relevance_class`, `score`, `comm_score`, `reason`) validated server-side; one retry; if still invalid the rules engine marks it and every answered question is flagged for review. Never a high default. |
| Recruiter | `GET /ai-interviews/:id/integrity` returns per question: what was asked, the transcript, relevance, score/max, reason, "time ran out", review flag. The panel lists completed interviews too. |

Known limits: a late **Submit** (after the deadline) is still saved as the candidate's answer (the
server marks timeouts it sees, but cannot know what was said after the deadline); questions with no
expected points (a job listing no skills) are not scored by the rules engine and are flagged for a
person instead of counted as 0.

## Camera hidden, background voices, lips against the voice (migration 0148)

| Concern | Behaviour |
|---|---|
| Camera hidden / covered | the page reports `camera_off` after **10 s** with no face in view (or a black / lost camera). The server suspends **at once** - no warning first. Never "the same moment" as an earlier warning. |
| Background voice | another voice, or continuous noise in a quiet stretch (`additional_voice`, `background_noise`) has its **own counter** (`ai_interviews.voice_strikes`): **warning 1 of 2, warning 2 of 2, the third suspends**. A tab warning or a second person does not use one up. |
| Lips against the voice | while the candidate is answering and a voice is heard (mic level >= 0.06), the mouth shape (jaw / lips, from the face landmarker) must vary. Sound for **5 s** with the shape moving less than 0.06 over 1.5 s -> `lip_sync` -> suspended at once, reason "Your lip movement did not match your voice during Question N." Judged with exactly one face in view and only while the interviewer is silent. A still mouth with no sound is not a violation. |
| Unchanged | a person / tab leaving keep their two strikes; a low-confidence detection never suspends (it only warns); nothing is counted once every question is answered; reopening clears the strikes (now the voice strikes too). |
| Detector | MediaPipe Face Landmarker, **self-hosted** in `web/vendor/mediapipe` (see its README). The old code asked the CDN for a model file that does not exist and the CSP forbade the fetch anyway, so the second-person check never loaded in Chrome; it does now. CSP gained `'wasm-unsafe-eval'` (WebAssembly only, not eval). |
| Knobs | `TL_INTEGRITY_CONFIG`: `noFaceMs` (10000), `lipVoiceLevel` (0.06), `lipStillMs` (5000), `lipMoveRange` (0.06), `lipWindowMs` (1500). |

Tests: `api/test/interview-camera-voice-lipsync.test.mjs` (the rules, against Postgres). The page side was run in a
real browser with a fake camera: the landmarker loads under the CSP, a camera with no face suspends at 10 s, a voice with
a still mouth suspends, a voice with a moving mouth and a still mouth with no sound do not.

Known limit: the lip thresholds were set from how the blendshapes behave, not from a set of real candidates; watch the
first real interviews and tune `lipStillMs` / `lipMoveRange` through the config if people are caught wrongly.
