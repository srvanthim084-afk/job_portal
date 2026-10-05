# External jobs (0049 … 0088, compliance in 0108)

**The rule (owner, 2026-10-05).** A TeamLink job is applied for inside TeamLink,
through the existing flow, unchanged. An external job's **Apply Now opens the
original job URL in a new tab** (`noopener`). The TeamLink application form is
never shown for an external job, and the two flows never mix. A click is
recorded as **"Apply Clicked"** — never as "Applied", never as a TeamLink or ATS
application.

## Which sources can feed jobs today

| Source | Mechanism | Works today without a licence? |
|---|---|---|
| Greenhouse | public Job Board API, board tokens on the Job Sources screen | **Yes** (behaviour unchanged since before 0108) |
| Lever | public Postings API | **Yes** |
| Remotive | public API, no key | **Yes** |
| Adzuna, Jooble, JSearch, SerpApi | keyed APIs | No — needs the API key in the environment **and** a licence record (their terms). JSearch/SerpApi link to employer sites, so their apply domains must also be approved |
| Naukri, Shine, Indeed, LinkedIn | no public API exists | **No** — only a licensed partner/employer feed with a complete licence record. Their connectors fetch nothing; the database refuses to switch them on otherwise |
| Other feed / API | an authorized JSON feed | No — needs a licence record and approved apply domains |
| Hand-entered (manual) | a recruiter enters vacancies | Yes, but Apply Now stays "Application link unavailable" until the source's apply domains are approved |

Nothing is ever scraped; no login, CAPTCHA, robots rule, rate limit or paywall
is bypassed.

## Where things are

| Piece | File |
|---|---|
| Licences, activation guard, health, quarantine, URL changes, audit, events, saved jobs, ranked portal search, canonical URL | `supabase/migrations/0108_external_jobs_compliance.sql` |
| Provider catalogue and per-source policy (kind, mechanism, approved domains, rate limit, preserved = Greenhouse) | `api/src/external/source-config.js` |
| The one link rule (https, public host, approved domain) | `api/src/external/link.js` |
| Validation before storing | `api/src/external/quality.js` |
| ExternalJobProvider contract (fetchJobs / normalizeJob / validateJob / getSourceMetadata) | `api/src/external/provider-contract.js` |
| Sync pipeline (Greenhouse untouched; checked pipeline for the rest), dedupe keys, closure | `api/src/external/service.js` |
| Health, backoff, admin alerts | `api/src/external/health.js` |
| Portal cache | `api/src/external/cache.js` |
| All new SQL calls | `api/src/external/compliance-store.js` |
| Admin / candidate routes | `api/src/routes/external-compliance.js`; portal routes in `api/src/routes/external-jobs.js` |
| Portal UI (cards in the existing lists, details, Apply, saved) | `web/teamlink-portal-external.js` |
| Admin Job Sources screen, recruiter list | `web/teamlink-job-sources.js` |

## Data the portal returns for an external job

`GET /api/portal/external-jobs` (and `/:id`) — besides the 0088 keys:
`jobSourceType` (`NAUKRI` | `SHINE` | `INDEED` | `LINKEDIN` | `OTHER_EXTERNAL`),
`jobSourceName`, `externalJobId`, `originalJobUrl` (only when it passes the link
rule, else `null`), `canonicalJobUrl`, `applyLink` (`available` |
`link_unavailable` | `job_unavailable`), `sourcePostedDate`, `externalStatus`
(`Active` | `Expired` | `Unavailable`), `collectedAt`, `lastExternalSyncAt`,
`lastExternalUpdateAt`, `origin: 'EXTERNAL'`, `freshness`.
TeamLink jobs (`toJob`) carry `jobSourceType: 'TEAMLINK'`, `originalJobUrl: null`.
TeamLink jobs keep their own `jobType` (`regular` | `walk-in`, W1).

## Behaviour

- **Apply Now (external)** opens `originalJobUrl` directly. No URL → "Application
  link unavailable", no button. Closed/expired/removed → "Job no longer
  available", no active button. `applyToJob` / `easyApply` / `cpEasyApply` /
  `capApply` / `rjApplyJob` route any `xjob_` id here, inside W1's form wrapper.
- **Tracking**: a signed-in candidate's click → `POST /api/external/apply` →
  `external_applications` row, status `clicked` ("Apply Clicked", with source and
  time). A visitor → `POST /api/portal/external-jobs/:id/click` (a count, nobody
  identified). The candidate may later answer "Did you apply?" — stored as
  "Applied on External Site (candidate's own report)".
- **Dedupe**: (source, source job id); else `url:<sha1 of canonical URL>`; else
  `ctl:<sha1 of company|title|location>`. A repeat sync updates the row.
- **Licences**: Naukri/Shine/Indeed/LinkedIn (any method), keyed APIs and other
  feeds cannot be switched on without a complete, current licence record
  (`PUT /api/external/sources/:id/licence`, admin). An expired/revoked licence
  switches the source off at the next sweep, history kept.
- **Closure**: closed, never deleted, only after the grace period AND a
  successful sync since the posting was last seen — a failed or empty sync never
  closes anything. Greenhouse keeps its pre-0108 rule.
- **Greenhouse**: unchanged — proved by `api/test/external-greenhouse-snapshot.test.mjs`
  against a snapshot recorded from the code before 0108.

## Tests

`api/test/external-portal.test.mjs`, `external-compliance.test.mjs`,
`external-greenhouse-snapshot.test.mjs`; `tools/verify-external-rls.mjs`,
`tools/verify-external-jobs.mjs`, `tools/verify-external-compliance.mjs` (T1–T7,
isolated instance only, employer pages stubbed with `ctx.route`).
