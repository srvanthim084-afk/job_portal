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
