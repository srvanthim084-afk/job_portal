/**
 * Several WhatsApp Business numbers, controlled by the administrator (0160).
 *
 * THE EXISTING CONNECTION IS THE PRIMARY NUMBER. Row `wan_primary` has no credentials of its own: its token and phone-number id stay in
 * the existing configuration (Integrations -> WhatsApp Business, or WHATSAPP_API_KEY / WHATSAPP_PHONE_ID), exactly as before, and the
 * primary number is open to all staff until the administrator restricts it. Every other number is a row with its own phone-number id,
 * business account and a SEALED token (AES-256-GCM, INTEGRATION_SECRET_KEY); no response ever carries one.
 *
 * WHO MAY SEND FROM A NUMBER is one question answered in the database (whatsapp_number_allowed): an administrator, or a recruiter /
 * team leader / BDE who is assigned to it directly, belongs to an assigned department, or the number is open to all. The server asks it
 * on every send; the screen only reflects the answer.
 *
 * WHICH NUMBER A MESSAGE USES: the one the sender chose, if they may; else their only number; else the default among theirs; else they
 * are told to choose. With none, the send is refused with a clear message and nothing is queued.
 */
import { withUser } from '../db.js';
import { config } from '../config.js';
import { ApiError, badRequest, forbidden, notFound } from '../errors.js';
import { sealSecrets, openSecrets, hintFor, secretKeyConfigured, SecretKeyMissing } from '../publishing/secrets.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
export const PRIMARY = 'wan_primary';

const apiBase = () => String(process.env.WHATSAPP_API_URL || config.whatsappApiUrl || 'https://graph.facebook.com/v21.0').replace(/\/$/, '');
const digits = (v) => String(v || '').replace(/\D/g, '');

/* ------------------------------------------------------------------ *
 * credentials, for the code that actually sends
 * ------------------------------------------------------------------ */
let credCache = new Map();
const CRED_TTL = 8000;
export const forgetNumberCredentials = () => { credCache = new Map(); };

/**
 * What to send with for a number. `null` id (every system message that has no sender) and the primary number use the existing global
 * configuration. Returns null when the number cannot be used (inactive, removed, no credentials) - the caller reports it.
 */
export async function credentialsFor(numberId) {
  if (!numberId || numberId === PRIMARY) {
    return { numberId: PRIMARY, accessToken: config.whatsappApiKey, phoneNumberId: config.whatsappPhoneId,
             businessId: config.waBusinessId || process.env.WHATSAPP_BUSINESS_ID || '', apiUrl: apiBase(), primary: true };
  }
  const hit = credCache.get(numberId);
  if (hit && Date.now() - hit.at < CRED_TTL) return hit.value;
  const row = await withUser(ENGINE, async (c) => (await c.query(
    `select * from whatsapp_numbers where id = $1 and removed_at is null`, [numberId])).rows[0]);
  let value = null;
  if (row && row.active && row.phone_number_id) {
    const s = openSecrets(row.access_token_enc);
    if (s && s.accessToken) {
      value = { numberId: row.id, accessToken: s.accessToken, phoneNumberId: row.phone_number_id, businessId: row.business_account_id || '',
                apiUrl: apiBase(), primary: false };
    }
  }
  credCache.set(numberId, { at: Date.now(), value });
  return value;
}

/* ------------------------------------------------------------------ *
 * asking Meta about a number
 * ------------------------------------------------------------------ */
/**
 * GET /{phone-number-id}?fields=... with this number's own token.
 * @returns {{status, detail, displayPhone?, verifiedName?, quality?}}
 */
export async function verifyWithMeta(cred) {
  if (!cred || !cred.accessToken || !cred.phoneNumberId) {
    return { status: 'disconnected', detail: 'No access token or phone number ID is set for this number.' };
  }
  const url = `${cred.apiUrl}/${encodeURIComponent(cred.phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating,code_verification_status,name_status`;
  let res;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${cred.accessToken}` }, signal: AbortSignal.timeout(12000) });
  } catch (err) {
    return { status: 'disconnected', detail: err.name === 'TimeoutError' ? 'WhatsApp did not answer in time.' : `Could not reach WhatsApp: ${err.message}` };
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = json && json.error ? json.error : {};
    const why = String(e.message || `HTTP ${res.status}`).slice(0, 240);
    /* an expired / wrong token or a number this token does not own: disconnected. */
    return { status: 'disconnected', detail: `WhatsApp refused: ${why}` };
  }
  if (cred.businessId) {
    /* the number must belong to the business account the administrator named */
    try {
      const r2 = await fetch(`${cred.apiUrl}/${encodeURIComponent(cred.businessId)}/phone_numbers?fields=id&limit=200`,
        { headers: { authorization: `Bearer ${cred.accessToken}` }, signal: AbortSignal.timeout(12000) });
      const j2 = await r2.json().catch(() => ({}));
      if (r2.ok && Array.isArray(j2.data) && j2.data.length && !j2.data.some((p) => String(p.id) === String(cred.phoneNumberId))) {
        return { status: 'disconnected', detail: 'This phone number ID does not belong to the WhatsApp Business account entered.' };
      }
    } catch { /* the account list is a cross-check; the number itself answered */ }
  }
  const pending = json.code_verification_status && String(json.code_verification_status).toUpperCase() !== 'VERIFIED';
  const nameBad = json.name_status && ['DECLINED', 'EXPIRED', 'NONE'].includes(String(json.name_status).toUpperCase());
  return {
    status: pending || nameBad ? 'verification_required' : 'connected',
    detail: pending ? `The number's code verification is "${json.code_verification_status}": finish verifying it in WhatsApp Manager.`
      : nameBad ? `The display name status is "${json.name_status}": check it in WhatsApp Manager.` : 'Connected.',
    displayPhone: json.display_phone_number || null, verifiedName: json.verified_name || null, quality: json.quality_rating || null,
  };
}

/* ------------------------------------------------------------------ *
 * the administrator's view
 * ------------------------------------------------------------------ */
const shapeAdmin = (n, access, counts) => {
  const primary = n.source === 'primary';
  const primaryCfg = primary ? !!(config.whatsappApiKey && config.whatsappPhoneId) : null;
  const sealed = n.access_token_enc ? openSecrets(n.access_token_enc) : null;
  return {
    id: n.id, primary, displayName: n.display_name,
    displayPhone: n.display_phone || null,
    phoneNumberId: primary ? (config.whatsappPhoneId || null) : n.phone_number_id,
    businessAccountId: primary ? (config.waBusinessId || process.env.WHATSAPP_BUSINESS_ID || null) : n.business_account_id,
    /* the credentials are never returned: only whether one is saved, and the last four characters */
    hasToken: primary ? !!config.whatsappApiKey : !!n.access_token_enc,
    tokenReadable: primary ? true : (n.access_token_enc ? !!sealed : false),
    tokenHint: primary ? (config.whatsappApiKey ? hintFor(config.whatsappApiKey) : null) : (sealed && sealed.accessToken ? hintFor(sealed.accessToken) : null),
    hasAppSecret: !!n.app_secret_enc,
    webhookVerifyToken: n.webhook_verify_token || null,
    verifiedName: n.verified_name || null, quality: n.quality_rating || null,
    status: primary && n.last_verified_at == null ? (primaryCfg ? 'verification_required' : 'disconnected') : n.status,
    statusDetail: primary && n.last_verified_at == null
      ? (primaryCfg ? 'Press Verify to check the connection.' : 'WhatsApp Business is not configured (Configure below).') : n.status_detail,
    lastVerifiedAt: n.last_verified_at, isDefault: n.is_default, active: n.active, openToAll: n.open_to_all,
    departments: access.departments, users: access.users, department: n.department || (n.open_to_all ? 'All staff' : null),
    messagesIn: counts.in, messagesOut: counts.out, createdAt: n.created_at, updatedAt: n.updated_at,
  };
};

export async function listNumbers(session) {
  return withUser(session, async (c) => {
    const nums = (await c.query(`select * from whatsapp_numbers where removed_at is null order by (source = 'primary') desc, display_name`)).rows;
    const deps = (await c.query(`select number_id, department from whatsapp_number_departments order by lower(department)`)).rows;
    const users = (await c.query(
      `select a.number_id, u.id as user_id, u.role, coalesce(r.name, b.name, u.email) as name, u.email,
              coalesce(r.department, case when u.role = 'bde' then 'BDE' end) as department, coalesce(r.is_team_lead, false) as team_lead
         from whatsapp_number_users a join users u on u.id = a.user_id
         left join recruiters r on r.user_id = u.id left join bde_users b on b.user_id = u.id`)).rows;
    const out = (await c.query(`select whatsapp_number_id as id, count(*)::int n from message_logs where whatsapp_number_id is not null group by 1`)).rows;
    const inn = (await c.query(`select number_id as id, count(*)::int n from whatsapp_messages where direction = 'in' group by 1`)).rows;
    const outM = new Map(out.map((x) => [x.id, x.n]));
    const inM = new Map(inn.map((x) => [x.id, x.n]));
    return nums.map((n) => shapeAdmin(n, {
      departments: deps.filter((d) => d.number_id === n.id).map((d) => d.department),
      users: users.filter((u) => u.number_id === n.id).map((u) => ({ userId: u.user_id, name: u.name, email: u.email, role: u.role, department: u.department, teamLead: u.team_lead })),
    }, { in: inM.get(n.id) || 0, out: outM.get(n.id) || 0 }));
  });
}

/** Everybody who can be given a number, and the departments in use (for the assignment screen). */
export async function assignableStaff(session) {
  return withUser(session, async (c) => {
    const staff = (await c.query(
      `select u.id as user_id, u.role, coalesce(r.name, b.name, u.email) as name, u.email,
              coalesce(r.department, case when u.role = 'bde' then 'BDE' end) as department, coalesce(r.is_team_lead, false) as team_lead
         from users u left join recruiters r on r.user_id = u.id left join bde_users b on b.user_id = u.id
        where u.role in ('recruiter', 'bde') order by lower(coalesce(r.name, b.name, u.email))`)).rows
      .map((u) => ({ userId: u.user_id, name: u.name, email: u.email, role: u.role, department: u.department, teamLead: u.team_lead }));
    const depts = (await c.query(
      `select d from (select department d from recruiters where department is not null and btrim(department) <> ''
                      union select department from whatsapp_number_departments
                      union select unnest(array['Manufacturing','Education','Medical','BDE','HR'])) x order by lower(d)`)).rows.map((r) => r.d);
    return { staff, departments: [...new Map(depts.map((d) => [d.toLowerCase(), d])).values()] };
  });
}

const audit = (c, action, id, detail) => c.query(`select audit_write($1,'whatsapp_number',$2,$3::jsonb)`, [action, id, JSON.stringify(detail || {})]);

/* ------------------------------------------------------------------ *
 * create / edit / reconnect / activate / remove
 * ------------------------------------------------------------------ */
function clean(input, { creating }) {
  const d = {};
  const displayName = String(input.displayName || '').trim();
  if (!displayName) d.displayName = 'Give the number a display name.';
  if (displayName.length > 80) d.displayName = 'Keep the display name under 80 characters.';
  const phoneNumberId = String(input.phoneNumberId || '').trim();
  if (creating && !/^\d{5,24}$/.test(phoneNumberId)) d.phoneNumberId = 'Enter the Phone number ID from Meta (digits only).';
  const business = String(input.businessAccountId || '').trim();
  if (business && !/^\d{5,24}$/.test(business)) d.businessAccountId = 'The WhatsApp Business account ID is digits only.';
  const token = String(input.accessToken || '').trim();
  if (creating && token.length < 20) d.accessToken = 'Enter the permanent access token from Meta.';
  if (token && token.length < 20) d.accessToken = 'That access token looks too short.';
  const phone = String(input.displayPhone || '').trim();
  if (phone && !/^\+?[\d\s()-]{8,20}$/.test(phone)) d.displayPhone = 'Enter the WhatsApp number with its country code, e.g. +91 98765 43210.';
  if (Object.keys(d).length) throw badRequest('Please check the highlighted fields and try again.', d);
  return { displayName, phoneNumberId, business, token, phone, appSecret: String(input.appSecret || '').trim() };
}

const dup = (err) => (err && err.code === '23505'
  ? new ApiError(409, 'DUPLICATE', 'That WhatsApp number (or phone number ID) is already connected.') : err);

export async function createNumber(session, input, newId, randomToken) {
  const v = clean(input, { creating: true });
  if (!secretKeyConfigured()) throw new ApiError(409, 'INTEGRATION_SECRET_KEY_MISSING', new SecretKeyMissing().message);
  const id = newId('wan');
  const sealed = sealSecrets({ accessToken: v.token });
  const appSealed = v.appSecret ? sealSecrets({ appSecret: v.appSecret }) : null;
  const digitsOnly = digits(v.phone);
  await withUser(session, async (c) => {
    await c.query(
      `insert into whatsapp_numbers (id, source, display_name, display_phone, phone_digits, phone_number_id, business_account_id, access_token_enc,
                                      app_secret_enc, webhook_verify_token, status, status_detail, created_by, updated_by)
       values ($1,'portal',$2,$3,$4,$5,$6,$7,$8,$9,'verification_required','Not verified yet.', app_user_id(), app_user_id())`,
      [id, v.displayName, v.phone || null, digitsOnly || null, v.phoneNumberId, v.business || null, sealed, appSealed, randomToken()])
      .catch((e) => { throw dup(e); });
    await audit(c, 'whatsapp_number.created', id, { displayName: v.displayName, phoneNumberId: v.phoneNumberId });
  });
  /* a number WhatsApp reports as one already connected (same display number) is not kept half-made */
  try {
    return await verifyNumber(session, id);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'DUPLICATE') {
      await withUser(session, (c) => c.query(`update whatsapp_numbers set removed_at = now(), active = false, access_token_enc = null, app_secret_enc = null where id = $1`, [id]));
    }
    throw err;
  }
}

export async function updateNumber(session, id, input) {
  const row = await getRow(session, id);
  const primary = row.source === 'primary';
  const v = clean({ ...input, phoneNumberId: row.phone_number_id || '0'.repeat(6) }, { creating: false });
  const sets = ['display_name = $2', 'updated_by = app_user_id()', 'updated_at = now()'];
  const params = [id, v.displayName];
  if (!primary) {
    if (input.phoneNumberId && String(input.phoneNumberId).trim() !== row.phone_number_id) {
      if (!/^\d{5,24}$/.test(String(input.phoneNumberId).trim())) throw badRequest('Please check the highlighted fields and try again.', { phoneNumberId: 'Enter the Phone number ID from Meta (digits only).' });
      params.push(String(input.phoneNumberId).trim()); sets.push(`phone_number_id = $${params.length}`);
      sets.push(`status = 'verification_required'`, `status_detail = 'Changed: verify again.'`);
    }
    if (input.businessAccountId !== undefined) { params.push(v.business || null); sets.push(`business_account_id = $${params.length}`); }
    if (v.phone) { params.push(v.phone); sets.push(`display_phone = $${params.length}`); params.push(digits(v.phone) || null); sets.push(`phone_digits = $${params.length}`); }
    if (v.token) {
      if (!secretKeyConfigured()) throw new ApiError(409, 'INTEGRATION_SECRET_KEY_MISSING', new SecretKeyMissing().message);
      params.push(sealSecrets({ accessToken: v.token })); sets.push(`access_token_enc = $${params.length}`);
      sets.push(`status = 'verification_required'`, `status_detail = 'New token saved: verify again.'`);
    }
    if (v.appSecret) {
      if (!secretKeyConfigured()) throw new ApiError(409, 'INTEGRATION_SECRET_KEY_MISSING', new SecretKeyMissing().message);
      params.push(sealSecrets({ appSecret: v.appSecret })); sets.push(`app_secret_enc = $${params.length}`);
    }
  }
  await withUser(session, async (c) => {
    await c.query(`update whatsapp_numbers set ${sets.join(', ')} where id = $1 and removed_at is null`, params).catch((e) => { throw dup(e); });
    await audit(c, 'whatsapp_number.updated', id, { fields: sets.map((s) => s.split(' =')[0]).filter((s) => !/^updated_/.test(s)), tokenChanged: !!v.token });
  });
  forgetNumberCredentials();
  return id;
}

async function getRow(session, id) {
  const row = await withUser(session, async (c) => (await c.query(`select * from whatsapp_numbers where id = $1 and removed_at is null`, [id])).rows[0]);
  if (!row) throw notFound('That WhatsApp number could not be found.');
  return row;
}

/** Ask WhatsApp about the number and record the answer (Verify / Reconnect). */
export async function verifyNumber(session, id, newToken) {
  const row = await getRow(session, id);
  if (newToken) {
    if (row.source === 'primary') throw badRequest('The primary number\'s token is changed in Integrations -> WhatsApp Business.');
    if (String(newToken).trim().length < 20) throw badRequest('Please check the highlighted fields and try again.', { accessToken: 'That access token looks too short.' });
    if (!secretKeyConfigured()) throw new ApiError(409, 'INTEGRATION_SECRET_KEY_MISSING', new SecretKeyMissing().message);
    await withUser(session, (c) => c.query(`update whatsapp_numbers set access_token_enc = $2 where id = $1`, [id, sealSecrets({ accessToken: String(newToken).trim() })]));
    forgetNumberCredentials();
  }
  forgetNumberCredentials();
  const cred = row.source === 'primary' ? await credentialsFor(PRIMARY) : await credentialsFor(id).then(async (c) => c || await rawCredentials(id));
  const r = await verifyWithMeta(cred);
  await withUser(session, async (c) => {
    await c.query(
      `update whatsapp_numbers
          set status = $2, status_detail = $3, last_verified_at = now(), verified_name = coalesce($4, verified_name), quality_rating = coalesce($5, quality_rating),
              display_phone = coalesce($6, display_phone), phone_digits = coalesce($7, phone_digits), updated_by = app_user_id(), updated_at = now()
        where id = $1`,
      [id, r.status, r.detail, r.verifiedName || null, r.quality || null, r.displayPhone || null, r.displayPhone ? digits(r.displayPhone) : null])
      .catch((e) => { throw dup(e); });
    await audit(c, newToken ? 'whatsapp_number.reconnected' : 'whatsapp_number.verified', id, { status: r.status, detail: r.detail });
  });
  forgetNumberCredentials();
  return id;
}

/* credentials of a number even if it is inactive (so an inactive one can still be verified before it is switched on) */
async function rawCredentials(id) {
  const row = await withUser(ENGINE, async (c) => (await c.query(`select * from whatsapp_numbers where id = $1 and removed_at is null`, [id])).rows[0]);
  const s = row && openSecrets(row.access_token_enc);
  return row && s && s.accessToken ? { accessToken: s.accessToken, phoneNumberId: row.phone_number_id, businessId: row.business_account_id || '', apiUrl: apiBase() } : null;
}

export async function setAccess(session, id, { departments, userIds, openToAll }) {
  await getRow(session, id);
  await withUser(session, (c) => c.query(`select whatsapp_number_set_access($1,$2::text[],$3::uuid[],$4)`,
    [id, (departments || []).map((d) => String(d).trim()).filter(Boolean).slice(0, 30), (userIds || []).slice(0, 500), !!openToAll]));
  return id;
}

export async function setDefault(session, id) {
  await getRow(session, id);
  await withUser(session, (c) => c.query(`select whatsapp_number_make_default($1)`, [id]))
    .catch((e) => { throw e && e.code === '22023' ? new ApiError(422, 'VALIDATION_FAILED', 'Only an active number can be the default.') : e; });
  return id;
}

export async function setActive(session, id, active) {
  const row = await getRow(session, id);
  if (row.source === 'primary') throw new ApiError(422, 'VALIDATION_FAILED', 'The primary number is switched off by disconnecting WhatsApp Business in this section.');
  await withUser(session, async (c) => {
    await c.query(`update whatsapp_numbers set active = $2, is_default = case when $2 then is_default else false end, updated_by = app_user_id(), updated_at = now() where id = $1`, [id, !!active]);
    await audit(c, active ? 'whatsapp_number.activated' : 'whatsapp_number.deactivated', id, {});
  });
  forgetNumberCredentials();
  return id;
}

export async function removeNumber(session, id) {
  const row = await getRow(session, id);
  if (row.source === 'primary') throw new ApiError(422, 'VALIDATION_FAILED', 'The primary number cannot be removed.');
  await withUser(session, async (c) => {
    await c.query(`delete from whatsapp_number_users where number_id = $1`, [id]);
    await c.query(`delete from whatsapp_number_departments where number_id = $1`, [id]);
    /* soft: its messages keep their history; the unique keys are freed so the number can be added again */
    await c.query(`update whatsapp_numbers set removed_at = now(), active = false, is_default = false, access_token_enc = null, app_secret_enc = null,
                          updated_by = app_user_id(), updated_at = now() where id = $1`, [id]);
    await audit(c, 'whatsapp_number.removed', id, { displayName: row.display_name });
  });
  forgetNumberCredentials();
}

/* ------------------------------------------------------------------ *
 * staff: which numbers may I use, which one does this send use
 * ------------------------------------------------------------------ */
export async function myNumbers(session) {
  const rows = await withUser(session, async (c) => (await c.query(`select * from whatsapp_my_numbers()`)).rows);
  return rows.map((n) => ({ id: n.id, displayName: n.display_name, displayPhone: n.display_phone, department: n.department,
    status: n.status, isDefault: n.is_default, primary: n.is_primary }));
}

export const NO_NUMBER = 'No WhatsApp number is assigned to you yet. Ask an administrator to give you (or your department) a number in Integrations -> WhatsApp, then try again.';

/**
 * The number a send uses, for THIS person. Throws a 403 / 409 the screen can show; a number the person may not use is never returned.
 */
export async function resolveSender(session, requestedId) {
  const mine = await myNumbers(session);
  if (requestedId) {
    const hit = mine.find((n) => n.id === requestedId);
    if (!hit) throw forbidden('You are not allowed to send from that WhatsApp number.');
    return hit;
  }
  if (!mine.length) throw new ApiError(403, 'NO_WHATSAPP_NUMBER', NO_NUMBER);
  if (mine.length === 1) return mine[0];
  const def = mine.find((n) => n.isDefault);
  if (def) return def;
  throw new ApiError(409, 'CHOOSE_WHATSAPP_NUMBER', 'Choose which WhatsApp number to send from.', { numbers: mine.map((n) => ({ id: n.id, displayName: n.displayName })) });
}

export const labelOf = (n) => `${n.displayName}${n.displayPhone ? ` (${n.displayPhone})` : ''}`;

/* ------------------------------------------------------------------ *
 * inbound routing
 * ------------------------------------------------------------------ */
/** The number a webhook event was addressed to (Meta says its phone-number id in the event's metadata). */
export async function numberForPhoneId(phoneNumberId) {
  const pid = String(phoneNumberId || '');
  if (pid) {
    const row = await withUser(ENGINE, async (c) => (await c.query(
      `select id from whatsapp_numbers where phone_number_id = $1 and removed_at is null`, [pid])).rows[0]);
    if (row) return row.id;
  }
  /* an event with no metadata, or addressed to the existing connection: the primary number */
  if (!pid || pid === String(config.whatsappPhoneId || '')) return PRIMARY;
  return null;
}

/** Every secret that may sign a webhook body, and every verify token that may answer the Meta handshake. */
export async function webhookSecrets() {
  const rows = await withUser(ENGINE, async (c) => (await c.query(
    `select app_secret_enc, webhook_verify_token from whatsapp_numbers where removed_at is null`)).rows);
  const secrets = [];
  const tokens = [];
  for (const r of rows) {
    const s = r.app_secret_enc ? openSecrets(r.app_secret_enc) : null;
    if (s && s.appSecret) secrets.push(s.appSecret);
    if (r.webhook_verify_token) tokens.push(r.webhook_verify_token);
  }
  return { secrets, tokens };
}

export async function recordMessage({ numberId, direction, contact, name, body, waId, kind, by }) {
  return withUser(ENGINE, async (c) => (await c.query(
    `select whatsapp_message_record($1,$2,$3,$4,$5,$6,$7,$8) as id`, [numberId, direction, contact, name || null, body || '', waId || null, kind || 'text', by || null])).rows[0].id);
}
