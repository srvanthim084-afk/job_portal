# Resume score + improvement tips

A 0-100 score for how strong a candidate's resume and profile look to a
recruiter, with specific tips that say what to fix first. Worked out on the
server; it never decides eligibility and no matching code reads it.

## The model (`api/src/resume/score.js`)

Eight weighted sections, from the saved profile and the resume text:

| Section | Points | What earns them |
|---|---|---|
| Contact details | 10 | name, phone, email, location (profile or resume) |
| Professional summary | 10 | present, 2-4 lines (12-90 words), specific - "hard working" / "challenging position" cost points |
| Work experience | 25 | job titles, companies, dates, measurable results ("handled 40 calls/day", "by 20%"); a **fresher's** internships and projects count here instead |
| Skills | 15 | eight or more, and mostly specific (tools, software) rather than generic ("communication") |
| Education | 10 | qualification, institution, year |
| Projects & certifications | 10 | a project with a description; one or two certifications |
| Formatting & readability | 10 | 1-2 pages of text, no wall-of-text paragraphs, one date style, no unexplained gap over 6 months; no resume uploaded = 0 here |
| Keywords | 10 | action verbs, and the skills open TeamLink jobs ask for the preferred role |

Labels: **Needs Work** < 50, **Good** 50-74, **Strong** 75-89, **Excellent** 90+.

Tips are specific (they name the missing skills, the gap, the count), each with
`section`, `priority` (High ≥ 5 points, Medium 3-4, Low), `issue`, `fix`, `gain`
(points it adds) and `field` (the profile field that fixes it). Sorted by
priority then gain; at most five are shown at a time.

**Unreadable resume** (`resume_parse_error`, or almost no text): status
`unreadable`, no total, and the message *"We could not read your resume. Try a
PDF or DOCX"* - never a 0. No resume at all is scored from the profile, with
"Upload your resume" as a tip.

## Optional AI tips (`api/src/resume/score-ai.js`)

With `AI_API_KEY` set, a Re-score asks the model for up to 3 extra tips about
the writing (weak bullets, missing results, vague summary):
official `@anthropic-ai/sdk`, model `AI_TIPS_MODEL` (default `claude-opus-5-5`),
`output_config { effort: "low", format: <JSON schema> }`, a frozen system prompt
with `cache_control`, `betas: ["server-side-fallback-2026-07-01"]` +
`fallbacks: "default"`, `stop_reason` checked before reading. Only the resume
text (phone numbers and emails removed), the skills and the preferred role are
sent. Every tip is validated (section, priority, length, gain 1-10) and dropped
if it names any company on the board or says "client". In Telugu or Hindi when
the browser language is. Shown with an **AI** label. Any failure, timeout,
refusal or bad output -> rule tips only, `engine: "rules"` and the reason.
`AI_API_BASE_URL` points the SDK at a mock server in tests.

## When it is recalculated

Triggers on `candidates` (profile and resume columns, internships /
achievements) and on `candidate_education` / `candidate_experience` put the
candidate on `candidate_resume_score_queue`. The candidate's GET scores a queued
candidate before answering; a sweep (every 5 minutes) works the queue for
everyone else, so recruiters' badges stay current. A row is only written when
the inputs changed (fingerprint), so the history shows real changes. Migration
0094 queues every existing candidate once.

## API

| Method | Path | Who |
|---|---|---|
| POST | `/api/candidate/resume/score` `{ lang?, ai? }` | candidate - Re-score (rate-limited) |
| GET | `/api/candidate/resume/score` | candidate - latest score, tips, `sinceLastWeek` |
| GET | `/api/candidate/resume/score/history` | candidate |
| GET | `/api/resume-scores?ids=a,b` | staff - badges for candidates they can see |
| GET | `/api/candidates?...&resumeScoreMin=70` | staff - the 70+ filter, in SQL |

## Where it shows

Candidate (`web/teamlink-resume-score.js`):

- `#/candidate/resume-score`: ring + label, the eight sections as bars, tips with
  **Fix now** (opens that exact editor on the Profile page: Basic details,
  Summary, Key skills, Education, Certifications, Employment, Projects,
  Internships; Upload resume; Career preferences), AI tips labelled AI,
  **Re-score**, "Score improved from 62 to 78", "+12 since last week", history.
- A compact card on Profile (beside Profile completion - same record, different
  question: completion counts sections filled, the score checks how well) and
  on Resume. The Resume page's older browser-only "AI Resume Quality Score" and
  suggestions now show the server's numbers for the candidate's own profile.
- After a resume upload: "Your resume scored 68/100. Here is how to improve it"
  as a small card with Later / See tips - optional, never blocking.
- Before applying with a score under 60: "Improve your profile to get more calls"
  [Improve] [Apply anyway]. Wraps `window.applyToJob` and `window.easyApply`;
  Apply anyway continues the original apply (and whatever other modules wrapped
  it). Shown once per job per page load. Never blocks.

Recruiter: a `📄 72` badge beside candidate names (profile, Talent Pool, Find
Candidates, Applications), and **Resume score 70+** on the Talent Pool and Find
Candidates filters.

`window.TLResumeScore.get()` returns the latest score object (null until
loaded); `.load(force)` returns a promise of it.

## Files

- `supabase/migrations/0094_resume_scores.sql` (`candidate_resume_scores` with
  history, the queue, triggers, `resume_score_record()` - engine only)
- `api/src/resume/score.js`, `api/src/resume/score-ai.js`,
  `api/src/ai/structured-call.js`, `api/src/routes/resume-score.js`
- `api/src/routes/candidates.js` (the `resumeScoreMin` filter)
- `web/teamlink-resume-score.js`
- Tests: `api/test/resume-score.test.mjs` (AI against a local mock);
  browser: `tools/verify-resume-score.mjs`
