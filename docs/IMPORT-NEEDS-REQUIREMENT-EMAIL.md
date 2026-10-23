# Naukri / Shine import: the recruiter is emailed when there is no requirement to go on (migration 0151)

An imported application that cannot be matched to a requirement used to wait as **Needs a requirement** (Applications ->
Import from email) with nobody told. Now the recruiter who owns the mailbox gets **one email per message**:

* who applied (name, email, phone), what they applied for, why it is waiting, and where to map it
  (Recruiter Portal -> Applications -> Import from email -> Needs a requirement -> pick the requirement -> **Map**);
* a Naukri digest says how many candidates and for which role;
* once only: the database claim (`intake_unmapped_notice_claim`) sets `email_messages.mapping_notified_at` in the statement
  that decides, so a re-sync (which re-reads these messages) or two processes cannot repeat it;
* a failed send gives the claim back and a later sync tries again, at most 3 times (`mapping_notice_tries`);
* a mailbox with no recruiter has nobody to tell (nothing is sent); a message that is not waiting for a requirement sends nothing;
* the import is never held up by it (the email is sent in the background), and the candidate and CV are already saved.

Code: `api/src/notify/unmapped-import.js`, called from `finish()` in `api/src/intake/process.js`.
Tests: `api/test/intake-unmapped-notice.test.mjs`, and an end-to-end check in `api/test/source-mailboxes.test.mjs`.

## Imported but not in Applications (fix, 22 Oct 2026)
A response whose role came off the email as a long board title - e.g. `Urgent | Hiring For BRANDING & MARKETING / CREATIVE CONTENT STRATEGIST` - was refused as "a sentence" (`roleTitle` counted the `|`, `&` and `/` as words). No requirement was created, so the candidate was kept in the pool with **no application**: imported, and nowhere in Applications. The rule now counts real words only (a genuine sentence is still refused).

Messages already stuck at *Needs a requirement* are imported again from **Import from Mail -> "Create the requirement and import them"** (`POST /api/intake/messages/reprocess-unmapped`): a recruiter imports the messages of their own mailboxes, an administrator all of them. The requirement is found or created from the title, the existing candidate is matched (never duplicated), the application and resume are created and screened. **Nobody is written to**: these are old messages, so each login is held (`import_login_notified_at` stays empty) and counted under the administrator's **Send login emails**, the one step that sends a backlog after the count has been looked at.

## Sync imports what is waiting, by itself (23 Oct 2026)
"Mails came, I synced, nothing in the portal": the 44 Shine responses at *Needs a requirement* only moved when somebody pressed the extra button. Now
* **Sync** (Import from Mail) and **Sync now** in Integrations also import again what that mailbox (a recruiter's own, an administrator's all) has waiting for a requirement - logins held, nobody emailed;
* the timer does the same on its first run after a start and then about hourly (`api/src/intake/scheduler.js`);
* a title that a board put symbols in front of (`???? Hiring for Prosthodontist - Dental`, an emoji that arrived as question marks) is stored clean (`Prosthodontist - Dental`), and migration 0163 renames the requirements already created that way;
* a mailbox is read faster: mail it has already been through is recognised from its Message-ID header, so the whole message (a CV attachment) is not downloaded again on every sync, and the per-command wait is 60 s (`MAILBOX_TIMEOUT_MS`) - big mailboxes were failing with "the mail server stopped responding".
