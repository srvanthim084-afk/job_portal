# Naukri & Shine responses: in the TeamLink portal only (migration 0162)

Recruiters connect their Naukri / Shine mailbox in **Administration -> Integrations -> Naukri & Shine Email Import**. The responses read
from it are stored in the portal's own database, assigned to the mailbox's recruiter, and shown in **Applications** and **Import from
Mail**. They are **not** forwarded, copied or mentioned by email to a recruiter's own address.

## What was found and removed
Tracing every place that writes to a recruiter's address:

| Path | Before | Now |
|---|---|---|
| `runApplicationAlerts` / daily digest (`api/src/notify/walkin-ats.js`) - "New application: ..." | an email to the job's recruiter for every new application, **including ones imported from Naukri / Shine** | imported applications (`applications.import_method = 'recruiter_email'`) get the **portal** notification only; the email channel is not even claimed |
| `notifyUnmapped` (`api/src/notify/unmapped-import.js`) - "Action needed: ... no requirement matches" | an email to the mailbox's recruiter | a **portal notification** (`IMPORT_NEEDS_REQUIREMENT#<message>`), and the message waits in Import from Mail -> Needs a recruiter |

Checked and clean: the SMTP / EmailJS / HTTP senders (`api/src/notify/providers.js`) set only `to` - no cc, bcc or a recruiter fallback; an
import or login failure is stored on the mailbox (`last_error`, shown in the portal) and nothing else is tried; the sync reads only the
configured source mailboxes; INTERNAL_HR_EMAIL notices are for walk-in applications, not imports.

## The one switch
`INTAKE_RECRUITER_EMAILS=true` (environment, **off** unless exactly `true`) is the separate, explicit approval for emailing a recruiter about
an imported response. Leave it unset. Everything else (password resets, account mail, candidates' own login mail, walk-in/HR notices, alerts
for applications that did not come from an import) is unchanged.

## What is kept on every response (`email_messages`)
`source` (naukri | shine), `mailbox_id`, `message_id` (the provider's own id), `thread_id` (first id in References, else In-Reply-To, else the
message's own Message-ID), `candidate_id`, `application_id`, and the recruiter through the mailbox. `GET /api/intake/messages` and
`/api/intake/queue` return them (`source`, `mailbox`, `messageId`, `threadId`, `recruiterId`, `recruiterName`); Row-Level Security still decides
who sees what (a recruiter sees only their own mailboxes' responses).

## Tested
`api/test/intake-responses-portal-only.test.mjs` against a real TLS IMAP server in the process: a Naukri and a Shine mailbox, one response
each -> both imported to the right recruiter and visible to that recruiter only; no email, copy or cc/bcc to a recruiter; the no-requirement
notice is in the portal; a refused login is an error in the portal with nothing sent and no other mailbox tried; reading again repeats nothing;
an application that did not come from an import still emails its recruiter; only `INTAKE_RECRUITER_EMAILS=true` emails an imported one.

## Who sees an imported response (0164)
An application imported from a recruiter's Naukri / Shine mailbox belongs to that mailbox's recruiter (and their team lead, and Admin). The owner of the job it attached to no longer sees it (pplications_read); applications that came any other way, and ones with no owner, are unchanged. Candidates stay a shared database for **searching** only (Find Candidates shows results only after a search).
