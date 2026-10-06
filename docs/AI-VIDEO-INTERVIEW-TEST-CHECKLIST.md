# AI video interview - test checklist

**A** = covered by an automated check (`api/test/ai-video-interview*.test.mjs`
= API, `tools/verify-ai-video-interview.mjs` = browser). **M** = by hand.

```
# API (one file at a time)
node --test api/test/ai-video-interview.test.mjs
node --test api/test/ai-video-interview-model.test.mjs
# browser, against an ISOLATED instance (never the live one)
TL_URL=http://127.0.0.1:<port>/ node tools/verify-ai-video-interview.mjs
```

## Interviewer rules
| | | |
|---|---|---|
| The owner's bad examples become the good ones | A | API |
| No gap phrasing reaches a candidate (rules planner, and a mocked model that writes it) | A | API |
| Every question is under 25 words | A | API |
| Age, religion, caste, marital status, health, nationality are blocked; "Gap analysis" is not | A | API |
| At most one follow-up per question; a retry gets the same one; the database refuses a second | A | API |
| A concrete answer gets none; a vague one gets one of the four templates | A | API |
| "No experience" gets "Thank you for being open. How would you approach learning it?" and the next question | A | API |
| The model can only choose a template; free text from it is ignored | A | API |
| A bad or unreachable model never blocks the interview | A | API |
| With a real model: read 15 questions for a role you know; they sound natural, not scripted | M | needs `AI_API_KEY` |

## Permission denied
| | | |
|---|---|---|
| The camera is refused: message, numbered steps, Retry | A | browser |
| Retry works once it is allowed; the help disappears | A | browser |
| No camera, or the camera in use by another app (real hardware) | M | |
| The permission is revoked in the middle of the interview (camera off for 5 s ends it - existing rule) | M | |
| A browser with no `getUserMedia` / an http page | M | |

## Slow network and dropped connection
| | | |
|---|---|---|
| Offline: "Reconnecting...", the timer stops, the words so far are kept | A | browser |
| Online again: the same question resumes, with the earlier words in the transcript | A | browser |
| A retried answer is not counted twice; progress says where to carry on | A | API |
| A reload mid-interview resumes from the server | M | |
| A throttled connection (DevTools "Slow 3G"): saves and uploads show "taking longer than usual" and complete | M | |
| An upload that is refused for good says so and the spoken answer is still saved | M | |
| Close the tab with an upload pending: the text answer is on the server; the recording may not be | M | |

## Long answers
| | | |
|---|---|---|
| The 40 s timer turns the pill amber at 10 s, with no sound, and submits at 00:00 (12 s in the test) | A | browser |
| Submit answer early moves on | A | browser |
| A caption longer than the transcript box scrolls and stays at the newest line | A | browser |
| A 40 s answer in a real browser keeps its live captions (the recogniser restarts itself) | M | |
| A 25 MB recording limit: answers are ~1-3 MB at 40 s; raise `INTERVIEW_RECORDING_MAX_BYTES` if recordings are made longer | M | |

## Silent candidates
| | | |
|---|---|---|
| Say nothing: the timer runs out, the answer is recorded as unanswered (score 0), the interview moves on, no follow-up | A | API (silence) |
| Mute mic: the status says so; the recorder keeps running; no captions | M | |
| A browser with no speech recognition: the note "Live captions aren't available in this browser - your spoken answer is still recorded." shows and no caption is invented | M | (stubbed away in the browser test) |
| The candidate pauses for 3+ seconds mid-answer: nothing interrupts them | M | the timer is the only limit |

## Layout
| | | |
|---|---|---|
| 1280: header, two equal columns (gap 16, min height 400), full-width transcript, centred controls | A | browser |
| The camera is mirrored, `object-fit: cover`; the camera-off avatar does not cover a live picture | A | browser |
| The mic level bar moves with the microphone | A | browser |
| The font, colours, 16 px radius, 30 px question | A | browser |
| 390: camera, question, transcript, controls stacked; controls sticky at the bottom; no sideways scroll | A | browser |
| 768 and 1024 widths; landscape phone | M | |
| Safari on iPhone (safe-area padding, MediaRecorder as MP4) | M | |
| A screenshot review at 1280 and 390 | A | `TL_SHOTS=<dir>` writes them |

## Keyboard only and accessibility
| | | |
|---|---|---|
| Tab to Start, Turn on camera, Continue, Start the questions, Submit, End interview; Enter activates | A | browser |
| Visible 3 px focus ring | A | browser |
| Every control is a `<button>` with an `aria-label`, at least 44 px | A | browser |
| The transcript is `aria-live="polite"` and 150 px high | A | browser |
| End interview opens a dialog; Escape cancels; Tab stays inside; the safe choice has focus | A | browser |
| `prefers-reduced-motion`: transitions are off | A | browser |
| Screen reader pass (NVDA / VoiceOver): the timer, the status line, the banner | M | |
| Contrast of the palette in use: amber `#7A4A00` on `#FFF4DE` 6.9:1, secondary text 7.2-8.0:1, white on accent 7.8:1, destructive 6.5:1, the green tick 5.0:1 (lowest) | M | computed from the WCAG formula; re-check if a colour changes |

## Saved data and access
| | | |
|---|---|---|
| Recordings are saved per question and per follow-up, linked to interview, question, candidate, job, application | A | API + browser |
| The transcript, with follow-ups, is on the interview | A | API |
| The recording is a real WebM that the job's recruiter can download | A | browser |
| Another candidate and a recruiter outside scope get nothing; no sign-in gets 401 | A | API |
| An HTML file named .webm is refused; an oversized or empty file is refused | A | API |
| A staff view of a recording is audited | A | API |
| The candidate cannot post a score, edit an integrity flag or reopen an interview; fields added to `/answer` are ignored | A | API |
| The candidate sees no score, ranking or decision at any point | A | browser |
| No page errors (the only console messages ignored are the pre-existing MediaPipe CSP warning and offline network errors) | A | browser |

## Regression (existing)
`api/test/api.test.mjs` (the AI interview section), `api/test/interview-prep.test.mjs`,
`tools/verify-interview.mjs`, `verify-interview-proctoring.mjs`,
`verify-interview-says-thanks-once.mjs`, `verify-interview-end-to-end.mjs`,
`verify-interview-scoring-is-real.mjs`, `verify-action-required.mjs`,
`verify-portal-upgrades.mjs`.
