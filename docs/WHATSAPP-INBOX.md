# WhatsApp Inbox (Recruiter Portal)

**WhatsApp** in the top header of every recruiter page (with a red unread badge) opens a WhatsApp Web-style inbox inside the portal.

| Left | Middle | Right |
|---|---|---|
| Conversations: avatar / initials, name, number, latest message with its tick, time, **unread count**, campaign, "needs reply", owner. Search by name, number or message. | The conversation: every message with date separators and **Sending / Sent / Delivered / Read / Failed** ticks, the campaign it belongs to, the message a reply answers (quoted), photos and documents. Reply box with attach. | **Campaign & filters**: campaign, assigned recruiter, department, date range, WhatsApp number, reply status (needs reply / replied), unread only. Below: the selected conversation's contact, number, campaign (and the original message), owner; an administrator reassigns it here. |

On a phone it is one pane at a time (list → conversation) with a Filters drawer.

## Replies arrive by themselves
Meta posts the candidate's message to `/api/whatsapp-agent/webhook` (signature checked). It is saved in `whatsapp_messages` (the same tables as the numbers, no second store), filed under the number it was sent to, matched to its conversation, and **pushed to every open inbox** over server-sent events (`/api/whatsapp/inbox/stream`); the header badge updates on every page. An event says only that something changed - never message text - and the page then asks the API, which answers per person.

* A retried webhook event is the same message id: it is saved once and answered once (also after a restart).
* The assistant (the job-search bot) does **not** answer a message that replies to a campaign or arrives in a conversation assigned to a recruiter: that is left for the recruiter. Everything else is answered as before.

## Campaign matching
A campaign send (`Send WhatsApp` with a campaign name) is recorded in the contact's conversation. An incoming message is tied to a campaign only when it can be told:
1. **Reply** - it answers one of the campaign's messages (WhatsApp names the message in `context.id`);
2. **Most likely** - otherwise, the most recent campaign message sent to that contact in the last 3 days (shown as "most likely a reply");
3. otherwise **none**: it is not called a campaign reply.
The campaign filter lists each campaign with its number of replies; the thread shows the campaign name and the original message.

## Who sees what
Row-level security decides, not the screen. An administrator sees everything. Anyone else sees the conversations on numbers they may use that are **unassigned or assigned to them**. The recruiter who ran a campaign is the first assignee; a colleague on the same number, or another team, does not see it. An administrator reassigns from the right panel (or clears the assignment); the history stays with the conversation, and every assignment is in the audit log. Unread is **per person**: opening a conversation reads it for you only.

## Sending
* **Reply**: free text, **only inside WhatsApp's 24-hour window** (the contact wrote to that number in the last 24 hours), through the conversation's own number. After the window, or after the contact sent STOP, or for a do-not-contact candidate, the reply box is closed and **Send a template** (approved templates only) is offered.
* **Files**: JPG / PNG photos (5 MB), PDF / Word / Excel / PowerPoint / text (10 MB), MP4 video and common audio (16 MB) - uploaded to WhatsApp and sent from the same number. What a contact sends is fetched from WhatsApp for those allowed to see the conversation.
* A double click or a retried request is one message (`clientKey`). WhatsApp's refusal is kept in the conversation as **Failed** with its reason.
* Ticks come from WhatsApp's delivery receipts and never move backwards.

## Files
`supabase/migrations/0161_whatsapp_inbox.sql`, `api/src/routes/whatsapp-inbox.js`, `api/src/whatsapp/events.js` (live updates), `api/src/whatsapp/numbers.js` (record, media),
`api/src/routes/whatsapp-agent.js` (webhook, receipts), `api/src/notify/bulk.js` (campaign messages into conversations), `web/teamlink-whatsapp-inbox.js`,
`api/test/whatsapp-inbox.test.mjs` (15 tests).
