# Voice search

A job seeker taps 🎤 in the job search bar and says, for example:

- "Nellore lo driver job kavali, salary 15000 paina"
- "Hyderabad mein work from home telecaller"
- "fresher data entry jobs near Guntur"

and the job list is filtered exactly as if they had typed and ticked the filters.

## How it works

1. **The browser listens** (Web Speech API, `SpeechRecognition` /
   `webkitSpeechRecognition`) in the chosen language - English (`en-IN`),
   తెలుగు (`te-IN`) or हिन्दी (`hi-IN`) - remembered on the device. It shows the
   words live, and stops after about 2 seconds of silence or 15 seconds in all.
2. **Only the text** goes to `POST /api/search/voice-parse { text, lang }`. No
   audio is recorded or uploaded by TeamLink. (Chrome's own speech recognition
   may use Google's servers; the privacy policy should say so.)
3. The server answers with **filter values the screens already accept** and the
   chips it understood: `[Driver] [Nellore] [₹15,000+ a month]`, plus which engine
   answered.
4. "You said: …" shows the chips. The candidate can remove any chip, press
   **Edit** to put the words into the normal search box, or **Search**.
5. Search starts from `freshSearchState()`, keeps the sort, sets the filters and
   calls `applySearch()` (so it lands in Recent Searches), on Home / Find jobs; on
   the candidate's Home and Search Jobs it sets the Search Jobs filters
   (`STATE.rj`) and the location field. If nothing matches: "No jobs for Plumber
   · Nellore" with one tap to remove each chip, and **Nearby places** (the
   location field's Near-by radius).

The mic is shown only when the browser has speech recognition and the page is
on HTTPS or localhost. Clear one-line messages for: microphone permission
denied, no speech heard, no microphone, network error.

## Understanding the words (`api/src/search/`)

Two engines produce the same *intent*; one function turns it into filters, so
the engines cannot disagree about what a filter value may be.

**Rules** (always available; `voice-parse.js` + the dictionary `voice-words.js`):

- filler words removed (kavali, lo, ki, chahiye, mein, job, naukri, udyogam,
  please, near, dhaggara, paas, … and their Telugu / Devanagari spellings)
- numbers in digits and words: "15000", "15k", "15 thousand", "fifteen thousand",
  "padihenu velu", "pandrah hazaar", "1.5 lakh", "3 lpa"; "2 years experience"
- fresher / "experience ledu" / "no experience"; work from home / "intlo nunchi"
  / "ghar se"; part time / full time / internship / contract / walk-in;
  "today" / "this week"
- job words in Telugu / Hindi / English -> the English title (driver, delivery
  boy, telecaller, nurse, data entry, sales, security guard, electrician,
  teacher, accountant, cook, helper, plumber, …). **Add the words your
  candidates actually say to `voice-words.js`** - ask recruiters for 50-100.
- places: the remaining words (pairs first) through a town on the live board,
  then the existing place index (`api/src/place-tree.js` - state, district,
  mandal, or a town of 5,000+ people, so an ordinary word that happens to be a
  hamlet's name is not taken for a place). The index loads in the background
  after start; until it has, the board's own towns are used.
- whatever is left becomes the keyword.

**AI** (when `AI_API_KEY` is set): official `@anthropic-ai/sdk`, model
`AI_VOICE_MODEL` (default `claude-opus-5-5`), `output_config { effort: "low",
format: <JSON schema> }`, frozen system prompt with `cache_control` listing what
may be filled, the spoken text in the user message as data, refusal fallback
(`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`),
`stop_reason` checked. A 5-second timeout (`AI_VOICE_TIMEOUT_MS`) or any failure
falls back to the rules, and the response says `engine: "rules"`. The model's
place still goes through the place lookup, and every value is validated.

### Values (what "accepted" means)

| Filter | Allowed |
|---|---|
| mode | the board's modes + `Onsite`, `Remote`, `Hybrid` (work from home = `Remote`) |
| jobType | the board's types + `Full-time`, `Part-time`, `Contract`, `Internship`, `Walk-in` |
| exp | `0–1 yrs` … `5–8 yrs` (the public sidebar); the candidate screen gets `Fresher`, `0–2 Years`, … |
| salaryMin | the public sidebar's LPA options (3, 5, 8, 12, 18, 25) - the largest at or below what was said |
| posted | 1, 3, 7, 15, 30 |
| loc | a place the board or the place index knows |

**Salary.** An amount under ₹1 lakh is read as monthly (₹15,000 a month = ₹1.8
LPA), lakh / LPA as yearly. The candidate's Search Jobs takes any LPA number, so
it gets 1.8. The public sidebar's lowest option is ₹3 LPA, so there the salary
filter is left off rather than invented, and the response carries a note saying
so. (The spec's example "salaryMin 15000" would have filtered on ₹15,000 LPA -
the sidebar's unit is LPA.)

## API

`POST /api/search/voice-parse` - public, 20 requests a minute per address
(`VOICE_RATE_LIMIT_MAX`). Body `{ text: 1..300 chars, lang: en-IN|te-IN|hi-IN }`;
an empty or longer text is a 400. Returns `{ filters, portal, understood, chips,
notes, engine }` (`filters` for the public search, `portal` for the candidate's
Search Jobs).

`GET /api/search/voice-stats` (admin): counts only - requests, per engine, AI
fallbacks, understood / empty. The spoken text is never logged.

## Limits

- Chrome, Edge and Android Chrome. Firefox has no speech recognition, and some
  iPhone browsers may not either; there the mic is simply hidden.
- HTTPS (the live site) or localhost only.
- Native-script speech (Telugu / Devanagari) is understood for the dictionary
  words and number words; places spoken in native script need the AI engine or
  a place-index alias.

## Files

- `api/src/search/voice-words.js`, `api/src/search/voice-parse.js`,
  `api/src/routes/voice-search.js`, `api/src/ai/structured-call.js`
- `web/teamlink-voice-search.js`
- Tests: `api/test/voice-search.test.mjs` (rules cases, limits, AI against a
  local mock, timeout fallback); browser: `tools/verify-voice-search.mjs`
  (speech recognition stubbed).
