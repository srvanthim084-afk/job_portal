# AI interview: photo verification before the interview (migration 0149)

Tests: `api/test/interview-photo-verification.test.mjs`. Page: `web/teamlink-interview-verification.js`.
Routes: `api/src/routes/interview-verification.js`. Rules in the database: `0149_interview_photo_verification.sql`.

## What a candidate sees

Press **Start AI Video Interview** and, before anything is planned or started, a full-screen verification opens:

| Step | Screen |
|---|---|
| 1 Prepare | job, candidate name, interview length (about 36 minutes, 15 questions), what the camera is for, the camera requirements, a link to the full privacy notice, "I cannot use a camera" |
| 2 Photo | live preview with a face oval, "we can see one face" hint, **Capture photo** |
| 3 Review | the photo; **Retake photo** or **Confirm photo** |
| 4 Instructions | the instructions, the privacy notice (open), two required checkboxes, **Continue to interview** (disabled until both are ticked) |
| 5 Start | **Start interview**: only now is the interview planned and its session created |

A refresh does not lose progress: the page asks the server and picks up at the step the candidate reached, with the stored
photo shown. A camera that is denied, missing, busy, unplugged, an upload that fails, or no network each show a plain message
and a way to try again. Works on phones (front camera, `playsinline`).

The "we can see one face" hint uses the self-hosted face model (`web/vendor/mediapipe`). It **never blocks**: an uncertain face
detection or a camera problem is not a reason to stop a candidate, and nobody is rejected for it.

## What the server enforces (not the page)

* `POST /api/ai-interviews/session` creates a new interview (the questions, the deadline, every timer) **only** from a
  `ready` verification for that application: a confirmed photo, the instructions acknowledged, the consent given, no older than
  `INTERVIEW_VERIFICATION_MINUTES` (180). Otherwise `403 VERIFICATION_REQUIRED` with the missing step - and nothing is created
  (no interview row, no questions generated).
* The check is asked **before** a single question is generated, in the same transaction that creates the interview. The
  verification is then tied to that interview (`used`); one verification starts exactly one session. Requests for the same
  application take turns (an advisory lock), so a double click or parallel requests get the same interview, never two.
* Opening the interview URL or refreshing cannot skip it: the URL only shows the landing page, and the session route is the gate.
* The steps run in order in the database functions: confirming needs a photo; consent needs a confirmed photo, the instructions
  acknowledged and the consent given, against the **current notice version** (an older version is refused with `NOTICE_CHANGED`).
* An interview already under way is handed back as it was (a refresh mid-interview resumes); interviews that were running when
  0149 was installed are exempt (`verification_exempt`). A retake after a suspension is a new attempt and needs a new verification.

## The photo

* Accepted by its **bytes**, not its name: JPEG, PNG or WebP, up to `INTERVIEW_PHOTO_MAX_BYTES` (2 MB). Anything else is `415`/`413`.
* **Encrypted before it is stored** (AES-256-GCM, a fresh IV per photo; key from `INTERVIEW_IMAGE_KEY`, else
  `INTEGRATION_SECRET_KEY`, else `AUTH_SECRET`) in the private storage under a random key. The database keeps only the key, the
  type, size and a hash - **no URL**. Nothing is served publicly. Changing the passphrase makes old photos unreadable; they age out.
* Served only by `GET /api/ai-interviews/verification/:id/photo`: the candidate's own, or a recruiter / admin who can see that
  application (row-level security). Not cached (`no-store`). Every staff view writes `verification.photo_viewed` to the interview audit log.
* A **retake** stores a new file, deletes the old one and restarts the confirmation, instructions and consent.
* **Retention:** `INTERVIEW_IMAGE_RETENTION_DAYS` (default **90**). An hourly sweep deletes the file, clears the key, and writes
  `verification.photo_deleted`. The record of what was agreed (times, notice version) stays; the photo then answers `410`.

## Consent and the notice

The notice text and its version (`NOTICE_VERSION`, in `api/src/interview/verification.js`) come from the server; the consent is
stored against that version with the time. It says why the photo is needed, that **one** photo is taken and **no further photos
are taken during the interview**, that the live camera checks run on the candidate's device and are not uploaded, that answers are
recorded as the interview instructions already say, who can see the photo, how long it is kept, that it is not used for facial
recognition or model training, and where to write for camera problems or privacy requests (`SUPPORT_EMAIL`).
**Change the text -> change `NOTICE_VERSION`**, and candidates are asked again.

## Camera unavailable

"I cannot use a camera" tells the recruiter who owns the application (a notification) and shows the support contact. A recruiter or
admin sees these candidates in a panel on **Applications** ("Candidates who cannot use a camera") and can **Waive photo** with a
reason (`verification.photo_waived`, with who and why). The candidate then only acknowledges the instructions; no image consent is
invented because no image exists. A candidate cannot waive their own photo.

## What a recruiter sees

In **Interview Integrity -> Review** a "Photo verification" block: the photo (opens in a new tab), when it was taken, confirmed,
the instructions acknowledged, the consent and its notice version, when the interview started, and how long the photo is kept.

## Audit

`verification.started`, `.photo_captured`, `.photo_confirmed`, `.ready`, `.session_authorized`, `.camera_help_requested`,
`.photo_waived`, `.photo_viewed`, `.photo_deleted` in `ai_interview_audit`. Ids, sizes and reasons only - never the image, a storage
key, an address or a browser string.

## Config

| Variable | Default | |
|---|---|---|
| `INTERVIEW_PHOTO_VERIFICATION` | on | `off` removes the requirement (development / the older `tools/verify-*.mjs` scripts, which start interviews without a camera) |
| `INTERVIEW_PHOTO_MAX_BYTES` | 2 MB | |
| `INTERVIEW_IMAGE_RETENTION_DAYS` | 90 | **a business / legal decision - confirm it** |
| `INTERVIEW_VERIFICATION_MINUTES` | 180 | how long a finished verification may wait for the interview to start |
| `INTERVIEW_IMAGE_KEY` | (falls back as above) | passphrase that encrypts photos |
| `SUPPORT_EMAIL` | EMAIL_FROM | shown in the notice for camera / privacy requests |

## Known limits

* A photo shows that a picture was submitted; it does not prove identity. The page says so and nothing rejects a candidate for it.
* The privacy notice is a plain-language draft: have it reviewed against your legal and retention requirements before relying on it.
* HTTPS is a deployment matter (browsers only open the camera on HTTPS or localhost); `jobs.teamlinks.in` is served over it.
* The test harness switches the requirement off by default (`INTERVIEW_PHOTO_VERIFICATION=off` in `api/test/harness.mjs`) so the many
  tests that start an interview directly keep working; `interview-photo-verification.test.mjs` switches it on.
