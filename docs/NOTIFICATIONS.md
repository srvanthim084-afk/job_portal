# Multi-channel interview notifications

Fires once, when an application is confirmed. Every applicable channel is
attempted independently and in parallel.

## What existed before

Very little, and less than it looked like:

| | Prototype | Now |
|---|---|---|
| Naukri | a settings toggle whose own label read **"Simulated"** — a boolean in `localStorage` | a real HTTP integration, honest about needing credentials |
| SMS | a text box for "your SMS API endpoint URL" | server-side provider behind `SMS_API_*` |
| WhatsApp | API key in `localStorage`, readable by any visitor | Cloud API, key server-side only |
| Email | EmailJS, sent **from the browser** | server-side, triggered by the event |
| Delivery tracking | none | one row per channel per attempt |

## The trigger

`POST /api/applications` → application commits → dispatch runs.

Dispatch runs **after** the application transaction commits, deliberately.
A dead SMS gateway must never roll back a candidate's application.

## One invite, one expiry, every channel

`issue_interview_invite()` is called once, before any message is composed.
It returns the token, the expiry (**48 hours**) and the application
timestamp, and every channel is rendered from those same values. No
provider reads the clock itself, so an SMS and an email cannot quote
different deadlines. There is a test that reads the SMS body the provider
actually received and checks the date against the application record.

The interview token is 24 random bytes, not derived from the application
id, so a candidate cannot reach someone else's interview by editing a URL.

## Delivery states

The specification allows `sent` and `failed`. Two more were necessary:

| Status | Meaning |
|---|---|
| `sent` | a provider accepted the message |
| `failed` | a provider was called and refused, errored, or timed out |
| `not_configured` | **no provider credentials** — nothing was attempted |
| `not_applicable` | the channel does not apply (Naukri, for a website application) |
| `skipped_no_address` | the channel applies but the candidate has no phone/email |

`not_configured` exists because the alternative is lying. With no SMS
credentials, recording `sent` tells a recruiter the candidate was
contacted when no message left the building; recording `failed` implies a
provider rejected something that was never sent. When someone asks why a
candidate never heard, those distinctions are the answer.

## Naukri — read this before assuming it works

**Naukri has no open employer API** for pushing a message into a
candidate's Applications or Messages view. Access is partner-gated and
granted per employer account; the endpoint, auth scheme and payload all
come from that agreement.

So the integration is written as a configurable HTTP call rather than a
guess at their protocol. Set `NAUKRI_API_URL` and `NAUKRI_API_KEY` and it
posts a documented payload:

```json
{
  "event": "INTERVIEW_INVITE",
  "candidate": { "name": "...", "email": "...", "phone": "..." },
  "job":       { "id": "j11", "title": "...", "company": "..." },
  "application": { "id": "app_...", "applied_at": "...", "source": "naukri" },
  "interview": { "url": "...", "expires_at": "..." },
  "message": "..."
}
```

Until those are set it reports `not_configured` and **never** reports
`sent`. It is only attempted at all when `application.source = 'naukri'` —
pushing a status update to a platform the candidate never used is noise.

## Independence

Each channel is a separate `Promise`. A provider that throws is caught and
recorded as `failed`; the others are unaffected. Recording the outcomes
cannot fail the application either — if the log write fails it is reported
to stderr and the application still stands.

## The output

`GET /api/applications/:id/notifications` returns the record the
specification defines, plus the attempt log:

```json
{
  "candidate_id": "cand4",
  "job_id": "j11",
  "source": "naukri",
  "channels_attempted": ["naukri", "sms", "whatsapp", "email"],
  "delivery_status": {
    "naukri": "not_configured",
    "sms": "sent",
    "whatsapp": "failed",
    "email": "not_configured"
  },
  "interview_expiry": "2026-09-23T09:16:22.756Z",
  "attempts": [
    { "channel": "sms", "status": "sent", "provider": "sms",
      "providerRef": "mock_1", "attempt": 1, "at": "..." },
    { "channel": "whatsapp", "status": "failed", "provider": "whatsapp",
      "error": "fetch failed", "attempt": 1, "at": "..." }
  ]
}
```

The summary comes from a SQL view over the attempt rows, so it cannot
drift from them. A retry is a new attempt, not an overwrite.

## Visibility

Recruiter and client for their own company, admin for everything, and the
**candidate for their own** — they are entitled to know whether they were
actually contacted. Another candidate gets nothing.

## Verification

```
api/test/api.test.mjs   10 tests
```

All three delivery states are exercised, including the success path
against a mock provider that really answers over HTTP — without that, the
only thing proven would be that broken channels report themselves
correctly.

| State | How |
|---|---|
| `sent` | mock provider returns 200; body and provider ref asserted |
| `failed` | WhatsApp pointed at a host that never answers |
| `not_configured` | email and Naukri have no credentials |
| `not_applicable` | Naukri, on a `website` application |

## Not done

- **No retry/backoff.** A failed channel is recorded and left. The schema
  supports retries (`attempt` increments), but nothing schedules one.
- **No delivery receipts.** Status is what the provider said at submission;
  webhooks for delivered/read are not wired.
- **IVR** is in the channel enum but has no provider.
