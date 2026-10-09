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
