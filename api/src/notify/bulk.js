/**
 * Messaging a selection of candidates, on a queue.
 *
 * WHY A QUEUE AND NOT A LOOP. A recruiter ticks forty people and presses
 * Send. Doing that inside the request means the recruiter watches a
 * spinner for a minute, a provider that hangs times the whole request
 * out, and half the batch ends up in a state nobody can name. So the
 * request writes forty rows and returns; this drains them.
 *
 * "SENT" IS ONLY EVER A PROVIDER'S WORD. Queueing returns 202 and says
 * queued - it does not say sent, because nothing has been sent. The row
 * becomes `sent` when a provider says so and `failed` with the reason
 * when it does not. That rule exists because "it returned 200 so it must
 * have worked" is how a recruiter comes to believe forty people were
 * written to when nobody was.
 *
 * NO NEW PROVIDERS. The email, SMS and WhatsApp integrations this
 * application already has are the ones used here, with the same
 * environment variables and the same not-configured reporting. A second
 * set of credentials for the same three channels is a second thing to
 * get wrong.
 */
import { withUser } from '../db.js';
import { providers } from './providers.js';

/* The engine identity: the queue belongs to the system, not to whoever
   happened to fill it. */
const ENGINE = { userId: '', role: 'admin', profileId: null };

/* ------------------------------------------------------------------ *
 * variables
 * ------------------------------------------------------------------ */

/**
 * The variables a recruiter may write into a message.
 *
 * Deliberately short, and every one of them is a fact this system holds
 * about the candidate. There is no `{{anything}}`: a variable that
 * resolves to nothing puts the literal braces into somebody's inbox.
 */
export const VARIABLES = [
  { key: 'candidate_name',  label: "The candidate's full name" },
  { key: 'first_name',      label: 'Their first name only' },
  { key: 'job_title',       label: 'The role they applied for, or their preferred role' },
  { key: 'company',         label: 'TeamLink Consultants' },
  { key: 'recruiter_name',  label: 'Your name' },
  { key: 'location',        label: 'Their current location' },
  { key: 'current_company', label: 'Where they work now' },
  { key: 'notice_period',   label: 'Their notice period' },
];

const COMPANY = 'TeamLink Consultants';

/** What each variable resolves to for one candidate. */
export function varsFor(cand, ctx = {}) {
  const name = String(cand.name || '').trim();
  return {
    candidate_name: name,
    first_name: name.split(/\s+/)[0] || name,
    job_title: String(ctx.jobTitle || cand.preferred_role || cand.title || '').trim(),
    company: COMPANY,
    recruiter_name: String(ctx.recruiterName || '').trim(),
    location: String(cand.location || '').trim(),
    current_company: String(cand.current_company || '').trim(),
    notice_period: String(cand.notice_period || '').trim(),
  };
}

/**
 * Fill {{variable}} in.
 *
 * An UNKNOWN variable is left exactly as it was typed, and an EMPTY one
 * becomes an empty string. Those are different problems and they deserve
 * different outcomes: a typo should be visible in the preview so the
 * recruiter fixes it, while "no notice period on file" is simply
 * nothing to say.
 */
export function render(body, vars) {
  return String(body || '').replace(/\{\{\s*([a-z_]{1,40})\s*\}\}/gi, (whole, key) => {
    const k = String(key).toLowerCase();
    return Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] ?? '') : whole;
  });
}

/** Which field carries the address for a channel. */
export function addressFor(channel, cand) {
  if (channel === 'email') return String(cand.email || '').trim();
  return String(cand.phone || '').trim();     // sms and whatsapp both use the mobile
}

/* ------------------------------------------------------------------ *
 * the templates a recruiter starts from
 *
 * Kept here rather than in a table because they are wording, not data:
 * nothing else reads them, they are always editable in the compose box
 * before anything is sent, and a row per template would be a migration
 * every time somebody rewords a sentence. The endpoint serves them, so
 * the front end never carries a copy.
 * ------------------------------------------------------------------ */
export const TEMPLATES = [
  {
    id: 'blank', name: 'Blank message', channels: ['email', 'sms', 'whatsapp'],
    subject: '', body: '',
  },
  {
    id: 'opportunity', name: 'New opportunity',
    channels: ['email', 'sms', 'whatsapp'],
    subject: '{{job_title}} opportunity at {{company}}',
    body: 'Hi {{first_name}},\n\n'
      + 'I am {{recruiter_name}} from {{company}}. We are hiring for {{job_title}} '
      + 'and your profile looks like a good fit.\n\n'
      + 'Would you be open to a short call this week?\n\n'
      + 'Thanks,\n{{recruiter_name}}\n{{company}}',
  },
  {
    id: 'interview_invite', name: 'Interview invitation',
    channels: ['email', 'sms', 'whatsapp'],
    subject: 'Interview for {{job_title}} — {{company}}',
    body: 'Hi {{first_name}},\n\n'
      + 'We would like to take your application for {{job_title}} forward and invite '
      + 'you to an interview.\n\n'
      + 'Please reply with a time that suits you.\n\n'
      + '{{recruiter_name}}\n{{company}}',
  },
  {
    id: 'documents', name: 'Documents needed',
    channels: ['email', 'whatsapp'],
    subject: 'Documents needed for your {{job_title}} application',
    body: 'Hi {{first_name}},\n\n'
      + 'To move your {{job_title}} application forward we still need a few documents '
      + 'from you. Could you send them across when you get a moment?\n\n'
      + 'Thanks,\n{{recruiter_name}}\n{{company}}',
  },
  {
    id: 'availability', name: 'Checking availability',
    channels: ['sms', 'whatsapp'],
    subject: '',
    body: 'Hi {{first_name}}, {{recruiter_name}} from {{company}}. Are you still '
      + 'looking for a {{job_title}} role? Your notice period on file is '
      + '{{notice_period}}. Please reply yes or no.',
  },
  {
    id: 'walkin', name: 'Walk-in invitation',
    channels: ['sms', 'whatsapp'],
    subject: '',
    body: 'Hi {{first_name}}, {{company}} is holding a walk-in for {{job_title}}. '
      + 'Reply INTERESTED and we will send you the date, time and address.',
  },
];

/* ------------------------------------------------------------------ *
 * the queue drain
 * ------------------------------------------------------------------ */

/**
 * Send one claimed row.
 *
 * WhatsApp's first message to somebody has to be an approved template on
 * the Business API - free text is rejected by Meta, not by us - so the
 * template id travels with the send and the provider decides. A failure
 * there is reported as a failure with Meta's reason, not silently
 * downgraded to SMS.
 */
async function deliver(row) {
  const provider = providers[row.channel];
  if (!provider) {
    return { status: 'failed', provider: row.channel, error: 'no such channel' };
  }
  try {
    return await provider.send({
      to: row.to_address,
      subject: row.subject || undefined,
      text: row.body,
      html: row.channel === 'email' ? htmlOf(row.body) : undefined,
      templateId: row.template_id || undefined,
      vars: { message: row.body, subject: row.subject || '' },
    });
  } catch (err) {
    return { status: 'failed', provider: row.channel, error: err.message };
  }
}

/** Plain text into something an email client renders as it was typed. */
function htmlOf(text) {
  const safe = String(text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:14px;`
    + `line-height:1.6;color:#1b2536;white-space:pre-wrap">${safe}</div>`;
}

/**
 * Drain up to `limit` queued messages.
 *
 * Returns what happened, per status, so the sweep can say something
 * useful in the log rather than "done".
 */
export async function drainQueue({ limit = 20 } = {}) {
  const claimed = await withUser(ENGINE, async (c) => (await c.query(
    `select * from message_log_claim($1)`, [limit])).rows);
  if (!claimed.length) return { claimed: 0 };

  const tally = { claimed: claimed.length, sent: 0, failed: 0, notConfigured: 0 };

  for (const row of claimed) {
    const out = await deliver(row);
    /* The provider's own words for what happened, mapped onto the
       statuses this table allows. `not_configured` stays distinct from
       `failed`: one is a deployment that has not set a key, the other is
       a message that was refused. */
    const status = out.status === 'sent' || out.status === 'delivered' ? 'sent'
      : out.status === 'not_configured' ? 'not_configured'
      : out.status === 'skipped_test_address' ? 'skipped_no_contact'
      : 'failed';

    if (status === 'sent') tally.sent += 1;
    else if (status === 'not_configured') tally.notConfigured += 1;
    else tally.failed += 1;

    await withUser(ENGINE, (c) => c.query(
      `select message_log_result($1,$2,$3,$4,$5)`,
      [row.id, status, out.provider || row.channel, out.ref || null,
       out.error || out.reason || null]))
      .catch((err) => console.error('[bulk] result not recorded:', err.message));
  }
  return tally;
}

/**
 * The background sweep, started with the others in app.js.
 *
 * Short interval, because a recruiter who presses Send expects the
 * messages to go now; the queue exists to get them out of the request,
 * not to delay them.
 */
export function startBulkMessageSweep() {
  const every = Number(process.env.BULK_MESSAGE_SWEEP_MS || 5000);
  const batch = Number(process.env.BULK_MESSAGE_BATCH || 20);
  let stopped = false;
  let running = false;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const out = await drainQueue({ limit: batch });
      if (out.claimed) {
        console.log(`[bulk] ${out.claimed} message(s): ${out.sent} sent`
          + (out.failed ? `, ${out.failed} failed` : '')
          + (out.notConfigured ? `, ${out.notConfigured} with no provider configured` : ''));
      }
    } catch (err) {
      console.error('[bulk] sweep failed:', err.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(run, every);
  if (timer.unref) timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
