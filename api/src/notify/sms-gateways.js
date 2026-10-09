/**
 * The three SMS providers an administrator can choose: MSG91, Fast2SMS, Twilio.
 *
 * Each one speaks its own protocol, so each has its own adapter here. What an
 * adapter returns is the same for all of them - { status, provider, ref?, error? } -
 * and it never reports `sent` unless the provider's own answer says it accepted
 * the message.
 *
 * Indian operators drop a message whose template is not DLT-registered, and some
 * aggregators report that as success. So the DLT template id is sent WITH the
 * message (flow / template), per the provider's own API, and a message with no
 * template for its purpose is refused here rather than sent and lost:
 *   purpose 'agreement'  agreement links     ({name}, {agreement no.}, {link})
 *   purpose 'otp'        one-time codes      ({code}, {minutes})
 *   purpose 'bulk'       everything else     (ONE variable: the message)
 * Twilio needs no DLT template (it sends the text as written).
 *
 * The endpoints can be redirected with MSG91_API_URL / FAST2SMS_API_URL /
 * TWILIO_API_URL - used by the tests against a local server; in production they
 * are the providers' own.
 *
 * The key and the Twilio token are handed in by the caller, used for the one
 * request, and never logged or returned.
 */
const MSG91_URL = () => process.env.MSG91_API_URL || 'https://control.msg91.com/api/v5/flow/';
const FAST2SMS_URL = () => process.env.FAST2SMS_API_URL || 'https://www.fast2sms.com/dev/bulkV2';
const TWILIO_URL = () => (process.env.TWILIO_API_URL || 'https://api.twilio.com/2010-04-01').replace(/\/$/, '');

export const SMS_PROVIDERS = ['MSG91', 'Fast2SMS', 'Twilio'];

/** 10-digit Indian mobiles get 91 in front; anything else keeps its own country code. */
export function indianDigits(to) {
  const d = String(to || '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  return d.replace(/^0+/, '');
}

async function call(url, { method = 'POST', headers = {}, body, timeoutMs = 10_000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { ok: res.ok, status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

const trim = (s) => String(s || '').slice(0, 300);

/** The DLT template for what is being sent, or null. */
function templateFor(templates, purpose) {
  const t = templates || {};
  /* each purpose needs ITS OWN registered template: an OTP sent under the bulk template would be dropped */
  return String(({ agreement: t.agreement, otp: t.otp, bulk: t.bulk }[purpose]) || '').trim() || null;
}

/**
 * Send one SMS.
 * @param p { provider, apiKey, senderId, twilioSid, templates:{agreement,otp,bulk}, purpose, to, text, vars }
 */
export async function sendViaGateway(p) {
  const provider = String(p.provider || '').toLowerCase();
  const purpose = ['agreement', 'otp'].includes(p.purpose) ? p.purpose : 'bulk';
  /* the variables the template carries; a bulk template has ONE: the message */
  const vars = purpose === 'bulk' ? [p.text] : (Array.isArray(p.vars) && p.vars.length ? p.vars : [p.text]);

  try {
    if (provider === 'twilio') {
      if (!p.twilioSid) return { status: 'failed', provider: 'sms', error: 'The Twilio Account SID is not set.' };
      const to = `+${indianDigits(p.to)}`;
      const sender = String(p.senderId || '');
      const form = new URLSearchParams({ To: to, Body: String(p.text || vars.join(' ')) });
      /* a number is sent as +E.164, an alphanumeric sender id as written */
      form.set('From', /^\d{6,}$/.test(sender) ? `+${sender}` : sender);
      const auth = Buffer.from(`${p.twilioSid}:${p.apiKey}`).toString('base64');
      const res = await call(`${TWILIO_URL()}/Accounts/${encodeURIComponent(p.twilioSid)}/Messages.json`, {
        headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
      if (!res.ok) return { status: 'failed', provider: 'sms', error: `Twilio ${res.status}: ${trim(res.json?.message || res.text)}` };
      return { status: 'sent', provider: 'sms', ref: res.json?.sid || null };
    }

    const template = templateFor(p.templates, purpose);
    if (!template) {
      return { status: 'failed', provider: 'sms',
        error: `No DLT template id is set for ${purpose === 'bulk' ? 'bulk / general' : purpose} messages, and the operator would drop the message. Add it in Configure.` };
    }

    if (provider === 'msg91') {
      const recipient = { mobiles: indianDigits(p.to) };
      vars.forEach((v, i) => { recipient[`VAR${i + 1}`] = String(v); });
      const res = await call(MSG91_URL(), {
        headers: { authkey: p.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ template_id: template, sender: p.senderId, short_url: '0', recipients: [recipient] }) });
      /* MSG91 answers 200 with {type:'error'} for a rejected request */
      if (!res.ok || (res.json && String(res.json.type).toLowerCase() === 'error')) {
        return { status: 'failed', provider: 'sms', error: `MSG91 ${res.status}: ${trim(res.json?.message || res.text)}` };
      }
      return { status: 'sent', provider: 'sms', ref: res.json?.message || null };
    }

    if (provider === 'fast2sms') {
      const res = await call(FAST2SMS_URL(), {
        headers: { authorization: p.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ route: 'dlt', sender_id: p.senderId, message: template,
          variables_values: vars.map((v) => String(v).replace(/\|/g, '/')).join('|'), numbers: indianDigits(p.to).replace(/^91/, ''), flash: 0 }) });
      if (!res.ok || (res.json && res.json.return === false)) {
        return { status: 'failed', provider: 'sms', error: `Fast2SMS ${res.status}: ${trim(res.json?.message || res.text)}` };
      }
      return { status: 'sent', provider: 'sms', ref: res.json?.request_id || null };
    }

    return { status: 'failed', provider: 'sms', error: `Unknown SMS provider "${p.provider}".` };
  } catch (err) {
    return { status: 'failed', provider: 'sms', error: err.name === 'AbortError' ? 'The provider did not answer in time.' : err.message };
  }
}
