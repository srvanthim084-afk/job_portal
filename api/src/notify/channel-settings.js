/**
 * The per-channel settings a recruiter fills in, read at send time.
 *
 * Credentials come from the environment and these come from the
 * database, and the split is deliberate: a key is a secret that belongs
 * to the deployment, while a sender header or a DLT template id is
 * operational and changes on an afternoon when an operator approves a
 * new wording. Asking somebody to redeploy for the second is how a panel
 * ends up storing the first.
 *
 * Cached for a few seconds. A dispatch touches every channel for every
 * candidate in a campaign, and re-reading two rows for each of them is
 * wasted work - but a recruiter who saves a template id and sends a test
 * must not be told to wait, so the cache is short and the save clears
 * it outright.
 */
import { withUser } from '../db.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };
const TTL_MS = 5000;

const EMPTY = {
  senderId: null,
  dltEntityId: null,
  dltTemplateId: null,
  templateName: null,
  templateLanguage: 'en',
};

let cache = null;
let cachedAt = 0;

const shape = (row) => (row ? {
  senderId: row.sender_id || null,
  dltEntityId: row.dlt_entity_id || null,
  dltTemplateId: row.dlt_template_id || null,
  templateName: row.template_name || null,
  templateLanguage: row.template_language || 'en',
  updatedAt: row.updated_at || null,
} : { ...EMPTY });

/**
 * Every channel's settings, keyed by channel.
 *
 * Never throws. A provider that cannot read its settings must still
 * attempt the send with what the environment gives it - failing to
 * deliver because a settings table was briefly unreachable would be a
 * worse outcome than sending without an optional header.
 */
export async function loadChannelSettings() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;

  try {
    const rows = await withUser(ENGINE, async (c) => (await c.query(
      `select * from channel_settings`)).rows);
    const next = { sms: { ...EMPTY }, whatsapp: { ...EMPTY } };
    for (const row of rows) next[row.channel] = shape(row);
    cache = next;
    cachedAt = Date.now();
    return cache;
  } catch (err) {
    console.error('[channels] settings could not be read:', err.message);
    return cache || { sms: { ...EMPTY }, whatsapp: { ...EMPTY } };
  }
}

/** One channel's settings, or the empty shape. */
export async function channelSettings(channel) {
  const all = await loadChannelSettings();
  return all[channel] || { ...EMPTY };
}

/** Called after a save, so the next send uses what was just entered. */
export function forgetChannelSettings() {
  cache = null;
  cachedAt = 0;
}
