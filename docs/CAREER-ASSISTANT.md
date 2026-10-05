# AI Career Assistant

The candidate's **AI Career Assistant** (`#/candidate/assistant`, and the
floating **TeamLink AI** chat on every candidate page) is answered by the
server. With an AI key it is Claude with read-only tools over the candidate's
own data; without one it is the rules engine, shown as **Basic mode**. The
conversation is stored, so it survives a refresh and a second device.

Before this, both chats were keyword matching in the browser
(`assistantReply()` / `cpAnswer()` in `web/index.html`), and the transcript
lived in page state.

## Where things are

| Piece | File |
|---|---|
| Tables, RLS, the usage table behind the hourly limit | `supabase/migrations/0100_career_assistant.sql` |
| Routes | `api/src/routes/career-assistant.js` |
| Model call, tool loop, refusal, errors, the rules engine | `api/src/ai/career-assistant.js` |
| The seven read-only tools | `api/src/ai/career-assistant-tools.js` |
| System prompt (spec Part B, verbatim, byte-stable) | `api/src/ai/career-assistant-prompt.js` |
| Page, floating chat, safe markdown, `TLCareerAssistant` | `web/teamlink-career-assistant.js` |
| API tests (mock Anthropic server) | `api/test/career-assistant.test.mjs` |
| Basic mode in Telugu / Hindi / romanized: detection and every sentence | `api/src/ai/career-assistant-i18n.js` |
| Browser check | `tools/verify-career-assistant.mjs` |

## API (candidate only; session, CSRF and the API rate limiter apply)

| Method | Path | |
|---|---|---|
| POST | `/api/career-assistant/messages` | `{ conversationId?, text (1–2000), context?: { interviewId } }` → `{ conversationId, reply, usedTools, engine: "ai" \| "rules", message, remainingThisHour }` |
| GET | `/api/career-assistant/conversations` | The candidate's conversations, newest first, and the current `engine`. |
| GET | `/api/career-assistant/conversations/:id` | Its messages (last 200). |
| DELETE | `/api/career-assistant/conversations/:id` | Clear chat. |
| GET | `/api/career-assistant/suggestion` | The Home page's "AI career suggestions" card: `{ reply, engine, language, usedTools, cached }`. See below. |

A Basic-mode reply also carries `language` (`en`, `te`, `hi`, `te-Latn`, `hi-Latn`).

Errors:

- `429 ASSISTANT_RATE_LIMITED` — more than **30 messages in an hour**
  (`CAREER_ASSISTANT_HOURLY_LIMIT`). The message says how many minutes to wait
  and `Retry-After` is set. It is counted in `career_assistant_usage`, which
  Clear chat does not touch and the API has no right to delete from, so
  clearing the chat does not reset the limit.
- `503 ASSISTANT_UNAVAILABLE` — "Assistant is unavailable right now, please
  try again." when the model cannot be reached (timeout, connection, 5xx,
  429 from the provider, a bad key). Nothing is stored for that message and no
  answer is substituted.
- `404` — a conversation that is not the candidate's (or was cleared).

## The model call

`askModel()` in `api/src/ai/career-assistant.js`, through the official
`@anthropic-ai/sdk`:

- `model`: `AI_ASSISTANT_MODEL` or `claude-opus-5-5`; `max_tokens` 16000;
  `output_config: { effort: "low" }`.
- No `thinking` parameter at all (disabling it, or a thinking budget, is a 400
  on this model) and no assistant prefill.
- Refusal fallback: `betas: ["server-side-fallback-2026-07-01"]`,
  `fallbacks: "default"`. `stop_reason` is checked before `content` is read; on
  `"refusal"` the candidate gets a polite "I can't help with that" and an offer
  to help with their job search.
- `system` is the frozen Part B prompt with `cache_control: ephemeral`. No
  date, name or id is ever put in it; candidate data travels only in tool
  results. The test suite pins the prompt's hash and checks the system block
  and tool list are byte-identical across requests and candidates.
- History: the last 20 stored turns, as plain text (the stored text is the
  final reply only).
- Tools: up to **5 rounds**; every `tool_result` of a round goes back in **one**
  user message; a failed read is `is_error: true` with a short reason (never a
  raw database error). After 5 rounds the model is asked once more with
  `tool_choice: none`, so it answers with what it has.
- Timeout `AI_ASSISTANT_TIMEOUT_MS` (30 s), retries `AI_ASSISTANT_MAX_RETRIES`
  (1). SDK errors are classified one by one (`APIConnectionTimeoutError`,
  `APIConnectionError`, `AuthenticationError`, `RateLimitError`,
  `BadRequestError`, `APIError`); only the class and status are logged, never
  the key.
- `AI_API_BASE_URL` points the SDK somewhere else — the tests use a local mock
  HTTP server. Production leaves it unset.
- Input and output tokens (including cache reads/writes) are stored on each
  assistant message so the cost can be watched.

### Tools (read-only, each run inside `withUser(candidate session)`)

| Tool | Returns |
|---|---|
| `get_my_profile` | first name, title, location, preferred location/role, experience, skills, education, certifications, languages, expected CTC, notice period, work modes, summary, resume on file, missing fields — **no email or phone** |
| `search_open_jobs({query?, location?, skills?, limit≤10})` | open jobs the candidate can see (hidden ones excluded), newest first |
| `get_job({job_id})` | one open job as the job page shows it; a draft or closed job is an error |
| `match_me_to_job({job_id})` | `matchCandidate()` from `api/src/ai/match.js`: score, matched and missing skills, experience/location/education fit |
| `get_my_applications` | job, stage **as the candidate is shown it** (`stage_label(stage, 'candidate')`, migration 0051), applied on, last update |
| `get_my_interviews` | upcoming and past interviews, AI interview status — "Client" in an interview type is replaced |
| `get_saved_jobs` | saved jobs that are still open |

Every tool has `strict: true` and `additionalProperties: false`, and the
server validates the input again before running it. Row level security is
what keeps them to the candidate: the queries are written with
`app_candidate_id()`, and even a query that forgot that would only see the
candidate's own rows. There are no write tools — the assistant links to the
screen instead.

Company names appear in tool results exactly where the candidate's job pages
show them (the same convention as the job cards); the prompt tells the model
not to guess a company that is not shown.

## Without a key: the rules engine ("Basic mode")

`rulesReply()` ports the prototype's `assistantReply()` intent by intent and
in the same order — improve/profile/resume, job/match/recommend, should I
apply, career path, interview prep, salary, skill gap, then help — answered
from the same reads the tools use (real profile gaps, the matching engine's
scores against real open jobs, the candidate's real interviews). It adds one
intent the system prompt insists on: a question about paying a fee gets the
"TeamLink does not charge candidates" warning.
`engine: "rules"` is returned and stored, and the page shows **Basic mode**.

### Basic mode in Telugu and Hindi (0102)

The rules engine answers in the language **and script** the candidate wrote
in - the rule the system prompt gives the model:

| the message | the answer |
|---|---|
| Telugu script ("నాకు ఉద్యోగం కావాలి") | Telugu script |
| Devanagari ("मुझे नौकरी चाहिए") | Hindi, Devanagari |
| romanized Telugu ("naaku job kavali") | romanized Telugu |
| romanized Hindi ("mujhe naukri chahiye") | romanized Hindi |
| English ("What jobs match me?") | English |
| nothing to tell ("jobs", a job title, an emoji) | the candidate's preferred language (0102); English when never chosen |

`detectLanguage()` (career-assistant-i18n.js) counts script characters first,
then distinctive romanized words (`naaku`, `kavali`, `ela`, `cheyali` ...
against `mujhe`, `chahiye`, `kaise`, `naukri` ...), then plain English words.
Words shared with English ("main", "to", "me", "hi") are deliberately not
counted as Hindi. The intents are matched in English, romanized and both
scripts (`ఉద్యోగ`, `नौकरी`, `jeetham`, `फीस` ...), in the same order as before.

Only the words around the data are translated: job titles, skills, match
scores, pay and dates come from the same reads as the English answer, so a
Telugu answer is exactly as real as an English one. Missing profile fields
are named in Telugu / Hindi; romanized answers keep the English field
names, as people write them. The interview round is never "Client".
Hindi sentences use the masculine first person ("मैं मदद कर सकता हूँ"), the
usual default for an assistant.

With an AI key nothing changes here: the frozen system prompt already tells
the model to answer in the candidate's language and script.

### The Home page card

The small **AI career suggestions** card on the candidate Home page used to
print `cpAnswer('what skills should I learn')` - keyword rules over the
browser's copy of the data. It now calls `GET /api/career-assistant/suggestion`,
which asks the **same engine as the chat** one fixed question, "What skills
should I learn?", in the candidate's preferred language:

- **rules** (no key): answered fresh each time from the database; nothing is
  counted against the hourly limit (no model, no cost).
- **ai**: one model call per candidate and language every
  `CAREER_ASSISTANT_SUGGESTION_TTL_MS` (6 hours), kept in memory; each call
  is counted in `career_assistant_usage` like a chat message, and the hourly
  limit applies (429).
- **Not a chat message:** nothing is written into the conversation, so
  opening Home does not put a question the candidate never typed into their
  chat.
- The card shows "Looking at your profile and open jobs…", then the answer
  (rendered by the same safe markdown as the chat, with the **Basic mode**
  label under the rules), or "Suggestions are unavailable right now" when the
  server fails - never an answer made up in the browser. `cpAnswer()` itself
  now returns nothing: no part of the page answers questions in the browser.

`TLCareerAssistant.openWith({ interviewId })` (the prep kit's "Practice with
AI Assistant") now sends its opening line in the candidate's preferred
language, so Basic mode answers that in Telugu or Hindi too.

## Storage (migration 0100)

- `career_assistant_conversations (id, candidate_id, created_at, updated_at)`
- `career_assistant_messages (id, conversation_id, candidate_id, role, text,
  tools_used, engine, input_tokens, output_tokens, created_at)` — a trigger
  refuses a message whose conversation belongs to someone else.
- `career_assistant_usage (id, candidate_id, engine, created_at)` — one row per
  message sent; the hourly limit.

RLS: a candidate reads and writes only their own rows. **Staff cannot read
them** — there is no recruiter or admin policy on these tables.

## The page

`web/teamlink-career-assistant.js` replaces `pageCareerAssistant`,
`sendAssistantMessage`, `assistantSubmit`, `cpFabHtml` and `cpAsk`:

- the user's bubble shows at once, then a typing bubble, then the reply;
- the previous conversation loads when the page or the floating chat opens;
  **Clear chat** deletes it (after a confirm);
- the existing chips just send their text;
- replies are **escaped first**, then only `**bold**`, bullet lines and links
  to `#/candidate/...` and `#/job/<id>` are turned back into markup — any other
  link, tag or attribute stays text;
- on a failure the chat shows "Assistant is unavailable right now, please try
  again" (or the server's own 429 message) as an error line — never a made-up
  answer;
- the floating chat and the page share one conversation.

### Hook for other features

```js
window.TLCareerAssistant.openWith({ interviewId, text? })
```

Opens `#/candidate/assistant` and sends "Help me prepare for my upcoming
interview." (or `text`) with `context.interviewId`. The server adds a line
about that interview to the model's input **only if the interview is the
candidate's own**; anyone else's id is ignored. The interview prep kit's
"Practice with AI Assistant" uses this. Also: `TLCareerAssistant.send(text)`,
`.clear()`, `.load()`, `.state()`.

## Configuration

| Variable | Default | |
|---|---|---|
| `AI_API_KEY` | empty | empty = rules engine ("Basic mode") |
| `AI_ASSISTANT_MODEL` | `claude-opus-5-5` | `claude-sonnet-5-5` is cheaper; test answer quality first |
| `AI_ASSISTANT_TIMEOUT_MS` | 30000 | |
| `AI_ASSISTANT_MAX_RETRIES` | 1 | |
| `AI_API_BASE_URL` | unset | tests only |
| `CAREER_ASSISTANT_HOURLY_LIMIT` | 30 | |
| `CAREER_ASSISTANT_SUGGESTION_TTL_MS` | 21600000 | how long the Home card keeps an AI suggestion |

## Limits and notes

- **Privacy:** with a key, the candidate's profile, applications and the jobs
  the tools read are sent to the Anthropic API. Say so in the privacy policy
  (DPDP Act 2023).
- **Cost:** every message is one or more model calls; `effort: low` and the
  cached system prompt keep it down. Watch the stored token counts.
- **Before launch:** run 30–50 real candidate questions (English, Telugu,
  Hindi, romanized) with a real key and read the answers. The automated tests
  use a mock model and prove the plumbing, not the answer quality.
- The Home page's "AI career suggestions" card is answered by the server
  (see above).
- Basic mode's Telugu and Hindi were written by hand for these templates;
  have a native speaker read `career-assistant-i18n.js` and
  `prep-kit-i18n.js` before launch, as with any copy.

## Tests

- `api/test/career-assistant.test.mjs` (DB 5470, API 9990, mock 9978): the
  English rules engine, privacy, the AI tool loop, refusal, errors, the limit.
- `api/test/candidate-language.test.mjs` (DB 5461, API 9981, mock 9861):
  Basic mode in Telugu, Hindi and romanized Telugu / Hindi from real data
  (draft jobs never offered), the preferred-language fallback, the fee
  warning in both scripts; the suggestion endpoint (401 / 403, rules answer
  in the preferred language with nothing written to the chat or the usage
  table; with AI the question goes in Hindi, a second call is cached, an
  upstream 500 is a 503).
- `tools/verify-career-assistant.mjs` adds check 12 (the Home card is
  answered by the server, Basic mode label, nothing written into the chat,
  `cpAnswer()` retired) and check 13 (romanized Telugu in, romanized Telugu
  out). `tools/verify-candidate-language.mjs` covers the card in Telugu and
  its failure state.
