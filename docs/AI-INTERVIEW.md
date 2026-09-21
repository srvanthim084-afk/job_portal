# AI voice interview — scoring and visibility

## The interview itself was already built

The prototype contains a real voice interview (the `AIIV` module,
`prototype.html:22084`). It was not replaced or rewritten. It already:

| Requirement | Where |
|---|---|
| 5 technical questions from **this** candidate's own skills | `generateQuestions()` `:22126` |
| 3 behavioural from a rotating pool | `shuffle(BEHAV_POOL).slice(0,3)` |
| 2 intro/resume questions, one forced resume-specific | `introPool()` |
| Voice only — speaks, listens, transcribes | `speechSynthesis`, `getUserMedia`, `SpeechRecognition` |
| Silence → score 0, advance | `scoreAnswer()` `:22150` |
| Off-topic → capped low regardless of fluency | caps at 24 |
| Per-question score **plus justification** | `scoreAnswer()` returns both |
| Technical / Behavioural / Communication / Overall | `aiScore()` `:22167` |

What it lacked was anywhere to put the result.

## What changed

### 1. Results are ATS data now, not tab data

Everything persisted to `localStorage`, so a score existed only in the
browser tab that produced it. A recruiter on another machine saw nothing,
and the candidate lost it on their next visit.

Two tables now hold it:

- **`ai_interviews`** — aggregates, status, transcript, `content_scored`
- **`ai_interview_answers`** — one row per question with score, communication
  score and the **justification** that produced it

Per-question rows exist because the spec requires an audit trail. A disputed
score can be explained rather than re-run.

### 2. Visible to candidate, recruiter, client and admin

Enforced by row-level security, not by the API:

| Role | Sees |
|---|---|
| Candidate | their own result, including per-question scores |
| Recruiter | every result for their own company's jobs |
| Client | every result for their own company's jobs |
| Admin | everything |
| Another candidate | nothing |
| A recruiter at another company | nothing |
| Anonymous | nothing |

Per-question **justifications** are withheld from the candidate — the spec
keeps them "for audit, not necessarily shown to candidate". The candidate
still sees their questions and their scores.

### 3. The server does not trust the browser's arithmetic

`ai_interview_record()` recomputes every aggregate from the per-question
rows. A client posting `overallPercentage: 99` alongside three failed
answers gets the average of those three answers. There is a test for
exactly that.

The weighting matches what the session showed the candidate — technical
covers technical and resume questions, communication averages only the
questions actually answered, and overall is `tech×0.5 + behav×0.3 +
comm×0.2`. An earlier draft used a plain average here, which would have
shown the candidate one number during the interview and a different one in
the ATS afterwards.

### 4. A score cannot exist without the answers behind it

A deferred constraint trigger rejects any completed interview that carries
an overall percentage but has no per-question rows. That is precisely "a
score disconnected from what the candidate actually said", so the database
refuses to store it.

### 5. Question sets are checked against every prior session

The prototype remembered only the **last** set, in `localStorage`
(`tl_ai_last_qset_<candidateId>`), so clearing storage or moving machine
silently allowed a repeat. Each set's hash is now stored, and
`GET /api/ai-interviews/question-set-used` checks against every interview
that candidate has ever taken.

## Two fabricated-score paths removed

Both produced a number from `matchScore` plus randomness, with no interview
behind it:

```js
// :4189  simulateAIInterview — a score with no interview at all
cand.aiInterviewScore = Math.max(55, Math.min(98, cand.matchScore + (Math.round(Math.random()*10)-5)));

// :4880  aiInterviewCard — invented one whenever none existed
const score = c.aiInterviewScore || (t ? t.overall : null) || Math.max(55, c.matchScore - 6);
```

`simulateAIInterview()` now declines and says a score can only come from a
real session. `aiInterviewCard()` renders **"Not yet interviewed"** in place
of the invented figure.

> **This is a deliberate UI difference.** Only the badge *text* changes —
> same element, same classes, same styling. Verified: candidate `cand10`
> would have displayed a fabricated `Score 55/100` and now reads
> `Not yet interviewed`.

## What is NOT implemented

**BDE.** The report object carries
`visible_to: ['candidate','recruiter','bde','client']`, but there is no BDE
role, login, dashboard or table anywhere in the 22,935-line prototype, and
none in the database. Scores are scoped to the four roles that exist. Adding
BDE is a schema decision that is still open.

**Server-side question generation and scoring.** Questions are generated and
answers scored in the browser, by the prototype's own keyword and topic
matching. That is content-based — it compares what was said against expected
terms for each question — but it is not an LLM. If you want genuine semantic
grading, that needs a model behind `AI_API_KEY` and a server-side scoring
endpoint. The tables and the API already carry everything such a change
would need; only the scorer would move.

**Transcription coverage.** `SpeechRecognition` requires HTTPS and a
supporting browser. When it is unavailable the session still records, with
`content_scored = false`, and the score is an estimate from response length.
That flag is returned by the API so the UI can distinguish it rather than
presenting an estimate as a content-based result.

## Verification

```
tools/verify-rls.mjs     6 tests — who can and cannot see a score
api/test/api.test.mjs   10 tests — recording, recomputation, refusals, visibility
```
