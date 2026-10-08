# One-click apply (0118)

Apply Now is one click. A signed-in candidate taps it and the application
is made at once. Nothing is asked first, and no profile field is required.

| Piece | Where |
|---|---|
| The browser flow | `web/teamlink-one-click-apply.js` |
| The route | `POST /api/applications/one-click` (`api/src/routes/portal-upgrades.js`) |
| The application itself | `POST /api/applications`, the one-click route hands the request on |
| Browser check, scenarios A-G | `tools/verify-one-click-apply.mjs` |

## What the candidate sees

**Signed in.** Apply Now (job page, cards, Search Jobs, home Easy Apply)
shows at once:

```
✓ Application Submitted Successfully
<job title>
Application ID: TL-APP-2026-00017
You can complete or update your profile anytime.
[View Application] [Complete Profile]
```

For a walk-in the confirmation also has the date, time, venue, View on Map
and Add to Calendar (`TLWalkinJobs.resultHtml`).

There is no application form, no screening questions, no "N of N answered"
and no "Fill N things to apply" sheet in front of the apply.

**Already applied.** "✓ Applied" on the job, and Apply Now shows "You have
already applied for this job." with the existing Application ID. The server
returns the existing application (`existing: true`), never a second one.

**Signed out.** A small box "Apply to <job title>" with one field,
"Email / Mobile Number", and Continue. It uses the existing auth:

- An account exists (`POST /api/auth/register/check`): a password field,
  "Sign in & apply" (`POST /api/auth/login`).
- A new person: registration (resume first, `docs/REGISTRATION.md`), with
  the email prefilled.

Either way the job is remembered (`tl_apply_intent_v1`, the same key
`teamlink-apply-auth.js` has always used). Once the account is signed in,
the application is submitted automatically and the confirmation shows.

**Complete Profile** opens the profile, separately from applying. A profile
not built yet gets the existing "Build your profile" steps (CV first).
Otherwise the profile's own "Complete profile" opens the first missing
section. The "Build your profile" prompt never opens on top of an apply or
its confirmation (`TLOneClickApply.holding()`).

## What did not change

- **One application path.** The one-click route only stopped refusing an
  incomplete profile. It still hands the request to `POST /api/applications`:
  duplicate check, walk-in capacity, rate limit, source, recruiter ownership,
  notifications, the AI match (`screenApplication`) and the pipeline stage.
- **The response** lists what the profile is missing as `profileMissing`.
  It is used only to offer Complete Profile, never to block.
- **Screening questions.** An application made without answers starts as
  `pending` when its job has questions, and the existing sweep sends the
  candidate the no-password screening link (`docs/SCREENING-QUESTIONS.md`).
  The recruiter's screening view is unchanged.
- **The application form is kept.** `TLWalkinJobs.open(jobId)` still opens
  it, with the screening section, prefill, draft, validation and walk-in
  block. Apply Now no longer opens it.
- **Undo hold.** The one-click route still holds the candidate's outbound
  messages for the 10-second window (0104). The confirmation does not offer
  Undo; the messages go out about 15 seconds after the apply.
- External (`xjob_`) jobs keep their own flow. Staff never apply.

## Checks

```
npm --prefix api test                       # portal-upgrades: one-click applies with an incomplete profile
TL_URL=http://127.0.0.1:4424/ node tools/verify-one-click-apply.mjs
```

The second needs an isolated instance; it refuses :4323.

| Scenario | Checked |
|---|---|
| A | Signed in, Apply Now: the confirmation and Application ID at once, no form or questions |
| B | Signed out, existing account: Email / Mobile, password, applied automatically |
| B2 | Signed out, new person: registration, then applied automatically |
| C | A profile without resume, skills or experience applies |
| D | Applying again: "You have already applied", no second application, "✓ Applied" |
| E | The application is in the pipeline with its job, stage and source |
| F | Complete Profile opens the profile builder; nothing covers the confirmation |
| G | The application was screened (AI match) |
