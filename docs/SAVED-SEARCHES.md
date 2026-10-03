# Saved searches and job alerts

A candidate's **saved search is their job alert**. There is one list, kept by
the server, shown on the **Job Alerts** page (`#/candidate/alerts`).

Before this, alerts lived in the browser (`user_prefs` key
`teamlink_job_alerts_v1`, and an in-memory list on the public search). The
server never read them, so no alert was ever sent. Migration `0086` copies
both old stores into the new table, so nobody loses an alert:

- a paused alert stays quiet (`off`);
- anything else keeps the frequency the candidate picked.

## Where things are

| Piece | File |
|---|---|
| Tables, RLS, the 20 limit, engine functions, migration of old alerts | `supabase/migrations/0086_saved_searches.sql` |
| Filter validation, labels, the matcher | `api/src/search/saved-match.js` |
| Routes | `api/src/routes/saved-searches.js` |
| Instant alerts, digests, quiet hours, "Stop this alert" tokens | `api/src/notify/saved-search-alerts.js` |
| Message wording (email / SMS / WhatsApp) | `buildSavedSearchMessages` in `api/src/notify/templates.js` |
| Place lookup for location tags | `treeResolver` in `api/src/place-tree.js` |
| Button, panel, Job Alerts page, Home row, hidden jobs | `web/teamlink-saved-searches.js` |

The tables are named `candidate_saved_searches`, `candidate_saved_search_hits`
and `candidate_saved_search_deliveries`, because `saved_searches` is the
recruiter's own table from `0001` and is left alone.

## API (candidate only, CSRF, normal rate limit)

| Method | Path | |
|---|---|---|
| GET | `/api/saved-searches` | The list. Each search has a `newCount`. |
| POST | `/api/saved-searches` | Body: `{ label?, filters, alert_frequency?, channels? }`. Same filters already saved → `409 DUPLICATE_SEARCH` with the existing `id`. |
| PUT | `/api/saved-searches/:id` | Rename, or change the frequency, channels or filters. |
| DELETE | `/api/saved-searches/:id` | |
| POST | `/api/saved-searches/:id/viewed` | Sets `last_viewed_at`, which resets "N new". |
| GET | `/api/saved-searches/stop?token=` | The email's **Stop this alert** link. Needs no sign-in. Sets that one search to `off`. |
| POST / DELETE | `/api/hidden-jobs/:jobId` | **Not interested**. Alerts skip hidden jobs. |

`newCount` is the number of open jobs that match the search and were
published after `last_viewed_at`. Hidden jobs are not counted.

## Filters

A saved search stores the **Jobs screen's own filter object** (`STATE.rj`),
so it loads back into the screen unchanged:

`q, loc, locations[], locTags[], locKm, exp[], ctcMin, ctcMax, modes[], types[], skills, edu, posted, company`

Unknown keys and unknown option values are refused (400). The server stores
filters in one canonical form: empty values dropped, lists sorted, spacing
collapsed. Two saves of the same search are therefore the same row, and the
database's `filters_key` catches the duplicate.

The **Job Match %** filter is not saved, because it depends on the profile at
that moment.

A save from the **public** search (signed out) is converted to these keys:

- the location becomes a location tag;
- the experience value becomes the nearest band.

The visitor is asked to sign in, and the search is saved straight after
(held in `sessionStorage` for up to an hour).

## How matching works

`jobMatchesFilters()` is a line-for-line port of `passes()` on the Jobs screen
(`web/index.html`). `api/test/saved-match-parity.test.mjs` lifts `passes()`
out of the page and runs both over the demo jobs from `0003_seed.sql`, across
400 generated searches. It fails on any disagreement, so changing the page's
filter breaks the test until the server is changed to match.

**Location tags** follow the same bands the results page draws:

| Band | Kept? |
|---|---|
| In the place, or anywhere inside it (a district holds its mandals and towns) | yes |
| Within 80 km, or within the radius the candidate chose if that is wider | yes |
| Remote jobs | yes |
| Anywhere else | no |

A **state** keeps only jobs inside it; it has no "nearby". Places are
resolved from the place tree (`var/places/india-tree.tsv`). Without the
tree, a tag matches its own name and common alternate spellings
(Bangalore / Bengaluru, Gurgaon / Gurugram …).

## Schedules

| Frequency | When |
|---|---|
| Instant | When the job is published. This runs after the profile-match alert, so nobody hears about one job from both. A sweep every 10 minutes catches jobs that reached the board some other way. |
| Daily | 08:00 IST. One message per candidate, up to 5 jobs, with a link to the full results. |
| Weekly | Monday 08:00 IST, the same. |
| Off | Saved, never sent. |

Each search records the last digest slot it was processed for
(`last_digest_at`), so a restart never sends one slot twice. A search saved
at 15:00 waits for the next 08:00.

## What is never sent

- The same job twice for one search. `candidate_saved_search_hits` is keyed
  (search, job).
- A job the candidate already got from the profile-match alert, applied to,
  or hid.
- A job that is closed, paused or archived by the time it would go.
- SMS or WhatsApp between 21:00 and 08:00 IST. These are recorded as
  `skipped_quiet_hours`; the email still goes.
- Anything to a candidate marked do-not-contact, or on a channel they opted
  out of.
- WhatsApp, until an approved template name is set in
  **Notification Settings → WhatsApp**. Meta rejects business-initiated
  WhatsApp without one, so these are recorded as `not_configured`.

Existing guards still apply: the outbound number allowlist, reserved test
addresses, and `not_configured` channels. Every channel attempt is a row in
`candidate_saved_search_deliveries`, holding the provider's own answer.

## Limits and privacy

- **20 saved searches per candidate.** A trigger enforces this in the
  database, not only in the page.
- **A candidate reads and writes only their own searches.** No policy lets
  recruiters or administrators read them.
- **The alert engine works through `saved_search_*` definer functions.**
  These admit only a caller with role `admin` and no user ID (the engine
  itself). A signed-in administrator has a user ID, so these functions
  refuse them.
- **Stop links are signed.** Each one is HMAC-signed with `AUTH_SECRET` and
  stops only the search it was issued for.

## Editable templates

Migration `0086` adds two rows, **Saved Search — New Job** and
**Saved Search — Digest**, to the templates list in **Notification Settings**.
An EmailJS template ID set there is used when email goes through EmailJS.

## Tests

```bash
npm run test:api
```

This runs `api/test/saved-searches.test.mjs` (CRUD, isolation, limit,
duplicates, validation, instant once per job, quiet hours, WhatsApp
`not_configured`, digest grouping, exclusions, stop link, migration of old
alerts) and the parity test. Email and SMS go only to the mock provider.

```bash
TL_URL=http://127.0.0.1:4415/ node tools/verify-saved-searches.mjs
```

This runs in the browser against an **isolated** instance. It refuses to
run against :4323, because it creates an account and a job.
