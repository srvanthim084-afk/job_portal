# Save & Post: publishing a TeamLink job to several destinations (0112)

A recruiter creates or edits a TeamLink job, ticks where it should go, and
presses **Save & Post**. The job is saved as before, then published to each
ticked destination by the server. Every destination has its own status on
the job, and **Posted** is shown only after a real confirmation.

This is OUTBOUND publishing. The inbound external-jobs feed (jobs other
sites publish, shown on the portal) is a separate feature
(docs/EXTERNAL-JOBS.md) and is not touched by this one.

| Destination | Works now? | What it is |
|---|---|---|
| TeamLink Job Portal | **Yes** | The job's public page on this portal, `/job/<id>` |
| TeamLink Website | **Yes** | The public jobs feed the company website embeds (JSON + RSS) and schema.org `JobPosting` on the job page |
| Naukri | Needs a Naukri agreement | Naukri's authorized employer / partner API |
| Shine | Needs a Shine agreement | Shine's authorized employer / partner API |
| Indeed | Needs Indeed's acceptance | Indeed pulls TeamLink's signed XML job feed (or an Indeed partner API) |

---

## 1. What works immediately

**TeamLink Job Portal.** Every Active job is on the portal. Save & Post
records the Portal destination and marks it **Posted** only after two
checks pass. First, an anonymous read finds the job public (RLS, `jobs_open`).
Second, the job's public page `https://<portal>/job/<id>` answers HTTP 200
and names the job (`<meta name="teamlink:job" content="<id>">`). The URL
stored on the publication, and linked from the badge, is that page. If the
job is closed, paused, archived, expired or past its walk-in date, the
Portal row reads **Removed**. It goes back to Posted when the job is made
Active again.

**TeamLink Website.** This repository has no separate company website. So
"TeamLink Website" is a public, cacheable jobs feed that the website (or any
other site) embeds:

| URL | Format |
|---|---|
| `GET /feeds/jobs.json` | JSON: every open job ticked for the website, each with its schema.org `JobPosting` |
| `GET /feeds/jobs.xml` | RSS 2.0 |
| `GET /feeds/jobs/<id>.json` | one job's entry (404 once it is closed or unticked) |
| `/job/<id>` | carries `<script type="application/ld+json">` `JobPosting` while the job is on the website |

The feeds are public, `Cache-Control: public, max-age=300`, and
`Access-Control-Allow-Origin: *`, so the website can `fetch()` them from the
browser. They contain only what the public job page already shows: no
recruiter, no applicant counts, and no company name that contains the word
"client". The Website row is **Posted** only when the job is in the feed and
its entry URL answers anonymously. If the company website has its own page
per job, set `TEAMLINK_WEBSITE_JOB_URL=https://…/careers/job?id={id}`. That
page must then also answer 200 before the row is Posted, and it becomes the
stored URL.

A ready-made, styled block for tmlink.in (search, filters, Apply Now), the hosting steps and the data copy are in `docs/WEBSITE-JOBS.md`. The bare minimum, for any site:

```html
<ul id="tl-jobs"></ul>
<script>
fetch('https://<portal>/feeds/jobs.json').then(r => r.json()).then(f => {
  document.getElementById('tl-jobs').innerHTML = f.jobs.map(j =>
    `<li><a href="${j.url}">${j.title}</a> - ${j.location} · ${j.salary || ''}</li>`).join('');
});
</script>
```

**Also working now, for every destination:**

- the "Post to" ticks on the job forms;
- per-destination badges on Manage Jobs, the recruiter's Jobs table and the
  job's own page;
- edits pushed as updates;
- closing or unticking takes the job down;
- retries with backoff, and a **Publish now** button;
- the Integrations screen;
- encrypted credential storage;
- the audit trail.

## 2. What requires external platform approval

Each of these needs an **agreement with that platform**. TeamLink cannot
grant this access itself, and nothing in this system pretends to have it.

- **Naukri.** Posting jobs into Naukri needs Naukri's authorized employer
  integration: a Naukri RMS / recruiter account with API access, or a
  Naukri partner (job-posting) API agreement. Naukri issues the API
  endpoint, the credentials and the posting specification.
- **Shine.** It needs a Shine.com employer / partner API agreement. Shine
  issues the endpoint and the credentials.
- **Indeed.** Indeed's normal model is that **Indeed pulls an XML job feed**
  that the employer or agency publishes. Indeed has to accept the feed
  (through Indeed's feed / partner programme, an account manager, or the
  Indeed employer account). Indeed's partner APIs are also available only
  under an agreement.

Until then, a job ticked for one of them shows **Integration Required** and
**nothing is sent**. The tick is remembered, so the job goes out by itself
once the integration is connected (§5). There is no scraping, no browser
automation, no login-form filling and no CAPTCHA handling anywhere in this
feature. A connector calls only the endpoint the administrator configured,
and nothing is hardcoded. The payload field names in
`api/src/publishing/connectors.js` (`MAPPERS`) follow each platform's
employer documentation. **When the platform issues its specification under
the agreement, that mapper is the one place to align with it.**

## 3. Credentials and configuration required

### On the server (environment, never in the browser)

| Variable | Needed for |
|---|---|
| `INTEGRATION_SECRET_KEY` | **Required to save any credential.** Must be at least 16 characters. Used for AES-256-GCM encryption at rest. If it is missing, the Integrations screen says so and refuses to save. If it is changed, stored credentials can no longer be read: the integration shows Integration Required until they are entered again. |
| `PUBLIC_ORIGIN` / `PUBLIC_SHARE_URL` | The public address that job URLs and feed URLs are built on. This already exists. |
| `PUBLISH_PROBE_ORIGIN` | Optional. The address the server uses to reach itself for the Posted checks. Defaults to `PUBLIC_ORIGIN`. |
| `TEAMLINK_WEBSITE_JOB_URL` | Optional. The company website's own per-job page, with `{id}`. |
| `PUBLISH_SWEEP_MS`, `PUBLISH_MAX_ATTEMPTS`, `PUBLISH_BACKOFF_BASE_MS`, `PUBLISH_HTTP_TIMEOUT_MS`, `PUBLISH_STATUS_CHECK_MS` | Optional tuning. See `.env.example`. |

### Per platform, entered in Administration → Integrations

| Field | Naukri / Shine (Partner API) | Indeed (XML feed) |
|---|---|---|
| Enabled | ✔ | ✔ |
| Connection type | `Partner API` | `XML job feed` (or `Partner API` if Indeed grants one) |
| Authorized API endpoint (base URL) | ✔ issued by the platform, `https://` only | - |
| Authentication | API key as Bearer · API key in a header (name configurable) · Client ID + secret (Basic) · OAuth 2.0 client credentials (+ token URL) | - |
| Account / employer ID | the employer or account id the platform issued | the publisher / account id |
| API key / Client ID / Client secret | as the platform issued them | - |
| Feed token | - | any long random value (**Generate** makes one). It signs the feed URL you give Indeed. |
| Status check URL | - | optional: where Indeed reports the listing's status |
| Callback signing secret | optional | the shared secret Indeed's confirmation is signed with |
| Advanced: API paths | default `GET /account` (credential check), `POST /jobs`, `PUT`/`DELETE`/`GET /jobs/{id}`, changeable to the platform's own paths | - |

The connector contract (`api/src/publishing/connectors.js`) is the same for
every destination:

- `validateCredentials`;
- `publish(job) → { externalJobId, externalUrl }`;
- `update`;
- `unpublish`;
- `status`.

A partner API publish must answer 2xx with a job id and/or URL. The
connector reads `id`, `jobId`, `job_id`, `externalJobId`, `url`, `jobUrl`,
`job_url` and `data.*`. A `status` of `pending` or `under_review` reads as
awaiting confirmation. Anything else is **Failed**. Every request carries
`Idempotency-Key: teamlink-<jobId>-<DESTINATION>` and the account id in
`X-Account-Id`.

**For Indeed's feed,** give Indeed these two things:

- the feed URL: `https://<portal>/feeds/indeed.xml?token=<feed token>`;
- the confirmation callback: `POST https://<portal>/hooks/publishing/indeed`.

The feed uses Indeed's published XML format (`<source><job>` with `title`,
`date`, `referencenumber` (the TeamLink job id), `url`, `company`, `city`,
`state`, `country`, `description`, `salary`, `education`, `jobtype`,
`experience`, `expirationdate`). A wrong or missing token gets a plain 404.

The callback body is JSON:

```json
{"reference":"<TeamLink job id>","externalJobId":"<Indeed job key>","url":"<Indeed job URL>","status":"live"}
```

It must be signed with `X-TeamLink-Signature: sha256=<hex HMAC-SHA256 of the
raw body with the callback secret>`. An unsigned or badly signed callback
gets a 401 and changes nothing.

**Secrets never come back.** No API response carries a credential. The
screen shows "•••• saved" and at most the last 4 characters, or nothing at
all for a secret shorter than 12 characters. A platform error message that
echoes a key is scrubbed before it is stored. Request bodies of the
integration routes are never logged. The configuration audit records which
fields changed, never their values.

## 4. Where the administrator enters them

**Sign in as an administrator → left sidebar → Integrations**
(`#/admin/integrations`).

The screen has three parts:

- **TeamLink systems**: Portal and Website. Both show *Works now*, their
  feed URLs, and job counts.
- **Job sites**: one card each for Naukri, Shine and Indeed. Each card has:
  - Enabled;
  - Connection type;
  - the fields from §3;
  - **Save**, **Test Connection** and **Publish waiting jobs now**;
  - Connected / Integration Required, with the exact reason;
  - Last test, Last sync, Last error and Jobs (posted / awaiting / failed /
    waiting counts);
  - Change history.
- **A warning** at the top if `INTEGRATION_SECRET_KEY` is not set.

**Test Connection** calls the connector's `validateCredentials` against the
configured endpoint and shows the platform's honest answer. Examples:

- "The platform rejected the credentials: …"
- "Could not reach … (timed out)"
- "Connected: … accepted the credentials (HTTP 200)"
- for the Indeed feed: "Feed ready … give this URL to Indeed".

Recruiters and candidates never see this screen. It is not in their menus,
the screen does not render for them, and every `/api/admin/integrations*`
route answers 403. In the database, the `publishing_integrations` row-level
security policy admits administrators only.

## 5. How Save & Post publishes automatically once connected

```
Recruiter: job form → ticks (Portal ✔, Website ✔, Naukri ☐, Shine ☐, Indeed ☐) → Save & Post
  │
  ├─ the job is saved exactly as before (POST / PUT /api/jobs)
  └─ PUT /api/jobs/:id/publications {destinations:[…]}
        one job_publications row per (job, destination), desired = published
        └─ the publisher reconciles the job:
             not configured             → Integration Required   (nothing sent)
             configured                 → claim the row (status Posting; one worker only)
                                          → connector.publish(job)
                   2xx + id/URL         → Posted (external id + URL stored, confirmed_at)
                   feed listing         → Listed in feed — awaiting confirmation
                   4xx / 5xx / timeout  → Failed (error stored), retried 30 s, 1 min, 2 min …
             Portal / Website           → Posted once the public URL answers (within the request)
  answer: every destination's status → the toast, badges on Manage Jobs and the job page
```

**Afterwards, with nobody pressing anything:**

- **Edit a posted job.** The job routes notify the publisher, and only what
  changed goes out (`PUT` to the platform). It is never posted a second time.
- **Close, pause, archive or expire it, or untick a destination.** It is
  taken down (`DELETE` on the platform, or dropped from the feed), and the
  row becomes **Removed**. Reopen it and it goes back up.
- **An administrator connects Naukri later.** Saving working credentials
  (or pressing **Publish waiting jobs now**) immediately publishes every open
  job that was ticked for Naukri. The background sweep, every
  `PUBLISH_SWEEP_MS` (60 s by default), does the same for anything missed.
  It also retries Failed rows when their backoff is due, checks feed
  listings for confirmation, and catches jobs closed or edited since they
  went out.
- **Indeed** stays at *Listed in feed — awaiting Indeed confirmation* until
  one of two things happens:
  - the signed callback arrives;
  - the configured status check reports the listing live with its id or URL.

  Only then is it **Posted**, never on TeamLink's own say-so.
- **Publish now / Retry** appears on a job's badges when anything is
  waiting. It makes that job's waiting rows due immediately.

**Never twice.** Four things prevent a double posting:

- a row is acted on only by the worker that atomically claimed it;
- calls for one job are serialised;
- a publish happens only while no external id is held;
- every call carries a stable idempotency key, so a retry after a timeout
  cannot create a second posting on a platform that honours it.

## Where it lives

| | |
|---|---|
| `supabase/migrations/0112_job_publishing.sql` | `publishing_destinations` (catalogue; add a row to add a destination), `publishing_integrations` (config; secrets encrypted), `publishing_integration_events` (config audit), `job_publications` (one row per job × destination), `job_publication_events` (per-row audit trail); RLS |
| `api/src/publishing/secrets.js` | AES-256-GCM sealing with `INTEGRATION_SECRET_KEY`, hints, scrubbing |
| `api/src/publishing/feed.js` | public job shape, JSON / RSS / partner XML feeds, JSON-LD |
| `api/src/publishing/connectors.js` | Portal, Website, partner API and pull-feed connectors (one contract) |
| `api/src/publishing/service.js` | the publisher: selection, reconcile, claim, retry/backoff, confirmation, sweep |
| `api/src/routes/job-publishing.js` | the API, the feeds and the callback |
| `web/teamlink-job-publishing.js` | Post to block, Save & Post, badges, Administration → Integrations |
| `api/test/job-publishing.test.mjs` | API tests against a local mock partner (no real platform is contacted) |
| `tools/verify-job-publishing.mjs` | the browser check, desktop and 390 px |

**Statuses:**

- **Pending**: queued.
- **Posting**: a worker is on it.
- **Posted**: confirmed, with a URL and/or external id.
- **Listed in feed — awaiting confirmation**: Indeed has not confirmed yet.
- **Failed**: the error is shown and the row is retried.
- **Integration Required**: no authorized integration is configured.
- **Removed**: taken down, or never needed to go up.

**Not covered:**

- The Bulk-posting and AI JD Generator pop-ups have no Post to block.
- Jobs from those two forms reach the portal as before, but get publication
  rows only after an edit with Save & Post.
- Real Naukri, Shine and Indeed endpoints have never been called. Only the
  agreement with each platform can provide them.
