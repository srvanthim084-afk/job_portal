/**
 * The applied date (0130): stored in UTC as applications.applied_at,
 * shown in IST as "09 Oct 2026" and "3:20 PM", filtered by India days.
 *
 * One place for the wording, so the candidate's email, the in-app
 * notifications, the recruiter's notice and the export all say the same
 * thing about the same moment.
 */
const TZ = 'Asia/Kolkata';

/** "09 Oct 2026" (DD MMM YYYY, IST). */
export function istDate(at) {
  const d = at instanceof Date ? at : new Date(at);
  if (!at || Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ });
}

/** "3:20 PM" (IST). */
export function istTime(at) {
  const d = at instanceof Date ? at : new Date(at);
  if (!at || Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TZ });
}

/** "09 Oct 2026, 3:20 PM IST". */
export function istDateTime(at) {
  const day = istDate(at);
  return day ? `${day}, ${istTime(at)} IST` : '';
}

/** A YYYY-MM-DD India day from a query string, or '' when it is not one. */
export function istDay(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isNaN(t) ? '' : s;
}

/**
 * SQL for "applied between two India days, both inclusive".
 * `push(value)` adds a parameter and returns its placeholder ($n).
 * Returns [] when neither end is set.
 */
export function appliedRangeSql(column, from, to, push) {
  const out = [];
  const a = istDay(from); const b = istDay(to);
  if (a) out.push(`${column} >= (${push(a)}::date::timestamp at time zone '${TZ}')`);
  if (b) out.push(`${column} < ((${push(b)}::date + 1)::timestamp at time zone '${TZ}')`);
  return out;
}

/** Display name of an application source; 'teamlink' is the portal itself. */
export function sourceLabel(src) {
  const v = String(src || '').trim().toLowerCase();
  if (!v || v === 'teamlink' || v === 'portal') return 'TeamLink Portal';
  return { naukri: 'Naukri', shine: 'Shine', indeed: 'Indeed', linkedin: 'LinkedIn', referral: 'Referral',
    job_alert: 'Job alert', walkin: 'Walk-in', external: 'External', rediscovery: 'Rediscovery', mail: 'Mailbox' }[v]
    || v.charAt(0).toUpperCase() + v.slice(1);
}
