/**
 * The prep kit against the database: making and keeping a kit, what the
 * candidate sees, the calendar file, and the messages about an interview.
 *
 * Called from POST/PUT /api/interviews (routes/misc.js) after their
 * transaction commits, and from routes/interview-prep.js.
 */
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { withUser } from '../db.js';
import { config } from '../config.js';
import { toCandidate } from '../shapes.js';
import { sendToCandidate } from '../notify/direct-send.js';
import { buildInterviewMessages } from '../notify/templates-interview.js';
import { buildKit, rulesKit, aiAvailable, locationTypeFor, roundFor, validateKitContent } from './prep-kit.js';
import {
  langOf, labelsFor, tipIn, bringIn, roundLabel, MODE_LABELS, STATUS_LABELS, DATE_LOCALE,
} from './prep-kit-i18n.js';

export const ENGINE = { userId: '', role: 'admin', profileId: null };
const IST_MS = 330 * 60 * 1000;
const base = () => config.publicOrigin.replace(/\/$/, '');
export const kitUrl = (id) => `${base()}/#/candidate/interview-prep/${encodeURIComponent(id)}`;
const interviewsUrl = () => `${base()}/#/candidate/interviews`;

/* ------------------------------------------------------------------ *
 * time
 * ------------------------------------------------------------------ */

/** '11:00 AM', '9:30 pm', '14:30' -> [h, m]; null when unreadable. */
export function parseTime(t) {
  const m = /^\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\s*$/i.exec(String(t || ''));
  if (!m) return null;
  let h = Number(m[1]); const mi = Number(m[2] || 0);
  const ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return [h, mi];
}

/** The start of an interview as an instant: its date and time are IST wall-clock. */
export function startsAt(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(date || ''));
  if (!d) return null;
  const t = parseTime(time) || [10, 0];
  return new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), t[0], t[1]) - IST_MS);
}

export function whenLabel(date, time, lang = 'en') {
  const s = startsAt(date, time);
  if (!s) return lang === 'en' ? 'a time the team will confirm' : labelsFor(lang).toBeConfirmed;
  let day;
  try {
    day = new Date(s.getTime()).toLocaleDateString(DATE_LOCALE[langOf(lang)] || 'en-GB',
      { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  } catch {
    day = new Date(s.getTime()).toLocaleDateString('en-GB',
      { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
  }
  return time ? `${day}, ${time}` : day;
}

const MODE_LABEL = { in_person: 'In person', video: 'Video call', phone: 'Phone call', teamlink_ai: 'TeamLink AI interview' };

/* ------------------------------------------------------------------ *
 * the recruiter's fields on an interview
 * ------------------------------------------------------------------ */

export const prepFieldsSchema = z.object({
  locationType: z.enum(['in_person', 'video', 'phone', 'teamlink_ai']).optional(),
  venueAddress: z.string().trim().max(500).optional(),
  meetingLink: z.string().trim().max(500).optional()
    .refine((v) => !v || /^https?:\/\//i.test(v), 'A meeting link starts with https://'),
  durationMinutes: z.coerce.number().int().min(5).max(600).optional(),
  contactPerson: z.string().trim().max(120).optional(),
  contactPhone: z.string().trim().max(30).optional(),
  candidateInstructions: z.string().trim().max(1000).optional(),
  releaseDetails: z.boolean().optional(),
  sendKit: z.boolean().optional(),
});

const FIELD_COLS = {
  locationType: 'location_type', venueAddress: 'venue_address', meetingLink: 'meeting_link',
  durationMinutes: 'duration_minutes', contactPerson: 'contact_person', contactPhone: 'contact_phone',
  candidateInstructions: 'candidate_instructions',
};

/** Write the prep fields as the caller (RLS decides whether they may). */
export async function savePrepFields(session, interviewId, fields) {
  return withUser(session, async (c) => {
    const sets = []; const vals = [];
    for (const [k, col] of Object.entries(FIELD_COLS)) {
      if (fields[k] !== undefined) { vals.push(fields[k] === '' ? null : fields[k]); sets.push(`${col}=$${vals.length}`); }
    }
    if (fields.releaseDetails === true) sets.push('details_released_at = coalesce(details_released_at, now())');
    if (fields.releaseDetails === false) sets.push('details_released_at = null');
    const iv = (await c.query(`select * from interviews where id=$1`, [interviewId])).rows[0];
    if (!iv) return null;
    const s = startsAt(iv.scheduled_date, iv.scheduled_time);
    vals.push(s); sets.push(`starts_at=$${vals.length}`);
    vals.push(interviewId);
    const upd = await c.query(`update interviews set ${sets.join(',')}, updated_at=now() where id=$${vals.length} returning *`, vals);
    return upd.rows[0] || null;
  });
}

/* ------------------------------------------------------------------ *
 * reading
 * ------------------------------------------------------------------ */

async function interviewContext(interviewId) {
  return withUser(ENGINE, async (c) => {
    const iv = (await c.query(`select * from interviews where id=$1`, [interviewId])).rows[0];
    if (!iv) return null;
    const job = (await c.query(
      `select j.*, co.name as company_name from jobs j left join companies co on co.id=j.company_id where j.id=$1`,
      [iv.job_id])).rows[0] || {};
    const cand = (await c.query(`select * from candidates where id=$1`, [iv.candidate_id])).rows[0] || null;
    const kit = (await c.query(`select * from interview_prep_kits where interview_id=$1`, [interviewId])).rows[0] || null;
    return { iv, job, cand, kit };
  });
}

const jobForKit = (j) => ({
  title: j.title, skills: j.skills || [], exp: j.exp_label, description: j.description,
  location: j.location, mode: j.mode,
});
const ivForKit = (iv) => ({ type: iv.type, mode: iv.mode, locationType: iv.location_type });

/* ------------------------------------------------------------------ *
 * making the kit
 * ------------------------------------------------------------------ */

/**
 * Make or refresh the kit.
 *
 *   regenerate=false  first kit, or a refresh after the date, time, mode or
 *                     venue changed: a kit the recruiter edited keeps its
 *                     questions and tips; the bring-list follows the format.
 *   regenerate=true   "Regenerate": everything from scratch, edits cleared.
 *
 * Built with the rules straight away; when AI is configured, the AI
 * version replaces it in the background (unless a recruiter edits it
 * first), so scheduling never waits on a model.
 */
export async function ensureKit(interviewId, { regenerate = false, by = null, background = true } = {}) {
  const ctx = await interviewContext(interviewId);
  if (!ctx) return null;
  const { iv, job, kit } = ctx;
  const rules = rulesKit(ivForKit(iv), jobForKit(job));
  const keep = kit && kit.recruiter_edited && !regenerate;
  const note = aiAvailable() ? 'AI engine running; rules kit shown meanwhile' : 'AI_API_KEY is not set: rules engine';

  await withUser(ENGINE, async (c) => {
    if (!kit) {
      await c.query(
        `insert into interview_prep_kits (id, interview_id, questions, tips, bring_list, generated_by, engine_note)
         values ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,'rules',$6) on conflict (interview_id) do nothing`,
        [`kit_${randomBytes(8).toString('hex')}`, interviewId, JSON.stringify(rules.questions),
         JSON.stringify(rules.tips), JSON.stringify(rules.bringList), note]);
    } else if (keep) {
      await c.query(`update interview_prep_kits set bring_list=$2::jsonb, generated_at=now() where id=$1`,
        [kit.id, JSON.stringify(rules.bringList)]);
    } else {
      await c.query(
        `update interview_prep_kits set questions=$2::jsonb, tips=$3::jsonb, bring_list=$4::jsonb,
                generated_by='rules', engine_note=$5, generated_at=now(),
                recruiter_edited=false, edited_by=$6, edited_at=case when $6::text is null then edited_at else now() end
          where id=$1`,
        [kit.id, JSON.stringify(rules.questions), JSON.stringify(rules.tips), JSON.stringify(rules.bringList),
         note, regenerate ? by : null]);
    }
  });

  if (!keep && aiAvailable()) {
    const upgrade = async () => {
      const out = await buildKit(ivForKit(iv), jobForKit(job), job.company_name || '');
      await withUser(ENGINE, (c) => c.query(
        `update interview_prep_kits set questions=$2::jsonb, tips=$3::jsonb, generated_by=$4, engine_note=$5, generated_at=now()
          where interview_id=$1 and not recruiter_edited`,
        [interviewId, JSON.stringify(out.questions), JSON.stringify(out.tips), out.generatedBy, out.engineNote]));
    };
    if (background) upgrade().catch((err) => console.error('[prep-kit] AI upgrade failed:', err.message));
    else await upgrade().catch((err) => console.error('[prep-kit] AI upgrade failed:', err.message));
  }
  return readKitStaff(ENGINE, interviewId);
}

/** A recruiter's edits. Checked like an AI answer: no company, no promises. */
export async function editKit(session, interviewId, { questions, tips, bringList }, by) {
  const ctx = await interviewContext(interviewId);
  if (!ctx) return null;
  const kit = {
    questions: (questions || []).map((x) => ({ q: String(x.q || '').trim(), why: String(x.why || '').trim(), topic: String(x.topic || '').trim().slice(0, 40) }))
      .filter((x) => x.q),
    tips: (tips || []).map((t) => String(t).trim()).filter(Boolean),
  };
  const bring = (bringList || []).map((b, i) => ({
    key: String(b.key || `item_${i + 1}`).replace(/[^\w-]/g, '').slice(0, 40) || `item_${i + 1}`,
    text: String(b.text || '').trim().slice(0, 160),
  })).filter((b) => b.text);
  // Recruiters may write fewer than six questions; every other check is
  // the one an AI answer has to pass.
  const company = ctx.job.company_name || '';
  try { validateKitContent(kit, company, { minQuestions: 1, minTips: 0 }); }
  catch (err) { throw Object.assign(new Error(`The kit ${err.message}. Candidates see it - change that and save again.`), { status: 400 }); }
  try { validateKitContent({ questions: kit.questions, tips: bring.map((b) => b.text) }, company, { minQuestions: 1, minTips: 0 }); }
  catch (err) { throw Object.assign(new Error(`A bring-list item ${err.message}.`), { status: 400 }); }
  const out = await withUser(session, (c) => c.query(
    `update interview_prep_kits set questions=$2::jsonb, tips=$3::jsonb, bring_list=$4::jsonb,
            recruiter_edited=true, edited_by=$5, edited_at=now()
      where interview_id=$1 returning id`,
    [interviewId, JSON.stringify(kit.questions), JSON.stringify(kit.tips),
     JSON.stringify(bring.length ? bring : ctx.kit.bring_list), by]));
  if (!out.rowCount) return null;
  return readKitStaff(session, interviewId);
}

/* ------------------------------------------------------------------ *
 * what each side sees
 * ------------------------------------------------------------------ */

/**
 * The candidate's page, built from candidate_interview_prep_v (or the
 * same columns for the recruiter's preview). No company, by construction:
 * the row has no company column to put anywhere.
 *
 * `lang` is the candidate's preferred language (0102). In te / hi the
 * tips, the bring-list (where they are the rules engine's own template
 * text), the mode, the round, the status and the page's headings
 * (`labels`) are in that language; the questions stay English
 * (spec §4). The .ics is always built from the English view.
 */
export function candidateView(row, ticks = [], { lang = 'en' } = {}) {
  const l = langOf(lang);
  const done = new Map(ticks.map((t) => [t.item_key, !!t.done]));
  const s = row.starts_at ? new Date(row.starts_at) : startsAt(row.scheduled_date, row.scheduled_time);
  const lt = row.location_type || locationTypeFor({ mode: row.mode, type: row.type });
  const bring = (row.bring_list || []).map((b) => ({ key: b.key, text: bringIn(b.text, l), done: done.get(b.key) === true }));
  return {
    interviewId: row.interview_id,
    role: row.job_title,
    // "Client Round" is "Company Round" to a candidate (0051), in every language.
    round: roundLabel(row.type || 'Interview', l),
    mode: (MODE_LABELS[l] || MODE_LABEL)[lt] || row.mode || null,
    locationType: lt,
    status: (STATUS_LABELS[l] && STATUS_LABELS[l][row.status]) || row.status,
    statusCode: row.status,
    date: row.scheduled_date ? String(row.scheduled_date).slice(0, 10) : null,
    time: row.scheduled_time || null,
    when: whenLabel(row.scheduled_date, row.scheduled_time, l),
    startsAt: s ? s.toISOString() : null,
    durationMinutes: Number(row.duration_minutes || 60),
    joinOpensAt: s ? new Date(s.getTime() - 15 * 60000).toISOString() : null,
    detailsReleased: !!row.details_released,
    venue: row.details_released ? row.venue_address || null : null,
    mapsUrl: row.details_released && row.venue_address
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(row.venue_address)}` : null,
    meetingLink: row.details_released ? row.meeting_link || null : null,
    contact: row.details_released && (row.contact_person || row.contact_phone)
      ? { name: row.contact_person || null, phone: row.contact_phone || null } : null,
    instructions: row.candidate_instructions || null,
    questions: row.questions || [],               // English, always (spec §4)
    tips: (row.tips || []).map((t) => tipIn(t, l)),
    bringList: bring,
    checklist: { done: bring.filter((b) => b.done).length, total: bring.length },
    viewedAt: row.viewed_at || null,
    language: l,
    labels: labelsFor(l),
    kitReady: !!row.kit_id,
  };
}

/** The recruiter's view of one interview's kit, read as `session`. */
export async function readKitStaff(session, interviewId) {
  return withUser(session, async (c) => {
    const iv = (await c.query(`select * from interviews where id=$1`, [interviewId])).rows[0];
    if (!iv) return null;
    const kit = (await c.query(`select * from interview_prep_kits where interview_id=$1`, [interviewId])).rows[0] || null;
    if (!kit && session.role !== 'admin') {
      const ok = (await c.query(`select prep_kit_staff_ok($1) as ok`, [interviewId])).rows[0].ok;
      if (!ok) return null;
    }
    const job = (await c.query(`select title from jobs where id=$1`, [iv.job_id])).rows[0] || {};
    // The preview is exactly what the candidate sees - in their language.
    const lang = langOf((await c.query(`select preferred_language from candidates where id=$1`,
      [iv.candidate_id])).rows[0]?.preferred_language);
    const ticks = kit ? (await c.query(`select item_key, done from interview_prep_checklist where kit_id=$1`, [kit.id])).rows : [];
    const msgs = (await c.query(
      `select kind, channel, status, error, created_at from interview_prep_messages
        where interview_id=$1 and status <> 'claimed' order by created_at desc limit 40`, [interviewId])).rows;
    const row = {
      interview_id: iv.id, job_title: job.title, type: iv.type, mode: iv.mode, status: iv.status,
      scheduled_date: iv.scheduled_date, scheduled_time: iv.scheduled_time, starts_at: iv.starts_at,
      duration_minutes: iv.duration_minutes, location_type: iv.location_type,
      venue_address: iv.venue_address, meeting_link: iv.meeting_link, contact_person: iv.contact_person,
      contact_phone: iv.contact_phone, details_released: !!iv.details_released_at,
      candidate_instructions: iv.candidate_instructions,
      kit_id: kit && kit.sent_at ? kit.id : null, questions: kit ? kit.questions : [], tips: kit ? kit.tips : [],
      bring_list: kit ? kit.bring_list : [], viewed_at: kit ? kit.viewed_at : null,
    };
    const preview = candidateView(row, ticks, { lang });
    return {
      interview: {
        id: iv.id, status: iv.status, type: iv.type, mode: iv.mode, date: preview.date, time: iv.scheduled_time,
        locationType: iv.location_type || preview.locationType, venueAddress: iv.venue_address,
        meetingLink: iv.meeting_link, durationMinutes: iv.duration_minutes, contactPerson: iv.contact_person,
        contactPhone: iv.contact_phone, candidateInstructions: iv.candidate_instructions,
        detailsReleasedAt: iv.details_released_at,
      },
      kit: kit ? {
        id: kit.id, questions: kit.questions, tips: kit.tips, bringList: kit.bring_list,
        generatedBy: kit.generated_by, engineNote: kit.engine_note, generatedAt: kit.generated_at,
        recruiterEdited: kit.recruiter_edited, editedBy: kit.edited_by, editedAt: kit.edited_at,
        sentAt: kit.sent_at, viewedAt: kit.viewed_at,
      } : null,
      status: statusOf(kit, ticks),
      preview: { ...preview, kitReady: !!kit },
      messages: msgs,
    };
  });
}

export function statusOf(kit, ticks) {
  const total = kit ? (kit.bring_list || []).length : 0;
  const keys = new Set(kit ? (kit.bring_list || []).map((b) => b.key) : []);
  const done = (ticks || []).filter((t) => t.done && keys.has(t.item_key)).length;
  return { hasKit: !!kit, sent: !!(kit && kit.sent_at), viewed: !!(kit && kit.viewed_at), done, total };
}

/* ------------------------------------------------------------------ *
 * the calendar file
 * ------------------------------------------------------------------ */

const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** An .ics for one interview: role and round, never the company. */
export function buildIcs(view) {
  const start = view.startsAt ? new Date(view.startsAt) : null;
  if (!start) return null;
  const end = new Date(start.getTime() + (view.durationMinutes || 60) * 60000);
  const where = view.venue || view.meetingLink || '';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TeamLink Consultants//Interview Prep Kit//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${view.interviewId}@teamlink-interview`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(`Interview: ${view.role} (${view.round})`)}`,
    ...(where ? [`LOCATION:${icsText(where)}`] : []),
    `DESCRIPTION:${icsText([`${view.round} for ${view.role}.`, view.mode ? `Mode: ${view.mode}` : '',
      `Prep kit: ${kitUrl(view.interviewId)}`].filter(Boolean).join('\n'))}`,
    'BEGIN:VALARM', 'TRIGGER:-PT2H', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(`Interview: ${view.role}`)}`, 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------------ *
 * messages
 * ------------------------------------------------------------------ */

async function templateId(key) {
  try {
    return await withUser(ENGINE, async (c) => (await c.query(
      `select template_id from notification_templates where event_key=$1`, [key])).rows[0]?.template_id || null);
  } catch { return null; }
}

/**
 * One message about an interview, to the candidate, on every channel.
 * @param kind  scheduled | kit | day_before | two_hours | rescheduled | cancelled
 * @param opts  { now, withKit, slot, ignoreQuietHours, override:{date,time} }
 */
export async function sendInterviewMessage(interviewId, kind, opts = {}) {
  let ctx = await interviewContext(interviewId);
  if (!ctx || !ctx.cand) return { kind, delivery_status: {}, skipped: 'not found' };
  // A message that links to the kit must have a kit behind the link.
  if (!ctx.kit && opts.withKit !== false && kind !== 'cancelled') {
    await ensureKit(interviewId);
    ctx = await interviewContext(interviewId);
  }
  const { iv, job } = ctx;
  const date = opts.override ? opts.override.date : iv.scheduled_date;
  const time = opts.override ? opts.override.time : iv.scheduled_time;
  const released = !!iv.details_released_at;
  const lt = iv.location_type || locationTypeFor({ mode: iv.mode, type: iv.type });
  const messages = buildInterviewMessages(kind, {
    candidateName: ctx.cand.name,
    jobTitle: job.title || 'your application',
    when: whenLabel(date, time),
    time,
    round: roundLabel(iv.type || 'Interview', 'en'),   // never "Client Round" (0051)
    modeLabel: MODE_LABEL[lt] || iv.mode,
    kitUrl: kitUrl(iv.id),
    interviewsUrl: interviewsUrl(),
    withKit: opts.withKit !== false,
    venue: released && lt === 'in_person' ? iv.venue_address : null,
    meetingLink: released && lt !== 'in_person' ? iv.meeting_link : null,
    contact: released ? [iv.contact_person, iv.contact_phone].filter(Boolean).join(', ') : null,
  });
  const key = kind === 'day_before' || kind === 'two_hours' ? 'interview_prep_reminder'
    : kind === 'rescheduled' || kind === 'cancelled' ? 'interview_prep_changed' : 'interview_prep_scheduled';
  const attempts = await sendToCandidate(toCandidate(ctx.cand), messages, {
    now: opts.now, ignoreQuietHours: !!opts.ignoreQuietHours, templateId: await templateId(key),
    vars: { job_title: job.title, interview_date: whenLabel(date, time), interview_time: time || '', portal_link: kitUrl(iv.id) },
  });
  await withUser(ENGINE, async (c) => {
    for (const a of attempts) {
      await c.query(`select prep_message_add($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [iv.id, kind, opts.slot || '', a.channel, a.result.status, a.to, a.result.provider || null,
         a.result.ref || null, a.result.error || null]);
    }
    if (opts.withKit !== false && kind !== 'cancelled') {
      await c.query(`update interview_prep_kits set sent_at = coalesce(sent_at, now()) where interview_id=$1`, [iv.id]);
    }
  }).catch((err) => console.error('[prep-kit] could not record messages:', err.message));
  const delivery_status = {};
  attempts.forEach((a) => { delivery_status[a.channel] = a.result.status; });
  return { kind, delivery_status, _messages: messages };
}

/* ------------------------------------------------------------------ *
 * hooks for POST / PUT /api/interviews
 * ------------------------------------------------------------------ */

/**
 * After an interview is created. Saves the prep fields the form sent
 * (contact defaults to the scheduling recruiter), makes the kit and sends
 * "Interview scheduled ... your prep kit: <link>". `sendKit: false` holds
 * the kit back for the recruiter to check first; the candidate is still
 * told the interview is booked.
 *
 * @returns the `notify` object the route returns
 */
export async function interviewScheduled(session, row, body = {}) {
  const parsed = prepFieldsSchema.safeParse(body || {});
  const fields = parsed.success ? parsed.data : {};
  try {
    if (!fields.contactPerson && session.role === 'recruiter') {
      const r = await withUser(session, async (c) => (await c.query(
        `select name from recruiters where id=$1`, [session.profileId])).rows[0]);
      if (r && r.name) fields.contactPerson = r.name;
    }
    if (!fields.locationType) fields.locationType = locationTypeFor({ mode: row.mode, type: row.type });
    await savePrepFields(session, row.id, fields);
    await ensureKit(row.id);
  } catch (err) {
    console.error('[prep-kit] could not prepare the kit:', err.message);
  }
  if (!row.application_id) return null;
  try {
    const out = await sendInterviewMessage(row.id, 'scheduled', { withKit: fields.sendKit !== false });
    return { event: 'INTERVIEW_SCHEDULED', delivery_status: out.delivery_status, prepKit: fields.sendKit !== false ? 'sent' : 'held' };
  } catch (err) {
    console.error('[prep-kit] the scheduled message failed:', err.message);
    return { event: 'INTERVIEW_SCHEDULED', error: 'dispatch_failed', delivery_status: {} };
  }
}

/**
 * After an interview is edited. Cancelled -> "cancelled" at once (and the
 * reminders stop, because they only run for Scheduled interviews).
 * Moved -> the kit is refreshed (recruiter edits kept) and "rescheduled"
 * goes at once; the reminders follow the new time because each is keyed
 * on the slot it is for.
 */
export async function interviewChanged(session, before, after) {
  const wasCancelled = after.status === 'Cancelled' && before.status !== 'Cancelled';
  const moved = after.status !== 'Cancelled'
    && (String(before.scheduled_date || '') !== String(after.scheduled_date || '')
      || String(before.scheduled_time || '') !== String(after.scheduled_time || ''));
  const modeChanged = String(before.mode || '') !== String(after.mode || '');
  if (moved || modeChanged) {
    try {
      await withUser(ENGINE, (c) => c.query(`update interviews set starts_at=$2 where id=$1`,
        [after.id, startsAt(after.scheduled_date, after.scheduled_time)]));
      await ensureKit(after.id);
    } catch (err) { console.error('[prep-kit] refresh failed:', err.message); }
  }
  if (!after.application_id || !(wasCancelled || moved)) return undefined;
  const kitSent = await withUser(ENGINE, async (c) => !!(await c.query(
    `select 1 from interview_prep_kits where interview_id=$1 and sent_at is not null`, [after.id])).rowCount);
  const out = await sendInterviewMessage(after.id, wasCancelled ? 'cancelled' : 'rescheduled', {
    withKit: kitSent,
    override: wasCancelled ? { date: before.scheduled_date, time: before.scheduled_time } : null,
  });
  return { event: wasCancelled ? 'INTERVIEW_CANCELLED' : 'INTERVIEW_RESCHEDULED', delivery_status: out.delivery_status };
}
