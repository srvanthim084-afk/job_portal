/**
 * Walk-in jobs (0106) - the rules and the words, shared by the job
 * routes, the application form and the candidate messages.
 *
 * A walk-in is a job (posting_kind 'walkin') with a date, a time window,
 * a venue and a person to ask for. Dates and times are India Standard
 * Time as the recruiter typed them: 'YYYY-MM-DD' and 'HH:MM'.
 */
import { badRequest, ApiError, CODES } from '../errors.js';
import { walkinEndsAt, walkinStartsAt } from '../shapes.js';

const IST_MS = 330 * 60 * 1000;

/**
 * A Google Maps link (0139): what the venue QR code encodes and a phone opens in Maps.
 * google.<tld>/maps..., maps.google.<tld>/..., maps.app.goo.gl/..., goo.gl/maps/...
 */
export function isGoogleMapsUrl(u) {
  let url;
  try { url = new URL(String(u || '').trim()); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if (host === 'maps.app.goo.gl') return path.length > 1;
  if (host === 'goo.gl') return path.startsWith('/maps');
  /* google.com, google.co.in, google.com.au ... - Google's own domains, and nothing after them */
  if (/^maps\.google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host)) return true;
  if (/^(?:www\.)?google\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(host)) return path.startsWith('/maps') || url.searchParams.has('cid');
  return false;
}

/**
 * The refusal for a walk-in whose dates are over (0137) - one sentence, the same
 * from every apply path. `when` is the date as posted ("2026-10-07" or "6 and 7
 * october 2026"), from walkin_completed() in the database.
 */
export function walkinCompletedError(when) {
  const d = dateLabel(when) || 'its date';
  return new ApiError(409, CODES.WALKIN_COMPLETED,
    `This walk-in was on ${d} and its dates are completed, so applications are closed. Please look at our other open jobs.`,
    { reason: 'walkin_closed', walkinDate: when || null });
}

/** 'YYYY-MM-DD' of the IST calendar day containing `now`. */
export function istDate(now = Date.now()) {
  return new Date(now + IST_MS).toISOString().slice(0, 10);
}
/** The IST wall-clock hour (0-23) at `now`. */
export function istHour(now = Date.now()) {
  return new Date(now + IST_MS).getUTCHours();
}
export function addDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
/** The instant of a walk-in's date + 'HH:MM', in ms (IST). */
export function walkinInstant(date, hhmm) {
  return walkinStartsAt(date, hhmm);
}

/** '10:00 AM' from '10:00'. Anything else is returned as typed. */
export function time12(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '').trim());
  if (!m) return String(t || '').trim();
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** 'Sat, 12 Oct 2026' from 'YYYY-MM-DD'; anything else as typed. */
export function dateLabel(date) {
  const s = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return s;
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[dt.getUTCDay()]}, ${d} ${months[m - 1]} ${y}`;
}

/** '10:00 AM - 4:00 PM', or whichever half exists. */
export function timeRange(from, to) {
  return [time12(from), time12(to)].filter(Boolean).join(' - ');
}

/** Ten digits of an Indian number (+91 / 0 prefixes dropped), or null. */
export function tenDigits(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? d : null;
}
/** A mobile: ten digits starting 6-9. */
export function isMobile(v) {
  const d = tenDigits(v);
  return !!d && /^[6-9]/.test(d);
}

const realDate = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const hhmm = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));

/**
 * The owner's spec names (walkinStartTime, walkinContactPerson, ...) are
 * accepted as well as the 0083 names the screens send, and mean the same
 * columns. Returns a new body; the original is not touched.
 */
export function normaliseWalkinBody(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const b = { ...raw };
  const alias = {
    walkinStartTime: 'walkinFrom', walkinEndTime: 'walkinTo',
    walkinContactPerson: 'walkinContact', walkinContactNumber: 'walkinPhone',
    walkinDocumentsToCarry: 'walkinDocuments', walkinSlotCapacity: 'walkinCapacity',
  };
  for (const [from, to] of Object.entries(alias)) {
    if (b[from] !== undefined && b[to] === undefined) b[to] = b[from];
    delete b[from];
  }
  if (Array.isArray(b.walkinDocuments)) b.walkinDocuments = b.walkinDocuments.map((x) => String(x).trim()).filter(Boolean).join('\n');
  if (b.jobType !== undefined) {
    if (b.postingKind === undefined) {
      const t = String(b.jobType).toLowerCase();
      if (t === 'walk-in' || t === 'walkin') b.postingKind = 'walkin';
      else if (t === 'regular') b.postingKind = 'job';
    }
    delete b.jobType;
  }
  for (const k of ['walkinFrom', 'walkinTo']) {
    if (typeof b[k] === 'string' && /^\d:\d{2}$/.test(b[k].trim())) b[k] = '0' + b[k].trim();
  }
  return b;
}

/**
 * The walk-in rules, on the server, for every screen that saves a job.
 *
 * @param body    the parsed job body
 * @param before  the row as it is now (PUT), or null (POST)
 *
 * Throws badRequest with per-field details. The rules:
 *   - date a real calendar date, times HH:MM, end after start, contact a
 *     valid 10-digit number, map link https://, capacity a whole number;
 *   - published (status open) and new or edited: date, start, end, venue,
 *     full address, contact person and number are required, and the
 *     date and end time may not already be in the past;
 *   - an edit that only closes, pauses or relabels an older walk-in is
 *     not held to rules it was created before (a date typed as free text
 *     by an older form stays as it is until somebody edits it);
 *   - capacity can never go below the people already registered.
 */
export function checkWalkin(body, before, now = Date.now()) {
  const kind = body.postingKind !== undefined ? body.postingKind : (before ? before.posting_kind : 'job');
  if (kind !== 'walkin') return;
  const cur = (k, col) => (body[k] !== undefined ? body[k] : (before ? before[col] : undefined));
  const v = {
    date: cur('walkinDate', 'walkin_date'), from: cur('walkinFrom', 'walkin_from'),
    to: cur('walkinTo', 'walkin_to'), venue: cur('walkinVenue', 'walkin_venue'),
    address: cur('walkinAddress', 'walkin_address'), map: cur('walkinMapLink', 'walkin_map_link'),
    contact: cur('walkinContact', 'walkin_contact'), phone: cur('walkinPhone', 'walkin_phone'),
    capacity: cur('walkinCapacity', 'walkin_capacity'),
  };
  const status = body.status !== undefined ? body.status : (before ? before.status : 'draft');
  const s = (x) => (x == null ? '' : String(x).trim());
  const changed = (k, col) => body[k] !== undefined && (!before || s(body[k]) !== s(before[col]));
  const detailsEdited = !before || ['walkinDate:walkin_date', 'walkinFrom:walkin_from', 'walkinTo:walkin_to',
    'walkinVenue:walkin_venue', 'walkinAddress:walkin_address', 'walkinContact:walkin_contact',
    'walkinPhone:walkin_phone'].some((p) => { const [k, col] = p.split(':'); return changed(k, col); });
  const reopening = before && before.status !== 'open' && status === 'open';
  const errs = {};

  // formats, whenever the value is new
  if (changed('walkinDate', 'walkin_date') && s(v.date) && !realDate(s(v.date))) errs.walkinDate = 'Walk-in date must be a date (YYYY-MM-DD).';
  if (changed('walkinFrom', 'walkin_from') && s(v.from) && !hhmm(s(v.from))) errs.walkinFrom = 'Start time must be a time (HH:MM).';
  if (changed('walkinTo', 'walkin_to') && s(v.to) && !hhmm(s(v.to))) errs.walkinTo = 'End time must be a time (HH:MM).';
  if ((changed('walkinFrom', 'walkin_from') || changed('walkinTo', 'walkin_to'))
      && hhmm(s(v.from)) && hhmm(s(v.to)) && s(v.to) <= s(v.from)) errs.walkinTo = 'End time must be after the start time.';
  if (changed('walkinPhone', 'walkin_phone') && s(v.phone) && !tenDigits(v.phone)) errs.walkinPhone = 'Contact number must be a valid 10-digit number.';
  if (changed('walkinMapLink', 'walkin_map_link') && s(v.map) && !/^https:\/\/\S+$/i.test(s(v.map))) errs.walkinMapLink = 'The map link must start with https://';
  /* 0139: the QR code a candidate scans opens this link - so it must be a Google Maps link */
  else if (changed('walkinMapLink', 'walkin_map_link') && s(v.map) && !isGoogleMapsUrl(s(v.map))) {
    errs.walkinMapLink = 'Please paste the Google Maps link of the venue (google.com/maps, maps.app.goo.gl or goo.gl/maps).';
  }

  const publishing = status === 'open' && (detailsEdited || reopening);
  if (publishing) {
    const need = [['date', 'walkinDate', 'Walk-in date'], ['from', 'walkinFrom', 'Start time'], ['to', 'walkinTo', 'End time'],
      ['venue', 'walkinVenue', 'Venue'], ['address', 'walkinAddress', 'Full address'],
      ['contact', 'walkinContact', 'Contact person'], ['phone', 'walkinPhone', 'Contact number']];
    for (const [key, field, label] of need) {
      if (!s(v[key]) && !errs[field]) errs[field] = `${label} is required for a walk-in job.`;
    }
    const dateMoved = !before || changed('walkinDate', 'walkin_date') || changed('walkinTo', 'walkin_to') || reopening;
    if (dateMoved && !errs.walkinDate && realDate(s(v.date))) {
      if (s(v.date) < istDate(now)) errs.walkinDate = 'The walk-in date cannot be in the past.';
      else {
        const ends = walkinEndsAt(s(v.date), s(v.to));
        if (ends != null && ends <= now && !errs.walkinTo) errs.walkinTo = 'This walk-in would already be over - choose a later end time or date.';
      }
    }
  }

  if (body.walkinCapacity != null && before && before.registered != null
      && Number(body.walkinCapacity) < Number(before.registered)) {
    errs.walkinCapacity = `${before.registered} people have already registered - the capacity cannot be lower than that.`;
  }

  if (Object.keys(errs).length) {
    throw badRequest(Object.values(errs)[0], errs);
  }
}

/**
 * The walk-in's facts for a candidate message, in reading order, empty
 * lines left out. Never the company: candidate-facing walk-in text names
 * the role and the place only.
 */
export function walkinFacts(w) {
  if (!w) return [];
  const docs = String(w.documents || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  return [
    ['Walk-in Date', dateLabel(w.date)],
    ['Time', timeRange(w.from, w.to)],
    ['Venue', w.venue],
    ['Address', w.address],
    ['Map', w.mapLink],
    ['Documents to carry', docs.join(', ')],
    ['Contact', [w.contact, w.phone ? `(${w.phone})` : ''].filter(Boolean).join(' ')],
    ['Instructions', w.instructions],
  ].filter((f) => f[1] != null && String(f[1]).trim() !== '');
}

/** The walk-in columns of a job row as the message builders read them. */
export function walkinOf(row) {
  if (!row || row.posting_kind !== 'walkin') return null;
  return {
    date: row.walkin_date || '', from: row.walkin_from || '', to: row.walkin_to || '',
    venue: row.walkin_venue || '', address: row.walkin_address || '', mapLink: row.walkin_map_link || '',
    documents: row.walkin_documents || '', instructions: row.walkin_instructions || '',
    contact: row.walkin_contact || '', phone: row.walkin_phone || '',
  };
}
