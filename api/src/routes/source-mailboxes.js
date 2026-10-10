/**
 * Naukri & Shine Email Import - Admin connects each board's mailbox to ONE recruiter (0135).
 *
 * Admin -> Integrations -> Naukri & Shine Email Import. One mailbox per board connection: the Naukri
 * mailbox imports Naukri responses only, the Shine mailbox Shine only, and every candidate and
 * application either creates belongs to the recruiter Admin chose for it.
 *
 * "Connected" means a real login worked. Connect opens the mailbox with the details given (TLS, LOGIN,
 * SELECT INBOX) BEFORE anything is saved; a refused password or IMAP being switched off is said in
 * plain words and nothing is stored. The app password is sealed (AES-256-GCM, publishing/secrets.js)
 * and no endpoint here ever returns it, any part of it, or the username it opens.
 *
 * ADMIN ONLY. The definer functions in 0135 check app_is_admin() themselves as well.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, notFound, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { sealSecrets, secretKeyConfigured } from '../publishing/secrets.js';
import { testImapLogin, IMAP_HOSTS } from '../intake/mailbox.js';
import { syncMailbox } from '../intake/process.js';

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const ENGINE = { userId: '', role: 'admin', profileId: null };

/** Where each provider keeps its incoming mail (IMAP over SSL). */
export const PROVIDER_HOSTS = {
  gmail: { host: 'imap.gmail.com', port: 993 },
  outlook: { host: 'outlook.office365.com', port: 993 },
};
const BOARD = { naukri: 'Naukri', shine: 'Shine' };

/** The email statuses, in the words the Admin screen uses. */
export const STATUS_LABEL = {
  new: 'Pending',
  processed: 'Imported',
  duplicate: 'Duplicate Skipped',
  needs_review: 'Pending Review',
  needs_mapping: 'Pending Review',
  failed: 'Failed',
  ignored: 'Not an application',
};

/* Syncs running right now, so the table can say "Processing" while one is. */
const running = new Set();

function parse(schema, body) {
  const out = schema.safeParse(body || {});
  if (!out.success) {
    const details = {};
    for (const i of out.error.issues) details[i.path.join('.') || 'body'] = i.message;
    throw new ApiError(422, 'VALIDATION_FAILED', 'Please check the highlighted fields.', details);
  }
  return out.data;
}

/* The database's refusals, as the screen should say them. */
function dbError(err) {
  const m = String((err && err.message) || '');
  if (/ADMIN_ONLY/.test(m)) return new ApiError(403, 'FORBIDDEN', 'Only Admin can change the Naukri & Shine mailboxes.');
  if (/NO_SUCH_RECRUITER/.test(m)) return new ApiError(422, 'VALIDATION_FAILED', 'Select a recruiter who exists.', { recruiterId: 'Select a recruiter.' });
  if (/BAD_SOURCE/.test(m)) return new ApiError(422, 'VALIDATION_FAILED', 'The source must be Naukri or Shine.');
  if (/MAILBOX_OTHER_SOURCE/.test(m)) {
    return new ApiError(409, 'MAILBOX_OTHER_SOURCE', 'This mailbox is already connected for the other job board. '
      + 'Naukri and Shine need separate mailboxes.');
  }
  if (/MAILBOX_OWNED/.test(m)) {
    return new ApiError(409, 'MAILBOX_OWNED', 'This mailbox is already connected to another recruiter. '
      + 'Use Reassign on that row to change its recruiter on purpose.');
  }
  return err;
}

/** Why a login did not work, in words somebody can act on. */
export function explainLoginFailure(out, { provider, host }) {
  const raw = String(out.error || '');
  if (out.authFailed || /refused: NO|AUTHENTICATIONFAILED|invalid credentials/i.test(raw)) {
    if (/IMAP access is disabled|IMAP is disabled|enable IMAP|\[ALERT\].*IMAP/i.test(raw)) {
      return 'IMAP is switched off for this mailbox. Turn it on (Gmail: Settings -> Forwarding and POP/IMAP -> Enable IMAP) and connect again.';
    }
    return provider === 'gmail'
      ? 'Gmail refused the login. Use a Google App Password (Google Account -> Security -> 2-Step Verification -> App passwords), '
        + 'not the account password, and check that IMAP is enabled in Gmail settings.'
      : 'The mail server refused the username or password. Check them (an app password if the account uses two-step sign-in) and connect again.';
  }
  if (/did not answer|stopped responding|timed? ?out|ETIMEDOUT/i.test(raw)) {
    return `The mail server ${host} did not answer in time. Check the server name and port, then try again.`;
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return `The mail server ${host} could not be found. Check the server name.`;
  if (/ECONNREFUSED/i.test(raw)) return `${host} refused the connection on that port. Incoming mail (IMAP over SSL) is usually port 993.`;
  if (/certificate|self.signed|CERT_/i.test(raw)) return `${host} did not present a valid security certificate.`;
  return `The mailbox could not be opened: ${raw || 'unknown error'}`;
}

function settingsFor(b, address) {
  const fixed = PROVIDER_HOSTS[b.provider];
  const domain = String(address).split('@')[1] || '';
  return {
    host: fixed ? fixed.host : (b.host || IMAP_HOSTS[domain] || ''),
    port: fixed ? fixed.port : (b.port || 993),
  };
}

const toConnection = (r, stats) => {
  const s = stats || {};
  const cfg = r.config || {};
  return {
    id: r.id,
    source: r.source,
    sourceLabel: BOARD[r.source] || r.source,
    address: r.address,
    provider: cfg.kind || r.provider,
    host: cfg.host || undefined,
    port: cfg.port || undefined,
    authMethod: r.auth_method || undefined,
    recruiterId: r.recruiter_id || undefined,
    recruiterName: r.recruiter_name || undefined,
    status: running.has(r.id) ? 'processing'
      : r.status === 'disconnected' ? 'disconnected'
      : r.status === 'error' ? 'error' : 'connected',
    statusLabel: running.has(r.id) ? 'Processing'
      : r.status === 'disconnected' ? 'Disconnected'
      : r.status === 'error' ? 'Sync failed' : 'Connected',
    lastError: r.status === 'error' ? (r.last_error || undefined) : undefined,
    hasCredential: !!r.secrets_sealed,
    connectedAt: r.connected_at ? new Date(r.connected_at).toISOString() : undefined,
    lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at).toISOString() : undefined,
    lastSuccessfulSyncAt: r.last_success_at ? new Date(r.last_success_at).toISOString() : undefined,
    emailsProcessed: s.processed || 0,
    candidatesImported: s.imported || 0,
    duplicatesSkipped: s.duplicates || 0,
    pendingReview: s.review || 0,
    failedImports: s.failed || 0,
    notApplications: s.ignored || 0,
    pending: s.pending || 0,
  };
};

async function loadConnections(session, id) {
  return withUser(session, async (c) => {
    const rows = (await c.query(
      `select b.*, r.name as recruiter_name
         from email_mailboxes b left join recruiters r on r.id = b.recruiter_id
        where b.source is not null ${id ? 'and b.id = $1' : ''}
        order by b.source, b.created_at`, id ? [id] : [])).rows;
    const stats = Object.fromEntries((await c.query(`select * from source_mailbox_stats()`)).rows
      .map((x) => [x.mailbox_id, x]));
    return rows.map((r) => toConnection(r, stats[r.id]));
  });
}

/** Sync in the background: Connect and Reconnect answer at once; the table shows "Processing". */
function syncInBackground(session, id) {
  if (running.has(id)) return;
  running.add(id);
  syncMailbox(session, id, { limit: 100 })
    .catch((err) => console.error('[source-mailboxes] sync failed for', id, String(err && err.message)))
    .finally(() => running.delete(id));
}

export default function sourceMailboxRoutes() {
  const r = Router();
  const admin = [requireAuth(), requireRole('admin')];

  /** The table. */
  r.get('/intake/source-connections', ...admin, wrap(async (req, res) => {
    const recruiters = await withUser(req.session, async (c) => (await c.query(
      `select id, name, email from recruiters order by name`)).rows);
    res.json({
      connections: await loadConnections(req.session),
      recruiters: recruiters.map((x) => ({ id: x.id, name: x.name, email: x.email })),
      providers: [
        { id: 'gmail', label: 'Gmail', ...PROVIDER_HOSTS.gmail },
        { id: 'outlook', label: 'Outlook / Microsoft 365', ...PROVIDER_HOSTS.outlook },
        { id: 'other', label: 'Other (IMAP)' },
      ],
      canStoreCredentials: secretKeyConfigured(),
    });
  }));

  /** Connect: prove the login, then save (sealed), then the first sync. */
  r.post('/intake/source-connections', ...admin, wrap(async (req, res) => {
    const b = parse(z.object({
      source: z.enum(['naukri', 'shine'], { errorMap: () => ({ message: 'Choose Naukri or Shine.' }) }),
      recruiterId: z.string({ required_error: 'Select a recruiter.' }).trim().min(1, 'Select a recruiter.').max(64),
      address: z.string({ required_error: 'Enter the mailbox email address.' }).trim().toLowerCase()
        .email('That is not a valid email address.').max(160),
      provider: z.enum(['gmail', 'outlook', 'other']).default('gmail'),
      username: z.string().trim().max(160).optional(),
      appPassword: z.string({ required_error: 'Enter the app password.' }).min(1, 'Enter the app password.').max(256),
      host: z.string().trim().max(200).optional(),
      port: z.coerce.number().int().min(1).max(65535).optional(),
    }), req.body);

    if (!secretKeyConfigured()) {
      throw new ApiError(503, 'INTEGRATION_SECRET_KEY_MISSING', 'The server cannot store mailbox passwords safely yet: '
        + 'INTEGRATION_SECRET_KEY is not set (at least 16 characters). Set it in the server environment and restart.');
    }

    const recruiter = await withUser(req.session, async (c) => (await c.query(
      `select id, name from recruiters where id = $1`, [b.recruiterId])).rows[0]);
    if (!recruiter) throw new ApiError(422, 'VALIDATION_FAILED', 'Select a recruiter who exists.', { recruiterId: 'Select a recruiter.' });

    /* the same address cannot be both boards, or two recruiters' - said before any login is tried */
    const existing = await withUser(req.session, async (c) => (await c.query(
      `select id, source, recruiter_id from email_mailboxes where address = $1`, [b.address])).rows[0]);
    if (existing && existing.source && existing.source !== b.source) throw dbError(new Error('MAILBOX_OTHER_SOURCE'));
    if (existing && existing.recruiter_id && existing.recruiter_id !== b.recruiterId) throw dbError(new Error('MAILBOX_OWNED'));

    const { host, port } = settingsFor(b, b.address);
    if (!host) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'Enter the incoming mail (IMAP) server for this mailbox.',
        { host: 'Enter the IMAP server, for example imap.yourcompany.com.' });
    }
    const user = b.username || b.address;

    /* THE REAL LOGIN. Nothing is saved unless it works. */
    const login = await testImapLogin({ host, port, user, password: b.appPassword });
    if (!login.ok) {
      throw new ApiError(400, 'MAILBOX_LOGIN_FAILED', explainLoginFailure(login, { provider: b.provider, host }));
    }

    const sealed = sealSecrets({ user, password: b.appPassword });
    const cfg = { kind: b.provider, host, port };
    let id;
    try {
      id = await withUser(req.session, async (c) => (await c.query(
        `select source_mailbox_save($1,$2,$3,$4,'imap',$5::jsonb,$6,'app_password') as id`,
        [newId('mbx'), b.address, b.source, b.recruiterId, JSON.stringify(cfg), sealed])).rows[0].id);
    } catch (err) { throw dbError(err); }

    syncInBackground(req.session, id);
    const [conn] = await loadConnections(req.session, id);
    res.status(201).json({
      connection: conn,
      message: `${BOARD[b.source]} mailbox connected for ${recruiter.name}. The login was verified; the first sync has started.`,
    });
  }));

  /** Reconnect: test again (with a new app password, or the stored one), then mark connected. */
  r.post('/intake/source-connections/:id/reconnect', ...admin, wrap(async (req, res) => {
    const b = parse(z.object({
      appPassword: z.string().max(256).optional(),
      username: z.string().trim().max(160).optional(),
    }), req.body);
    const box = await withUser(req.session, async (c) => (await c.query(
      `select * from email_mailboxes where id = $1 and source is not null`, [req.params.id])).rows[0]);
    if (!box) throw notFound('That mailbox connection could not be found.');

    const { mailboxSecrets } = await import('../intake/mailbox.js');
    const stored = mailboxSecrets(box.address, box);
    const cfg = box.config || {};
    const host = cfg.host || stored.host;
    const port = Number(cfg.port || 993);
    const user = b.username || (stored.sealed ? stored.user : box.address);
    const password = b.appPassword || (stored.sealed ? stored.password : '');
    if (!password) {
      throw new ApiError(422, 'VALIDATION_FAILED', 'This mailbox has no saved password (it was disconnected). Enter the app password to reconnect.',
        { appPassword: 'Enter the app password.' });
    }

    const login = await testImapLogin({ host, port, user, password });
    if (!login.ok) {
      await withUser(ENGINE, (c) => c.query(
        `update email_mailboxes set status = case when status = 'disconnected' then status else 'error' end,
                last_error = $2, updated_at = now() where id = $1`,
        [box.id, explainLoginFailure(login, { provider: cfg.kind, host })]));
      throw new ApiError(400, 'MAILBOX_LOGIN_FAILED', explainLoginFailure(login, { provider: cfg.kind, host }));
    }
    const sealed = b.appPassword || !stored.sealed ? sealSecrets({ user, password }) : null;
    try {
      await withUser(req.session, (c) => c.query(`select source_mailbox_reconnect($1,$2,null)`, [box.id, sealed]));
    } catch (err) { throw dbError(err); }
    await withUser(ENGINE, (c) => c.query(`select mailbox_auth_accepted($1)`, [box.id])).catch(() => {});
    syncInBackground(req.session, box.id);
    const [conn] = await loadConnections(req.session, box.id);
    res.json({ connection: conn, message: 'Reconnected. The login was verified; a sync has started.' });
  }));

  /** Sync Now - the mailbox's own board, imports to its own recruiter. */
  r.post('/intake/source-connections/:id/sync', ...admin, wrap(async (req, res) => {
    const box = await withUser(req.session, async (c) => (await c.query(
      `select id, status from email_mailboxes where id = $1 and source is not null`, [req.params.id])).rows[0]);
    if (!box) throw notFound('That mailbox connection could not be found.');
    if (box.status === 'disconnected') {
      throw new ApiError(409, 'MAILBOX_DISCONNECTED', 'This mailbox is disconnected. Reconnect it first.');
    }
    if (running.has(box.id)) throw new ApiError(409, 'SYNC_RUNNING', 'A sync of this mailbox is already running.');
    running.add(box.id);
    let out;
    try { out = await syncMailbox(req.session, box.id, { limit: 100 }); } finally { running.delete(box.id); }
    const results = out.results || [];
    const n = (...st) => results.filter((x) => st.includes(x.status)).length;
    const [conn] = await loadConnections(req.session, box.id);
    res.json({
      connection: conn,
      error: out.error ? (out.message || out.error) : undefined,
      emailsRead: out.seen || 0,
      imported: out.imported || 0,
      duplicates: n('duplicate'),
      alreadyRead: n('already_processed'),
      pendingReview: n('needs_review', 'needs_mapping'),
      failed: n('failed'),
      notThisBoard: results.filter((x) => x.status === 'ignored' && /this mailbox imports/.test(x.reason || '')).length,
    });
  }));

  /** Disconnect: the password is erased and nothing more is read. Imported candidates stay. */
  r.post('/intake/source-connections/:id/disconnect', ...admin, wrap(async (req, res) => {
    let ok;
    try {
      ok = await withUser(req.session, async (c) => (await c.query(
        `select source_mailbox_disconnect($1) as ok`, [req.params.id])).rows[0].ok);
    } catch (err) { throw dbError(err); }
    if (!ok) throw notFound('That mailbox connection could not be found.');
    const [conn] = await loadConnections(req.session, req.params.id);
    res.json({ connection: conn, message: 'Disconnected. The saved password was erased; candidates already imported are unchanged.' });
  }));

  /** Reassign: explicit, confirmed, audited - for the imports from now on; no candidate moves. */
  r.post('/intake/source-connections/:id/reassign', ...admin, wrap(async (req, res) => {
    const b = parse(z.object({
      recruiterId: z.string().trim().min(1, 'Select a recruiter.').max(64),
      confirm: z.literal(true, { errorMap: () => ({ message: 'Confirm the reassignment.' }) }),
    }), req.body);
    let ok;
    try {
      ok = await withUser(req.session, async (c) => (await c.query(
        `select source_mailbox_reassign($1,$2) as ok`, [req.params.id, b.recruiterId])).rows[0].ok);
    } catch (err) { throw dbError(err); }
    if (!ok) throw notFound('That mailbox connection could not be found.');
    const [conn] = await loadConnections(req.session, req.params.id);
    res.json({
      connection: conn,
      message: `New imports from this mailbox now go to ${conn && conn.recruiterName}. Candidates imported earlier stay with their recruiter.`,
    });
  }));

  /** View Logs: what happened to each email - status and reason only, never the email body. */
  r.get('/intake/source-connections/:id/logs', ...admin, wrap(async (req, res) => {
    const box = await withUser(req.session, async (c) => (await c.query(
      `select id from email_mailboxes where id = $1 and source is not null`, [req.params.id])).rows[0]);
    if (!box) throw notFound('That mailbox connection could not be found.');
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select m.id, m.from_address, m.subject, m.received_at, m.status, m.reason, m.processed_at,
              m.has_attachment, m.candidate_id, c.name as candidate_name
         from email_messages m left join candidates c on c.id = m.candidate_id
        where m.mailbox_id = $1
        order by coalesce(m.processed_at, m.received_at) desc nulls last
        limit 200`, [box.id])).rows);
    const audit = await withUser(req.session, async (c) => (await c.query(
      `select action, detail, created_at as at from audit_log where entity = 'mailbox' and entity_id = $1
        order by created_at desc limit 50`, [box.id])).rows).catch(() => []);
    res.json({
      emails: rows.map((m) => ({
        id: m.id,
        from: m.from_address || undefined,
        subject: m.subject || undefined,
        receivedAt: m.received_at ? new Date(m.received_at).toISOString() : undefined,
        processedAt: m.processed_at ? new Date(m.processed_at).toISOString() : undefined,
        status: m.status,
        statusLabel: STATUS_LABEL[m.status] || m.status,
        reason: m.reason || undefined,
        hasAttachment: !!m.has_attachment,
        candidateId: m.candidate_id || undefined,
        candidateName: m.candidate_name || undefined,
      })),
      events: audit.map((a) => ({ action: a.action, detail: a.detail || {}, at: new Date(a.at).toISOString() })),
    });
  }));

  return r;
}
