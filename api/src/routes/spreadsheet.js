/**
 * Spreadsheets in and out.
 *
 * IN:  a recruiter uploads a list of candidates. The screen accepted only
 *      pasted CSV, so anybody working from the .xlsx a job board or a
 *      client sent had to open Excel, Save As CSV, and hope the commas in
 *      "Bengaluru, Karnataka" survived. Both formats are read here, on the
 *      server, where the file can be parsed properly.
 *
 * OUT: the AI calling results as a real .xlsx. CSV opens in Excel but is
 *      not an Excel file - it loses types, mangles long phone numbers into
 *      scientific notation, and cannot hold a second sheet.
 *
 * Both use api/src/xlsx.js, which has no dependencies.
 */
import { Router } from 'express';
import multer from 'multer';
import { withUser } from '../db.js';
import { wrap, badRequest, ApiError } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { readSpreadsheet, writeSheet } from '../xlsx.js';
import { toRupees } from '../money.js';
import { inviteCandidates } from '../notify/invite.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const ENGINE = { userId: '', role: 'admin', profileId: null };

/* ------------------------------------------------------------------ *
 * reading a candidate list
 * ------------------------------------------------------------------ */

/**
 * Work out which column is which.
 *
 * A file from Naukri, one from a client and one somebody typed by hand
 * will not agree on column order or spelling, and demanding a fixed order
 * is how an import feature ends up unused. Headers are matched loosely;
 * a file with no recognisable header falls back to the documented order.
 */
/*
 * ORDER MATTERS. The first pattern that matches a column claims it, and a
 * column is claimed once - so the most specific spelling has to come
 * first. A Naukri export carries both "Current Designation" and "Role";
 * if `title` matched "Role" first, the designation column would be left
 * for something else to pick up.
 */
const FIELDS = [
  ['name', /^(candidate\s*)?(full\s*)?name$|^candidate$|^applicant\s*name$/i],
  // "Verified Mobile" is a yes/no column in a Naukri export, not a
  // number, so the real one is matched first and the flag never wins.
  ['phone', /^(mobile|phone|contact)\s*(no\.?|number|num)?$|mobile\s*number|phone\s*number|^cell/i],
  ['email', /^e.?mail(\s*(id|address))?$|^email$/i],
  ['skills', /key\s*skills|it\s*skills|^skills?$|technolog|stack/i],
  ['location', /^(current\s*)?(location|city)$|current\s*location|^based/i],
  ['preferredLocation', /pref.*location/i],
  ['title', /current\s*designation|^designation$|resume\s*headline|job\s*title|^title$|^position$/i],
  ['currentCompany', /current\s*(employer|company|organi[sz]ation)|^company$|^employer$|organi[sz]ation/i],
  /*
   * Naukri writes experience as "5 Year(s) 6 Month(s)" and also exports
   * a plain "Total Experience". Both are read; parseExperience() below
   * turns the first into 5.5 rather than 56.
   */
  ['expYears', /total\s*exp|work\s*exp|^exp(erience)?\s*(in\s*years|years|yrs)?$/i],
  // "Annual Salary" and "Expected Annual Salary" are Naukri's wording;
  // the expected one is matched FIRST so it cannot be taken as current.
  ['expectedCtc', /expected\s*(annual\s*)?(ctc|salary|package)|exp(ected)?\s*ctc/i],
  ['ctc', /current\s*(annual\s*)?(ctc|salary|package)|^annual\s*salary$|^ctc$|^salary$/i],
  ['noticePeriod', /notice/i],
  ['education', /highest\s*(degree|qualification)|ug\s*course|pg\s*course|education|qualification|degree/i],
  ['source', /^source$|portal|job\s*board/i],
];

/**
 * "5 Year(s) 6 Month(s)" is five and a half years, not fifty-six.
 *
 * Stripping the non-digits - which is what this did - glued the numbers
 * together and imported a candidate with 56 years of experience. Naukri
 * writes it that way on every row of an export, so it was not an edge
 * case; it was every row.
 */
export function parseExperience(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;

  const ym = /(\d+(?:\.\d+)?)\s*(?:y|yr|yrs|year|years)\b[^\d]*(?:(\d+)\s*(?:m|mo|mon|month|months)\b)?/i.exec(s);
  if (ym) {
    const years = Number(ym[1]) + (ym[2] ? Number(ym[2]) / 12 : 0);
    return Number.isFinite(years) ? Math.round(years * 10) / 10 : null;
  }
  // Months alone - a fresher with "8 Month(s)".
  const m = /(\d+)\s*(?:m|mo|mon|month|months)\b/i.exec(s);
  if (m) return Math.round((Number(m[1]) / 12) * 10) / 10;

  const plain = Number(s.replace(/[^\d.]/g, ''));
  return Number.isFinite(plain) && plain > 0 && plain < 60 ? plain : null;
}

/** Header row -> {field: columnIndex} */
function mapColumns(header) {
  const map = {};
  header.forEach((cell, i) => {
    const h = String(cell || '').trim();
    if (!h) return;
    for (const [field, re] of FIELDS) {
      if (map[field] === undefined && re.test(h)) { map[field] = i; return; }
    }
  });
  return map;
}

const DEFAULT_ORDER = ['name', 'phone', 'email', 'skills', 'location'];

const looksLikeHeader = (row) =>
  row.some((c) => /name|phone|mobile|e.?mail|skill|location/i.test(String(c || '')));

const splitList = (v) => String(v || '')
  .split(/[;,|]/).map((x) => x.trim()).filter(Boolean).slice(0, 40);

const cleanPhone = (v) => {
  const s = String(v || '').trim();
  if (!s) return '';
  // Excel turns a long number into 9.19E+11; that is not a phone number
  // and must not be stored as one.
  if (/e\+/i.test(s)) return '';
  const digits = s.replace(/[^\d+]/g, '');
  return digits.length >= 10 ? digits : '';
};

export default function spreadsheetRoutes() {
  const r = Router();

  /**
   * POST /api/candidates/import
   *
   * Accepts .xlsx or .csv, as a file or as pasted text. Reports exactly
   * what happened to each row rather than a count, because "47 imported"
   * with no detail is useless when the file had 50 rows.
   */
  r.post('/candidates/import', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    upload.single('file'), wrap(async (req, res) => {
      let rows;
      let format;

      if (req.file) {
        try {
          const out = readSpreadsheet(req.file.buffer, req.file.originalname || '');
          rows = out.rows;
          format = out.format;
        } catch (err) {
          throw new ApiError(422, err.code || 'UNREADABLE_FILE', err.message);
        }
      } else if (req.body && req.body.text) {
        const out = readSpreadsheet(Buffer.from(String(req.body.text), 'utf8'), 'pasted.csv');
        rows = out.rows;
        format = 'csv';
      } else {
        throw badRequest('Choose a file or paste some rows.');
      }

      rows = rows.filter((row) => row.some((c) => String(c || '').trim() !== ''));
      if (!rows.length) throw badRequest('That file has no rows.');

      /*
       * The header is not always the first row.
       *
       * A Naukri export opens with a banner - the search name, the date
       * it was run, a blank line or two - and the column names sit a few
       * rows down. Taking row 0 as the header meant falling back to the
       * positional order, which mapped somebody's name to whatever
       * happened to be in column one, or refused the file outright with
       * "no name column".
       *
       * So the header is LOOKED FOR, in the first fifteen rows, and
       * everything above it is discarded as the banner it is.
       */
      let header = null;
      let map = {};
      let bannerRows = 0;
      let headerCells = [];
      const lookIn = Math.min(rows.length, 15);
      for (let i = 0; i < lookIn; i++) {
        if (!looksLikeHeader(rows[i])) continue;
        const found = mapColumns(rows[i]);
        // A header names at least a couple of things we understand; one
        // stray cell saying "location" in the banner does not count.
        if (Object.keys(found).length < 2) continue;
        bannerRows = i;
        headerCells = rows[i].map((c) => String(c || '').trim());
        rows.splice(0, i + 1);
        header = true;
        map = found;
        break;
      }
      if (!header && looksLikeHeader(rows[0])) {
        header = true;
        headerCells = rows[0].map((c) => String(c || '').trim());
        map = mapColumns(rows.shift());
      }
      if (!Object.keys(map).length) {
        DEFAULT_ORDER.forEach((f, i) => { map[f] = i; });
      }
      if (map.name === undefined) {
        throw new ApiError(422, 'NO_NAME_COLUMN',
          'No name column was found. Name the first column "Name", or include a header row.');
      }

      const at = (row, field) => (map[field] === undefined ? '' : String(row[map[field]] || '').trim());

      const imported = [];
      const updated = [];
      const skipped = [];

      // The import runs as the CALLER: a recruiter importing a list is
      // subject to the same policies as everything else they do.
      await withUser(req.session, async (c) => {
        for (const [index, row] of rows.entries()) {
          const name = at(row, 'name');
          const email = at(row, 'email').toLowerCase();
          const phone = cleanPhone(at(row, 'phone'));
          const line = index + (header ? 2 : 1);

          if (!name) { skipped.push({ line, reason: 'no name' }); continue; }
          if (!email && !phone) {
            skipped.push({ line, name, reason: 'no email and no phone - nothing to contact them on' });
            continue;
          }

          const company = at(row, 'currentCompany');
          const place = at(row, 'location');

          /*
           * One master profile per person: an import must never fork
           * somebody who is already in the database.
           *
           * Email and phone first, because they identify a person. But
           * THE CANDIDATES ALREADY HERE MAY HAVE NEITHER - the ones
           * imported from Naukri's summary emails have a name, a title,
           * a company and a location and nothing else, because that is
           * all the digest carries. Matching on address alone would have
           * created a second Bershan beside the first, and the export
           * that finally brought his phone number would have left the
           * original sitting there uncontactable forever.
           *
           * So a contactless profile is matched on NAME PLUS a
           * corroborating field. Never name alone - two people share a
           * name often, and merging them is not recoverable - and never
           * a profile that already has contact details, because then
           * this would be merging two people who each told us who they
           * are.
           */
          const existing = (await c.query(
            `select id, name, email, phone from candidates
              where ($1 <> '' and lower(email) = $1)
                 /*
                  * The LAST TEN DIGITS, not the whole string.
                  *
                  * A Naukri export writes "+91 98450 00111" and the same
                  * person may already be stored as "9845000111". Compared
                  * whole, those are different numbers, and the import
                  * created a second copy of somebody it was holding the
                  * phone number of. Ten digits identify an Indian mobile
                  * whatever precedes them.
                  */
                 or ($2 <> '' and length(regexp_replace($2, '[^0-9]', '', 'g')) >= 10
                     and right(regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g'), 10)
                       = right(regexp_replace($2, '[^0-9]', '', 'g'), 10))
              limit 1`, [email, phone])).rows[0]
            || (await c.query(
            `select id, name, email, phone from candidates
              where lower(name) = lower($1)
                and coalesce(email, '') = '' and coalesce(phone, '') = ''
                and (
                  ($2 <> '' and lower(coalesce(current_company, '')) = lower($2))
                  or ($3 <> '' and lower(coalesce(location, '')) = lower($3))
                )
              limit 1`, [name, company, place])).rows[0];

          const skills = splitList(at(row, 'skills'));
          // "5 Year(s) 6 Month(s)" is 5.5, not 56.
          const expYears = parseExperience(at(row, 'expYears'));
          const fields = {
            name,
            email: email || null,
            phone: phone || null,
            location: place || null,
            preferred_location: at(row, 'preferredLocation') || null,
            title: at(row, 'title') || null,
            current_company: company || null,
            exp_years: expYears,
            exp: at(row, 'expYears') || null,
            ctc: at(row, 'ctc') || null,
            expected_ctc: at(row, 'expectedCtc') ? toRupees(at(row, 'expectedCtc')) : null,
            notice_period: at(row, 'noticePeriod') || null,
            education: at(row, 'education') || null,
          };

          if (existing) {
            // Fill the gaps, never overwrite: the profile in the database
            // has usually been through a human, and the spreadsheet has
            // usually not.
            const sets = [];
            const vals = [];
            for (const [col, v] of Object.entries(fields)) {
              if (v === null || v === '' || col === 'name') continue;
              vals.push(v);
              sets.push(`${col} = coalesce(nullif(${col}::text, ''), $${vals.length})::${
                col === 'exp_years' || col === 'expected_ctc' ? 'numeric' : 'text'}`);
            }
            if (skills.length) {
              vals.push(skills);
              sets.push(`skills = case when coalesce(array_length(skills,1),0) = 0
                                       then $${vals.length}::text[] else skills end`);
            }
            if (sets.length) {
              vals.push(existing.id);
              await c.query(`update candidates set ${sets.join(', ')}, updated_at = now()
                              where id = $${vals.length}`, vals);
            }
            updated.push({ line, id: existing.id, name: existing.name,
                           email: existing.email, phone: existing.phone });
            continue;
          }

          const id = newId('cand');
          await c.query(
            // The recruiter who uploaded the file owns the row. Without
            // an owner the profile is visible to every recruiter, which
            // is the leak recruiter isolation exists to close.
            `insert into candidates
               (id, name, email, phone, location, preferred_location, title,
                current_company, exp_years, exp, ctc, expected_ctc, notice_period,
                education, skills, technical_skills, owner_recruiter_id)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16)`,
            [id, fields.name, fields.email, fields.phone, fields.location,
             fields.preferred_location, fields.title, fields.current_company,
             fields.exp_years, fields.exp, fields.ctc, fields.expected_ctc,
             fields.notice_period, fields.education, skills,
             req.session.role === 'recruiter' ? req.session.profileId : null]);
          imported.push({ line, id, name, email: fields.email, phone: fields.phone });
        }
      });

      /*
       * Give them a way in.
       *
       * An imported candidate used to be a row nobody could see but the
       * recruiter: no login, no way to correct what the file said about
       * them, no idea they were on a list. Each one now gets a portal
       * account and their credentials by email, SMS and WhatsApp.
       *
       * AFTER the transaction, and not awaited: a provider timing out
       * must not roll back an import that has already succeeded, and a
       * recruiter who has just uploaded four hundred rows should not
       * watch a spinner while four hundred messages go out. The result
       * of every attempt is recorded in candidate_invites either way.
       */
      // Updated rows too, not only new ones: somebody already in the
      // database who has never had a login is in exactly the position
      // this fixes. candidate_portal_account() declines to make a second
      // account, and candidate_invited() declines to send a second set
      // of credentials, so nobody is written to twice.
      const invitable = imported.concat(updated).filter((c) => c.email || c.phone);
      if (invitable.length) {
        inviteCandidates(invitable, {
          invitedBy: req.session.userId || 'import',
          addedBy: null,
        }).catch((err) => console.error('[import] invitations failed:', err.message));
      }

      /*
       * WHICH COLUMNS WERE UNDERSTOOD, and which were not.
       *
       * "47 imported" does not tell a recruiter whether the phone column
       * was read or quietly ignored, and an export from a job board has
       * thirty columns of which we want twelve. Both lists are returned,
       * so a file that half-worked says so instead of looking fine.
       */
      const recognised = Object.entries(map)
        .map(([field, i]) => ({ field, column: headerCells[i] || `column ${i + 1}` }));
      const ignored = headerCells
        .map((h, i) => ({ h, i }))
        .filter(({ h, i }) => String(h || '').trim()
          && !Object.values(map).includes(i))
        .map(({ h }) => String(h).trim());

      res.status(201).json({
        format,
        bannerRows,
        recognised,
        ignored,
        columns: Object.keys(map),
        imported: imported.length,
        updated: updated.length,
        skipped: skipped.length,
        // What the recruiter is told will happen, so "did they get their
        // login?" is answerable from the same screen that imported them.
        invited: invitable.length,
        detail: { imported, updated, skipped },
      });
    }));

  /**
   * GET /api/ai-calling/export?jobId=&campaignId=
   *
   * Every call, as a real workbook: what was asked, what was answered,
   * and what the recruiter has to do next.
   */
  r.get('/ai-calling/export', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const { jobId, campaignId, candidateId } = req.query;

      const rows = await withUser(req.session, async (c) => {
        const where = [], vals = [];
        const add = (sql, v) => { vals.push(v); where.push(sql.replace('$?', `$${vals.length}`)); };
        if (jobId) add('s.job_id=$?', jobId);
        if (campaignId) add('s.campaign_id=$?', campaignId);
        if (candidateId) add('s.candidate_id=$?', candidateId);
        const clause = where.length ? `where ${where.join(' and ')}` : '';

        return (await c.query(
          `select s.*, c.name as candidate_name, c.email as candidate_email,
                  c.phone as candidate_phone, c.location as candidate_location,
                  j.title as job_title, r.name as recruiter_name
             from ai_call_sessions s
             join candidates c on c.id = s.candidate_id
             left join jobs j on j.id = s.job_id
             left join recruiters r on r.id = s.recruiter_id
             ${clause}
            order by s.queued_at desc
            limit 5000`, vals)).rows;
      });

      const COLUMNS = [
        'Call date', 'Candidate', 'Phone', 'Email', 'Location', 'Requirement',
        'Recruiter', 'Language', 'Call status', 'Outcome', 'Interest', 'Reason',
        'Expected CTC (LPA)', 'Notice period', 'Earliest joining',
        'Location accepted', 'Work mode accepted', 'Wants interview',
        'Callback requested', 'Callback at', 'Recruiter callback',
        'Duration (s)', 'Questions asked by candidate', 'Concerns', 'Summary',
      ];

      const yn = (v) => (v === true ? 'Yes' : v === false ? 'No' : '');
      const when = (v) => (v ? new Date(v).toLocaleString('en-GB') : '');

      const body = rows.map((s) => [
        when(s.queued_at),
        s.candidate_name,
        s.candidate_phone || '',
        s.candidate_email || '',
        s.candidate_location || '',
        s.job_title || '',
        s.recruiter_name || '',
        ({ en: 'English', hi: 'Hindi', te: 'Telugu' })[s.language] || s.language || '',
        s.status,
        s.outcome || '',
        s.interest_status || '',
        s.interest_reason || '',
        s.expected_ctc ? Number((Number(s.expected_ctc) / 100000).toFixed(2)) : '',
        s.notice_period || '',
        s.earliest_joining_date ? new Date(s.earliest_joining_date).toLocaleDateString('en-GB') : '',
        yn(s.location_accepted),
        yn(s.work_mode_accepted),
        yn(s.interview_interest),
        s.callback_required ? 'Yes' : '',
        when(s.callback_at),
        s.recruiter_callback_required ? 'Yes' : '',
        s.duration_seconds == null ? '' : Number(s.duration_seconds),
        (s.candidate_questions || []).join(' | '),
        (s.candidate_concerns || []).join(' | '),
        s.summary || '',
      ]);

      const buf = writeSheet(COLUMNS, body, 'AI calls');
      const name = `TeamLink_AI_Calls_${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.setHeader('content-type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('content-disposition', `attachment; filename="${name}"`);
      res.setHeader('content-length', buf.length);
      res.end(buf);
    }));

  /**
   * GET /api/candidates/export — the candidate list, as a workbook.
   * Same columns the screen's CSV export produced, in a real .xlsx.
   */
  r.get('/candidates/export', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const ids = String(req.query.ids || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!ids.length) throw badRequest('Select the candidates to export.');

      const rows = await withUser(req.session, async (c) => (await c.query(
        `select c.*,
                (select count(*) from ai_call_sessions s where s.candidate_id = c.id) as calls,
                (select s.outcome from ai_call_sessions s
                  where s.candidate_id = c.id and s.outcome is not null
                  order by s.queued_at desc limit 1) as last_call_outcome,
                (select s.summary from ai_call_sessions s
                  where s.candidate_id = c.id and s.summary is not null
                  order by s.queued_at desc limit 1) as last_call_summary
           from candidates c where c.id = any($1) limit 5000`, [ids])).rows);

      const COLUMNS = [
        'Name', 'Designation', 'Current company', 'Experience', 'Location',
        'Preferred location', 'Current CTC', 'Expected CTC (LPA)', 'Skills',
        'Education', 'Notice period', 'Email', 'Phone', 'Resume', 'Source',
        'Do not contact', 'Preferred language',
        'AI calls', 'Last call outcome', 'Last call summary',
      ];

      const body = rows.map((c) => [
        c.name, c.title || '', c.current_company || '', c.exp || '',
        c.location || '', c.preferred_location || '', c.ctc || '',
        c.expected_ctc ? Number((Number(c.expected_ctc) / 100000).toFixed(2)) : '',
        [...new Set([...(c.skills || []), ...(c.technical_skills || [])])].join('; '),
        c.education || '', c.notice_period || '', c.email || '', c.phone || '',
        c.resume_file || '', c.source || '',
        c.do_not_contact ? 'Yes' : '',
        ({ en: 'English', hi: 'Hindi', te: 'Telugu' })[c.preferred_language] || '',
        Number(c.calls || 0),
        c.last_call_outcome || '',
        c.last_call_summary || '',
      ]);

      const buf = writeSheet(COLUMNS, body, 'Candidates');
      const name = `TeamLink_Candidates_${new Date().toISOString().slice(0, 10)}.xlsx`;
      res.setHeader('content-type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('content-disposition', `attachment; filename="${name}"`);
      res.setHeader('content-length', buf.length);
      res.end(buf);
    }));

  return r;
}
