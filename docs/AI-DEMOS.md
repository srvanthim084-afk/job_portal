# AI Hiring Demo and AI WhatsApp Agent

Both pages (`#/ai-pipeline`, `#/whatsapp-demo`) used to be simulations built on
the prototype's seeded demo candidates. Real data hides candidates from
visitors, so they crashed for anyone signed out. They now run on the real
backend; the routes, navbar and page look are unchanged.

## AI Hiring Demo — `#/ai-pipeline`

`POST /api/ai-pipeline/run { jobId, text? , applicationId? }`

| Step | Comes from |
|---|---|
| Resume parsing | `api/src/resume/fields.js` `extractFields` (what an uploaded resume is read with) |
| Job matching | `api/src/ai/ai-match.js` `aiMatch` (JD skills matched / JD skills required) |
| AI screening | `api/src/ai/screening.js` `scoreApplication` (admin-weighted, with the shortlist line from AI Settings) |
| Ranking | the job's real applications (row-level security decides what the viewer can count) |
| Recommendation | the screening verdict; a human always decides |
| AI interview | `api/src/ai/interview.js` `planInterview` (the AI model when `AI_API_KEY` is set, the job-description planner otherwise) |

Three ways in, none invented: paste your own resume text (anyone, nothing is
stored, the text is not logged); your saved profile (a signed-in candidate);
or a real application the viewer may see. A candidate is never shown the
screening verdict, the ranking or the interview score about themselves.

`GET /api/ai-pipeline/applications` lists what the viewer may run it on.

## AI WhatsApp Agent — `#/whatsapp-demo`

One engine (`api/src/whatsapp/agent.js`) answers the page's chat and real
WhatsApp messages. It searches the open TeamLink jobs, sends apply links
(the TeamLink form does the applying), and, for a candidate, answers about
their own applications and interviews through the AI Career Assistant's reads.
Anything else goes to the Career Assistant (the AI model with `AI_API_KEY`,
its labelled rules engine without).

| Endpoint | |
|---|---|
| `GET /api/whatsapp-agent/status` | configured or not (names of missing variables for an admin only) |
| `POST /api/whatsapp-agent/chat` | the page's chat |
| `GET/POST /api/whatsapp-agent/webhook` | Meta's verification handshake and incoming messages |

### Making the real WhatsApp number work

1. In the Meta developer console create a WhatsApp Business app and add a phone number.
2. Server `.env`:
   - `WHATSAPP_API_KEY` — the permanent access token
   - `WHATSAPP_PHONE_ID` — the phone number ID
   - `WHATSAPP_VERIFY_TOKEN` — any long random string you choose
   - `WHATSAPP_APP_SECRET` — the app secret (webhook posts must carry a matching `X-Hub-Signature-256`)
   - optional `WHATSAPP_API_URL`, `WHATSAPP_AGENT_HOURLY_PER_PHONE` (default 40)
3. In Meta: callback URL `https://<your public host>/api/whatsapp-agent/webhook`, verify token as above, subscribe to **messages**. The host must be public HTTPS (a tunnel such as ngrok works for testing). Set `PUBLIC_SHARE_URL` to the same origin so links in replies open for the candidate.
4. Restart the server. The page then shows the channel as connected.

Until then the page says "WhatsApp Agent is not configured…" and the webhook
answers 503. Nothing is pretended: no message is reported as sent that was not.

A sender is matched to a candidate by the last 10 digits of their registered
mobile; if that number belongs to no account (or to more than one) they are
treated as a guest and get public job search only. Meta's retries are answered
once. Message text is not logged.

Free text is only allowed inside WhatsApp's 24-hour window that opens when the
candidate messages you — which is exactly the reply case this handles.

### Not done
- Booking an interview slot from chat: interviews are created by recruiters (or taken as the AI interview on the portal); the agent shows what exists and where to take it.
- Applying from inside the chat: it sends the apply link; the existing application form (with its identity checks) does the applying.
