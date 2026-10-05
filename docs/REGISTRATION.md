# Candidate registration, Candidate ID, documents and privacy (0109)

## What the candidate sees
`Register` (header) opens `#/register/candidate` - the existing page, re-arranged by
`web/teamlink-registration.js` into seven steps: **1 Basic, 2 Education, 3 Experience,
4 Preferences, 5 Resume, 6 Account, 7 Review**, with a stepper, a progress bar, Back /
Continue and a final **Create Account**. It stays resume-first: the existing upload, the
server parser and the "AI found…" no-overwrite tags are the first thing in step 1.
Step 5 shows the chosen resume (Replace / Remove / Download) and queues optional Cover
Letter, Certificates, Marksheets and Experience Letters.

After the account is created: **Registration Successful / Welcome to TeamLink! /
Candidate ID: TL-CAN-000123 / Your profile has been created successfully. /
[Complete Profile] [Search Jobs]**. When the candidate came from Apply Now, a smaller
non-blocking card says the same and the application continues
(`teamlink-apply-auth.js` is unchanged).

Profile: Candidate ID under the name; **Documents** card (resume + documents: upload,
replace, download, delete with a confirm step); **Your data & privacy** card (consents
with version and date, withdraw/give communication consent, Download My Data, Request
Account Deletion). Recruiters see `Candidate ID · Internal ID` and a Documents panel on
the candidate profile. Admins get **Privacy Requests** in the sidebar.

## Where each field goes
| Form | Stored |
|---|---|
| Full / First / Middle / Last name | `name`, `first_name`, `middle_name`, `last_name` (0109) |
| DOB, Gender, Alternate email | `date_of_birth`, `gender`, `alt_email` (0057) |
| Mobile, WhatsApp | `phone`, `whatsapp_number` (0109) |
| Current location, City, State, Country | `location`, `city` (0109), `state` (0057), `country` (0109) |
| Photo | `candidate_documents` kind `photo` + `photo_*` (0057) |
| Highest qualification, degree, branch, college, year, CGPA, 10th/12th/Grad/PG % | `education` line + `candidate_education` rows (0080) |
| Total experience | `exp` (band label), `exp_years`, `candidate_type` |
| Job title, company, previous company, relevant exp, skills | `title`, `current_company`, `previous_companies`, `relevant_exp_years`, `skills` |
| LinkedIn, GitHub, Portfolio, Certifications, Languages, Summary | existing columns |
| Preferred role, locations (several, comma-joined), employment types | `preferred_role`, `preferred_location`, `preferred_employment_types` (0109) |
| Work mode, expected salary, notice period (the four required) | as before (0082) |
| Current salary, relocate | `ctc` ("7 LPA"), `willing_to_relocate` |
| Availability, message language | 0092, 0102 (their own modules) |
| Preferred communication | `email_opt_in`, `sms_opt_in`, `whatsapp_opt_in`, `preferred_contact_method` |
| Consents | `candidate_consents` (kind, status, version, policy_url, created_at) |

## Server
- `POST /auth/register` (extended): optional `confirmPassword` (must match), `consent
  {terms, communication, resumeProcessing}` (a decline is refused; with
  `REGISTRATION_CONSENT_REQUIRED=true` - default in production - missing consent is
  refused), honeypot `website`, Indian mobile format. Duplicate email ->
  409 `EMAIL_TAKEN` "An account with this email already exists. Please Login.";
  duplicate mobile (last 10 digits, accounts only, advisory-locked in
  `auth_register_candidate`) -> 409 `PHONE_TAKEN` "An account with this mobile number
  already exists.". Returns `candidateCode`.
- Limits: `REGISTER_RATE_LIMIT_MAX` attempts / origin / hour, `REGISTER_FAILURE_MAX`
  refused attempts / origin / hour, `LOGIN_ACCOUNT_LOCK_MAX` wrong passwords per account
  (any origin) per `LOGIN_ACCOUNT_LOCK_MINUTES`. Production defaults 20 / 10 / 20 / 15.
- `POST /auth/register/check` yes/no for the inline duplicate message (`REGISTER_CHECK_MAX`).
- `GET /registration/settings` - `CONSENT_VERSION`, `PRIVACY_POLICY_URL`,
  `PRIVACY_POLICY_VERSION`, `TERMS_URL`, file limits.
- Documents: `POST /candidates/:id/documents`, `PUT|DELETE /candidates/:id/documents/:docId`,
  `GET /candidates/:id/documents/:docId/download`, `DELETE /candidates/:id/resume`.
  Magic bytes + per-kind type + size (`DOCUMENT_MAX_BYTES`, `PHOTO_MAX_BYTES`); every read and
  write under the caller's rights, so a document is exactly as visible as its candidate
  (owner, recruiters RLS lets see the candidate - 0091's shared database, private
  candidates only their own recruiter - and admins).
- Privacy: `GET /me/privacy`, `POST /me/consents`, `GET /me/data-export` (explicit
  allowlist; no staff notes, comments, internal scores, call data or other people),
  `POST /me/deletion-request`, `POST /me/deletion-request/cancel`,
  `GET /admin/deletion-requests`, `POST /admin/deletion-requests/:id`
  (`in_review|completed|rejected`, optional `deactivate`: login suspended + do-not-contact).
  Nothing is ever deleted automatically. No legal-compliance claim is made.
- Messages (`api/src/notify/registration-messages.js`): welcome email with the Candidate
  ID right after registration; one profile reminder after `REGISTRATION_REMINDER_HOURS`
  (48) for thin profiles of people who registered through this flow. Claimed before
  sending, never twice, skipped (and recorded) for do-not-contact, email opt-out or
  withdrawn consent; failed welcomes retried up to 3 attempts by the half-hourly sweep.

## Candidate ID
`candidates.candidate_code` = `TL-CAN-` + 6 digits from `candidate_code_seq` (the 0019
pattern), set by trigger on every insert, backfilled oldest-first, unique, and never
changed by an update.

## Draft
`localStorage['tl_reg_draft_v1']` (device only; listed as local-only in the storage
shim so it never reaches `/api/prefs`): text and ticks only, never a password or a file,
14-day expiry, cleared on success or "Start over". A draft never creates an account.

## Tests
`api/test/registration.test.mjs` (22), `tools/verify-registration.mjs` (28, desktop +
390px). `verify-apply-auth`, `verify-register-form`, `verify-register-resume-first`,
`verify-availability`, `verify-candidate-language` were updated to fill fields on their
steps (`TLRegistration.reveal(id)`).
