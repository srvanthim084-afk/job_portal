/**
 * Salary, as people actually type it.
 *
 * `ctc` and `expected_ctc` are numeric columns, and recruiters and
 * candidates write "18,00,000", "₹18 LPA", "18 lakh" or "1800000" into
 * the fields that fill them. Passing any of the first three straight to
 * Postgres fails with
 *
 *     invalid input syntax for type numeric: "18,00,000"
 *
 * which the API reports as a 500 — a crash, in response to a completely
 * ordinary way of writing a number.
 *
 * One parser, shared, so the offer screen and the resume parser cannot
 * disagree about what "18" means.
 */

/**
 * @param raw  what somebody typed
 * @returns {number|null} rupees per year, or null if there is no number in it
 */
export function toRupees(raw) {
  const text = String(raw ?? '').toLowerCase().replace(/[,\s₹]/g, '');
  const m = /(\d+(?:\.\d+)?)/.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (/lpa|lakh|lac|\dl|l$/.test(text)) return Math.round(n * 100000);
  if (/cr|crore/.test(text)) return Math.round(n * 10000000);
  // A bare small number in a salary field means lakhs in this market:
  // nobody is offered eighteen rupees.
  if (n < 1000) return Math.round(n * 100000);
  return Math.round(n);
}
