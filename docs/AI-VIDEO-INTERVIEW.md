# AI video interview

The candidate-facing AI interview at `#/ai-interview/<application>`: a device
check, a spoken briefing, then one question at a time with a live camera, a
live transcript, a per-question timer, and a recording of every answer.

**This upgrades the AI interview that was already in the product. It is not a
second module.** Every existing route, table, score/evaluation path and
integrity check is kept.

| Kept (unchanged in behaviour) | Changed |
|---|---|
| `POST /api/ai-interviews/session`, `/answer`, `/finish`, the `ai_interviews` and `ai_interview_answers` tables, RLS and the definer functions | The questions are written to the owner's interviewer rules (below) |
| Server-side grading (`evaluate()`), the 50/30/20 aggregates, `content_scored`, the 48 h deadline | At most one follow-up per question, only for a vague answer |
| `ai_interview_due_at`, `applications.stage` (`ai_screening` to `ai_interview_done`), the Action Required "Attend AI Interview" row | The screen: layout, colours, DM Sans, device check, transcript, controls |
| `web/teamlink-interview-integrity.js` (two-strike person/voice rule), `proctorSample`, tab/noise/camera rules | Each answer is saved when it is given, not at the end |
| `web/teamlink-interview-prep.js` (the prep kit), `docs/AI-INTERVIEW.md` | Recordings per question; reconnect and resume |

The candidate is never shown a score, a ranking or a decision. The closing
screen says thank you and what happens next. Scores, the AI evaluation,
recruiter notes, integrity flags and the pipeline decision are written only by
the server (`ai_interview_finish`, `ai_interview_recorded`,
`interview_integrity_report`); a candidate has no route that can write them,
and `POST /api/ai-interviews` (which accepts per-question scores) is now closed
to candidates.

## Files

| | |
|---|---|
| `api/src/ai/prompts/ai-interviewer-system.txt` | the interviewer's system prompt (standalone; loaded by the generator) |
| `api/src/ai/interview-style.js` | the deterministic post-filter, follow-up templates, vagueness and "no experience" detection |
| `api/src/ai/interview.js` | question planning (model or rules) and grading; now uses the two files above |
| `api/src/ai/interview-speech.js` | the optional server STT/TTS plug-in points (off by default) |
| `api/src/routes/ai-interviews.js` | + `/progress`, `/recordings` (upload, list, file), `/speech`; `/answer` takes `part` |
| `api/src/storage.js` | `validateRecording` / `storeRecording` (same driver as resumes) |
| `supabase/migrations/0116_ai_video_interview.sql` | `ai_interview_answer_parts`, `ai_interview_recordings` and their definer functions |
| `web/teamlink-ai-video-interview.js` | the screen's markup, styles, transcript, recorder, uploads, reconnect, dialog |
| `web/index.html` (the `AIIV` module) | wired to the screen: device check, per-answer save, follow-up, controls |
| `web/teamlink-integration.js` | session planning with resume; `TL.finishAiSession` |
| `tools/verify-ai-video-interview.mjs` | Playwright end-to-end check |
| `api/test/ai-video-interview.test.mjs`, `ai-video-interview-model.test.mjs` | API tests |
| `docs/AI-VIDEO-INTERVIEW-TEST-CHECKLIST.md` | the test checklist |

## How the interviewer behaves

The system prompt is `api/src/ai/prompts/ai-interviewer-system.txt` (the
owner's persona, flow, question-style rules, examples, follow-up templates and
behaviour rules). With `AI_API_KEY` set, it is the model's system prompt when it
plans the interview; the job description and resume go in the user turn as
data. A prompt can be ignored by a model, so **every question passes
`enforceQuestion()` before a candidate hears it**, whichever planner wrote it:

* gap phrasing ("I could not find", "your resume does not show", "you did not
  mention", "I don't see", "it is not listed", "missing", "why not", ...) is
  rewritten into the owner's template around the skill, e.g. *"Sourcing is a
  key part of this role. Could you walk me through your experience with it?"*,
  or dropped when there is no skill to rewrite around;
* a question over 24 words is shortened (its closing question sentence) or
  rewritten around its topic, or dropped;
* a question on age, religion, caste, marital status, family plans, health,
  nationality, ethnicity, gender or sexuality, politics or union membership is
  blocked (a skill that merely contains a flagged word, such as "Gap analysis"
  or "Patient health monitoring", is recognised from the job's own skills);
* a dropped question is replaced from the rules planner, so the blueprint
  (2 intro, 5 from the job, 5 from the resume, 3 behavioural) still adds up.

With **no AI key** the rules planner builds the same blueprint from the job
description and resume in the same style, and goes through the same filter.
The skills a resume does not show are still asked about first (a recruiter can
read that in each question's `source`) but the candidate is never told.

**Follow-ups.** At most one per question (enforced by the primary key of
`ai_interview_answer_parts`, not by the browser), chosen only from:
"Could you share a specific example?", "What was the outcome?", "Which tools
or methods did you use?", "What would you do differently next time?". They are
asked only when the answer is vague: deterministically, an answer under 12
words, or with no example, tool or result words (and one that gives an example
with no outcome gets "What was the outcome?"); with `AI_API_KEY` the model picks
a template or none, and anything else it writes is ignored. A retried answer is
offered the same follow-up, never a second.

**"No experience"** ("I have no experience with that", "I've never used it")
is answered with *"Thank you for being open. How would you approach learning
it?"*, then the interview moves on.

The AI never reveals scores or decisions during the interview.

## The screen

Desktop: header (round label in small caps, "Question N of M", timer pill with
a clock), then two equal columns with a 16 px gap and a 400 px minimum (the
mirrored camera on `#101524`, 16 px corners, "Camera on", the candidate's name;
and the white AI panel with the avatar, "Asking question N", the question at
30 px bold, the status line and a mic level bar), then the full-width live
transcript (max height 150 px, then it scrolls), then the control bar (Mute
mic, Turn off camera, Submit answer, End interview with a confirmation).
Below 768 px it stacks (camera, question, transcript, controls) and the
controls are sticky at the bottom; the portal's bottom tab bar and floating
assistant button step aside while an interview is on screen.

Colours: accent `#5B2FC9`, background `#F3F4F8`, text `#15192B`, secondary
`#4A5068`, destructive `#B3261E`. Icons are inline SVG. The mic level is a CSS
bar (a `transform: scaleX`, no canvas, so there is nothing to scale for
`devicePixelRatio`). Controls are real `<button>`s, at least 44 px, with
`aria-label`s and a 3 px focus ring; the transcript is `aria-live="polite"`;
`prefers-reduced-motion` turns all transitions and animation off.

**Font.** DM Sans is loaded from Google Fonts, because the portal's CSP
(`api/src/app.js`, helmet) already allows `fonts.googleapis.com` and
`fonts.gstatic.com`. If it cannot load, the stack falls back to Inter, Public
Sans and the system fonts.

### Flow

1. **Device check** - camera, microphone (a level bar and "We can hear you"),
   internet, and whether live captions are available. Continue is enabled when
   the camera and the connection pass.
2. **Briefing** - greets the candidate by name, says the role, the number of
   questions and the approximate duration, then the conditions. It is spoken.
3. **Questions** - the question is shown, written to the transcript as "AI",
   and spoken. When it has been spoken, the 40 second timer starts, the answer
   is recorded and live captions appear as "You". The last 10 seconds turn the
   timer pill amber (no sound). At 00:00 the answer is submitted for the
   candidate. Submit answer ends it early.
4. **Follow-up** (if the server asks for one) on the same question number, on
   its own timer.
5. **End interview** asks for confirmation; confirming submits the answers so
   far, and unanswered questions are recorded as unanswered.
6. **Close** - thank you, what happens next. No score.

The answer time is 40 s. A test can shorten it with `window.__TLVI_TEST__ =
{ answerSecs }` set before the page loads (that is how
`verify-ai-video-interview.mjs` runs in 12 s). Nothing in production sets it.

## Browser permissions

The interview needs **camera** and **microphone** on a secure origin (https, or
localhost). If the browser refuses, the device check says which, lists the
steps (click the padlock or camera icon, set Camera and Microphone to Allow,
close other apps that use the camera, press **Retry**) and **Retry** asks again.
The page sends no `Permissions-Policy` header, so the portal's own origin may
use both. Speech recognition (the Web Speech API) is Chrome, Edge and Safari;
it may send audio to the browser vendor's service. Firefox has none, so there
the screen says: *"Live captions aren't available in this browser - your spoken
answer is still recorded."* No caption is ever invented; an answer with no
captions is recorded and kept as audio and video.

## Recordings and the transcript

* A `MediaRecorder` records each answer (and each follow-up) and the page
  uploads it to `POST /api/ai-interviews/:id/recordings` (multipart, `seq`,
  `part`, `durationMs`). It goes through the **same storage driver as resumes**
  (`STORAGE_DRIVER`), is identified by its **magic bytes** (WebM, MP4, Ogg or
  WAV, never the browser's word for it), is limited to
  `INTERVIEW_RECORDING_MAX_BYTES` (default 25 MB) and stored under a random key
  `interviews/<candidate>/<interview>/<uuid>.<ext>`. No public URL is ever made.
* `ai_interview_recordings` links each file to the interview, question,
  candidate, job and application. A retried upload replaces itself.
* Each answer's words are saved when it is submitted (`/answer`) and combined
  with its follow-up's into the existing `answer_summary`, which the existing
  grading reads. The full transcript, with follow-ups, is `ai_interviews.transcript`.
* Reading: the **row** is read under the caller's own RLS (the interview's own
  visibility - the candidate, the job's recruiter and client, a BDE, an admin).
  Another candidate, or a recruiter at another company, gets an empty list and
  a 404 on the file. A staff view of a recording is written to
  `ai_interview_audit`.
* If an upload fails it is retried with backoff (up to 12 times) and the
  screen says "Saving your answer recording is taking longer than usual -
  retrying...". A refusal that retrying cannot fix is reported on screen and the
  spoken answer is still saved as text.

## Connection drops

The transcript lives in memory and in `sessionStorage` (per viewer, for
resilience only); **the server is the record**. When the connection drops the
timer stops, the answer so far is kept, and a "Reconnecting..." banner shows.
Requests are retried with exponential backoff. When the API answers again, the
**same question** is asked again with the words already said carried into it. A
reload does the same: the session is resumed from
`GET /api/ai-interviews/:id/progress` (which question, whether its follow-up is
pending, which recordings arrived), not restarted. An answer is never lost
silently: a save that cannot be completed keeps retrying, and the interview
only continues once it has landed.

## Setup

No new dependency. Apply migration `0116` (the dev server and the test harness
apply every migration in `supabase/migrations`). Optional environment, all
read **only on the server**:

| Variable | Default | |
|---|---|---|
| `AI_API_KEY` | unset | question generation and follow-up choice by the model; unset = the rules planner (same style) |
| `AI_MODEL`, `AI_API_URL`, `AI_TIMEOUT_MS` | existing | the model, endpoint and timeout |
| `INTERVIEW_RECORDING_MAX_BYTES` | 26214400 | per recording |
| `INTERVIEW_STT_PROVIDER` | `off` | `http` to transcribe uploaded answers on the server |
| `INTERVIEW_STT_URL`, `INTERVIEW_STT_KEY` | | the endpoint (audio bytes in, `{ "text": "..." }` out) and its bearer key |
| `INTERVIEW_TTS_PROVIDER` | `off` | `http` to speak questions in a server voice |
| `INTERVIEW_TTS_URL`, `INTERVIEW_TTS_KEY`, `INTERVIEW_TTS_VOICE` | | the endpoint (JSON `{ text, language, voice }` in, audio bytes out) and its key |
| `INTERVIEW_SPEECH_TIMEOUT_MS` | 20000 | for either |

## Plugging in speech and question generation

* **Question generation** - set `AI_API_KEY`. `planInterview()` calls the
  model with the system prompt file and filters what comes back. To use a
  different prompt, edit `ai-interviewer-system.txt`; to use another provider,
  change `ask()` in `api/src/ai/interview.js` - the post-filter still applies.
* **Speech-to-text** - the default is the browser's `SpeechRecognition`
  (captions only; the recording is the record). To transcribe on the server,
  set `INTERVIEW_STT_PROVIDER=http` and `INTERVIEW_STT_URL`. After a recording
  is uploaded, if the browser captured no words for that answer, the server
  sends the audio to the endpoint and fills the transcript in. It never
  overwrites words the candidate already has on file, and a provider failure
  loses nothing.
* **Text-to-speech** - the default is the browser's `speechSynthesis`. Set
  `INTERVIEW_TTS_PROVIDER=http` and `INTERVIEW_TTS_URL`; the session reports
  `speech.tts = "server"` and the screen plays
  `GET /api/ai-interviews/:id/speech?seq=N&part=main`, falling back to the
  browser's voice if that fails. The text spoken is always the server's own
  question, never the caller's.

The session response and `/progress` carry only the *mode* (`browser` or
`server`). No endpoint or key is ever sent to the page, written to a log or put
in a response.

## Not included

* Server-side face or voice recognition. The integrity module's checks are
  unchanged (`docs/AI-INTERVIEW.md`).
* A recruiter-side player UI. Recordings are listed and served by the API
  (`GET /api/ai-interviews/:id/recordings`) under the existing access rules.
* Transcoding. Recordings are stored as the browser produced them.
