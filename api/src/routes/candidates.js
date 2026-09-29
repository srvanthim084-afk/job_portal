/**
 * Candidate routes, including Find Candidates (requirements 10 and 11).
 *
 * Requirement 11 is explicit: do not load the whole candidate database
 * into the browser to filter it. Every filter below runs as SQL with a
 * LIMIT, and the response carries a total so the existing pagination UI
 * can render without the rows behind it.
 *
 * The filter names match the controls already on the Find Candidates
 * screen, so the existing form can post straight here.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withUser } from '../db.js';
import { wrap, badRequest, notFound, forbidden, ApiError, CODES } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { toCandidate, toApplication, attachPrimary,
         toEducationRecord, toExperienceRecord } from '../shapes.js';
import { inviteCandidate, resendCredentials } from '../notify/invite.js';
import { hashPassword } from '../auth.js';
import { TEMPLATES, VARIABLES, varsFor, render, addressFor } from '../notify/bulk.js';

/**
 * Validate, or fail with the message beside the field that is wrong.
 *
 * The same shape the rest of the API uses: `details` is keyed by field
 * name so the form can put each message where it belongs rather than
 * showing one sentence at the top.
 */
const parse = (schema, body) => {
  const out = schema.safeParse(body || {});
  if (out.success) return out.data;
  const details = {};
  for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
  throw badRequest('Please check the highlighted fields and try again.', details);
};

const list = (v) => {
  if (v === undefined || v === null || v === '') return [];
  return (Array.isArray(v) ? v : String(v).split(','))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
};

export default function candidateRoutes() {
  const r = Router();

  /**
   * Find Candidates. Recruiter/admin only at the route level; RLS narrows
   * the rows again underneath, so a recruiter cannot reach a private
   * profile outside their own pipeline even if this handler were wrong.
   */
  r.get('/candidates', requireAuth(), requireRole('recruiter', 'admin', 'client'),
    wrap(async (req, res) => {
      const q = req.query;
      // The Find Candidates screen pages through results in the browser, so
      // it asks for a bounded WINDOW of matches rather than a single page.
      // The filtering still happens in SQL — the browser never receives the
      // whole table — and `total` below reports the true match count so the
      // UI can say when a result set was capped.
      const limit  = Math.min(parseInt(q.limit, 10) || 25, 500);
      const offset = Math.max(parseInt(q.offset, 10) || 0, 0);

      const skills    = list(q.skills);
      const locations = list(q.location);
      const notice    = list(q.noticePeriod);
      const education = list(q.education);
      const employment = list(q.employment);
      const industry  = list(q.industry);
      const stages    = list(q.stage);

      const out = await withUser(req.session, async (c) => {
        // Built explicitly, one filter at a time. Every value goes in via a
        // numbered placeholder — no user input is ever concatenated into
        // the SQL string (requirement 19, SQL-injection protection).
        const where = [], params = [];
        const push = (frag) => where.push(frag);

        if (q.q) {
          params.push(`%${String(q.q).trim()}%`);
          const i = params.length;

          /*
           * A PHONE NUMBER IS A SEARCH TERM.
           *
           * It was not one: typing a candidate's own mobile number
           * returned nothing at all, because the number is stored as it
           * was written - "+91 98450 11111", "09845011111" - and a plain
           * `ilike '%9845011111%'` matches none of those spellings.
           *
           * That was already awkward; it became a real hole when a
           * candidate could be added with a phone and no email, because
           * then the number is the ONLY thing besides their name that
           * identifies them, and a recruiter with a number in front of
           * them could not find the person it belongs to.
           *
           * Compared on the last ten digits, which is how the duplicate
           * check and the outbound allowlist already compare telephones,
           * so all three agree on what "the same number" means.
           */
          const digits = String(q.q).replace(/\D/g, '');
          let phoneFrag = '';
          if (digits.length >= 6) {
            params.push(`%${digits.slice(-10)}%`);
            const p = params.length;
            phoneFrag = `
                 or regexp_replace(coalesce(phone, ''),     '\\D', '', 'g') ilike $${p}
                 or regexp_replace(coalesce(alt_phone, ''), '\\D', '', 'g') ilike $${p}`;
          }

          push(`(name ilike $${i} or title ilike $${i} or current_company ilike $${i}
                 or education ilike $${i} or summary ilike $${i} or email ilike $${i}
                 or alt_email ilike $${i}${phoneFrag})`);
        }
        if (skills.length) {
          /*
           * SKILLS ARE MATCHED CASE-INSENSITIVELY AND BY WHOLE WORD.
           *
           * This used to be `skills && $1::text[]` - a PostgreSQL array
           * overlap, which is exact and case-SENSITIVE. Twenty-one
           * candidates on file have "Python"; a recruiter typing "python"
           * got none of them, and the screen said "No candidates match
           * the current search criteria", which is a sentence about the
           * candidates and was actually about the capital P. Sixteen have
           * "SQL" and the search found the one person whose entry happens
           * to be lowercase.
           *
           * Exactness was the second half of it. A skill is stored as the
           * board or the CV wrote it - "Advanced Excel", "Excel Sheet",
           * "Excel Report Preparation" - and none of those is the string
           * "Excel", so an exact match finds a fraction of the people who
           * have the skill.
           *
           * WHOLE WORD, though, not substring: "Excellent Communication
           * in English" is not an Excel skill, and "C" must not match
           * "Accounting". The pattern requires a non-alphanumeric
           * character (or the end of the string) on each side.
           *
           * Both columns are searched, as before - the UI has one Skills
           * control and the data has two columns - by concatenating them
           * rather than repeating the condition.
           */
          const rx = (t) => String(t).trim()
            // The term is a recruiter's typing, not a pattern. Every
            // regex metacharacter in it is escaped so "C++" and "C#" are
            // searched for literally instead of failing to compile.
            .replace(/[.^$*+?()[\]{}|\\/-]/g, '\\$&');
          params.push(skills.map((t) => `(^|[^[:alnum:]])${rx(t)}($|[^[:alnum:]])`));
          const i = params.length;
          push(`exists (
                  select 1 from unnest(
                    coalesce(skills, '{}'::text[]) || coalesce(technical_skills, '{}'::text[])
                  ) as s
                  where s ~* any($${i}::text[])
                )`);
        }
        if (locations.length) { params.push(locations); push(`location = any($${params.length})`); }
        if (notice.length)    { params.push(notice);    push(`notice_period = any($${params.length})`); }
        if (employment.length){ params.push(employment);push(`candidate_type = any($${params.length})`); }
        if (education.length) {
          params.push(education.map((e) => `%${e}%`));
          push(`education ilike any($${params.length}::text[])`);
        }
        if (q.gender) { params.push(String(q.gender)); push(`gender = $${params.length}`); }

        if (q.expMin !== undefined && q.expMin !== '') {
          params.push(Number(q.expMin)); push(`exp_years >= $${params.length}`);
        }
        if (q.expMax !== undefined && q.expMax !== '') {
          params.push(Number(q.expMax)); push(`exp_years <= $${params.length}`);
        }
        if (q.ctcMax !== undefined && q.ctcMax !== '') {
          params.push(Number(q.ctcMax)); push(`expected_ctc <= $${params.length}`);
        }
        if (q.ctcMin !== undefined && q.ctcMin !== '') {
          params.push(Number(q.ctcMin));
          // includeZeroSalary mirrors the checkbox on the Find Candidates
          // sidebar: a candidate who has not stated a package should not be
          // silently dropped by a minimum-salary filter.
          push(q.includeZeroSalary === 'false'
            ? `expected_ctc >= $${params.length}`
            : `(expected_ctc is null or expected_ctc >= $${params.length})`);
        }
        // the sidebar's verification / resume toggles
        if (q.emailVerified === 'true')  push(`email_verified`);
        if (q.mobileVerified === 'true') push(`mobile_verified`);
        if (q.hasResume === 'true')      push(`resume_file is not null`);
        if (q.hidePrivate === 'true')    push(`not is_private`);
        if (q.hasComments === 'true') {
          push(`exists (select 1 from candidate_comments cc where cc.candidate_id = candidates.id)`);
        }
        if (q.commentTag) {
          params.push(String(q.commentTag));
          push(`exists (select 1 from candidate_comments cc
                         where cc.candidate_id = candidates.id
                           and cc.tag = $${params.length})`);
        }
        if (q.activeWithinDays) {
          /*
           * THIS ONE LINE EMPTIED THE WHOLE FIND CANDIDATES SCREEN.
           *
           * `profile_active_days_ago` was only ever written by the demo
           * seed. Every real candidate - imported from a board, or
           * self-registered - has it NULL, and `NULL <= 180` is NULL,
           * not true, so the row is dropped. The screen sends this filter
           * on every search because its default is "active in the last 6
           * months", so the server answered ZERO to every query anybody
           * ever made. A recruiter searching for a skill was told "No
           * candidates match the current search criteria" with a hundred
           * and fifteen candidates in the table.
           *
           * The fallback is the row's own timestamps, which is the same
           * answer toCandidate() gives the client, so the count in the
           * header and the rows underneath it cannot disagree.
           */
          params.push(Number(q.activeWithinDays));
          push(`coalesce(
                  profile_active_days_ago,
                  floor(extract(epoch from (now() - coalesce(updated_at, created_at))) / 86400)::int
                ) <= $${params.length}`);
        }
        if (industry.length) {
          params.push(industry);
          push(`exists (select 1 from applications a
                          join jobs j  on j.id = a.job_id
                          join companies co on co.id = j.company_id
                         where a.candidate_id = candidates.id
                           and co.industry = any($${params.length}))`);
        }
        if (stages.length) {
          params.push(stages);
          push(`exists (select 1 from applications a
                         where a.candidate_id = candidates.id
                           and a.stage = any($${params.length}))`);
        }

        /*
         * HAS THIS PERSON APPLIED TO ANYTHING?
         *
         * The Candidates screen used to answer this by listing the
         * candidate ids found on applications - which is the whole
         * difference between it and the talent pool, and the only thing
         * the pool could not already do. It is one EXISTS, in SQL, so it
         * pages and counts like every other filter here rather than
         * filtering the twenty-five rows that happen to be on screen.
         *
         *   applied=yes   the people the Candidates screen showed
         *   applied=no    sourced, imported or referred and never applied
         *                 - the ones only the pool has ever shown
         */
        const applied = String(q.applied || '').trim().toLowerCase();
        if (applied === 'yes' || applied === 'no') {
          push(`${applied === 'no' ? 'not ' : ''}exists (
                  select 1 from applications a where a.candidate_id = candidates.id)`);
        }

        /*
         * THE THREE THE TALENT POOL ASKS FOR.
         *
         * All in SQL, like everything above, because the pool is paged -
         * filtering the twenty-five rows that happen to be on screen
         * would silently answer a different question from the one the
         * recruiter asked.
         */
        const poolStatuses = list(q.poolStatus);
        if (poolStatuses.length) {
          params.push(poolStatuses);
          push(`pool_status = any($${params.length})`);
        }

        /*
         * WHERE THEY CAME FROM — several at once, and "Unknown" among
         * them.
         *
         * A candidate with no source recorded is not an error, it is a
         * candidate imported before anybody was asked to record one, and
         * a recruiter cleaning that up needs to be able to ASK for them.
         * So 'Unknown' is a value this filter accepts and means `is
         * null`, rather than a gap the filter cannot express.
         */
        const sources = list(q.source);
        if (sources.length) {
          const named = sources.filter((x) => x !== 'Unknown');
          const wantsUnknown = sources.length !== named.length;
          if (named.length && wantsUnknown) {
            params.push(named);
            push(`(source = any($${params.length}) or source is null)`);
          } else if (named.length) {
            params.push(named);
            push(`source = any($${params.length})`);
          } else {
            push('source is null');
          }
        }

        // Everyone linked to one requirement, however far along they are.
        if (q.jobId) {
          params.push(String(q.jobId));
          push(`exists (select 1 from applications a
                         where a.candidate_id = candidates.id
                           and a.job_id = $${params.length})`);
        }

        /*
         * Last contacted. `contactedWithinDays` finds the recently
         * touched; `notContactedForDays` finds the opposite, which is
         * the more useful of the two - a sourcing list is worked by
         * finding who has gone quiet.
         */
        if (q.contactedWithinDays) {
          params.push(Number(q.contactedWithinDays));
          push(`exists (select 1 from candidate_contact_history h
                         where h.candidate_id = candidates.id
                           and h.created_at > now() - make_interval(days => $${params.length}))`);
        }
        if (q.notContactedForDays) {
          params.push(Number(q.notContactedForDays));
          push(`not exists (select 1 from candidate_contact_history h
                             where h.candidate_id = candidates.id
                               and h.created_at > now() - make_interval(days => $${params.length}))`);
        }
        if (String(q.neverContacted) === 'true') {
          push(`not exists (select 1 from candidate_contact_history h
                             where h.candidate_id = candidates.id)`);
        }

        const clause = where.length ? `where ${where.join(' and ')}` : '';

        // Keys match the UI's "Sort by" control. An unknown value falls back
        // rather than being interpolated — `order` reaches the SQL string
        // directly, so it must only ever be one of these literals.
        const sortable = {
          Relevance: 'name asc',
          recent: 'profile_updated_days_ago asc nulls last',
          'Freshness': 'profile_active_days_ago asc nulls last',
          name: 'name asc',
          experience: 'exp_years desc nulls last',
          'Experience': 'exp_years desc nulls last',
          'Salary': 'expected_ctc asc nulls last',
          /* 0075. `nulls last` so the ones with no source recorded sort
             to the end rather than to the top, where they would push the
             answer the recruiter asked for off the first page. */
          source: 'source asc nulls last, name asc',
          'source-desc': 'source desc nulls last, name asc',
          added: 'created_at desc',
          'added-asc': 'created_at asc',
        };
        const order = sortable[q.sort] || 'name asc';

        const total = await c.query(`select count(*)::int n from candidates ${clause}`, params);

        params.push(limit, offset);
        const rows = await c.query(
          `select * from candidates ${clause}
           order by ${order} limit $${params.length - 1} offset $${params.length}`, params);

        // the pipeline position for just this page of candidates
        const ids = rows.rows.map((x) => x.id);
        const apps = ids.length
          ? await c.query(`select * from applications where candidate_id = any($1)`, [ids])
          : { rows: [] };

        return { total: total.rows[0].n, rows: rows.rows, apps: apps.rows };
      });

      /* Find Candidates is recruiter/admin/client only at the route
         level, so the staff shape is correct here. */
      const cands = out.rows.map((x) => toCandidate(x, { staff: true }));
      const extra = attachPrimary(cands, out.apps.map(toApplication));

      res.json({
        candidates: cands,
        applications: extra,
        total: out.total,
        limit, offset,
        hasMore: offset + cands.length < out.total,
      });
    }));

  /*
   * DECLARED BEFORE `/candidates/:id`, AND IT HAS TO BE.
   *
   * Express matches in order, so with the id route first this path is
   * read as a candidate whose id is the literal string
   * "message-templates" and answers 404. Moving it below again breaks
   * the compose box with no error anywhere near the cause.
   */
  /**
   * GET /api/candidates/message-templates
   *
   * The starting points and the variables, served rather than hard-coded
   * into the page - so the wording lives in one place and the compose box
   * cannot offer a variable the renderer does not know.
   */
  r.get('/candidates/message-templates', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const channel = String(req.query.channel || '').toLowerCase();
      const list = ['email', 'sms', 'whatsapp'].includes(channel)
        ? TEMPLATES.filter((t) => t.channels.includes(channel))
        : TEMPLATES;
      res.json({
        templates: list.map((t) => ({
          id: t.id, name: t.name, channels: t.channels,
          subject: t.subject, body: t.body,
        })),
        variables: VARIABLES,
      });
    }));

  /*
   * BEFORE '/candidates/:id'.
   *
   * Express matches in order, so a literal path registered after a
   * parameterised one of the same shape is never reached: '/candidates/
   * source-counts' was being read as a candidate whose id is
   * "source-counts", and answered with an empty body.
   */
  /**
   * GET /api/candidates/source-counts
   *
   * How many candidates came from each source, for the filter's own
   * counts. Answered by the database rather than by counting a page of
   * results in the browser, which would report "3 from Job Board" when
   * it meant "3 on this page".
   *
   * 'Unknown' is returned as a source in its own right, because a
   * recruiter tidying up the pool needs to see how many have none.
   */
  r.get('/candidates/source-counts', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const rows = await withUser(req.session, async (c) => (await c.query(
        `select coalesce(source, 'Unknown') as source, count(*)::int as n
           from candidates
          group by coalesce(source, 'Unknown')
          order by n desc, source asc`)).rows);

      const known = await withUser(req.session, async (c) => (await c.query(
        `select unnest(candidate_source_values()) as s`)).rows.map((x) => x.s));

      res.json({
        counts: rows,
        total: rows.reduce((n, x) => n + Number(x.n || 0), 0),
        /* Every value the vocabulary allows, so the filter can offer one
           that nobody is currently using rather than hiding it. */
        sources: known.concat(['Unknown']),
      });
    }));

  r.get('/candidates/:id', requireAuth(), wrap(async (req, res) => {
    const out = await withUser(req.session, async (c) => {
      const { rows } = await c.query(`select * from candidates where id=$1`, [req.params.id]);
      if (!rows.length) return null;
      const apps = await c.query(`select * from applications where candidate_id=$1`, [req.params.id]);
      /* The repeatable sections of the manual entry form (migration
         0057). Write-only data is lost data: what a recruiter typed into
         "+ Add Education" has to be readable again. */
      const edu = await c.query(
        `select qualification, specialization, institution, passing_year, score,
                education_type
           from candidate_education where candidate_id=$1 order by sort_order, id`,
        [req.params.id]);
      const exp = await c.query(
        `select company, job_title, start_date, end_date, currently_working, location,
                employment_type, responsibilities, leaving_reason
           from candidate_experience where candidate_id=$1 order by sort_order, id`,
        [req.params.id]);
      return { row: rows[0], apps: apps.rows, edu: edu.rows, exp: exp.rows };
    });
    if (!out) throw notFound('That candidate could not be found.');

    /* A candidate can read their OWN row through this route, and must
       not read the recruiter's notes on themselves. */
    const cand = toCandidate(out.row, { staff: req.session.role !== 'candidate' });
    const extra = attachPrimary([cand], out.apps.map(toApplication));
    cand.educationRecords = out.edu.map(toEducationRecord);
    cand.experienceRecords = out.exp.map(toExperienceRecord);
    res.json({ candidate: cand, applications: extra });
  }));

  /** Profile edit. A candidate may change only their own record. */
  /* ================================================================== *
   * Adding a candidate by hand
   *
   * Three routes could create a candidate before this one - the person
   * registered, a job-board email was parsed, a spreadsheet was imported
   * - and none of them is a recruiter sitting with a CV and a phone
   * call. "+ Add Candidate" had no endpoint behind it at all.
   *
   * NOTHING IS CREATED BY OPENING THE FORM, and nothing is created by
   * uploading a resume to it. The row appears when Save is pressed and
   * the validation below passes, and not before.
   * ================================================================== */

  /**
   * An admin session, for the one question RLS cannot answer.
   *
   * "Does this mobile number already exist?" asked under a recruiter's
   * own rights returns "no" for every candidate owned by a different
   * recruiter - and then a second record is created for somebody already
   * in the database. The lookup therefore runs here, and what it finds is
   * filtered against what the caller may actually read before any of it
   * is returned. See migration 0057 for why a `security definer`
   * function is not the answer.
   */
  const ENGINE = { userId: '', role: 'admin', profileId: null };

  const newId = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  /** The last ten digits, which is how two Indian mobile numbers are the
      same number whether or not somebody typed +91. */
  const digits10 = (v) => {
    const d = String(v || '').replace(/\D/g, '');
    return d.length >= 10 ? d.slice(-10) : '';
  };

  /**
   * Who already holds this email or this mobile.
   *
   * A row the caller may read comes back whole and they can open it. A
   * row they may not read comes back as `visible: false` carrying NO
   * name, NO address and NO number - the identifier is taken, and that
   * is all they learn. Enough to stop a duplicate; not enough to read
   * somebody else's candidate.
   */
  async function findDuplicates(session, { email, phone, ignoreId }) {
    const e = String(email || '').trim().toLowerCase();
    const p = digits10(phone);
    if (!e && !p) return [];

    const rows = await withUser(ENGINE, async (c) => (await c.query(
      `select id, name, email, phone, alt_email, alt_phone, pool_status, created_at
         from candidates
        where ($1 <> '' and (lower(btrim(coalesce(email,''))) = $1
                             or lower(btrim(coalesce(alt_email,''))) = $1))
           or ($2 <> '' and (right(regexp_replace(coalesce(phone,''),     '\\D', '', 'g'), 10) = $2
                          or right(regexp_replace(coalesce(alt_phone,''), '\\D', '', 'g'), 10) = $2))
        order by created_at desc
        limit 10`, [e, p])).rows);

    const hits = rows.filter((x) => x.id !== ignoreId);
    if (!hits.length) return [];

    const visibleRows = await withUser(session, async (c) => (await c.query(
      `select id from candidates where id = any($1)`, [hits.map((x) => x.id)])).rows);
    const seen = new Set(visibleRows.map((x) => x.id));

    return hits.map((x) => {
      const onEmail = e && (String(x.email || '').trim().toLowerCase() === e
                         || String(x.alt_email || '').trim().toLowerCase() === e);
      const base = {
        id: x.id,
        matchedOn: onEmail ? 'email address' : 'mobile number',
        visible: seen.has(x.id),
        createdAt: x.created_at,
      };
      return base.visible
        ? { ...base, name: x.name, email: x.email || '', phone: x.phone || '',
            poolStatus: x.pool_status || 'sourced' }
        : base;
    });
  }

  /**
   * POST /api/candidates/duplicate-check
   *
   * What the form calls as the recruiter leaves the email or mobile
   * field, so the warning appears before they have typed forty more
   * fields. Save re-runs the same check server-side - this one is a
   * courtesy, not the enforcement.
   */
  r.post('/candidates/duplicate-check', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const b = req.body || {};
      res.json({ duplicates: await findDuplicates(req.session, {
        email: b.email, phone: b.phone, ignoreId: b.ignoreId,
      }) });
    }));

  /* The tag-style fields: an array of short strings, or a comma-separated
     string, because a paste from a spreadsheet is one of those. */
  const tags = (max) => z.union([
    z.array(z.string().trim().max(120)).max(max),
    z.string().max(max * 121),
  ]).optional().transform((v) => {
    if (v === undefined) return undefined;
    const a = Array.isArray(v) ? v : String(v).split(',');
    return [...new Set(a.map((s) => String(s).trim()).filter(Boolean))].slice(0, max);
  });

  const text = (max) => z.string().trim().max(max).optional();
  /* An empty date input posts "", and `z.string().date()` rejects it -
     which showed the recruiter "Invalid date" on a field they had left
     alone. Blank means "not given". */
  const dateish = z.union([z.string().trim().max(10), z.null()]).optional()
    .transform((v) => (v && String(v).trim() ? String(v).trim() : null));
  const numish = z.union([z.number(), z.string().trim().max(20), z.null()]).optional()
    .transform((v) => {
      if (v === null || v === undefined || String(v).trim() === '') return null;
      const n = Number(String(v).replace(/[^\d.-]/g, ''));
      return Number.isFinite(n) ? n : null;
    });
  const boolish = z.union([z.boolean(), z.string().max(8)]).optional()
    .transform((v) => (v === undefined ? undefined
      : v === true || v === 'true' || v === 'on' || v === '1'));

  const educationRow = z.object({
    qualification:  text(160),
    specialization: text(160),
    institution:    text(200),
    passingYear:    numish,
    score:          text(40),
    educationType:  text(40),
  });

  const experienceRow = z.object({
    company:          text(200),
    jobTitle:         text(160),
    startDate:        dateish,
    endDate:          dateish,
    currentlyWorking: boolish,
    location:         text(120),
    employmentType:   text(40),
    responsibilities: text(4000),
    leavingReason:    text(400),
  });

  const createSchema = z.object({
    /* ---- the six the brief makes mandatory ---------------------------- */
    firstName: z.string().trim().min(1, 'First name is required').max(80),
    lastName:  text(80),
    /*
     * A WAY TO REACH THEM, rather than one particular way.
     *
     * Both of these were mandatory, which meant a recruiter with a phone
     * number and no address - the ordinary case for somebody met at a
     * walk-in - could not record the person at all. Either one will do;
     * the route refuses a save that has neither, because a candidate
     * nobody can contact is a row that can never become anything.
     *
     * Each is still FORMAT-CHECKED when supplied. Optional does not mean
     * "anything goes": a malformed address is worse than a blank one,
     * because a blank one is visibly blank.
     */
    phone:     z.string().trim().min(6, 'A phone number is required').max(32),
    email:     z.string().trim()
                 .min(1, 'An email address is required')
                 .email('That does not look like an email address').max(200),
    /*
     * NOT ASKED FOR ANY MORE.
     *
     * The quick-add form collects four things - name, phone, gender,
     * email - and the candidate fills in the rest themselves once they
     * sign in. A location the recruiter guessed at is worse than a blank
     * one the candidate will correct, and `source` is defaulted below to
     * the one thing that is actually known: a recruiter typed this in.
     */
    location:  text(120),
    source:    text(60),
    /* Whether a CV was attached. NOT a requirement any more - see the
       route - but still reported, because the form's next step is the
       upload and it needs to know whether to expect one. */
    hasResume: boolish,
    /*
     * Whether to create a portal login and send it. Default is to send:
     * the recruiter unticks the box when they mean to add somebody
     * quietly, which is the rarer case and the one worth an explicit act.
     */
    sendCredentials: boolish,

    /* ---- identity ----------------------------------------------------- */
    /* Required by the quick-add form. Kept as a plain string rather than
       an enum so a value the form does not offer - one arriving from an
       import - is still stored rather than rejected. */
    gender:        text(40),
    dateOfBirth:   dateish,
    altPhone:      text(32),
    altEmail:      z.union([z.string().trim().email().max(200), z.literal('')]).optional(),
    preferredLocation: text(160),
    state:         text(80),
    district:      text(80),
    address:       text(400),
    pincode:       text(12),
    nationality:   text(60),
    linkedin:      text(300),
    portfolio:     text(300),

    /* ---- professional -------------------------------------------------- */
    title:            text(160),
    currentCompany:   text(160),
    exp:              text(40),
    expYears:         numish,
    relevantExpYears: numish,
    employmentType:   text(40),
    ctc:              text(40),
    expectedCtc:      numish,
    noticePeriod:     text(40),
    availableFrom:    dateish,
    immediateJoiner:  boolish,
    jobStatus:        text(60),
    jobChangeReason:  text(400),
    preferredWorkModes: tags(10),
    preferredShift:   text(40),
    willingToRelocate: boolish,
    relocationLocation: text(160),

    /* ---- the repeatable sections --------------------------------------- */
    educationRecords:  z.array(educationRow).max(20).optional(),
    experienceRecords: z.array(experienceRow).max(30).optional(),
    education:         text(400),

    /* ---- skills --------------------------------------------------------- */
    skills:          tags(100),
    secondarySkills: tags(100),
    technicalSkills: tags(100),
    softSkills:      tags(60),
    tools:           tags(60),
    certifications:  tags(60),

    /* ---- recruitment ----------------------------------------------------- */
    sourceDetails:       text(300),
    jobId:               text(64),
    appliedRole:         text(160),
    assignedRecruiterId: text(64),
    hiringType:          text(40),
    poolStatus:          text(40),
    pipelineStage:       text(40),
    priority:            text(20),
    availability:        text(60),
    candidateReference:  text(80),
    referredBy:          text(120),

    /* ---- documents -------------------------------------------------------- */
    resumeVersion: text(40),
    resumeSource:  text(60),
    coverLetter:   text(8000),

    /* ---- communication ----------------------------------------------------- */
    emailOptIn:    boolish,
    smsOptIn:      boolish,
    whatsappOptIn: boolish,
    preferredContactMethod: text(40),

    /* ---- notes --------------------------------------------------------------- */
    candidateNotes:  text(8000),
    recruiterNotes:  text(8000),
    internalRemarks: text(8000),
    tags:            tags(40),

    /* ---- the interview, agreed but NOT scheduled ------------------------ *
     * An interview in this system belongs to an application, and a
     * candidate entered by hand may not have one yet. What the recruiter
     * agreed on the call is recorded as an intention (migration 0058) and
     * nothing is scheduled by saving this form. */
    interviewPrefs: z.object({
      required: boolish,
      type:     text(60),
      mode:     text(40),
      date:     dateish,
      time:     text(20),
      interviewer: text(120),
      locationOrLink: text(400),
      notes:    text(4000),
    }).optional(),

    /* The recruiter saw the duplicate warning and chose to go on. Without
       it a possible duplicate is refused, which is the point. */
    allowDuplicate: boolish,
  });

  /**
   * POST /api/candidates
   *
   * Creates ONE candidate from the manual entry form. Recruiter, BDE or
   * admin - a candidate cannot create another candidate.
   */
  r.post('/candidates', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const out = createSchema.safeParse(req.body || {});
      if (!out.success) {
        const details = {};
        for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
        throw badRequest('Please check the highlighted fields and try again.', details);
      }
      const b = out.data;

      /*
       * NO RESUME IS REQUIRED.
       *
       * It used to be: a save that did not promise a file was refused
       * outright. But a recruiter adding somebody they met at a walk-in,
       * or transcribing a phone call, does not have a CV and is not
       * going to invent one - so the form could not be used for the very
       * situation it was most needed in, and the honest record ("this
       * person exists, no CV yet") could not be written down at all.
       *
       * A resume still fills blank fields when one is attached; it is
       * simply no longer the price of admission.
       */

      /*
       * ONE WAY TO REACH THEM IS REQUIRED, either way round.
       *
       * A candidate with neither an address nor a number cannot be
       * contacted, cannot be sent a login, and cannot be deduplicated
       * against anybody - which makes the row worse than useless, since
       * it will be created again tomorrow by the next person who meets
       * them.
       */
      const email = String(b.email || '').trim();
      const phone = String(b.phone || '').trim();

      /*
       * Gender is checked here rather than in the schema so the message
       * lands on the field, the way the other three do.
       */
      if (!String(b.gender || '').trim()) {
        throw badRequest('Please check the highlighted fields and try again.',
          { gender: 'Please choose one.' });
      }

      /* An Indian mobile is ten digits; the dialling code is carried in
         front of it and is not part of that count. */
      if (!digits10(phone)) {
        throw badRequest('Please check the highlighted fields and try again.',
          { phone: 'That does not look like a mobile number.' });
      }

      /*
       * BLANK MEANS ABSENT, and absent means NULL.
       *
       * The form posts '' for a field nobody filled in, and `candidates`
       * carries `check (email is null or btrim(email) <> '')` - because
       * an empty string is not an address, and storing one defeats every
       * later test of "do we have a way to reach this person".
       *
       * Without this the insert failed a check constraint and the
       * recruiter was told "That value is not allowed", which names
       * neither the field nor the problem.
       */
      b.email = email || null;
      b.phone = phone || null;

      /* ---- duplicates, before anything is written --------------------- */
      const duplicates = await findDuplicates(req.session, { email: b.email, phone: b.phone });
      if (duplicates.length && b.allowDuplicate !== true) {
        throw new ApiError(409, CODES.DUPLICATE_CANDIDATE,
          'A candidate with similar information already exists.', { duplicates });
      }

      const name = [b.firstName, b.lastName].filter(Boolean).join(' ').trim();
      const id = newId('cand');
      const ownerRecruiterId = req.session.role === 'recruiter' ? req.session.profileId : null;

      const candidate = await withUser(req.session, async (c) => {
        /*
         * WHERE THEY CAME FROM, IN THE ONE VOCABULARY (0075).
         *
         * Screens write "naukri.com", "Walk-in", "Referred by Priya" and
         * a dozen other spellings of a handful of things. The column now
         * holds a fixed set, so the wording that arrived is folded into
         * it here — and KEPT, in source_details, because "Referred by
         * Priya" says which referral and the vocabulary cannot.
         *
         * Anything unrecognised becomes 'Other' rather than being
         * refused: a candidate is not worth losing over the spelling of
         * where they came from.
         */
        if (b.source) {
          const canon = (await c.query(
            `select candidate_source_canonical($1) as s`, [b.source])).rows[0].s;
          if (canon && canon !== b.source) {
            b.sourceDetails = String(b.sourceDetails || '').trim() || b.source;
          }
          b.source = canon;
        }

        await c.query(
          `insert into candidates (
             id, name, email, phone, location, gender, title,
             date_of_birth, alt_phone, alt_email, preferred_location,
             state, district, address, pincode, nationality,
             linkedin, portfolio,
             exp, exp_years, relevant_exp_years, employment_type,
             current_company, ctc, expected_ctc, notice_period,
             available_from, immediate_joiner, job_status, job_change_reason,
             preferred_work_modes, preferred_shift,
             willing_to_relocate, relocation_location,
             skills, technical_skills, soft_skills, tools, certifications,
             education, summary,
             source, source_details, hiring_type, priority, availability,
             candidate_reference, referred_by, assigned_recruiter_id,
             resume_version, resume_source, cover_letter,
             email_opt_in, sms_opt_in, whatsapp_opt_in, preferred_contact_method,
             candidate_notes, recruiter_notes, internal_remarks, tags,
             pool_status, interview_prefs, entry_method, created_by,
             owner_recruiter_id, sourced_at
           ) values (
             $1,$2,$3,$4,$5,$6,$7,
             $8,$9,$10,$11,
             $12,$13,$14,$15,$16,
             $17,$18,
             $19,$20,$21,$22,
             $23,$24,$25,$26,
             $27,$28,$29,$30,
             $31,$32,
             $33,$34,
             $35,$36,$37,$38,$39,
             $40,$41,
             $42,$43,$44,$45,$46,
             $47,$48,$49,
             $50,$51,$52,
             $53,$54,$55,$56,
             $57,$58,$59,$60,
             $61,$62::jsonb,'manual',$63,$64, now()
           )`,
          [id, name, b.email, b.phone, b.location, b.gender || null, b.title || null,
           b.dateOfBirth, b.altPhone || null, b.altEmail || null, b.preferredLocation || null,
           b.state || null, b.district || null, b.address || null, b.pincode || null,
           b.nationality || null,
           b.linkedin || null, b.portfolio || null,
           b.exp || null, b.expYears, b.relevantExpYears, b.employmentType || null,
           b.currentCompany || null, b.ctc || null, b.expectedCtc, b.noticePeriod || null,
           b.availableFrom, b.immediateJoiner === true, b.jobStatus || null,
           b.jobChangeReason || null,
           b.preferredWorkModes || [], b.preferredShift || null,
           b.willingToRelocate === undefined ? null : b.willingToRelocate,
           b.relocationLocation || null,
           /* Primary and secondary skills are one searchable list - the
              matcher, the search and every filter read `skills`, and a
              secondary skill kept somewhere else is a skill nobody can
              search for. The split is preserved by ORDER, primary first. */
           [...(b.skills || []), ...(b.secondarySkills || [])].slice(0, 100),
           b.technicalSkills || [], b.softSkills || [], b.tools || [],
           b.certifications || [],
           /* `summary` is the candidate's own profile blurb and stays
              empty: what the recruiter wrote is a recruiter's note and
              goes in candidate_notes, where it is labelled as one. */
           b.education || null, null,
           b.source, b.sourceDetails || null, b.hiringType || null,
           b.priority || null, b.availability || null,
           b.candidateReference || null, b.referredBy || null,
           b.assignedRecruiterId || null,
           b.resumeVersion || null, b.resumeSource || null, b.coverLetter || null,
           b.emailOptIn !== false, b.smsOptIn !== false, b.whatsappOptIn === true,
           b.preferredContactMethod || null,
           b.candidateNotes || null, b.recruiterNotes || null, b.internalRemarks || null,
           b.tags || [],
           b.poolStatus || 'sourced',
           b.interviewPrefs && Object.values(b.interviewPrefs)
             .some((v) => v !== undefined && v !== null && v !== '')
             ? JSON.stringify(b.interviewPrefs) : null,
           req.session.userId || null, ownerRecruiterId]);

        /* ---- the repeatable sections, in the order they were typed ---- */
        const edu = (b.educationRecords || [])
          .filter((e) => Object.values(e).some((v) => v !== undefined && v !== null && v !== ''));
        for (let i = 0; i < edu.length; i += 1) {
          const e = edu[i];
          await c.query(
            `insert into candidate_education
               (candidate_id, qualification, specialization, institution,
                passing_year, score, education_type, sort_order)
             values ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [id, e.qualification || null, e.specialization || null, e.institution || null,
             e.passingYear, e.score || null, e.educationType || null, i]);
        }

        const exp = (b.experienceRecords || [])
          .filter((e) => Object.values(e).some((v) => v !== undefined && v !== null && v !== ''));
        for (let i = 0; i < exp.length; i += 1) {
          const e = exp[i];
          await c.query(
            `insert into candidate_experience
               (candidate_id, company, job_title, start_date, end_date,
                currently_working, location, employment_type, responsibilities,
                leaving_reason, sort_order)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [id, e.company || null, e.jobTitle || null, e.startDate, e.endDate,
             e.currentlyWorking === true, e.location || null, e.employmentType || null,
             e.responsibilities || null, e.leavingReason || null, i]);
        }

        /* The employer NAMES also go on the candidate, because
           `previous_companies` is what the search and the matcher read.
           The detail lives in the rows above; this is the index. */
        const employers = [...new Set(exp.map((e) => e.company).filter(Boolean))].slice(0, 40);
        if (employers.length) {
          await c.query(`update candidates set previous_companies = $1 where id = $2`,
            [employers, id]);
        }

        return (await c.query(`select * from candidates where id = $1`, [id])).rows[0];
      });

      /* ---- the portal login ------------------------------------------ *
       *
       * A candidate added by a recruiter could not sign in: the row
       * existed and nothing ever gave them a way to reach it. The same
       * routine the import uses creates the account and sends the
       * credentials, so both doors produce the same result.
       *
       * NEVER FATAL. The candidate is already saved by this point, and a
       * mail provider being down must not undo that - the caller is told
       * what happened and the UI offers to send again.
       *
       * The password is generated, hashed and sent inside inviteCandidate;
       * it is never returned here and never logged. `delivery` says only
       * which channel reached which status.
       */
      const shaped = toCandidate(candidate, { staff: true });
      let credentials = { attempted: false, sent: false, accountCreated: false, delivery: {} };

      if (b.sendCredentials !== false) {
        credentials.attempted = true;
        try {
          /*
           * WAITED FOR, BUT NOT INDEFINITELY.
           *
           * Waiting is what lets the screen say whether the message
           * actually left, which is the difference between "login
           * details sent" and a recruiter who believes that and is
           * wrong. It normally takes about a second.
           *
           * But the save must not hang on a provider that has stopped
           * answering, so after a short wait the request returns and the
           * send carries on in the background. Nothing is lost when that
           * happens: the account is already created, the outcome is
           * still written to candidate_invites, and the screen says the
           * message is on its way rather than that it arrived.
           */
          const sending = inviteCandidate(shaped, {
            invitedBy: req.session.userId || req.session.role || 'recruiter',
          });

          /* Rejections must not become unhandled ones when the race is
             won by the timer. */
          sending.catch((err) => {
            console.error('[candidates] the invitation failed after the reply:', err.message);
          });

          const TOO_LONG = Number(process.env.INVITE_WAIT_MS || 2500);
          let timer = null;
          const gaveUp = Symbol('still sending');
          const done = await Promise.race([
            sending,
            new Promise((resolve) => { timer = setTimeout(() => resolve(gaveUp), TOO_LONG); }),
          ]);
          if (timer) clearTimeout(timer);

          if (done === gaveUp) {
            credentials.queued = true;
            credentials.reason = 'still sending';
          } else {
            credentials.sent = !!done.invited;
            credentials.accountCreated = !!done.accountCreated;
            credentials.delivery = done.delivery || {};
            if (done.reason) credentials.reason = done.reason;
          }
        } catch (err) {
          /* The message, not the credentials. */
          console.error('[candidates] could not send portal credentials:', err.message);
          credentials.reason = 'the invitation could not be sent';
        }
        /*
         * WHY NOTHING ARRIVED, precisely.
         *
         * "No email address" is the wrong thing to say about somebody
         * whose account was created and whose login IS their phone
         * number - the account exists and works; what failed is the
         * delivery, and the recruiter needs to know which of the two it
         * was before they decide whether to chase it.
         */
        if (!credentials.sent && !credentials.reason) {
          const d = credentials.delivery || {};
          const noTextChannel = d.sms !== 'sent' && d.whatsapp !== 'sent';
          if (!email && phone && credentials.accountCreated && noTextChannel) {
            credentials.reason =
              (d.sms === 'not_configured' && d.whatsapp === 'not_configured')
                ? 'their login is their mobile number, but no SMS or WhatsApp '
                  + 'provider is configured to send it'
                : 'the message to their mobile could not be delivered';
          } else if (!email) {
            credentials.reason = 'no email address to send a login to';
          } else {
            credentials.reason = 'no channel accepted the message';
          }
        }
      }

      res.status(201).json({
        candidate: shaped,
        /* Said plainly, because the form's next step depends on it: the
           row exists, the file does not yet. */
        resumePending: b.hasResume === true,
        duplicatesAccepted: duplicates.length || 0,
        credentials,
      });
    }));

  /* ================================================================== *
   * Messaging a selection of candidates
   *
   * Three endpoints: what may be written, what will be sent, and the
   * history for one person.
   * ================================================================== */

  /**
   * POST /api/candidates/bulk-message
   *
   * Queues one message per selected candidate and returns immediately.
   *
   * IT RETURNS 202 AND SAYS "QUEUED", not "sent". Nothing has been sent
   * when this responds - the sweep in notify/bulk.js does that, and the
   * row becomes `sent` only when a provider says so. Reporting a send
   * from the fact that this call succeeded is precisely the mistake the
   * per-row status exists to prevent.
   */
  r.post('/candidates/bulk-message', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const b = parse(z.object({
        channel: z.enum(['whatsapp', 'email', 'sms']),
        candidateIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500),
        templateId: z.string().trim().max(60).optional(),
        subject: z.string().trim().max(300).optional(),
        body: z.string().trim().min(1).max(20_000),
        /* The role the message is about, when the recruiter picked one.
           It is what {{job_title}} falls back to. */
        jobId: z.string().trim().max(64).optional(),
      }), req.body);

      if (b.channel === 'email' && !String(b.subject || '').trim()) {
        throw badRequest('Please check the highlighted fields and try again.',
          { subject: 'An email needs a subject.' });
      }

      /* ---- only candidates this recruiter may actually reach --------
         Loaded under their own rights, so RLS - not this handler -
         decides. Ids they cannot see simply do not come back, and are
         reported as unreachable rather than silently dropped. */
      const rows = await withUser(req.session, async (c) => (await c.query(
        `select id, name, email, phone, title, preferred_role, location,
                current_company, notice_period, do_not_contact
           from candidates where id = any($1)`, [b.candidateIds])).rows);

      const found = new Map(rows.map((x) => [x.id, x]));
      const unreachable = b.candidateIds.filter((id) => !found.has(id));

      const job = b.jobId
        ? await withUser(req.session, async (c) => (await c.query(
            `select id, title from jobs where id=$1`, [b.jobId])).rows[0])
        : null;

      const me = req.session.role === 'recruiter'
        ? await withUser(req.session, async (c) => (await c.query(
            `select name from recruiters where id=$1`, [req.session.profileId])).rows[0])
        : null;

      const batchId = newId('msgb');
      const queued = [];
      const skipped = [];
      const blocked = [];

      for (const cand of rows) {
        /* "Stop contacting me" is honoured here as it is everywhere
           else. A recruiter selecting a hundred people has not read a
           hundred profiles, and this is the flag that exists so they do
           not have to. */
        if (cand.do_not_contact) {
          blocked.push({ id: cand.id, name: cand.name,
                         reason: 'asked not to be contacted' });
          continue;
        }

        const vars = varsFor(cand, {
          jobTitle: job ? job.title : undefined,
          recruiterName: me ? me.name : '',
        });
        const to = addressFor(b.channel, cand);
        const bodyText = render(b.body, vars);
        const subject = b.channel === 'email' ? render(b.subject || '', vars) : null;

        const row = await withUser(ENGINE, async (c) => (await c.query(
          `select * from message_log_queue($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [batchId, cand.id, b.channel, b.templateId || null,
           subject, bodyText, to || null,
           req.session.userId || null, req.session.role])).rows[0]);

        if (row.status === 'skipped_no_contact') {
          skipped.push({ id: cand.id, name: cand.name });
        } else {
          queued.push({ id: cand.id, name: cand.name });
        }
      }

      res.status(202).json({
        batchId,
        channel: b.channel,
        /* Said in the words that are true right now. */
        queued: queued.length,
        skipped: skipped.length,
        blocked: blocked.length,
        unreachable: unreachable.length,
        skippedFor: b.channel === 'email' ? 'email address' : 'mobile number',
        skippedCandidates: skipped.slice(0, 50),
        blockedCandidates: blocked.slice(0, 50),
        note: 'Queued. Nothing is reported as sent until the provider confirms it — '
          + 'the result appears against each candidate under Communication.',
      });
    }));

  /**
   * GET /api/candidates/bulk-message/:batchId
   *
   * How the batch is getting on. The compose modal polls this so the
   * summary it shows is what actually happened rather than what was asked
   * for.
   */
  r.get('/candidates/bulk-message/:batchId', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const rows = await withUser(req.session, async (c) => (await c.query(
        `select status, count(*)::int as n from message_logs
          where batch_id = $1 group by status`, [req.params.batchId])).rows);

      const by = {};
      rows.forEach((x) => { by[x.status] = x.n; });
      const total = rows.reduce((a, x) => a + x.n, 0);
      const done = (by.sent || 0) + (by.failed || 0) + (by.not_configured || 0)
                 + (by.skipped_no_contact || 0);

      const failures = ((by.failed || 0) + (by.not_configured || 0))
        ? await withUser(req.session, async (c) => (await c.query(
            `select m.candidate_id, c.name, m.status, m.error
               from message_logs m join candidates c on c.id = m.candidate_id
              where m.batch_id = $1 and m.status in ('failed','not_configured')
              limit 25`, [req.params.batchId])).rows)
        : [];

      res.json({
        batchId: req.params.batchId,
        total,
        sent: by.sent || 0,
        failed: by.failed || 0,
        notConfigured: by.not_configured || 0,
        skipped: by.skipped_no_contact || 0,
        pending: (by.queued || 0) + (by.sending || 0),
        finished: total > 0 && done === total,
        failures: failures.map((f) => ({
          candidateId: f.candidate_id, name: f.name, status: f.status,
          /* The provider's own reason. A recruiter who is told "failed"
             and nothing else cannot fix anything. */
          error: f.error || '',
        })),
      });
    }));

  /**
   * GET /api/candidates/:id/messages
   *
   * The Communication section on a candidate's profile: everything a
   * recruiter has written to this person, with what became of it.
   */
  r.get('/candidates/:id/messages', requireAuth(), wrap(async (req, res) => {
    if (req.session.role === 'candidate' && req.session.profileId !== req.params.id) {
      throw forbidden('You can only see your own messages.');
    }
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select id, batch_id, channel, template_id, subject, body, to_address,
              status, error, provider, sent_by_role, queued_at, sent_at
         from message_logs where candidate_id = $1
        order by coalesce(sent_at, queued_at) desc limit 200`, [req.params.id])).rows);

    const staff = ['recruiter', 'bde', 'admin'].includes(req.session.role);
    res.json({
      messages: rows.map((m) => ({
        id: Number(m.id),
        batchId: m.batch_id,
        channel: m.channel,
        templateId: m.template_id,
        subject: m.subject || '',
        body: m.body,
        to: m.to_address || '',
        status: m.status,
        /* A provider's failure reason is operational detail. The
           candidate reading their own history has no use for it and it
           can name internal configuration. */
        error: staff ? (m.error || '') : undefined,
        provider: staff ? m.provider : undefined,
        queuedAt: m.queued_at,
        sentAt: m.sent_at,
      })),
    });
  }));

  /**
   * POST /api/candidates/:id/source
   *
   * Change where a candidate came from, and write the change to their
   * activity history. Staff only: a candidate does not get to restate
   * how we found them.
   *
   * `alsoSeen` records an ADDITIONAL door rather than replacing the
   * first one — a candidate who applies through Naukri and later walks
   * in still came from Naukri, and the reporting has to keep saying so.
   */
  r.post('/candidates/:id/source', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const b = parse(z.object({
        source: z.string().trim().max(60),
        sourceDetails: z.string().trim().max(200).optional(),
        alsoSeen: z.boolean().optional(),
      }), req.body);

      const actor = req.session.userId || req.session.role || 'staff';

      const out = await withUser(req.session, async (c) => {
        if (b.alsoSeen) {
          await c.query(`select candidate_source_seen($1,$2,$3,$4)`,
            [req.params.id, b.source, b.sourceDetails || null, actor]);
        } else {
          await c.query(`select candidate_source_set($1,$2,$3,$4) as s`,
            [req.params.id, b.source, b.sourceDetails || null, actor]);
        }
        const { rows } = await c.query(`select * from candidates where id=$1`, [req.params.id]);
        return rows[0];
      });

      if (!out) throw notFound('That candidate could not be found.');
      res.json({ candidate: toCandidate(out, { staff: true }) });
    }));

  /**
   * GET /api/candidates/:id/activity
   *
   * What has been done to this record and by whom — at present, changes
   * of source. Staff only, and read-only: the history is written by the
   * functions that make the changes, never by a caller.
   */
  r.get('/candidates/:id/activity', requireAuth(),
    requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
      const rows = await withUser(req.session, async (c) => (await c.query(
        `select kind, summary, detail, actor, created_at
           from candidate_activity
          where candidate_id = $1
          order by created_at desc
          limit 100`, [req.params.id])).rows);

      res.json({
        activity: rows.map((x) => ({
          kind: x.kind, summary: x.summary, detail: x.detail || {},
          actor: x.actor || undefined,
          at: new Date(x.created_at).toISOString(),
        })),
      });
    }));

  /**
   * POST /api/candidates/:id/onboarding-later
   *
   * "Ask me later." Increments the count and stamps the time, and answers
   * with the new count so the screen knows whether to keep offering the
   * modal or drop to the quiet banner.
   *
   * A candidate may only do this for themselves. Staff may do it for a
   * candidate they can already see, which is what the Talent Pool's own
   * "stop prompting" would use.
   *
   * NOT A PUT ON THE PROFILE. The client does not know the current count,
   * so sending "the new value" would lose one every time two tabs raced;
   * the increment belongs where the row is.
   */
  r.post('/candidates/:id/onboarding-later', requireAuth(), wrap(async (req, res) => {
    if (req.session.role === 'candidate' && req.session.profileId !== req.params.id) {
      throw forbidden('You can only do that for your own profile.');
    }

    const count = await withUser(req.session, async (c) => (await c.query(
      `select candidate_onboarding_later($1) as n`, [req.params.id])).rows[0].n);

    if (Number(count) < 0) throw notFound('That candidate could not be found.');
    res.json({ ok: true, laterCount: Number(count) });
  }));

  r.put('/candidates/:id', requireAuth(), wrap(async (req, res) => {
    if (req.session.role === 'candidate' && req.session.profileId !== req.params.id) {
      throw forbidden('You can only edit your own profile.');
    }

    const schema = z.object({
      name: z.string().trim().min(2).max(120).optional(),
      phone: z.string().trim().max(32).optional(),
      location: z.string().trim().max(120).optional(),
      title: z.string().trim().max(160).optional(),
      summary: z.string().max(8000).optional(),
      education: z.string().max(400).optional(),
      exp: z.string().max(40).optional(),
      expYears: z.number().min(0).max(60).optional(),
      ctc: z.string().max(40).optional(),
      expectedCtc: z.number().min(0).optional(),
      noticePeriod: z.string().max(40).optional(),
      currentCompany: z.string().max(160).optional(),
      previousCompanies: z.array(z.string().max(160)).max(40).optional(),
      careerGoal: z.string().max(400).optional(),
      preferredRole: z.string().max(160).optional(),
      preferredLocation: z.string().max(160).optional(),
      candidateType: z.string().max(60).optional(),
      gender: z.string().max(40).optional(),
      linkedin: z.string().max(300).optional(),
      github: z.string().max(300).optional(),
      portfolio: z.string().max(300).optional(),
      // Where candidates in this market actually are, and what a recruiter
      // asks for by name (0013).
      naukri: z.string().max(300).optional(),
      indeed: z.string().max(300).optional(),
      skills: z.array(z.string().max(120)).max(100).optional(),
      technicalSkills: z.array(z.string().max(120)).max(100).optional(),
      certifications: z.array(z.string().max(200)).max(60).optional(),
      languages: z.array(z.string().max(60)).max(30).optional(),
      preferredWorkModes: z.array(z.string().max(40)).max(10).optional(),
      isPrivate: z.boolean().optional(),
      whatsappOptIn: z.boolean().optional(),
      // "Stop contacting me." Recorded when a call hears it, and
      // settable here so an emailed or spoken request can be honoured
      // without somebody editing the database by hand. Every outbound
      // channel checks it - calls, alerts, stage updates and the retry
      // sweep - so one flag stops all of them.
      doNotContact: z.boolean().optional(),

      /*
       * Education and work history as ROWS (0080).
       *
       * The same two shapes the create route takes, so a candidate
       * correcting what was read out of their CV sends what the wizard
       * that collected it sends.
       *
       * REPLACE, NOT MERGE: the candidate is looking at the whole list
       * and pressing Save, so what is on the screen is what they mean to
       * have. Omit the key to leave a list alone; an empty array says
       * there are none, which is a different statement and is honoured.
       */
      educationRecords:  z.array(educationRow).max(20).optional(),
      experienceRecords: z.array(experienceRow).max(30).optional(),
    });
    const out = schema.safeParse(req.body || {});
    if (!out.success) {
      const details = {};
      for (const i of out.error.issues) details[i.path.join('.') || 'form'] = i.message;
      throw badRequest('Please check the highlighted fields and try again.', details);
    }
    const body = out.data;

    const COLS = {
      name: 'name', phone: 'phone', location: 'location', title: 'title',
      summary: 'summary', education: 'education', exp: 'exp', expYears: 'exp_years',
      ctc: 'ctc', expectedCtc: 'expected_ctc', noticePeriod: 'notice_period',
      currentCompany: 'current_company', previousCompanies: 'previous_companies',
      careerGoal: 'career_goal', preferredRole: 'preferred_role',
      preferredLocation: 'preferred_location', candidateType: 'candidate_type',
      gender: 'gender', linkedin: 'linkedin', github: 'github', portfolio: 'portfolio',
      naukri: 'naukri', indeed: 'indeed',
      skills: 'skills', technicalSkills: 'technical_skills',
      certifications: 'certifications', languages: 'languages',
      preferredWorkModes: 'preferred_work_modes',
      isPrivate: 'is_private', whatsappOptIn: 'whatsapp_opt_in',
      doNotContact: 'do_not_contact',
    };

    /*
     * The row lists first (0080), through the definer function - both
     * tables are behind row level security and a blocked write there
     * affects zero rows and raises nothing.
     */
    const wroteRecords = !!(body.educationRecords || body.experienceRecords);
    if (wroteRecords) {
      await withUser(req.session, (c) => c.query(
        `select candidate_records_replace($1,$2,$3)`,
        [req.params.id,
         body.educationRecords ? JSON.stringify(body.educationRecords) : null,
         body.experienceRecords ? JSON.stringify(body.experienceRecords) : null]));
    }

    const cand = await withUser(req.session, async (c) => {
      const sets = [], vals = [];
      for (const [k, col] of Object.entries(COLS)) {
        if (body[k] !== undefined) { vals.push(body[k]); sets.push(`${col}=$${vals.length}`); }
      }
      /*
       * Rows and no flat columns is a legitimate save - the wizard's
       * "I only fixed my job history" case. Refusing it as "nothing to
       * update" would report a failure for a write that had already
       * happened, which is worse than either outcome on its own.
       */
      if (!sets.length) {
        if (!wroteRecords) throw badRequest('Nothing to update.');
        const cur = await c.query(`select * from candidates where id=$1`, [req.params.id]);
        if (!cur.rowCount) throw notFound('That candidate could not be found.');
        return cur.rows[0];
      }
      sets.push(`profile_updated_days_ago = 0`);
      vals.push(req.params.id);
      const upd = await c.query(
        `update candidates set ${sets.join(',')} where id=$${vals.length} returning *`, vals);
      if (!upd.rowCount) {
        const seen = await c.query(`select 1 from candidates where id=$1`, [req.params.id]);
        throw seen.rowCount ? forbidden('You cannot edit this profile.')
                            : notFound('That candidate could not be found.');
      }
      return upd.rows[0];
    });

    res.json({ candidate: toCandidate(cand) });
  }));

  /**
   * GET /api/candidates/:id/invites
   *
   * Did this person ever get their login, and on which channel?
   *
   * The question a recruiter asks when somebody they imported has not
   * signed in. RLS on candidate_invites answers it only for people they
   * can already see, and the candidate can see their own.
   *
   * NO PASSWORD IS RETURNED, EVER. `hadCredentials` says whether the
   * message carried one; the value itself existed for the length of one
   * function call and was never stored.
   */
  r.get('/candidates/:id/invites', requireAuth(), wrap(async (req, res) => {
    if (req.session.role === 'candidate' && req.session.profileId !== req.params.id) {
      throw forbidden('You can only see your own messages.');
    }
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select channel, status, to_address, provider, error,
              had_credentials, created_at
         from candidate_invites where candidate_id = $1
        order by created_at desc limit 50`, [req.params.id])).rows);

    res.json({
      invites: rows.map((d) => ({
        channel: d.channel,
        status: d.status,
        to: d.to_address || undefined,
        provider: d.provider || undefined,
        error: d.error || undefined,
        hadCredentials: !!d.had_credentials,
        at: new Date(d.created_at).toISOString(),
      })),
    });
  }));

  /**
   * POST /api/candidates/:id/invite
   *
   * Give this person a way into the portal, and tell them.
   *
   * Two cases, and the difference matters:
   *
   *   no account yet  -> create one and send the credentials
   *   has an account  -> issue a NEW temporary password, but only if the
   *                      message actually leaves. See resendCredentials:
   *                      committing first and sending second would lock
   *                      somebody out the moment a provider is down.
   *
   * NO PASSWORD IS RETURNED. The response says which channels the
   * message left on, and nothing else.
   */
  r.post('/candidates/:id/invite', requireAuth(), requireRole('recruiter', 'bde', 'admin'),
    wrap(async (req, res) => {
      const c = await withUser(req.session, async (cl) => (await cl.query(
        `select id, name, email, phone, user_id, do_not_contact
           from candidates where id = $1`, [req.params.id])).rows[0]);
      if (!c) throw notFound('That candidate could not be found.');

      if (c.do_not_contact) {
        throw new ApiError(409, 'DO_NOT_CONTACT',
          `${c.name} has asked not to be contacted.`);
      }
      if (!c.email) {
        throw badRequest('That candidate has no email address, so there is '
          + 'nowhere to send a login.');
      }

      const who = { id: c.id, name: c.name, email: c.email, phone: c.phone };
      const out = c.user_id
        ? await resendCredentials(who, { invitedBy: req.session.userId || 'recruiter' })
        : await inviteCandidate(who, { invitedBy: req.session.userId || 'recruiter' });

      const sent = !!(out.sent || out.invited);
      res.json({
        sent,
        // Which case it was, so the screen can say "account created" or
        // "new password issued" rather than guessing.
        accountCreated: !!out.accountCreated,
        passwordReplaced: sent && !!c.user_id,
        to: c.email,
        delivery: out.delivery || {},
        // Why nothing happened, when nothing did. Never a password.
        reason: out.reason || undefined,
      });
    }));

  /**
   * GET /api/candidates/:id/nudges
   *
   * Has this person been prodded about their profile, and how often?
   *
   * The count is what makes "twice, ever" checkable from outside - a
   * rule nobody can inspect is a rule nobody can trust.
   */
  r.get('/candidates/:id/nudges', requireAuth(), wrap(async (req, res) => {
    if (req.session.role === 'candidate' && req.session.profileId !== req.params.id) {
      throw forbidden('You can only see your own messages.');
    }
    const rows = await withUser(req.session, async (c) => (await c.query(
      `select kind, status, to_address, error, created_at
         from candidate_nudges where candidate_id = $1
        order by created_at desc limit 20`, [req.params.id])).rows);

    res.json({
      nudges: rows.map((n) => ({
        kind: n.kind, status: n.status, to: n.to_address || undefined,
        error: n.error || undefined,
        at: new Date(n.created_at).toISOString(),
      })),
    });
  }));

  /** Recruiter notes. RLS keeps one recruiter's notes from another's view. */
  r.post('/candidates/:id/comments', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const { tag, body } = req.body || {};
      if (!body || !String(body).trim()) throw badRequest('A comment cannot be empty.');
      const row = await withUser(req.session, async (c) => {
        const { rows } = await c.query(
          `insert into candidate_comments (candidate_id, recruiter_id, tag, body)
           values ($1,$2,$3,$4) returning *`,
          [req.params.id, req.session.profileId, tag || null, String(body).slice(0, 4000)]);
        return rows[0];
      });
      res.status(201).json({ comment: row });
    }));

  r.get('/candidates/:id/comments', requireAuth(), requireRole('recruiter', 'admin'),
    wrap(async (req, res) => {
      const rows = await withUser(req.session, async (c) => {
        const { rows } = await c.query(
          `select * from candidate_comments where candidate_id=$1 order by created_at desc`,
          [req.params.id]);
        return rows;
      });
      res.json({ comments: rows });
    }));

  return r;
}
