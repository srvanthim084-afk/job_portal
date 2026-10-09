# Apply Now: the applied date and the "Applied Date" filter (0130)

Builds on one-click Apply Now (`docs/ONE-CLICK-APPLY.md`). Nothing existing was
removed; every filter, export and notification that was there still is.

## The applied date

- `applications.applied_at` (UTC, set by the database when the application is
  made) is the only applied date. Every screen, export, email and filter reads it
  and shows it in IST as `DD MMM YYYY` (`09 Oct 2026`), with the time
  (`3:20 PM`) on hover.
- Nobody edits it through the product. Migration 0130 keeps the old `applied_at` /
  `applied_on` on any UPDATE made by the API's role (`app_api`); a superuser
  repair in SQL is still possible.
- Candidate: `Applied ✓ · 09 Oct 2026` on every applied job card (Search /
  Recommended, job page, Saved Jobs, home rows); `Applied on 09 Oct 2026` and
  `Applied 2 days ago` on the Applications page; the timeline
  Applied → Screening → Interview → Offer with the date each step was reached
  (Applied with its time); a count on "My Applications" and on the bottom bar.
- Recruiter: a sortable **Applied On** column (newest first by default); the
  profile timeline line `Applied for <job> on <date>`; the export column
  `Applied On` (`09 Oct 2026, 3:20 PM IST`).
- Notices: the candidate's in-app "You applied for <job>" and confirmation email
  (subject `You applied for <job>`; email only when the interview invitation
  already went out, so no second SMS), and the recruiter's
  `<candidate> applied for <job>` all say `Applied on <date, time> IST`. An open
  recruiter screen picks up a new application within about 20 seconds.

## The calendar (`web/teamlink-date-range.js`, `TLDateRange`)

One component in three places: recruiter Applications (next to Search, Applied
for, Stage, Came from, AI match), Talent Pool (Added on, Applied on) and the
candidate's Applications page. Presets (Today, Yesterday, Last 7 days, Last 30
days, This month, Last month, Custom range); a start click then an end click, or
one day; Apply / Clear and an ✕ in the field; no future days; IST; a bottom sheet
at 640px and below. Filters combine with AND, the count updates at once
(`24 applications`), chips with Clear all show what is on.

Server parameters (India days, `YYYY-MM-DD`, both ends inclusive):

| Endpoint | Parameters |
|---|---|
| `GET /api/applications` | `from`, `to`, `sort=applied_asc` |
| `GET /api/candidate/applications/history` | `from`, `to`, `sort=oldest` |
| `GET /api/candidates` (Talent Pool) | `addedFrom`, `addedTo`, `appliedFrom`, `appliedTo` |
| `POST /api/recruiter/candidates/export` | `applicationIds` (one row per application) |

On the recruiter Applications screen, Export → "Everything matching the current
filters" sends exactly the applications on screen (`applicationIds`); RLS still
decides what each recruiter may read.

## Edge cases

- Incomplete profile: the application is made; the success toast adds
  "Complete your profile to improve your chances" with a link. A missing resume or
  contact detail still asks first (unchanged from 0118).
- API failure: a toast with Retry; the button goes back to Apply Now. Nothing
  shows "Applied" unless the server created the application.
- External jobs: Apply Now opens the original page; on returning to TeamLink the
  candidate is asked "Did you apply?" ("Yes" lists it as Applied (External)).

## Checks

```
npm --prefix api test                       # includes test/apply-applied-date.test.mjs
TL_URL=http://127.0.0.1:4471/ TL_SINK_LOG=<sink log> node tools/verify-applied-date.mjs
TL_URL=http://127.0.0.1:4472/ node tools/verify-one-click-apply.mjs
```

Both browser checks refuse :4323; run them on an isolated instance.
