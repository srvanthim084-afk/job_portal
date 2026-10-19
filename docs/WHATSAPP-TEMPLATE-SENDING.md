# WhatsApp template sending (Recruiter Portal)

The **WhatsApp** button on a candidate selection opens one popup, *Send WhatsApp Message*:
1. **Candidates** – the people selected on the page (searchable list, tick boxes, Select all / Deselect all, a count; add more from the pool with the search box). Each row shows name, number, job title and application status.
2. **Select WhatsApp Template** – searchable list of the templates WhatsApp has approved (and an optional *Job* for candidates who have not applied yet).
3. **WhatsApp Message Preview** – the header, body, footer and buttons exactly as that candidate will get them, with a switcher (‹ ›) to read each candidate's own message.
Then *Preview Message*, *Send WhatsApp* (a confirmation first: "You are about to send WhatsApp messages to N selected candidates"), *Cancel*. After sending, a live table shows **Pending / Sent / Delivered / Read / Failed** per candidate, with WhatsApp's reason for a failure and **Retry failed**. The **History** tab lists earlier sends (a recruiter's own; an administrator's view adds a by-recruiter summary).

It is available wherever recruiters select candidates: Talent Pool (selection bar), Find Candidates, and Applications (selection bar – each message then uses that application's own job and status). It is not in the Vendor Portal, HRMS or Accounts.

## Where the candidate's details come from
Never typed. The server fills each template from the database for each candidate: `{{candidate_name}} {{first_name}} {{job_title}} {{application_status}} {{company_name}} {{recruiter_name}} {{interview_date}} {{interview_time}} {{job_location}} {{job_id}} {{job_link}} {{location}} {{notice_period}}`. The application status is the candidate's own word for the stage (`stages.candidate_label`, e.g. *Shortlisted*). A field with no value uses the template's **fallback**; with neither, that candidate is **not sent to** and the popup says which field is missing (nothing ever goes out as `undefined`, `null` or `{{…}}`).

## Who is not sent to (and why it says so)
No / invalid mobile number · *do not contact* · placed · **no WhatsApp opt-in on record** · another recruiter holds them / contacted them inside the cooldown · "not looking" · a missing field with no fallback. An administrator or team lead may tick *include candidates with no opt-in* (recorded). Candidates reply **STOP** to opt out and **START** to opt back in (handled by the webhook).

## Templates (administrators)
*Admin → Integrations → Manage WhatsApp templates* (and *Templates & Campaigns → WhatsApp → + WhatsApp Business template*). Each template has: display name, **WhatsApp template name + language** (as in WhatsApp Manager), category, WhatsApp approval status, header (text / image / document / video), body with `{{fields}}`, footer, buttons (quick reply, link with a variable, call) and fallbacks. **Sync from WhatsApp Business** pulls the approved templates in (needs the access token and the WhatsApp Business account ID: *Integrations → WhatsApp Business → WhatsApp Business ID*, or `WHATSAPP_BUSINESS_ID`); a synced body keeps `{{1}} {{2}}` until each number is matched to a field. The n-th field in the body is parameter n, so the parameters reach WhatsApp in the order the template expects. Recruiters see and can send only templates that are **approved by WhatsApp**, approved in the portal and fully matched.

## How it is sent (no second integration)
`POST /api/whatsapp/send` writes one row per candidate to the existing queue (`message_logs`, drained by `notify/bulk.js`) through the existing WhatsApp provider (`providers.js`) – so the cooldown / hold / availability rules, the **outbound allow-list** (`OUTBOUND_ALLOWLIST`) and "sent only when the provider says so" all apply. Idempotent: the popup makes a key when it opens; the same click twice or a network retry is one send. **Retry failed** re-queues only failed rows. Delivery receipts (sent → delivered → read, failed) arrive at `/api/whatsapp-agent/webhook` (needs `WHATSAPP_APP_SECRET` and the webhook subscribed to *messages* status updates in Meta).
Recorded per message: candidate, number, recruiter, template, job/application, the filled-in text and the exact parameters, time, status, WhatsApp message id, error, and credits when WhatsApp reports a billable message.

## Test before bulk sending
While `OUTBOUND_ALLOWLIST` lists numbers, **only those numbers receive anything**. Put your own test numbers there, send a template to them, then clear it when ready for real candidates.

## Files
`supabase/migrations/0158_whatsapp_templates.sql`, `api/src/whatsapp/templates.js`, `api/src/routes/whatsapp-send.js`, `api/src/routes/whatsapp-agent.js` (receipts, STOP/START), `api/src/notify/providers.js` + `bulk.js` (template payload), `web/teamlink-whatsapp-send.js`, `api/test/whatsapp-template-send.test.mjs` (15 tests).
