# Candidate preferred language

A candidate can choose the language TeamLink talks to them in: **English**,
**తెలుగు (Telugu)** or **हिन्दी (Hindi)**. Migration
`0102_candidate_language.sql`.

This is not the profile's **Languages** card (`candidates.languages`, the
languages the candidate speaks, which a recruiter reads). The two are stored
separately and changing one never touches the other.

## Where it is stored

`candidates.preferred_language`: `en` | `te` | `hi`, or NULL.

- **The column already existed.** 0018 (AI calling) added it as plain text,
  and the calling agent writes the language a person actually spoke on a call
  into it. It is the same fact, so the portal uses the same column.
- **0102 adds the rule:** a check constraint allows only `en`, `te`, `hi` or
  NULL. Stored values are normalised first (case, spaces); anything else is
  cleared.
- **NULL means "never chosen"** and reads as English everywhere in the
  portal. There is deliberately no column default of `'en'`: for the calling
  agent NULL means "use the admin's default call language"
  (`ai_call_settings.default_language`), and a default would override that for
  every candidate. (The brief asked for `default 'en'`; this is the reason it
  is not a database default.)
- `toCandidate()` (`api/src/shapes.js`) returns it as `preferredLanguage`
  (`'en' | 'te' | 'hi' | null`).

## Who can set it

Only through the existing rules - no new writer:

- `PUT /api/candidates/:id { preferredLanguage }` under `candidates_self_write`
  (the candidate themselves, an owning recruiter, an admin). Anything other
  than `en`, `te`, `hi` is a 400.
- `POST /api/auth/register { ..., preferredLanguage }` (optional), written as
  the new candidate right after their account exists.
- The AI calling agent, as before (0018's definer function).

## The screens (`web/teamlink-candidate-language.js`)

- **Profile:** a **Preferred language** card (English / తెలుగు / हिन्दी) next
  to the other profile cards. A tap saves to the server; the card shows the
  saved choice after a refresh. Nothing is kept in the browser.
- **Registration:** a "Preferred language for TeamLink messages" select under
  the notice period / availability fields, sent with the registration itself.

## What it changes

| | |
|---|---|
| Interview prep kit | tips, checklist, headings, mode, round, status and date in Telugu / Hindi; questions stay English. `docs/INTERVIEW-PREP-KIT.md` "Language". |
| Career assistant, Basic mode | the fallback language when a message does not show its own. `docs/CAREER-ASSISTANT.md`. |
| Home "AI career suggestions" card | answered in the preferred language. `docs/CAREER-ASSISTANT.md`. |
| "Practice with AI Assistant" | the opening line is sent in the preferred language. |
| AI calling | the agent now actually reads it (`candidate.preferredLanguage` was never mapped by `toCandidate`, so 0018's "remember for next time" had no effect until now). NULL still means the admin's default call language. |

Messages (email / SMS / WhatsApp) are still English.

## Tests

- `api/test/candidate-language.test.mjs` - the column, registration, the PUT,
  the check constraint, RLS (another candidate gets 403), the kit, Basic mode,
  the Home card.
- `tools/verify-candidate-language.mjs` - registration select, the profile
  card (saved, kept after refresh, Languages untouched), the Home card in
  Telugu and its failure state, the assistant in romanized Telugu and Hindi,
  phone width:

  ```
  TL_URL=http://127.0.0.1:4421/ node tools/verify-candidate-language.mjs
  ```
