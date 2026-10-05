/**
 * The AI Career Assistant's tools - READ-ONLY, and every one of them runs
 * inside withUser(<the candidate's session>), so row level security
 * decides what the candidate may see. They return what the candidate's
 * own screens already show them and never more: no email, no phone, no
 * recruiter notes, no internal stage names (the candidate wording of a
 * stage, 0051), and no other candidate's anything.
 *
 * The same functions feed the rules engine (no AI key), so "Basic mode"
 * answers come from exactly the data the model would have been given.
 */
import { toCandidate, toJob } from '../shapes.js';
import { matchCandidate } from './match.js';

const clip = (s, n) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** The candidate never reads the word "Client" (0051). */
const candidateWords = (s) => String(s || '').replace(/\bclient\b/gi, 'Company').replace(/\bClients\b/g, 'Companies');

/* ------------------------------------------------------------------ *
 * definitions sent to the model (strict, no extra properties)
 * ------------------------------------------------------------------ */

export const TOOL_DEFS = [
  {
    name: 'get_my_profile',
    description: 'The signed-in candidate\'s own profile: title, location, preferred locations and role, experience, skills, education, expected CTC (in lakhs per annum), notice period, whether a resume is on file, and which profile fields are still missing.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'search_open_jobs',
    description: 'Search the open jobs on TeamLink that the candidate can see. All filters are optional. Returns at most `limit` jobs (default 5, never more than 10), newest first.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to look for in the job title, description or skills.' },
        location: { type: 'string', description: 'A city or district name.' },
        skills: { type: 'array', items: { type: 'string' }, description: 'Skills the job should ask for.' },
        limit: { type: 'integer', description: 'How many jobs to return, 1 to 10.' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_job',
    description: 'One open job as the candidate sees it: title, company (when the job page shows it), location, work mode, experience, pay, skills, education and description.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { job_id: { type: 'string', description: 'The job id, e.g. from search_open_jobs.' } },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'match_me_to_job',
    description: 'The candidate\'s AI Match for one open job: score = the job\'s required skills the candidate has / the job\'s required skills x 100 (null when the job lists no skills, so say there is no match percentage), the matched and missing skills, and - as words only, never part of the score - how experience, location and education fit. This is the only source of match percentages.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: { job_id: { type: 'string' } },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_my_applications',
    description: 'The candidate\'s own applications: job, current stage (as shown to the candidate) and when it was last updated.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_my_interviews',
    description: 'The candidate\'s own interviews, upcoming and past, including TeamLink AI interviews and their status.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'get_saved_jobs',
    description: 'The jobs the candidate has saved.',
    strict: true,
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
];

const TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.name));

/* ------------------------------------------------------------------ *
 * the reads
 * ------------------------------------------------------------------ */

async function me(c) {
  const row = (await c.query(`select * from candidates where id = app_candidate_id()`)).rows[0];
  if (!row) throw new Error('your profile could not be found');
  /* resume text is evidence of a skill for the AI Match, exactly as on the
     card (portal/core.js screeningInputs); it is never returned to the model */
  return { ...toCandidate(row), resumeText: row.resume_text || '' };
}

export function missingFields(p) {
  const out = [];
  if (!p.title) out.push('current job title');
  if (!(p.skills || []).length && !(p.technicalSkills || []).length) out.push('skills');
  if (!p.education) out.push('education');
  if (p.expYears == null && !p.exp) out.push('years of experience');
  if (!p.location) out.push('current location');
  if (!p.preferredLocation) out.push('preferred job location');
  if (p.expectedCtc == null) out.push('expected salary');
  if (!p.resumeFile) out.push('resume');
  if (!p.summary) out.push('profile summary');
  return out;
}

async function getMyProfile(c) {
  const p = await me(c);
  return {
    first_name: String(p.name || '').split(' ')[0],
    title: p.title || '',
    location: p.location || '',
    preferred_location: p.preferredLocation || '',
    preferred_role: p.preferredRole || '',
    experience_years: p.expYears ?? null,
    experience: p.exp || '',
    skills: [...new Set([...(p.skills || []), ...(p.technicalSkills || [])])],
    education: p.education || '',
    certifications: p.certifications || [],
    languages: p.languages || [],
    expected_ctc_lpa: p.expectedCtc ?? null,
    notice_period: p.noticePeriod || '',
    preferred_work_modes: p.preferredWorkModes || [],
    summary: clip(p.summary, 600),
    resume_on_file: !!p.resumeFile,
    missing_fields: missingFields(p),
  };
}

function jobCard(r) {
  const j = toJob(r);
  return {
    job_id: j.id,
    title: j.title,
    company: r.company_name || '',
    location: j.location || '',
    work_mode: j.mode || '',
    experience: j.exp || '',
    pay: j.pay || '',
    type: j.type || '',
    skills: (j.skills || []).slice(0, 10),
    posted: j.posted || '',
  };
}

const OPEN = `select j.*, co.name as company_name from jobs_open j left join companies co on co.id = j.company_id`;

async function searchOpenJobs(c, input = {}) {
  const lim = Math.max(1, Math.min(10, Number.isInteger(input.limit) ? input.limit : 5));
  const where = ['j.id not in (select job_id from hidden_jobs where candidate_id = app_candidate_id())'];
  const vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replace(/\$\?/g, `$${vals.length}`)); };
  const q = clip(input.query, 120);
  if (q) {
    add(`(j.title ilike $? or coalesce(j.description,'') ilike $? or array_to_string(j.skills,' ') ilike $?
          or coalesce(co.name,'') ilike $?)`, `%${q}%`);
  }
  const loc = clip(input.location, 80);
  if (loc) add(`coalesce(j.location,'') ilike $?`, `%${loc}%`);
  const skills = (Array.isArray(input.skills) ? input.skills : []).map((s) => clip(s, 60).toLowerCase()).filter(Boolean).slice(0, 10);
  if (skills.length) add(`exists (select 1 from unnest(j.skills) s where lower(s) = any($?))`, skills);
  vals.push(lim);
  const rows = (await c.query(`${OPEN} where ${where.join(' and ')}
    order by j.published_at desc nulls last, j.created_at desc limit $${vals.length}`, vals)).rows;
  return { count: rows.length, jobs: rows.map(jobCard) };
}

async function openJob(c, id) {
  const r = (await c.query(`${OPEN} where j.id = $1`, [String(id || '').slice(0, 80)])).rows[0];
  if (!r) throw new Error('that job is not open, or does not exist');
  return r;
}

async function getJob(c, input) {
  const r = await openJob(c, input.job_id);
  const j = toJob(r);
  return {
    ...jobCard(r),
    education: j.education || '',
    salary_min_lpa: j.salaryMin ?? null,
    salary_max_lpa: j.salaryMax ?? null,
    posting_kind: j.postingKind || 'job',
    description: clip(j.desc, 2000),
    requirements: (j.requirements || []).slice(0, 12).map((x) => clip(x, 200)),
    responsibilities: (j.responsibilities || []).slice(0, 12).map((x) => clip(x, 200)),
    ...(j.walkinDate ? { walkin: { date: j.walkinDate, time: j.walkinTime || '', venue: j.walkinVenue || '' } } : {}),
  };
}

/* The candidate's AI Match (ai-match.js, skills vs the JD only) - the same
   number as the job card and "Why this match?". Experience, location and
   education are reported as words beside it and do not move it. */
export function matchSummary(job, cand) {
  const m = matchCandidate(job, cand);
  const b = m.breakdown;
  const ai = m.aiMatch;
  return {
    score: ai.score,
    score_basis: ai.score == null ? 'the job lists no skills, so there is no AI Match' : 'JD skills matched / JD skills required',
    matched_skills: ai.matched,
    missing_skills: ai.missing,
    experience_fit: b.experience ? b.experience.fit || '' : '',
    location_fit: b.location ? b.location.reason || '' : '',
    education_fit: b.education ? b.education.reason || '' : '',
  };
}

async function matchMeToJob(c, input) {
  const r = await openJob(c, input.job_id);
  const cand = await me(c);
  return { job_id: r.id, title: r.title, location: r.location || '', ...matchSummary(toJob(r), cand) };
}

async function getMyApplications(c) {
  const rows = (await c.query(
    `select a.job_id, a.stage, a.applied_at, a.updated_at,
            stage_label(a.stage, 'candidate') as stage_label,
            j.title, j.location, co.name as company_name
       from applications a
       left join jobs j on j.id = a.job_id
       left join companies co on co.id = j.company_id
      where a.candidate_id = app_candidate_id()
      order by a.updated_at desc limit 50`)).rows;
  return {
    count: rows.length,
    applications: rows.map((r) => ({
      job_id: r.job_id,
      title: r.title || 'A job that is no longer listed',
      company: r.company_name || '',
      location: r.location || '',
      stage: candidateWords(r.stage_label || r.stage),
      applied_on: r.applied_at ? new Date(r.applied_at).toISOString().slice(0, 10) : '',
      last_update: r.updated_at ? new Date(r.updated_at).toISOString().slice(0, 10) : '',
    })),
  };
}

async function getMyInterviews(c) {
  const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
  const ivs = (await c.query(
    `select i.id, i.job_id, i.type, i.scheduled_date, i.scheduled_time, i.mode, i.status, j.title
       from interviews i left join jobs j on j.id = i.job_id
      where i.candidate_id = app_candidate_id()
      order by i.scheduled_date desc nulls last limit 30`)).rows;
  const ai = (await c.query(
    `select a.id, a.job_id, a.status, a.completed_at, a.started_at, j.title
       from ai_interviews a left join jobs j on j.id = a.job_id
      where a.candidate_id = app_candidate_id()
      order by a.created_at desc limit 20`)).rows;
  const shape = (i) => ({
    interview_id: i.id,
    job_id: i.job_id,
    job_title: i.title || '',
    type: candidateWords(i.type || 'Interview'),
    date: i.scheduled_date || '',
    time: i.scheduled_time || '',
    mode: i.mode || '',
    status: i.status,
  });
  return {
    upcoming: ivs.filter((i) => i.status === 'Scheduled' && (!i.scheduled_date || i.scheduled_date >= today)).map(shape).reverse(),
    past: ivs.filter((i) => !(i.status === 'Scheduled' && (!i.scheduled_date || i.scheduled_date >= today))).map(shape),
    ai_interviews: ai.map((a) => ({
      job_id: a.job_id,
      job_title: a.title || '',
      status: a.status,
      completed_on: a.completed_at && a.status === 'completed' ? new Date(a.completed_at).toISOString().slice(0, 10) : '',
    })),
  };
}

async function getSavedJobs(c) {
  const rows = (await c.query(
    `select j.*, co.name as company_name from saved_jobs s
       join jobs_open j on j.id = s.job_id
       left join companies co on co.id = j.company_id
      where s.candidate_id = app_candidate_id()
      order by s.created_at desc nulls last limit 20`)).rows;
  return { count: rows.length, jobs: rows.map(jobCard) };
}

const RUN = {
  get_my_profile: getMyProfile,
  search_open_jobs: searchOpenJobs,
  get_job: getJob,
  match_me_to_job: matchMeToJob,
  get_my_applications: getMyApplications,
  get_my_interviews: getMyInterviews,
  get_saved_jobs: getSavedJobs,
};

/**
 * Validate what the model sent, beyond what `strict` guarantees, and run
 * it. Throws on anything invalid - the caller turns that into an
 * is_error tool_result rather than dropping it.
 */
export async function runTool(c, name, input) {
  if (!TOOL_NAMES.has(name)) throw new Error(`unknown tool ${name}`);
  const i = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const allowed = new Set(Object.keys(TOOL_DEFS.find((t) => t.name === name).input_schema.properties));
  for (const k of Object.keys(i)) if (!allowed.has(k)) throw new Error(`unexpected field ${k}`);
  if ((name === 'get_job' || name === 'match_me_to_job') && (typeof i.job_id !== 'string' || !i.job_id.trim())) {
    throw new Error('job_id is required');
  }
  if (i.query != null && typeof i.query !== 'string') throw new Error('query must be text');
  if (i.location != null && typeof i.location !== 'string') throw new Error('location must be text');
  if (i.skills != null && !(Array.isArray(i.skills) && i.skills.every((s) => typeof s === 'string'))) {
    throw new Error('skills must be a list of text');
  }
  if (i.limit != null && !Number.isInteger(i.limit)) throw new Error('limit must be a whole number');
  return RUN[name](c, i);
}

/* exported for the rules engine */
export const reads = { me, getMyProfile, searchOpenJobs, getMyApplications, getMyInterviews, OPEN, jobCard };
export { candidateWords };
