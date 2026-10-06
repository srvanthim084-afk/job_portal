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
  /*
   * "NUMBER" ON ITS OWN, which is what a recruiter's own sheet says.
   *
   * This required mobile|phone|contact BEFORE the word, so a column
   * headed simply "Number" - the heading on the Profile Screening Sheet,
   * and on most sheets somebody types by hand - matched nothing. The
   * phone column was then unmapped, and every single row was refused
   * with "no email and no phone, nothing to contact them on" while the
   * numbers sat right there in the file.
   *
   * "Ph", "Phone/Mobile" and "Mobile No / Alt No" missed for the same
   * reason: the pattern was anchored at both ends around one spelling.
   * A header list is never finished, which is why sniffValueColumns()
   * below reads the DATA as well - but widening the obvious spellings
   * first keeps the mapping explainable on the Columns step.
   */
  ['phone', /^(mobile|phone|contact|whats\s*app|wa)|^ph\.?$|^cell|^number$|^num$|mobile|phone\s*(no|number)|contact\s*(no|number)/i],
  // "Mail ID" is the commonest spelling on an Indian recruiter's own
  // sheet and did not match: the pattern required an "e" before "mail".
  ['email', /^e.?mail(\s*(id|address))?$|^email$|^mail(\s*(id|address))?$|e.?mail\s*id/i],
  // "Technical Skills" failed on both halves - "technolog" does not
  // match "technical", and "^skills?$" is anchored.
  ['skills', /key\s*skills|it\s*skills|technical\s*skills|^skills?$|skill\s*set|technolog|stack/i],
  ['location', /^(current\s*)?(location|city|place)$|current\s*(location|city)|^based|^city\s*name$/i],
  ['preferredLocation', /pref.*location/i],
  ['title', /current\s*designation|^designation$|resume\s*headline|job\s*title|^title$|^position$/i],
  ['currentCompany', /current\s*(employer|company|organi[sz]ation)|^company(\s*name)?$|^employer$|organi[sz]ation|present\s*company/i],
  /*
   * Naukri writes experience as "5 Year(s) 6 Month(s)" and also exports
   * a plain "Total Experience". Both are read; parseExperience() below
   * turns the first into 5.5 rather than 56.
   */
  // "Years of Exp" and "Exp (Yrs)" are how it is written by hand.
  ['expYears', /total\s*exp|work\s*exp|years?\s*of\s*exp|^exp(erience)?\s*(in\s*years|years|yrs|\(yrs?\))?$|^yrs?\s*exp/i],
  // "Annual Salary" and "Expected Annual Salary" are Naukri's wording;
  // the expected one is matched FIRST so it cannot be taken as current.
  ['expectedCtc', /expected\s*(annual\s*)?(ctc|salary|package)|exp(ected)?\s*ctc/i],
  ['ctc', /current\s*(annual\s*)?(ctc|salary|package)|^annual\s*salary$|^ctc$|^salary$/i],
  // "NP" on its own. Anchored, so it cannot claim a column called
  // "NP Status" or swallow an unrelated two-letter heading elsewhere.
  ['noticePeriod', /notice|^np$|^n\.p\.?$/i],
  ['education', /highest\s*(degree|qualification)|ug\s*course|pg\s*course|education|qualification|degree/i],
  ['source', /^source$|portal|job\s*board|^referred\s*by$/i],
  /* Free text the recruiter keeps beside a name. Not stored on the
     candidate today - it is read so the column is not reported as
     "ignored", which is what makes a recruiter think the import lost
     something. */
  ['notes', /^notes?$|^remarks?$|^comments?$/i],
  ['resume', /^resume$|^cv$|resume\s*(file|link|url)|cv\s*(file|link|url)/i],
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

/**
 * A phone number out of a spreadsheet cell, and WHY when there is none.
 *
 * The old version returned a bare string, so every failure looked
 * identical to the caller and the recruiter was told "no phone" whether
 * the column was missing, the cell was blank, Excel had mangled the
 * number into 9.19E+11, or somebody had typed two numbers separated by a
 * slash. Those are four different problems with four different fixes.
 *
 * WHAT IT HANDLES, all of it seen on real sheets:
 *
 *   "+91 95398 13730"     spaces, brackets, dashes and the country code
 *   "09539813730"         a leading zero from an STD-dialled list
 *   "9539813730 / 9440…"  two numbers in one cell - the first wins
 *   "9539813730, 944…"    the same, comma separated
 *   9539813730            a NUMBER cell, not text
 *   9.53981373E+9         Excel's scientific notation
 *
 * @returns { phone, reason }  phone is '' when none could be read, and
 *                             reason then says what was wrong with it.
 */
const cleanPhone = (v) => {
  const raw = String(v === null || v === undefined ? '' : v).trim();
  if (!raw) return { phone: '', reason: 'blank' };

  /*
   * SCIENTIFIC NOTATION IS EXPANDED, NOT DISCARDED.
   *
   * This used to return '' the moment it saw "e+", which threw away
   * every row in a sheet whose phone column was formatted as a number.
   * Expanding it recovers the number when Excel kept the digits; when it
   * did not - 9.19E+11 is 919000000000, and the real digits are gone -
   * the padding shows up as a run of trailing zeros and the recruiter is
   * told to format the column as Text rather than being told the number
   * is missing.
   */
  let text = raw;
  if (/^[\d.]+e\+?\d+$/i.test(raw.replace(/\s/g, ''))) {
    const n = Number(raw.replace(/\s/g, ''));
    if (!Number.isFinite(n)) return { phone: '', reason: `not a number: "${raw}"` };
    text = n.toFixed(0);
    if (/0{4,}$/.test(text)) {
      return { phone: '',
        reason: `Excel stored this as a number and lost digits ("${raw}"). `
              + 'Format the column as Text in the spreadsheet and export it again.' };
    }
  }

  /* Two numbers in one cell: take the first that is usable rather than
     gluing them together into a twenty-digit string. */
  const parts = text.split(/[,;/|]|\s{2,}|or/i).map((p) => p.trim()).filter(Boolean);
  const tried = [];

  for (const part of (parts.length ? parts : [text])) {
    let digits = part.replace(/\D/g, '');
    if (!digits) { tried.push(part); continue; }
    // +91 / 0091 / 91 in front of a ten-digit mobile, and the 0 an STD
    // list leaves on. Taken off ONLY when what remains is still a
    // plausible number, so a genuine ten-digit number starting 91 or 0
    // is not shortened into an invalid one.
    if (digits.length > 10 && digits.startsWith('0091')) digits = digits.slice(4);
    if (digits.length > 10 && digits.startsWith('91')) digits = digits.slice(2);
    while (digits.length > 10 && digits.startsWith('0')) digits = digits.slice(1);

    if (digits.length === 10) return { phone: digits, reason: null };
    /* Not an Indian mobile, but long enough to be a real number
       somewhere - a landline with an STD code, an overseas number.
       Kept rather than refused; the duplicate check compares the last
       ten digits anyway. */
    if (digits.length > 10 && digits.length <= 15) return { phone: digits, reason: null };
    tried.push(part);
  }

  return { phone: '',
    reason: `not a usable number: "${tried.join(' / ').slice(0, 60)}"` };
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
       * PREVIEW, AND THE RECRUITER'S OWN COLUMN MAPPING.
       *
       * `preview` runs everything below - the header hunt, the column
       * mapping, the duplicate matching - and writes nothing, so the
       * recruiter can see what a file WOULD do before it does it. It is
       * the same code path rather than a second one, because a preview
       * that is computed differently from the import is a preview of
       * something else.
       *
       * `mapping` is the correction: {"Mobile Number": "phone"}, sent
       * back after the recruiter has fixed whatever auto-mapping got
       * wrong. It is applied over the guess, never instead of it, so
       * correcting one column does not lose the other eleven.
       */
      const preview = String(req.body?.preview || '') === 'true' || req.body?.preview === true;

      /*
       * THE ROWS THE RECRUITER CHOSE TO SKIP.
       *
       * Sent as the line numbers shown on the review screen, because
       * that is what they were deciding about. A duplicate they marked
       * Skip is left completely alone - not merged, not gap-filled, not
       * touched - which is the difference between "this is the same
       * person, fill in what we are missing" and "this is not who the
       * file thinks it is".
       */
      let skipLines = new Set();
      if (req.body?.skip) {
        let raw = req.body.skip;
        if (typeof raw === 'string') {
          try { raw = JSON.parse(raw); } catch { raw = raw.split(','); }
        }
        if (!Array.isArray(raw)) throw badRequest('The skip list could not be read.');
        skipLines = new Set(raw.map((n) => Number(n)).filter(Number.isFinite));
      }
      let override = {};
      if (req.body?.mapping) {
        try {
          override = typeof req.body.mapping === 'string'
            ? JSON.parse(req.body.mapping) : req.body.mapping;
        } catch { throw badRequest('The column mapping could not be read.'); }
        if (!override || typeof override !== 'object' || Array.isArray(override)) {
          throw badRequest('The column mapping could not be read.');
        }
      }

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

      /*
       * The recruiter's corrections, by column NAME rather than index,
       * because that is what they were shown. A field mapped to "" is
       * one they explicitly told us to ignore.
       */
      const known = new Set(FIELDS.map(([f]) => f));
      for (const [col, field] of Object.entries(override)) {
        const i = headerCells.findIndex((h) => h === col);
        if (i < 0) continue;
        for (const [f, at2] of Object.entries(map)) if (at2 === i) delete map[f];
        if (!field) continue;
        if (!known.has(field)) throw badRequest(`"${field}" is not a TeamLink field.`);
        map[field] = i;
      }

      if (map.name === undefined) {
        throw new ApiError(422, 'NO_NAME_COLUMN',
          'No name column was found. Name the first column "Name", or include a header row.');
      }

      const at = (row, field) => (map[field] === undefined ? '' : String(row[map[field]] || '').trim());

      const imported = [];
      const updated = [];
      const skipped = [];
      const merges = [];
      const pooledIds = [];          // existing people the importer now has a pool row for
      const importId = preview ? null : newId('imp');

      // The import runs as the CALLER: a recruiter importing a list is
      // subject to the same policies as everything else they do.
      await withUser(req.session, async (c) => {
        for (const [index, row] of rows.entries()) {
          const name = at(row, 'name');
          const email = at(row, 'email').toLowerCase();
          const phoneRead = cleanPhone(at(row, 'phone'));
          const phone = phoneRead.phone;
          const line = index + (header ? 2 : 1);

          /*
           * THE FIRST THREE ROWS, EXACTLY AS THEY WERE READ.
           *
           * "no email and no phone" on every row of a sheet that plainly
           * has phone numbers is impossible to diagnose from the screen,
           * and the answer was always in one of three places: the header
           * did not match, the mapping did not carry, or the value did
           * not survive cleaning. All three are printed here, once per
           * import, so the next time it happens the log says which.
           */
          if (index < 3) {
            console.log(`[import] row ${line}`,
              JSON.stringify({
                raw: row.slice(0, 8),
                mappedColumns: Object.fromEntries(Object.entries(map)
                  .map(([f, i]) => [f, headerCells[i] || `column ${i + 1}`])),
                nameCell: name,
                emailCell: at(row, 'email'),
                phoneCell: at(row, 'phone'),
                phoneAfterCleaning: phone || null,
                phoneRejectedBecause: phoneRead.reason,
              }));
          }

          if (!name) { skipped.push({ line, reason: 'no name' }); continue; }
          if (!email && !phone) {
            /*
             * WHICH of the four things went wrong, not "no contact".
             *
             * The single message covered a missing column, a blank cell,
             * a number Excel had mangled, and a value that was simply
             * not a phone number. A recruiter who is told "no phone" on
             * a sheet full of phone numbers has nothing to act on.
             */
            const noPhoneColumn = map.phone === undefined;
            const noEmailColumn = map.email === undefined;
            let reason;
            if (noPhoneColumn && noEmailColumn) {
              reason = 'neither a phone nor an email column was mapped - '
                + 'set one on the Columns step';
            } else if (noPhoneColumn) {
              reason = 'no email in this row, and no phone column was mapped';
            } else if (phoneRead.reason === 'blank') {
              reason = 'the phone cell is empty and there is no email';
            } else {
              reason = `no email, and the phone ${phoneRead.reason}`;
            }
            skipped.push({ line, name, reason });
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
          /*
           * 0117: asked of the WHOLE table (candidate_find_by_contact answers
           * with an id and nothing else), then read back under the caller's
           * rights. A person who exists but is private to somebody else is
           * not duplicated and not merged into: the row is skipped.
           *
           * The LAST TEN DIGITS of the phone, not the whole string: a Naukri
           * export writes "+91 98450 00111" and the same person may already
           * be stored as "9845000111".
           */
          const matchedId = (email || phone)
            ? (await c.query(`select candidate_find_by_contact($1, $2) as id`, [email, phone])).rows[0].id
            : null;
          const existing = (matchedId && (await c.query(
            `select id, name, email, phone from candidates where id = $1`, [matchedId])).rows[0])
            || (!matchedId && (await c.query(
            `select id, name, email, phone from candidates
              where lower(name) = lower($1)
                and coalesce(email, '') = '' and coalesce(phone, '') = ''
                and (
                  ($2 <> '' and lower(coalesce(current_company, '')) = lower($2))
                  or ($3 <> '' and lower(coalesce(location, '')) = lower($3))
                )
              limit 1`, [name, company, place])).rows[0]) || undefined;

          /* On file, but private to somebody else: never duplicated, never
             touched, and nothing about them is said. */
          if (matchedId && !existing) {
            skipped.push({ line, name,
              reason: 'this person is already on file and their profile is private - not imported' });
            continue;
          }

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

          /*
           * WHERE THIS ROW CAME FROM (0075).
           *
           * The file's own Source column when it has one - "naukri",
           * "Referred by Priya" - and 'Bulk Import' when it does not,
           * because that IS where the candidate came from as far as this
           * portal is concerned. The raw wording is kept in
           * source_details; the column itself is canonicalised by the
           * database, since it now holds a fixed vocabulary and an
           * unrecognised value would be refused outright.
           *
           * DELIBERATELY NOT IN `fields`. The merge path a few lines
           * below iterates that object as a list of COLUMN NAMES, so a
           * key that is not a column makes every re-import of a file
           * fail with "column source_raw does not exist".
           */
          const sourceRaw = at(row, 'source') || null;

          if (existing) {
            /* Marked Skip on the review screen: recorded as skipped and
               left exactly as it was. */
            if (skipLines.has(line)) {
              skipped.push({ line, name, reason: 'skipped — you chose not to merge this one',
                             id: existing.id, choice: 'skip' });
              continue;
            }
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
            /* 0117: the person already exists - reused, never duplicated -
               and the importing recruiter gets a talent_pool row of their
               own for them (their notes and tags are theirs). */
            if (!preview) {
              await c.query(`select talent_pool_link($1, 'imported')`, [existing.id]);
              pooledIds.push(existing.id);
            }
            let filledGaps = 0;
            if (sets.length && !preview) {
              vals.push(existing.id);
              /* Row-level security decides whether this recruiter may edit
                 the shared profile; when they may not, nothing is filled
                 and nothing is logged as merged. */
              filledGaps = (await c.query(`update candidates set ${sets.join(', ')}, updated_at = now()
                              where id = $${vals.length}`, vals)).rowCount;
            }
            if (filledGaps) {
              /* WHICH GAPS. The merge only ever fills empty columns, so
                 the interesting question afterwards is which ones it
                 filled - and months later, on whose authority. */
              merges.push({
                candidateId: existing.id,
                matchedOn: [existing.email && email ? 'email' : null,
                            existing.phone && phone ? 'phone' : null]
                  .filter(Boolean).join('+') || 'name+company',
                incoming: { name, email: email || null, phone: phone || null,
                            location: place || null, currentCompany: company || null,
                            skills },
                filled: Object.fromEntries(
                  Object.entries(fields).filter(([k, v]) => v !== null && v !== '' && k !== 'name')),
              });
            }
            /*
             * On a preview the recruiter is deciding what to do about
             * this person, so they get both sides of it: what is on file
             * and what the file would add. §6 of the brief is exactly
             * this screen.
             */
            updated.push({ line, id: existing.id, name: existing.name,
                           email: existing.email, phone: existing.phone,
                           incoming: preview ? {
                             name,
                             email: email || null,
                             phone: phone || null,
                             location: place || null,
                             currentCompany: company || null,
                             expYears,
                             noticePeriod: at(row, 'noticePeriod') || null,
                             skills,
                           } : undefined });
            continue;
          }

          if (skipLines.has(line)) {
            skipped.push({ line, name, reason: 'skipped — you chose not to import this one',
                           choice: 'skip' });
            continue;
          }
          const id = newId('cand');
          if (preview) {
            /* Everything above ran - the parse, the mapping, the search
               for an existing profile - and found nobody. That is the
               answer the preview needs; the row is not written. */
            imported.push({ line, id: null, name, email: fields.email, phone: fields.phone,
                            incoming: {
                              name,
                              email: fields.email, phone: fields.phone,
                              location: fields.location,
                              currentCompany: fields.current_company,
                              expYears: fields.exp_years,
                              noticePeriod: fields.notice_period,
                              skills,
                            } });
            continue;
          }
          await c.query(
            // The recruiter who uploaded the file owns the row. Without
            // an owner the profile is visible to every recruiter, which
            // is the leak recruiter isolation exists to close.
            `insert into candidates
               (id, name, email, phone, location, preferred_location, title,
                current_company, exp_years, exp, ctc, expected_ctc, notice_period,
                education, skills, technical_skills, owner_recruiter_id,
                source, source_details)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,
                     candidate_source_canonical($17), $18)`,
            [id, fields.name, fields.email, fields.phone, fields.location,
             fields.preferred_location, fields.title, fields.current_company,
             fields.exp_years, fields.exp, fields.ctc, fields.expected_ctc,
             fields.notice_period, fields.education, skills,
             req.session.role === 'recruiter' ? req.session.profileId : null,
             sourceRaw || 'Bulk Import',
             sourceRaw || null]);
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
      /*
       * The record of this upload, written as the engine because the
       * audit tables are not directly writable by anybody (migration
       * 0048). It is written AFTER the candidates, so an import that
       * failed half way does not leave a row claiming it succeeded.
       */
      if (!preview) {
        try {
          await withUser(ENGINE, async (c) => {
            await c.query(
              `insert into candidate_imports
                 (id, filename, format, total_rows, created_count, merged_count,
                  skipped_count, column_map, imported_by, recruiter_id)
               values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
              [importId, (req.file && req.file.originalname) || null, format,
               rows.length, imported.length, updated.length, skipped.length,
               JSON.stringify(Object.entries(map).reduce((o, [f, i]) => {
                 o[headerCells[i] || `Column ${i + 1}`] = f; return o;
               }, {})),
               req.session.userId || null,
               req.session.role === 'recruiter' ? req.session.profileId : null]);

            if (imported.length) {
              await c.query(
                `update candidates set import_id = $1, sourced_at = now()
                  where id = any($2)`,
                [importId, imported.map((x) => x.id)]);
            }
            /* 0117: the importing recruiter's pool rows carry this upload
               (for the people the file created and the ones it found). */
            if (req.session.role === 'recruiter' && req.session.profileId
                && (imported.length || pooledIds.length)) {
              await c.query(
                `update talent_pool
                    set origin = 'imported', import_id = $1, updated_at = now()
                  where recruiter_id = $2 and candidate_id = any($3) and import_id is null`,
                [importId, req.session.profileId,
                 imported.map((x) => x.id).concat(pooledIds)]);
            }

            for (const m of merges) {
              await c.query(
                `insert into candidate_merge_logs
                   (candidate_id, import_id, matched_on, incoming, filled, merged_by)
                 values ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
                [m.candidateId, importId, m.matchedOn,
                 JSON.stringify(m.incoming), JSON.stringify(m.filled),
                 req.session.userId || null]);
            }
          });
        } catch (err) {
          /* The candidates are in. Losing the audit row is worth saying
             out loud and is not worth failing the import over. */
          console.error('[import] audit trail not written:', err.message);
        }
      }

      /*
       * IMPORTING SOMEBODY IS NOT INVITING THEM.
       *
       * This used to create a portal account for every imported row and
       * send the credentials out by email, SMS and WhatsApp, on the
       * reasoning that a candidate should be able to correct what a
       * spreadsheet says about them. The cost of that reasoning is that
       * uploading a sourcing list - people who have not applied, have
       * not been spoken to, and in many cases have never heard of us -
       * messages every one of them.
       *
       * A candidate now becomes a portal user when somebody decides to
       * invite them, which is what `invite=true` says. Off by default:
       * the safe direction for an action that cannot be taken back once
       * four hundred messages have left the building.
       */
      const invite = String(req.body?.invite || '') === 'true' || req.body?.invite === true;
      const invitable = (preview || !invite)
        ? []
        : imported.concat(updated).filter((c) => c.email || c.phone);
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

      res.status(preview ? 200 : 201).json({
        preview,
        importId,
        merged: merges.length,
        format,
        bannerRows,
        recognised,
        ignored,
        columns: Object.keys(map),
        /* The header as it was written in the file, next to the field
           each column was matched to, so the mapping screen can show
           both sides and let the recruiter change one. */
        headerCells,
        mapping: Object.entries(map).reduce((o, [field, i]) => {
          o[headerCells[i] || `Column ${i + 1}`] = field;
          return o;
        }, {}),
        fields: FIELDS.map(([f]) => f),
        totalRows: rows.length,
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
   * GET /api/candidates/import/template — the blank workbook to fill in.
   *
   * A recruiter with their own spreadsheet does not need this: the
   * importer matches headers loosely and reads whatever they already
   * have. It is for the recruiter who has a list in their head, or in a
   * format nothing can read, and wants to know what the columns should
   * be called.
   *
   * One example row, marked as an example, because a blank sheet with
   * eleven headers does not say whether Skills is one cell or eleven, or
   * what a notice period is supposed to look like.
   */
  r.get('/candidates/import/template', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const COLUMNS = ['Name', 'Phone', 'Email', 'Skills', 'Experience', 'Location',
        'Current Company', 'Notice Period', 'Resume', 'Source', 'Notes'];
      const EXAMPLE = [
        ['Rahul Kumar', '9845000111', 'rahul.kumar@example.com',
         'Java, Spring Boot, SQL', '5 Years 6 Months', 'Hyderabad',
         'ABC Technologies', '30 Days', 'rahul-kumar-cv.pdf', 'Referral',
         'Example row — delete before uploading. Separate skills with commas.'],
      ];
      const buf = writeSheet(COLUMNS, EXAMPLE, 'Candidates');
      res.setHeader('content-type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('content-disposition',
        'attachment; filename="TeamLink_Candidate_Import_Template.xlsx"');
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
                /* 0117: what a colleague noted about where they came from is
                   theirs; shown only for people in a pool the caller may read. */
                case when exists (select 1 from talent_pool tp where tp.candidate_id = c.id)
                     then c.source_details end as source_details_scoped,
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
        'Education', 'Notice period', 'Email', 'Phone', 'Resume',
        /* 0075. The source, what makes it specific, and when they were
           added - the same three the screen's CSV now carries, so the two
           exports do not disagree about what a candidate record contains. */
        'Source', 'Source detail', 'Added on',
        'Do not contact', 'Preferred language',
        'AI calls', 'Last call outcome', 'Last call summary',
      ];

      const body = rows.map((c) => [
        c.name, c.title || '', c.current_company || '', c.exp || '',
        c.location || '', c.preferred_location || '', c.ctc || '',
        c.expected_ctc ? Number((Number(c.expected_ctc) / 100000).toFixed(2)) : '',
        [...new Set([...(c.skills || []), ...(c.technical_skills || [])])].join('; '),
        c.education || '', c.notice_period || '', c.email || '', c.phone || '',
        c.resume_file || '', c.source || 'Unknown', c.source_details_scoped || '',
        c.created_at ? new Date(c.created_at).toISOString().slice(0, 10) : '',
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
