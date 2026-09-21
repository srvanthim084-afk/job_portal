# Frontend integration — what changed, and what didn't

## The prototype is untouched

`baseline/prototype.html` is byte-identical to the file supplied:

```
SHA-256  8cc4b430d496694618d72a51ce0a7cd11fe567701d3544ac852d38186efc0862
```

`web/build.mjs` asserts that hash before every build and refuses to run if
it has moved. The served app is the prototype **plus one appended
`<script>` tag** — 442 bytes, 7 lines. The first 1,587,110 bytes of
`web/index.html` are verified byte-for-byte identical to the input.

No CSS rule, no HTML template, no render function was edited.

## How the data source was swapped without touching the UI

The prototype reads data synchronously inside template literals —
`DATA.jobById(id)` alone appears 163 times. Making those `await` would
mean rewriting all 19 page renderers.

So `DATA` stays a synchronous in-memory cache. Only its edges moved:

| | before | after |
|---|---|---|
| boot | seed arrays in the file | one `await /api/bootstrap` before first paint |
| reads | `DATA.jobById(id)` | **unchanged** — all ~700 call sites still work |
| writes | mutate the array | intercepted → API → reconcile → `render()` |
| storage | 58 `localStorage` keys | shimmed: same `get/set`, backed by `/api/prefs` |

Two interception seams are used, both of which the prototype already uses
on itself: function wrapping (`const prev = window.fn`) and `localStorage`
(every persistence path funnels through a known key — `persistPosting()`
writes job creates *and* edits through `teamlink_posted_jobs_v1`).

## UI fidelity result

```
npm run ui:compare baseline integrated

  identical: 76/80   layout: 4   styling: 2   data-only: 0
  console errors: 0
```

80 screens = 40 routes × desktop 1440 and mobile 390.

Capture against a freshly started `tools/dev-server.mjs`. Running the other
verification suites first leaves interviews and applications in the dev
database, and the comparison then reports those extra rows as differences.

**Four screens differ, in two groups. Both are required by the security
requirements, and neither is a design change.**

---

### 1. `login-candidate` — the "Quick demo login" panel is empty

The prototype built that panel from `DATA.candidates` directly
(`demoAccountsFor`, prototype.html:2199), which meant an anonymous visitor
to `#/login/candidate` was shown **four real candidates' names and email
addresses** on an unauthenticated page.

Every button in that panel also called `loginAs(role, id)` — a **one-click
passwordless sign-in**. Keeping it working would defeat the entire
authentication system; it is the same hole as `submitLogin()` accepting any
candidate.

What was done:

- Staff accounts (recruiter, client, admin) still populate the panel, from
  `public_login_hints()` — a single narrow `SECURITY DEFINER` function, so
  the disclosure is explicit and auditable in one place.
- **Candidates are never listed.** They are members of the public.
- Clicking a name focuses the email field and names the person. It does not
  fill in an address (only one staff email is already printed on that page;
  auto-filling the rest would publish addresses that are not otherwise
  public) and it does not sign anyone in.
- `SHOW_LOGIN_HINTS=false` removes the panel's contents entirely for a real
  production deployment.

**This is the one screen where the UI could not be preserved exactly and
also meet the security requirements.** The markup and styling are
unchanged; the candidate panel simply has no rows.

### 2. `client-candidates` — cross-company candidates no longer appear

A TechNova client (`c1`, Rajeev Menon) was shown **Rohit Malhotra**, whose
application is to `j2` — an **InnovateSoft** job. Also Vikram Singh and
Sneha Kulkarni, likewise from other companies.

That is a cross-tenant leak: one client company could see another's
candidate pipeline. The row count drops from 10 to 3 because the client now
sees only their own company's candidates, at client-visible stages only.

The design is identical — same table, same badges, same styling. There are
fewer rows because there should always have been fewer rows.

---

## Also fixed while integrating

| Found | Consequence | Fix |
|---|---|---|
| `previousCompanies` stored as `text`, but the prototype uses an **array** | `(c.previousCompanies \|\| []).join` threw on the candidate profile | column is `text[]`; a test now asserts **all seven** array-valued candidate fields stay arrays |
| The seed extractor read only the `DATA` block | prototype.html:6392 enriches candidates with gender, `emailVerified`, `mobileVerified` and recruiter notes — **all silently lost**, while every row count still looked right | the extractor now reads the **fully loaded page**; 8/10 verification flags and 4 recruiter notes recovered, with a regression guard |
| CSP blocked `cdn.jsdelivr.net` | EmailJS SDK failed to load, breaking email notifications | that one origin allowed explicitly |
| The two public demo screens crashed | `/ai-pipeline` and `/whatsapp-demo` dereference `cand5`/`cand4`, which RLS correctly hides from anonymous visitors | demo fixtures in a static file, swapped in **only during a demo-screen render**; never database rows, never in Find Candidates or any dashboard total |

## Find Candidates and interview scheduling

Both were still going through the in-memory cache. They now use the API.

### Find Candidates — filtering moved into SQL (requirements 10, 11)

The screen already exposed the seams needed, so nothing about it changed:

| Seam | Used for |
|---|---|
| `window.getFilteredCandidates(pool)` | the documented pool hook `baseResults()` calls (`:6502`) |
| `window.fcrSet` / `fcrToggleFacet` | every filter change |
| `window.fcrSetPage` / `fcrSetPageSize` | paging |

Filters now reach Postgres as query parameters: keywords, skills, location,
notice period, education, industry, experience range, salary range, gender,
verification flags, resume presence, recruiter-comment tag, and activity
window. The existing client chain — five stacked layers of criteria filters
(`:9768`, `:10400`, `:10672`, `:13413`) plus the local "hide viewed / hide
emailed" refinements — still runs, but on the server's result window rather
than the whole candidate table.

**One honest limitation.** The screen pages through results in the browser
(`paged()` at `:6752` slices `list.length`), so the client is handed a
bounded *window* of matches — 200 by default, `TL.fcr.window` — rather than
one page at a time. Filtering genuinely happens in SQL and the browser never
receives the whole table, which is what requirement 11 is protecting
against. Fetching strictly one page per request would mean rewriting
`paged()`, which is inside the screen's own IIFE — a UI change. Say the word
if you want that trade made the other way.

### Interview scheduling

`mjScheduleInterview()` pushed straight into `DATA.interviews`, so a
scheduled interview existed only in that browser tab. It now creates a real
row, and the API moves the application to `interview_scheduled` and notifies
the candidate **in the same transaction**, so the three can never disagree.

A selected or rejected candidate is not demoted back to
`interview_scheduled` — scheduling a follow-up round no longer rewinds their
stage.

## Three more defects found while wiring this

| Found | Consequence | Fix |
|---|---|---|
| `date` columns round-tripped through a JS `Date` | node-postgres parses `date` at **local** midnight, so any server east of UTC rendered it a day early — book the 15th, display the 14th | a type parser keeps `date` a plain `YYYY-MM-DD` string; a test asserts the round trip |
| `interviews_write` and `offers_write` checked the ROLE but not the COMPANY | any recruiter could schedule an interview against another company's job and candidate — and the read policy then hid it from them, which is worse | both policies now name the caller's company; an RLS test covers it |
| The UI suite captured `recruiter/find`, which does not exist | it rendered blank in **both** builds, so it compared as "identical" and the real screen was never checked at all | route corrected to `find-candidates`; the capture now warns about any screen that renders almost nothing |

That last one is the instructive failure: a comparison harness reports
"no change" just as happily when it is looking at nothing.

## Two things only found by actually clicking

### The CSP killed every button in the application

`helmet` defaults `script-src-attr` to `'none'`, which blocks inline event
handler **attributes** — `onclick=`, `onsubmit=`, `onchange=` — completely
independently of `script-src 'unsafe-inline'`.

The prototype has **1,034 of them**:

```
onclick 807 · onchange 132 · oninput 57 · onkeydown 9 · onsubmit 5 · onfocus 3 · onblur 3
```

Every one was dead. The login form fell back to a native GET, which put the
password in the address bar:

```
?email=recruiter%40teamlink.com&password=TeamLink%402026
```

Nothing caught it. The pages rendered identically, the UI comparison
reported 76/80, there were zero console errors, and all 114 other checks
passed — because every one of them drove the app through its JavaScript API
rather than its controls.

Fixed with `scriptSrcAttr: ["'unsafe-inline'"]`, and
`tools/verify-interaction.mjs` now clicks real buttons so it cannot recur.

### The prototype already talked to a different Supabase project

`TL_SUPA` / `TL_API` (`:21156`) points at project `ohamvhilaljvkjpzaaln` and
fetches jobs straight from the browser.

The key there is a **publishable** one and the code explicitly refuses
`service_role` keys, so this was never a credential leak. But it is a second
source of truth for jobs against a different database — which requirement 17
rules out — and it is the browser querying a database directly, which
requirement 2 rules out.

`TL_API.configured()` gates on `TL_SUPA.url` and falls back to reading
`DATA`, which this file fills from the real API. Clearing that url is
therefore the whole fix: every `TL_API` call keeps working and resolves
against the backend instead. The original values are kept on
`TL.disabledSupabase` for reference.

## Behaviour that deliberately changed

These are required by the security requirements and cannot be preserved:

- `loginAs()` no longer mints a session. The server decides who you are.
- `submitLogin()` no longer accepts any candidate without a password.
- `ROLE_CREDENTIALS` (`Admin@123` et al.) is dead — the login form posts to
  `/api/auth/login` and the constant is never read.
- A recruiter sees their own company's pipeline. An admin still sees
  everything.

## The offline message that was never about being offline

A reported bug: logging in or clicking **Apply Now** showed

> You appear to be offline - check your connection

three or four times over, on a machine with a working connection.

The message was produced by this file. Every `fetch` rejection mapped to
one code, `NETWORK`, and that one string. A rejection means *no response
at all*, which has four quite different causes, and only one of them is
being offline:

| What happened | `navigator.onLine` | What the app said | What it says now |
|---|---|---|---|
| Page opened from disk (`file://`) | `true` | you are offline | this page was opened as a file |
| API not running | `true` | you are offline | cannot reach the TeamLink server |
| Request timed out | `true` | you are offline | the server took too long |
| Machine really offline | `false` | you are offline | you appear to be offline |

The actual fault was the first row. `web/index.html` opened by
double-clicking it has no http origin, so `fetch('/api/bootstrap')`
resolves to `file:///C:/api/bootstrap` and Chrome refuses the scheme
before any request leaves the browser. Nothing loads - `DATA.jobs` is 0 -
and the app blamed the network. The repetition was one toast per failed
call: bootstrap, then login, then apply.

What changed, all in `web/teamlink-integration.js`:

- **Classification.** `classify()` picks the code from the conditions, and
  the offline wording is reachable only when `navigator.onLine === false`.
- **No server to call.** A `file://` page fails the request immediately,
  with an explanation and a console message naming the fix, instead of
  attempting a fetch that cannot succeed.
- **Timeouts.** Requests abort after 20s (`opts.timeout` to override) so a
  hung server surfaces as a timeout, not a button stuck on "Signing in...".
- **Status mapping.** A response without one of the API's own error codes -
  a proxy's 502, a bare 404 - is mapped from its HTTP status: 401/403
  authentication, 404 not found, 409 conflict, 422 validation, 500 server,
  502/503 unreachable, 504 timeout.
- **One failure, one toast.** An identical message inside the toast's own
  4.2s lifetime is the same event reported twice, and is suppressed.
- **`TL.diagnose()`** in the console answers "is the backend connected?"
  with a verdict, the API base, and the last five failed calls. On
  localhost every failure is already logged with its method, URL, status
  and response body; `?tlDebug=1` turns that on anywhere.

### Four defects underneath it

Chasing this turned up faults that had nothing to do with the toast.

1. **`GET /api/bootstrap` fired 13 queries with `Promise.all` on one
   connection.** They share a client, so node-postgres queues them anyway -
   there was no concurrency to win. What it did add: when one query failed,
   the transaction aborted and the twelve still queued returned 25P02
   "current transaction is aborted". `Promise.all` then rejected with
   whichever landed first, so the log named a symptom and the original
   error was lost. Now sequential.

2. **A stage note could not be saved.** The API wrote it with
   `update application_stage_history set note=$1 ... order by id desc limit 1`,
   which is MySQL syntax; PostgreSQL rejects it outright. The failed
   statement aborted the transaction, so the rest of the move failed with
   25P02 and returned `DATABASE_ERROR`. It was wrapped in `.catch(() => {})`
   commented "history is advisory; never fail the move over it" - the catch
   is precisely what made the move impossible. Every existing test moved a
   stage *without* a note, so 70 tests passed over it. The note now travels
   with the move through `app.stage_note`, written by the trigger that
   already inserts the history row (migration `0008_stage_note.sql`).

3. **A poisoned connection went back into the pool.** If the rollback in
   `withUser` also failed, the client was released still inside the aborted
   transaction, and the *next* request failed with 25P02 somewhere
   unrelated - which is why login and bootstrap were failing for no reason
   of their own. Such a connection is now destroyed, not reused.

4. **A fresh checkout came up with the wrong origin.** `api/src/config.js`
   reads `process.env` once at import time. `tools/dev-server.mjs` set its
   defaults *after* the seeding step - and seeding imports `auth.js`, which
   imports `config.js`, on a first run only. So run one had
   `PUBLIC_ORIGIN=http://localhost:8080` and rejected every POST from the
   browser with `403 Origin not allowed`, while curl worked (it sends no
   Origin header) and a restart "fixed" it. The defaults now precede every
   `api/src` import.

Also fixed: a 401 from any background call used to sign the candidate out
mid-application. `/auth/me` is now consulted first, and only a session the
server agrees is gone ends the session. And `localStorage.removeItem` sent
`DELETE /api/prefs/<key>` for keys the database owns, which 401'd after
logout; it now mirrors the guards `setItem` already had.

## Verification

```
npm run verify:db         schema 10/10 · rls 29/29 · seed 16/16 · migrate 13/13
npm run test:api          72/72
npm run verify:candidate  18/18  register -> login -> apply -> history -> refresh
npm run verify:interaction 7/7   real clicks on real controls
npm run verify:search      9/9
npm run rehearse          24/24  a deployment against an empty database
npm run ui:compare baseline fixed     76/80 identical, 4 deliberate
```

`verify:candidate` is the one that covers the bug above: it walks the whole
candidate journey, then simulates each way a call can fail and asserts the
app names the right one.

Run the whole stack locally — Postgres, API and the app — with:

```
node tools/dev-server.mjs 4323
```
