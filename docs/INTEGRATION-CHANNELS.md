# Administration -> Integrations: Email (SMTP), SMS Gateway, WhatsApp Business (0122)

Three configurable channels on the Integrations page (below the existing job-site cards, which are
unchanged). Each card shows **Connected / Not Connected** and **Live / Demo**, and has **Connect /
Reconnect, Test, Disconnect, History** and **Configure →**. Configure opens a centred modal (title with
icon, ×, scrollable body, sticky footer: Cancel and **Save & Connect**). Only the Super Admin (the
`admin` role) can open or change them.

## Fields
| Channel | Fields (secret in bold) | Required to connect |
|---|---|---|
| Email (SMTP) | SMTP Host, Port, From Address, Username, **Password / App Key**, Encryption (SSL / STARTTLS / None), Default From Name | host, port, from address, username, password |
| SMS Gateway | Provider (MSG91 / Fast2SMS / Twilio), Sender ID (6 chars) / Twilio From Number, **API Key / Auth Token**, Twilio Account SID (Twilio only), DLT Template ID for Agreement Link / OTP / Bulk | provider, sender ID, key (+ SID for Twilio) |
| WhatsApp Business | Business Phone Number, Phone Number ID, WhatsApp Business ID, **Permanent Access Token**, Template Namespace, Template Language Code, Template Name for Agreement Link / OTP / Bulk | phone number ID, business ID, token |

Required fields are validated on the server and shown inline under each field.

## Secrets
Stored in one AES-256-GCM blob (`integration_channels.secrets_enc`, key = `INTEGRATION_SECRET_KEY`
from the server environment, 16+ characters). They are **never returned**: the page is told "saved"
and, for a long secret, its last four characters, shown as `••••••2026 — leave blank to keep, "-" to
clear`. A save without the key configured is refused with a clear message. Request bodies are never
logged, the history records field *names* only, and test results are scrubbed of secret values.

## What reads these settings
Every sender (candidate messages, offer letters, invoices, payslips, signing OTPs) goes through
`notify/providers.js`. While a channel is **connected**, its saved values are laid over the
environment's (`loadChannelOverlay`), so nothing is hard-coded; **Disconnect** gives the channel back to
the environment's own values (EMAIL_SMTP_*, SMS_*, WHATSAPP_*), if any.

* **Email:** the saved host / port / encryption / username / password / from.
* **SMS:** the chosen provider's own API — MSG91 (flow API), Fast2SMS (DLT route), Twilio (Messages API).
  Callers say what the message is (`purpose: 'otp' | 'agreement'`, default bulk) and the matching DLT
  template is sent with it; a message with no template for its purpose is refused rather than lost.
* **WhatsApp:** Cloud API; the template for the purpose (agreement `{{1}} name, {{2}} agreement no.,
  {{3}} link`; OTP `{{1}} code`; bulk `{{1}}` = the message). Plain text only works inside Meta's
  24-hour customer session.

## Test
Test sends a REAL message through the provider using the **saved** settings (so a channel can be proven
before it is connected): an email to the administrator's own address (or one typed), an SMS / WhatsApp
to a number typed. It respects `OUTBOUND_ALLOWLIST` like every other send. The result and time are on
the card and in the history.

## History
`integration_channel_events`: settings saved (fields changed), secret saved / cleared, connected,
reconnected, disconnected, test passed / failed, with who and when.

## API
`GET /api/admin/integration-channels`, `PUT /…/:channel` (Save & Connect), `POST /…/:channel/connect`,
`/disconnect`, `/test`, `GET /…/:channel/events`.

## Tests
`api/test/integration-channels.test.mjs` (11: real SMTP server, provider stand-ins),
`tools/verify-channel-config.mjs` (browser, 1280 and 390 px).

## Limits
* The MSG91 / Fast2SMS / Twilio / WhatsApp requests follow each provider's documented API and are
  tested against local stand-ins; they have **not** been run against live accounts (no credentials here).
  MSG91 template variables are sent as `VAR1…VARn`; if a template names its variables differently,
  adjust it in `notify/sms-gateways.js`.
* Live / Demo means: Live = connected here (the real provider is contacted); Demo = not connected here.
