/**
 * Screening answers as they leave TeamLink: the client submission
 * (ats/push.js buildExport) and the recruiter's Excel/CSV export
 * (routes/exports.js).
 *
 * What goes: notice period / last working day, current and expected CTC,
 * current location, relocation, and the job-specific answers.
 * What never goes: the must-have (knock-out) flag, the weights, who
 * answered and how, and the "interviewed through another consultancy"
 * answer - unless the recruiter ticked "share with client" on it.
 */
import { answerText } from './questions.js';

const SHAREABLE = `(s.std_key is distinct from 'other_consultancy' or s.share_with_client)`;

/** For buildExport(): read on the caller's connection, so RLS applies. */
export async function clientScreening(c, applicationId) {
  let rows;
  try {
    rows = (await c.query(
      `select s.std_key, s.question_text, s.question_type, s.answer
         from application_screening_answers s
        where s.application_id = $1 and ${SHAREABLE}
        order by s.position`, [applicationId])).rows;
  } catch { return null; }
  if (!rows.length) return null;
  const by = (k) => rows.find((r) => r.std_key === k);
  const val = (k) => { const r = by(k); return r ? r.answer.value : null; };
  const notice = by('notice_period');
  return {
    noticePeriod: notice ? notice.answer.value : null,
    lastWorkingDay: notice && notice.answer.detail ? notice.answer.detail : null,
    currentCtcLpa: val('current_ctc') == null ? null : Number(val('current_ctc')),
    expectedCtcLpa: val('expected_ctc') == null ? null : Number(val('expected_ctc')),
    currentLocation: val('current_location'),
    willingToRelocate: val('relocate') == null ? null : val('relocate') === 'yes',
    answers: rows.filter((r) => !r.std_key || r.std_key === 'other_consultancy')
      .map((r) => ({ question: r.question_text, answer: answerText(r.answer, r.question_type) })),
  };
}

/* ---- the Excel/CSV columns (routes/exports.js) ---- */

const one = (key) => `(select s.answer from application_screening_answers s
                         where s.application_id = ap.app_id and s.std_key = '${key}' limit 1)`;

export const SCREENING_COLUMNS = {
  screeningNotice:      { label: 'Notice (screening)',           col: one('notice_period') },
  screeningCurrentCtc:  { label: 'Current CTC (screening)',      col: one('current_ctc') },
  screeningExpectedCtc: { label: 'Expected CTC (screening)',     col: one('expected_ctc') },
  screeningLocation:    { label: 'Current Location (screening)', col: one('current_location') },
  screeningRelocate:    { label: 'Willing to Relocate',          col: one('relocate') },
  screeningAnswers:     { label: 'Screening Answers',
    col: `(select jsonb_agg(jsonb_build_object('q', s.question_text, 't', s.question_type, 'a', s.answer) order by s.position)
             from application_screening_answers s
            where s.application_id = ap.app_id
              and (s.std_key is null or (s.std_key = 'other_consultancy' and s.share_with_client)))` },
};

/** A screening cell as a person reads it; undefined for any other column. */
export function presentScreening(key, v) {
  if (!SCREENING_COLUMNS[key]) return undefined;
  if (v == null) return '';
  if (key === 'screeningAnswers') {
    return (Array.isArray(v) ? v : []).map((x) => `${x.q}: ${answerText(x.a, x.t)}`).join(' | ');
  }
  const t = answerText(v);
  if (key === 'screeningCurrentCtc' || key === 'screeningExpectedCtc') return t ? `${t} LPA` : '';
  return t;
}
