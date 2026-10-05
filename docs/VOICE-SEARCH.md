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
- places said in **Telugu or Devanagari script** (or romanised the Telugu way)
  work without the AI key: see *Places in Telugu / Hindi script* below.
- whatever is left is understood by MEANING (see *By meaning* below); a word in
  another script that is neither a concept nor a place is dropped - it is never
  the search key.

### Places in Telugu / Hindi script (`indic-translit.js`, `place-sound.js`)

"నెల్లూరు లో డ్రైవర్ జాబ్", "हैदराबाद में टेलीकॉलर", "గుంటూరులో డేటా ఎంట్రీ":

1. **Transliteration** of Telugu and Devanagari to Latin letters, the usual
   way: a consonant carries an inherent *a* unless a vowel sign replaces it or a
   virama (్ / ्) removes it; anusvara is *m* before p/b/m/n and at the end of a
   Telugu word, else *n*; nukta (ज़ = z, फ़ = f, ड़ = r or d - both are tried);
   Hindi drops the inherent *a* at the end of a word and between two syllables
   that keep theirs (हैदराबाद = haidraabaad, पटना = patnaa, कानपुर = kaanpur);
   zero-width joiners inside a word are ignored. నెల్లూరు = nelluuru,
   విశాఖపట్నం = vishaakhapatnam.
2. **A sound key** that folds what varies between spellings: aspiration
   (kh/k, th/t, bh/b, sh/s, ph/f/p), c/k/q, w/v, z/j, every h, long vowels and
   doubled letters, y as a vowel, the last vowel. Nellore, nellooru and
   నెల్లూరు all become *nelur/nelor*; its consonant skeleton is *nlr*.
3. **The match**: the skeleton must be identical and the vowels close (a short
   name must be exact; a different first sound costs more, so ఒంగోలు is Ongole
   and not Angul). Telugu case endings joined to the name are taken off
   (నెల్లూరులో, హైదరాబాద్‌లో), and Telugu's *-am* (అనంతపురం = Anantapur).
4. **Only real places, and only big enough ones**: the live board's own towns,
   and the index's states, districts and cities of 100,000+ people
   ("Rajahmundry Urban" / "Pune Division" answer by their base name). A mandal
   or a village is never reached by sound - an ordinary word too often sounds
   like one; they still match when spelt exactly. Nothing that is not in the
   index or on the board is ever returned.
5. **Known renames and nicknames** (`PLACE_VARIANTS` in `voice-words.js`:
   Vizag, Bezawada, Bombay, Madras, Gurgaon, Kashi, దిల్లీ, Hyd, Hyderbad ...) -
   used only when the name they point at is in the index.
6. **Ordinary words that sound like a city** (`NOT_PLACES`: కొత్త "new" ~ Kota,
   చిన్న "small" ~ Chennai, फोन ~ Pune, लड़की ~ Ladakh ...) are never places.
   Measured over 320 ordinary Telugu / Hindi / English job-search words: no
   false place except "krishna", which is also the exact name of a district
   (the exact-name rule, unchanged). Add a word there if one turns up.

### By meaning (`voice-semantic.js`, `job-vocabulary.js`)

The spoken words are kept (`originalQuery`, shown in "You said" exactly as
recognised) but are **never the search key**. They become a search object:

```
{ originalQuery, language: TELUGU|HINDI|ENGLISH|MIXED|OTHER, intent: 'job_search',
  normalizedQuery: 'technology consultant jobs in Hyderabad',
  role[], skills[], technologies[], location[], experience[], qualification[], salary[],
  jobType[], industry[], noticePeriod[], synonyms[], semanticTerms[], searchMode: 'semantic',
  concepts[], keywords[], remote, years, fresher, label }
```

- **Concepts** come from `job-vocabulary.js` (roles, technologies, skills,
  industries, qualifications - plus every job in `JOB_WORDS`): English words
  and phrases directly ("python developer" = Python + Developer); English
  loanwords written in Telugu / Devanagari by sound (కన్సల్టెంట్ = consultant,
  టెక్నాలజీకి = technology, డెవలపర్ / डेवलपर = developer, జావా = java,
  పైథాన్ = python, సాఫ్ట్‌వేర్ = software), with the Telugu case endings
  taken off; pure Telugu / Hindi words through each concept's `native` list
  (కృత్రిమ మేధ = AI, ఆసుపత్రి = healthcare). A loanword for any job title on the
  live board is understood too (the board's own words, by sound: పైలట్ = pilot).
  Filler in all three languages is dropped (సంబంధించిన, ప్రస్తుతం, ఉన్నాను,
  కావాలి, ఉద్యోగాలు, naaku, kavali, unnaya, related, currently ...).
- **Each concept also finds** its synonyms and the technologies it covers
  (`expand`: Python -> Django, Flask, FastAPI, pandas; AI -> machine learning,
  ML, deep learning, generative AI, LLM, NLP, computer vision; React ->
  React.js, ReactJS, Redux, Next.js; Technology -> software, developer,
  engineer ...), and its neighbours only for "related jobs" (`related`).
- **The ranking** reads the real job fields: title, skills, department,
  description, responsibilities, requirements, education, the company's name
  and industry. Per job, 0-100: the concepts (title 30 / skills 25 /
  description 20 - a concept found only in the description still matches),
  location 15 (the place index's hierarchy when it is loaded: Hyderabad covers
  Secunderabad), experience 5 when it was said, and the signed-in candidate's
  own profile 5 (`ai/match.js`). Labels: 90+ Excellent, 75+ Strong, 60+
  Relevant, else Related. Results are in that order.
- **Remote** ("remote", "work from home", ఇంటి నుంచి, घर से) keeps only jobs
  whose own mode / type / location says remote, work from home or WFH.
- **Spoken place wins**: a place said is the location filter (the candidate's
  profile location is not added); no place said means no location filter.

**Fallback, in this order** - the first level that finds anything is shown:

| Level | Needs | Message |
|---|---|---|
| 1 | every concept + the place | - |
| 2 | the skills / technologies + the place | No exact Python Developer jobs in Hyderabad. Showing N closest matches. |
| 3 | the role + the place (only when no skill was said) | same |
| 4 | every concept, anywhere | No Java Developer jobs found in Hyderabad. Showing Java Developer jobs in other locations. |
| 5 | any concept + the place | N related jobs found. Showing the closest matches. |
| 6 | any concept, anywhere | same |
| 7 | a related role / technology, or the candidate's profile | same |
| - | nothing | No matching Welder jobs found in Nellore. / No matching jobs found. |

A place on its own ("హైదరాబాద్‌లో jobs కావాలి") shows the jobs there - and is
used ONLY when no role, skill or other term was said: "Java developer in
Hyderabad" never falls back to random Hyderabad jobs. When nothing but a
salary / mode / job type was said, this layer does not run an empty search;
the screen's own filters do it (`passthrough`).

**In the browser** (`web/teamlink-voice-search.js`; the UI is unchanged): Search
shows exactly the ranked jobs, in their order, with the screen's other filters
still applying on top. The search box shows the normalized search ("python",
"technology consultant") and the location field the normalized place. Typing a
different search, or picking a different place, hands the list back to the
ordinary filters; **Edit** ends the voice search and puts the normalized
criteria into the inputs (what is typed then wins); **Again** replaces the
previous voice search entirely. The empty / related messages above appear in
the existing notice above the list. (On the candidate's Search Jobs the
screen's own sort - match to the profile - orders the selected jobs; the page
sorts inside a closure that cannot be reached without editing index.html.)

**Saved searches**: saving while a voice search is on screen stores, with the
screen's filters, `filters.voice` = { language, originalQuery,
normalizedQuery, concepts, keywords, location, role, skills, technologies,
industry, qualification, experience, jobType, remote, years }
(`saved-match.js normalizeFilters`). Alerts and the "new jobs" count match a
saved voice search by meaning (`voiceMatches`: every concept in the title,
skills or description, synonyms included; remote from the job's own data);
running it again re-ranks it on the server (`POST /api/search/semantic`).
Typed saved searches are unchanged (the parity test still passes).

**Unicode**: every cleanup keeps letters with their combining marks (`\p{M}` -
vowel signs, virama) and the zero-width (non-)joiners. A cleanup that dropped
them turned "నాకు హైదరాబాద్‌లో" into loose base letters (fixed in
`voice-parse.js`); Latin diacritic folding is never applied to Telugu /
Devanagari text (`fold()` in the route).

**VOICE_DEBUG**: `VOICE_DEBUG=true` on the server prints `[VOICE RAW]`,
`[VOICE LANGUAGE]`, `[VOICE NORMALIZED]`, `[VOICE ROLE]`, `[VOICE SKILLS]`,
`[VOICE TECHNOLOGIES]`, `[VOICE LOCATION]`, `[VOICE EXPERIENCE]`,
`[VOICE REMOTE]`, `[VOICE SEMANTIC TERMS]`, `[VOICE FALLBACK]`,
`[VOICE RESULT COUNT]` per request; `window.VOICE_DEBUG = true` does the same
in the browser. Both are off by default - production logs never carry what was
said.

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
notes, engine, search, semantic }` (`filters` for the public search, `portal` for
the candidate's Search Jobs, `search` the normalized search object,
`semantic` = `{ level, levelName, total, results: [{ jobId, score, label, parts }],
message, related, empty, passthrough? }` - the open jobs the viewer may see,
ranked).

`POST /api/search/semantic { search }` - same limit; ranks a search object the
browser already holds (after a chip is removed, or for a saved voice search).
Unknown concepts and any native-script keyword or place are dropped.

`GET /api/search/voice-stats` (admin): counts only - requests, per engine, AI
fallbacks, understood / empty. The spoken text is never logged.

## Limits

- Chrome, Edge and Android Chrome. Firefox has no speech recognition, and some
  iPhone browsers may not either; there the mic is simply hidden.
- HTTPS (the live site) or localhost only.
- Native-script places are matched by sound against states, districts and
  cities of 100,000+ (and the board's own towns); a mandal or village said in
  Telugu / Devanagari script is not found unless the AI engine is on.
- The rules engine knows the concepts in `job-vocabulary.js`; a job word that
  is neither there nor in a live job's title is not understood (the empty
  message says what was understood). Add words there.
- Native-script number words beyond the common ones are not parsed.

## Files

- `api/src/search/voice-words.js`, `api/src/search/voice-parse.js`,
  `api/src/routes/voice-search.js`, `api/src/ai/structured-call.js`
- `api/src/search/indic-translit.js` (transliteration, sound keys),
  `api/src/search/place-sound.js` (places by sound),
  `api/src/search/job-vocabulary.js` (concepts), `api/src/search/voice-semantic.js`
  (the search object, ranking, fallback, saved-search matching),
  `api/src/place-tree.js treeSoundRows()`, `api/src/search/saved-match.js` (voice key)
- `web/teamlink-voice-search.js`, `web/teamlink-saved-searches.js` (voice criteria)
- Tests: `api/test/voice-search.test.mjs` (rules cases, limits, AI against a
  local mock, timeout fallback), `api/test/voice-places.test.mjs`
  (transliteration, 25 native-script place phrases, 23 negatives),
  `api/test/voice-semantic.test.mjs` (the owner's ten acceptance tests, the
  master task's sentences, Unicode, saved voice searches); browser:
  `tools/verify-voice-search.mjs` (speech recognition stubbed; the master task's
  12 sentences and priority / fallback / Edit / Again / typed tests with a
  per-test report).
