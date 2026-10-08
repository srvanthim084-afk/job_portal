# One-click apply (0118)

Apply Now is one click. A signed-in candidate taps it and the application
is made at once. Nothing is asked first, and no profile field is required.

| Piece | Where |
|---|---|
| The browser flow | `web/teamlink-one-click-apply.js` |
| The route | `POST /api/applications/one-click` (`api/src/routes/portal-upgrades.js`) |
| The application itself | `POST /api/applications`, the one-click route hands the request on |
| Browser check, scenarios A-H, X, M | `tools/verify-one-click-apply.mjs` |

## What the candidate sees

**Signed in, profile complete.** Apply Now (job page, cards, Search Jobs,
Recommended, Saved, home Easy Apply) submits at once. No form, modal, drawer
or page opens.

1. The button turns to **"Applying…"** and is disabled (a double tap is one
   application: the module holds one request per job, and the server refuses
   a second).
2. The application is made (`POST /api/applications/one-click`).
3. The button on every card and page for that job becomes **"Applied ✓"**
   (disabled, teal), and a small toast appears (bottom of the screen, above
   the tab bar on a phone):

   ```
   ✓ Applied successfully to <Job Title> at <Company>
     Application ID: TL-APP-2026-00017                [Undo] ✕
   ```

   **Undo** is there for five seconds (`DELETE /api/applications/:id`, the
   server allows it for ten). A walk-in's toast also has the walk-in line and
   Add to Calendar.
4. The job is in `DATA.applications` at once: the Applications page lists it
   as **Applied**, dated today.

**Failure.** An error toast with **Retry**; the button is "Apply Now" again.

**Already applied.** "Applied ✓" from the start (after a refresh too), and a
repeat tap shows "You have already applied for this job." The server returns
the existing application (`existing: true`) or `DUPLICATE_APPLICATION` (409);
never a second.

**Profile incomplete.** Only what a recruiter needs to read an application is
mandatory: name, email, mobile number and **resume**. If one is missing a small
prompt (not a form) says "Please complete your profile to apply" and lists it,
with **[Complete Profile]** and **[Cancel]**. Cancel applies nothing. Complete
Profile opens the resume step (or the profile's first missing section); when
the profile is complete the candidate is returned to the job and the
application is sent by itself (`tl_apply_after_profile_v1`, two hours at most).
The server itself still accepts an incomplete profile; the prompt is the
screen's check.

**External jobs** (Naukri, Indeed, Shine, ...). Apply Now opens the employer's
page in a new tab and records the click (`teamlink-portal-external.js`). The
Applications page lists it in an **External applications** card as **"Applied
(External)"**. It is not an ATS application and has no stage; TeamLink cannot
see what happens on the employer's site, and says so. (The API still calls the
record `clicked` / "Apply Clicked"; only the screen's words changed.)

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
  messages for the 10-second window (0104); the toast's Undo (five seconds)
  falls inside it.
- **ATS side, unchanged.** The normal application record (job, candidate,
  time, AI match, resume on file), match 75% and over to the ATS, 55-74% to
  recruiter review, stage emails as before.
- Staff never apply.

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
