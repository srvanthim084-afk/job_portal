# Several WhatsApp numbers, and every conversation in the portal (0160)

## What changed
TeamLink used to have ONE WhatsApp connection. It now supports any number of WhatsApp Business numbers, controlled by the administrator.
The existing connection is not replaced: it becomes the **primary number** (`wan_primary`). Its token and phone-number ID stay where they were
(Integrations → Messaging channels → WhatsApp Business, or `WHATSAPP_API_KEY` / `WHATSAPP_PHONE_ID`), and it is **open to all staff** until the
administrator restricts it, so nothing that worked yesterday stops working.

## Administrator: Integrations → WhatsApp numbers
- **+ Add WhatsApp Number**: display name, the **Phone number ID** and **WhatsApp Business account ID** from Meta, and a **permanent access token**
  (optionally the Meta app secret if the number belongs to a different Meta app). The number is verified with WhatsApp at once.
- **Connection** shows *Connected*, *Disconnected* (with WhatsApp's reason, e.g. an invalid token) or *Verification required* (the number's code /
  display-name verification is not finished). **Verify / Reconnect** asks WhatsApp again, and can take a new token.
- **Assign**: tick departments (Manufacturing, Education, Medical, BDE, HR, or any you type), pick people (recruiters, team leaders, BDEs), or open the
  number to all staff. A person may send from a number if they are picked, work in a ticked department, or it is open to all. Administrators can use every
  active number. **Make default**, **Deactivate / Activate**, **Remove** (history stays), **Edit**.
- Table with search and filters by department, person and connection status, message counts, and **Messages** (the conversations of that number).
- The token is stored sealed (AES-256-GCM, `INTEGRATION_SECRET_KEY`) and never sent to a page; only "saved … 1234". Duplicates (same phone-number ID, or WhatsApp
  reporting the same number) are refused. Every create / assign / verify / reconnect / default / deactivate / remove is in the audit log.

## Sending
The send popup shows **Send from**: the sender's own number (one number: used; several: choose, the default is pre-selected). A person with no number sees
"No WhatsApp number is assigned to you yet" and **cannot send**; asking for a number they have not been given is refused on the server and nothing is queued.
The campaign, History and results show which number each send used. System messages (application updates, OTPs) keep using the primary.

## Conversations, in the portal
- **WhatsApp** button in the header (and the popup's **Conversations** tab): every conversation on the numbers you may use, newest first, with
  "waiting for my reply". Campaign results link each candidate to their conversation; the candidate's profile (Communication) lists what they wrote back
  and what was sent, with the number.
- Candidates' messages arrive at the Meta webhook (`/api/whatsapp-agent/webhook`). **One callback URL serves every number**: each event names its number
  (`metadata.phone_number_id`), and is filed under that number, answered from it, and shown only to people who may use it. Each number has its own verify
  token (shown in its Edit screen); the global `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_APP_SECRET` also keep working.
- **Reply** from the portal is free text and allowed only **inside WhatsApp's 24-hour window** (the contact wrote to that number in the last 24 hours).
  After that, or after the contact sent STOP, or for a do-not-contact candidate, only an approved template (Send WhatsApp) can be used.

## Checking a number with Meta
Press **Verify**: the server calls `GET /{phone-number-id}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status`
with that number's own token, and, when a Business account ID is given, checks the number belongs to it. Nothing is assumed: *Connected* means WhatsApp
answered for that number.

## Files
`supabase/migrations/0160_whatsapp_numbers.sql`, `api/src/whatsapp/numbers.js`, `api/src/routes/whatsapp-numbers.js`,
`api/src/routes/whatsapp-agent.js` (webhook routing), `api/src/notify/providers.js` + `bulk.js` (send from a chosen number),
`web/teamlink-whatsapp-numbers.js`, `web/teamlink-whatsapp-send.js`, `api/test/whatsapp-numbers.test.mjs` (13 tests).
