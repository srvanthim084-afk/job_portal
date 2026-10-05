/**
 * Resume score + improvement tips, on the server (0094).
 *
 * Out of 100, from the saved profile AND the resume text, in eight
 * weighted sections:
 *
 *   contact        10   name, phone, email, location
 *   summary        10   present, 2-4 lines, specific
 *   experience     25   roles, companies, dates, measurable results
 *                       (a fresher's internships and projects count here)
 *   skills         15   enough of them, specific rather than generic
 *   education      10   qualification, institution, year
 *   projects       10   projects and certifications
 *   formatting     10   1-2 pages, no wall-of-text paragraphs, consistent
 *                       dates, no long unexplained gaps
 *   keywords       10   action verbs, and the words recruiters search for
 *                       the candidate's preferred role (from open jobs)
 *
 * Labels: Needs Work < 50, Good 50-74, Strong 75-89, Excellent 90+.
 *
 * Tips are specific - they name the skills, the gap, the count - and
 * each carries section, priority, issue, fix, the points it adds and the
 * profile field that fixes it. At most five are shown.
 *
 * An unreadable resume is NOT scored as 0: status 'unreadable' and the
 * message "We could not read your resume. Try a PDF or DOCX".
 *
 * Pure: scoreProfile() takes data and returns a result. Reading the
 * database and storing the row is computeAndStore() below.
 *
 * The score does not feed eligibility or matching - nothing outside the
 * score screens reads it.
 */
import { createHash } from 'node:crypto';
import { withUser } from '../db.js';

export const WEIGHTS = {
  contact: 10, summary: 10, experience: 25, skills: 15,
  education: 10, projects: 10, formatting: 10, keywords: 10,
};
export const SECTION_LABELS = {
  contact: 'Contact details', summary: 'Professional summary', experience: 'Work experience',
  skills: 'Skills', education: 'Education', projects: 'Projects & certifications',
  formatting: 'Formatting & readability', keywords: 'Keywords',
};
export const UNREADABLE_MESSAGE = 'We could not read your resume. Try a PDF or DOCX';

export function labelFor(total) {
  if (total >= 90) return 'Excellent';
  if (total >= 75) return 'Strong';
  if (total >= 50) return 'Good';
  return 'Needs Work';
}
export const priorityFor = (gain) => (gain >= 5 ? 'High' : gain >= 3 ? 'Medium' : 'Low');
const PRI = { High: 0, Medium: 1, Low: 2 };

const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (v == null ? '' : String(v)).trim();
const words = (s) => str(s).split(/\s+/).filter(Boolean);
const uniqLower = (arr) => {
  const seen = new Map();
  arr.forEach((s) => { const t = str(s); if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); });
  return [...seen.values()];
};

const GENERIC_SKILLS = new Set(['communication', 'communication skills', 'teamwork', 'team work', 'hard working',
  'hardworking', 'leadership', 'ms office', 'microsoft office', 'computer', 'computer basics', 'basic computer',
  'internet', 'problem solving', 'time management', 'quick learner', 'punctual', 'honest', 'english',
  'positive attitude', 'self motivated', 'adaptability', 'multitasking']);

const ACTION_VERBS = ['managed', 'led', 'developed', 'handled', 'achieved', 'improved', 'created', 'designed',
  'implemented', 'organised', 'organized', 'coordinated', 'trained', 'sold', 'delivered', 'resolved',
  'supported', 'built', 'increased', 'reduced', 'prepared', 'maintained', 'processed', 'analysed', 'analyzed',
  'served', 'operated', 'launched', 'negotiated', 'supervised', 'planned', 'completed', 'generated', 'won',
  'automated', 'tested', 'deployed', 'collected', 'verified', 'assisted'];

const VAGUE = [/hard[- ]?working/i, /challenging (position|role|career|environment)/i, /reputed (organi[sz]ation|company)/i,
  /seeking an? (opportunity|position)/i, /to work in an? (dynamic|reputed|growing)/i, /best of my (ability|knowledge)/i];

/* "handled 40 calls/day", "increased sales by 20%", "₹2 lakh", "team of 6" */
const IMPACT = /(\d+(\.\d+)?\s?%|₹\s?\d|rs\.?\s?\d|\b\d+(\.\d+)?\s?(lakh|lakhs|crore|crores|k)\b|\b\d+\+?\s?(calls|customers|clients|patients|orders|leads|deliveries|students|accounts|projects|people|members|employees|stores|branches|tickets|cases|users|vehicles|shipments|units|sales|days|hours)\b|\bteam of \d+|\bby \d+)/gi;

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';
const DATE_FORMATS = [
  ['month-year', new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(19|20)\\d\\d\\b`, 'i')],
  ['mm/yyyy', /\b(0?[1-9]|1[0-2])[/-](19|20)\d\d\b/],
  ['dd/mm/yyyy', /\b\d{1,2}[/.-]\d{1,2}[/.-](19|20)\d\d\b/],
  ['yyyy-mm', /\b(19|20)\d\d-(0[1-9]|1[0-2])\b/],
];

function parseYm(v) {
  const s = str(v);
  let m = /^(\d{4})-(\d{2})/.exec(s);
  if (m) return Number(m[1]) * 12 + Number(m[2]) - 1;
  m = new RegExp(`(${MONTHS})[a-z]*\\.?\\s+(\\d{4})`, 'i').exec(s);
  if (m) return Number(m[2]) * 12 + MONTHS.split('|').indexOf(m[1].toLowerCase().slice(0, 3));
  m = /(\d{4})/.exec(s);
  return m ? Number(m[1]) * 12 : null;
}

/** Gaps of more than six months between consecutive jobs. */
export function employmentGaps(rows, now = new Date()) {
  const spans = list(rows).map((r) => {
    const s = parseYm(r.start_date || r.startDate);
    const cur = r.currently_working || r.currentlyWorking;
    const e = cur ? now.getUTCFullYear() * 12 + now.getUTCMonth() : parseYm(r.end_date || r.endDate);
    return s != null && e != null && e >= s ? { s, e } : null;
  }).filter(Boolean).sort((a, b) => a.s - b.s);
  const gaps = [];
  let end = null;
  for (const sp of spans) {
    if (end != null && sp.s - end > 6) {
      gaps.push({ months: sp.s - end, from: Math.floor(end / 12), to: Math.floor(sp.s / 12) });
    }
    end = end == null ? sp.e : Math.max(end, sp.e);
  }
  return gaps;
}

/**
 * The skills recruiters ask for, for this candidate's preferred role,
 * out of the open jobs: the skills of jobs whose title shares a word with
 * the role, most frequent first; the board's top skills when none do.
 */
export function demandFor(role, jobs) {
  const roleWords = str(role).toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 2);
  const count = (js) => {
    const m = new Map();
    js.forEach((j) => list(j.skills).forEach((s) => {
      const t = str(s); if (!t) return;
      const k = t.toLowerCase();
      const cur = m.get(k) || { name: t, n: 0 }; cur.n += 1; m.set(k, cur);
    }));
    return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((x) => x.name);
  };
  const forRole = roleWords.length
    ? list(jobs).filter((j) => roleWords.some((w) => str(j.title).toLowerCase().includes(w)))
    : [];
  return { forRole: forRole.length > 0, skills: count(forRole.length ? forRole : list(jobs)).slice(0, 15) };
}

/**
 * @param d.cand  the candidates row (snake_case, as stored)
 * @param d.edu   candidate_education rows
 * @param d.exp   candidate_experience rows
 * @param d.jobs  open jobs [{title, skills}]
 * @param d.now   Date
 */
export function scoreProfile(d) {
  const c = d.cand || {};
  const now = d.now || new Date();
  const text = str(c.resume_text);
  const hasResume = !!str(c.resume_file);

  if (hasResume && (str(c.resume_parse_error) || text.length < 40)) {
    return { status: 'unreadable', total: null, label: null, message: UNREADABLE_MESSAGE, sections: {}, tips: [] };
  }

  const lower = text.toLowerCase();
  const sections = {};
  const tips = [];
  const tip = (section, gain, issue, fix, field) => {
    if (gain > 0) tips.push({ section, priority: priorityFor(gain), issue, fix, gain: Math.round(gain), field });
  };
  const put = (key, score, notes) => {
    sections[key] = { score: Math.max(0, Math.min(WEIGHTS[key], Math.round(score))), max: WEIGHTS[key],
      label: SECTION_LABELS[key], notes: notes || [] };
  };

  const role = str(c.preferred_role) || str(c.title);
  const skills = uniqLower([...list(c.skills), ...list(c.technical_skills)]);
  const expRows = list(d.exp);
  const eduRows = list(d.edu);
  const internships = list(c.internships).filter((x) => x && (str(x.role) || str(x.org)));
  const projects = list(c.projects).filter((p) => p && str(typeof p === 'string' ? p : p.name));
  const certs = list(c.certifications).filter((x) => str(x));

  /* ---- contact (10) ---- */
  {
    const phone = str(c.phone) || (/(\+?91[\s-]?)?[6-9]\d{9}\b/.test(text) ? 'resume' : '');
    const email = str(c.email) || (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text) ? 'resume' : '');
    let s = 0;
    if (str(c.name)) s += 2;
    if (phone) s += 3; else tip('contact', 3, 'Your mobile number is missing.', 'Add your mobile number so recruiters can call you.', 'basic');
    if (email) s += 3; else tip('contact', 3, 'Your email address is missing.', 'Add an email address recruiters can write to.', 'basic');
    if (str(c.location)) s += 2; else tip('contact', 2, 'Your current location is missing.', 'Add the city you live in - most recruiter searches filter on it.', 'basic');
    put('contact', s);
  }

  /* ---- summary (10) ---- */
  {
    const w = words(c.summary).length;
    const exampleRole = role || 'your target role';
    let s;
    if (!w) {
      s = 0;
      tip('summary', 10, 'Your summary is missing.',
        `Add a 2-line summary for ${exampleRole}: what you do, for how long, and one result you are proud of.`, 'summary');
    } else if (w < 12) {
      s = 4;
      tip('summary', 6, `Your summary is very short (${w} words).`,
        `Write 2-4 lines for ${exampleRole}: your experience, your main skills and one achievement.`, 'summary');
    } else if (w > 150) {
      s = 6;
      tip('summary', 4, `Your summary is long (${w} words).`,
        'Cut it down to 2-4 lines - recruiters read the first few lines only.', 'summary');
    } else {
      s = w > 90 ? 8 : 10;
      if (w > 90) tip('summary', 2, `Your summary runs to ${w} words.`, 'Trim it to 2-4 lines so the key points stand out.', 'summary');
    }
    if (w && VAGUE.some((rx) => rx.test(c.summary))) {
      const before = s; s = Math.max(0, s - 3);
      tip('summary', before - s, 'Your summary uses general phrases like "hard working" or "challenging position".',
        `Replace them with specifics: years of experience, tools you use and what you achieved as ${exampleRole}.`, 'summary');
    }
    put('summary', s);
  }

  /* ---- experience (25) ---- */
  const fresher = (Number(c.exp_years) || 0) === 0 && !expRows.length && !str(c.current_company);
  {
    const responsibilities = expRows.map((r) => str(r.responsibilities)).join('\n');
    const internText = internships.map((x) => `${str(x.desc)} ${str(x.role)}`).join('\n');
    const impactHits = new Set(((`${responsibilities}\n${internText}\n${text}`).match(IMPACT) || [])
      .map((m) => m.toLowerCase().replace(/\s+/g, ' ')));
    const impact = impactHits.size;
    const impactScore = impact >= 3 ? 10 : impact === 2 ? 7 : impact === 1 ? 4 : 0;
    let s = 0;
    if (fresher) {
      const anyIntern = internships.length > 0;
      const described = internships.some((x) => str(x.desc).length >= 30) || projects.some((p) => str(p.desc).length >= 30);
      if (anyIntern) s += 10;
      else tip('experience', 8, 'No internship or training is listed.',
        'Add an internship, apprenticeship or training - even a short one shows recruiters you have started working.', 'internships');
      if (described) s += 5;
      else tip('experience', 5, 'Your internships and projects have no description.',
        'Add 2-3 lines on what you did in each one.', anyIntern ? 'internships' : 'projects');
      if (projects.length) s += 3;
      s += Math.min(7, impactScore);
      if (!impactScore) tip('experience', 5, 'No measurable results are mentioned.',
        'Add numbers to what you did, e.g. "surveyed 120 customers" or "built 3 projects".', anyIntern ? 'internships' : 'projects');
    } else {
      const roles = expRows.filter((r) => str(r.job_title)).length || (str(c.title) && str(c.current_company) ? 1 : 0);
      const companies = expRows.filter((r) => str(r.company)).length || (str(c.current_company) ? 1 : 0);
      const dated = expRows.filter((r) => str(r.start_date)).length
        || (new RegExp(`((${MONTHS})[a-z]*\\.?\\s+)?(19|20)\\d\\d\\s*(-|–|to)\\s*((${MONTHS})[a-z]*\\.?\\s+)?((19|20)\\d\\d|present|now|till date|current)`, 'i').test(text) ? 1 : 0);
      if (roles) s += 6; else tip('experience', 6, 'Your job titles are missing.', 'Add each job with its title - recruiters search by designation.', 'employment');
      if (companies) s += 4; else tip('experience', 4, 'The companies you worked for are missing.', 'Add the company name for each job.', 'employment');
      if (dated) s += 5; else tip('experience', 5, 'Your jobs have no dates.', 'Add the month and year you started and left each job.', 'employment');
      s += impactScore;
      if (impactScore < 10) {
        tip('experience', 10 - impactScore,
          impact ? `Only ${impact} measurable result${impact === 1 ? ' is' : 's are'} mentioned.` : 'No measurable results are mentioned in your work experience.',
          `Add ${impact ? 3 - Math.min(impact, 2) : '2-3'} measurable results to your last job (e.g. "handled 40 calls/day", "cut delivery time by 20%").`,
          'employment');
      }
    }
    put('experience', s, fresher ? ['Counted as a fresher: internships and projects count here.'] : []);
  }

  /* ---- skills (15) ---- */
  const demand = demandFor(role, d.jobs || []);
  {
    const n = skills.length;
    let s = n >= 8 ? 12 : n >= 5 ? 10 : n >= 3 ? 7 : n >= 1 ? 4 : 0;
    const have = new Set(skills.map((x) => x.toLowerCase()));
    const missing = demand.skills.filter((x) => !have.has(x.toLowerCase())).slice(0, 3);
    if (n < 8) {
      /* the gain is what reaching eight skills would add */
      tip('skills', 12 - s,
        n ? `You list ${n} skill${n === 1 ? '' : 's'}.` : 'You have not listed any skills.',
        missing.length
          ? `Add these skills that are common for ${role || 'jobs on TeamLink'}: ${missing.join(', ')}.`
          : `Add ${8 - n} more specific skills - tools, software and machines you can use.`,
        'skills');
    }
    if (n) {
      const specific = skills.filter((x) => !GENERIC_SKILLS.has(x.toLowerCase())).length;
      if (specific / n >= 0.6) s += 3;
      else {
        const generic = skills.filter((x) => GENERIC_SKILLS.has(x.toLowerCase())).slice(0, 2);
        tip('skills', 3, `Most of your skills are general (${generic.join(', ')}).`,
          'List specific tools and abilities instead, e.g. "Tally ERP", "Excel pivot tables", "forklift operation".', 'skills');
      }
    }
    put('skills', s);
  }

  /* ---- education (10) ---- */
  {
    const qual = eduRows.find((e) => str(e.qualification)) || (str(c.education) ? { qualification: c.education } : null);
    const inst = eduRows.some((e) => str(e.institution)) || /\b(university|college|institute|school|iti|polytechnic)\b/i.test(text);
    const year = eduRows.some((e) => e.passing_year) || (str(c.education) && /(19|20)\d\d/.test(c.education));
    let s = 0;
    if (qual) s += 6; else tip('education', 6, 'Your education is missing.', 'Add your highest qualification - recruiters filter on it in almost every search.', 'education');
    if (inst) s += 2; else if (qual) tip('education', 2, 'The college or institute is missing.', 'Add where you studied.', 'education');
    if (year) s += 2; else if (qual) tip('education', 2, 'The year of passing is missing.', 'Add the year you passed out.', 'education');
    put('education', s);
  }

  /* ---- projects & certifications (10) ---- */
  {
    let s = 0;
    if (projects.length) {
      s += 3;
      if (projects.some((p) => str(p.desc).length >= 15)) s += 2;
      else tip('projects', 2, 'Your projects have no description.', 'Add one or two lines on what each project did and the tools used.', 'projects');
    } else {
      tip('projects', 5, 'No projects are listed.', `Add a project you worked on${role ? ` related to ${role}` : ''} - at college, at work or on your own.`, 'projects');
    }
    if (certs.length >= 2) s += 5;
    else if (certs.length === 1) { s += 4; tip('projects', 1, 'You list one certification.', 'Add any other course or certificate you have completed.', 'certifications'); }
    else tip('projects', 5, 'No certifications are listed.', `Add a certificate or short course${skills[0] ? ` in ${skills[0]}` : ''} - it helps you stand out from similar profiles.`, 'certifications');
    put('projects', s);
  }

  /* ---- formatting (10) ---- */
  {
    let s = 0;
    const gaps = employmentGaps(expRows, now);
    if (!hasResume) {
      tip('formatting', 10, 'No resume is uploaded.', 'Upload your resume as a PDF or DOCX so recruiters can read it.', 'resume');
    } else {
      const wc = words(text).length;
      if (wc >= 200 && wc <= 1200) s += 3;
      else if ((wc >= 100 && wc < 200) || (wc > 1200 && wc <= 2000)) {
        s += 1;
        tip('formatting', 2, wc < 200 ? `Your resume is short (${wc} words).` : `Your resume is long (${wc} words - more than two pages).`,
          wc < 200 ? 'Add detail to your jobs and skills so it fills about one page.' : 'Keep it to 1-2 pages: cut old or repeated details.', 'resume');
      } else {
        tip('formatting', 3, wc < 100 ? 'Very little text could be read from your resume.' : `Your resume is very long (${wc} words).`,
          wc < 100 ? 'Upload a text-based PDF or DOCX rather than a scan or photo.' : 'Keep it to 1-2 pages.', 'resume');
      }
      const longParas = text.split(/\n/).filter((l) => l.trim().length > 450).length;
      if (longParas === 0) s += 3;
      else if (longParas === 1) { s += 2; tip('formatting', 1, 'One paragraph is very long.', 'Break it into short bullet points.', 'resume'); }
      else tip('formatting', 3, `${longParas} paragraphs are very long.`, 'Use short bullet points instead of long paragraphs.', 'resume');
      const formats = DATE_FORMATS.filter(([, rx]) => rx.test(text)).length;
      if (formats <= 1) s += 2;
      else tip('formatting', 2, 'Dates are written in different styles.', 'Write every date the same way, e.g. "Jan 2022 - Mar 2024".', 'resume');
    }
    if (!gaps.length) { if (hasResume) s += 2; }
    else {
      const g = gaps.sort((a, b) => b.months - a.months)[0];
      tip('formatting', 2, `Employment gap of ${g.months} months (${g.from}-${String(g.to).slice(2)}) found.`,
        'Add a short note about it, or any freelance work or course you did in that time.', 'employment');
    }
    put('formatting', s);
  }

  /* ---- keywords (10) ---- */
  {
    const hay = `${lower}\n${str(c.summary).toLowerCase()}\n${expRows.map((r) => str(r.responsibilities)).join(' ').toLowerCase()}\n${internships.map((x) => str(x.desc)).join(' ').toLowerCase()}`;
    const verbs = ACTION_VERBS.filter((v) => new RegExp(`\\b${v}\\b`).test(hay));
    let s = verbs.length >= 5 ? 5 : verbs.length >= 3 ? 3 : verbs.length >= 1 ? 2 : 0;
    if (verbs.length < 5) {
      tip('keywords', 5 - s, verbs.length ? `Only ${verbs.length} action word${verbs.length === 1 ? '' : 's'} are used.` : 'Your experience does not use action words.',
        'Start each point with an action word: "handled", "managed", "delivered", "improved", "trained".', fresher ? 'internships' : 'employment');
    }
    const have = `${hay}\n${skills.join(' ').toLowerCase()}\n${str(c.title).toLowerCase()}`;
    if (!role) {
      s += 2;
      tip('keywords', 3, 'Your preferred role is not set.', 'Set the role you want, so your score can check the words recruiters search for it.', 'career');
    } else if (demand.skills.length) {
      const found = demand.skills.filter((k) => have.includes(k.toLowerCase()));
      const add = found.length >= 3 ? 5 : found.length === 2 ? 4 : found.length === 1 ? 2 : 0;
      s += add;
      if (add < 5) {
        const miss = demand.skills.filter((k) => !have.includes(k.toLowerCase())).slice(0, 3);
        tip('keywords', 5 - add, `Your profile uses ${found.length} of the words recruiters search for ${role}.`,
          `Use these words in your skills and summary where they are true for you: ${miss.join(', ')}.`, 'skills');
      }
    } else {
      const roleWords = role.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
      if (roleWords.length && roleWords.every((w) => have.includes(w))) s += 5;
      else {
        s += 2;
        tip('keywords', 3, `Your profile does not mention "${role}".`, `Mention ${role} in your summary and headline.`, 'summary');
      }
    }
    put('keywords', s);
  }

  const total = Object.values(sections).reduce((a, x) => a + x.score, 0);
  tips.sort((a, b) => PRI[a.priority] - PRI[b.priority] || b.gain - a.gain);
  /* One tip per field+issue; keep the order. */
  const seen = new Set();
  const uniqueTips = tips.filter((t) => { const k = `${t.section}|${t.issue}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((t, i) => ({ id: `r${i + 1}`, source: 'rules', ...t }));
  return { status: 'scored', total, label: labelFor(total), sections, tips: uniqueTips, fresher };
}

/* ------------------------------------------------------------------ *
 * reading and storing
 * ------------------------------------------------------------------ */

const ENGINE = { userId: '', role: 'admin', profileId: null };

export function fingerprintOf(d) {
  const c = d.cand || {};
  const pick = ['name', 'email', 'phone', 'location', 'title', 'summary', 'education', 'exp', 'exp_years',
    'current_company', 'previous_companies', 'preferred_role', 'skills', 'technical_skills', 'certifications',
    'languages', 'projects', 'internships', 'achievements', 'resume_file', 'resume_storage_path',
    'resume_parse_error', 'resume_text'];
  const src = JSON.stringify({
    c: pick.map((k) => (c[k] === undefined ? null : c[k])),
    e: list(d.edu), x: list(d.exp),
    j: (d.jobs || []).map((j) => `${j.title}|${list(j.skills).join(',')}`).sort(),
  });
  return createHash('md5').update(src).digest('hex');
}

/** Everything the score is computed from, for one candidate (engine rights). */
export async function loadInputs(candidateId) {
  return withUser(ENGINE, async (c) => {
    const cand = (await c.query(`select * from candidates where id = $1`, [candidateId])).rows[0];
    if (!cand) return null;
    const edu = (await c.query(
      `select qualification, specialization, institution, passing_year from candidate_education
        where candidate_id = $1 order by sort_order, id`, [candidateId])).rows;
    const exp = (await c.query(
      `select company, job_title, start_date, end_date, currently_working, responsibilities
         from candidate_experience where candidate_id = $1 order by sort_order, id`, [candidateId])).rows;
    const jobs = (await c.query(
      `select title, skills from jobs where status = 'open' and source_type = 'TEAMLINK' and not coalesce(paused, false)
          and not coalesce(archived, false) order by published_at desc nulls last limit 400`)).rows;
    return { cand, edu, exp, jobs };
  });
}

export const resumeIdOf = (cand) => (cand && cand.resume_file
  ? `${cand.resume_storage_path || cand.resume_file}@${cand.resume_uploaded_at ? new Date(cand.resume_uploaded_at).toISOString() : ''}`
  : null);

/**
 * Score one candidate and store a row - unless nothing changed since the
 * last row (same fingerprint), in which case the last row stands.
 *
 * @param opts.aiTips  [{...}] already validated AI tips to store with it
 * @param opts.force   store even when unchanged (a Re-score with AI tips)
 * @returns { row, created }
 */
export async function computeAndStore(candidateId, opts = {}) {
  const d = await loadInputs(candidateId);
  if (!d) return null;
  const fp = fingerprintOf(d);
  const last = await withUser(ENGINE, async (c) => (await c.query(
    `select * from candidate_resume_scores where candidate_id = $1 order by scored_at desc, id desc limit 1`,
    [candidateId])).rows[0] || null);
  const aiTips = opts.aiTips || null;
  if (last && last.fingerprint === fp && !opts.force && !aiTips) {
    await withUser(ENGINE, (c) => c.query(`select resume_score_queue_drop($1)`, [candidateId])).catch(() => {});
    return { row: last, created: false, inputs: d };
  }
  const r = scoreProfile({ ...d, now: new Date() });
  const id = await withUser(ENGINE, async (c) => (await c.query(
    `select resume_score_record($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as id`,
    [candidateId, resumeIdOf(d.cand), r.status, r.total, r.label, JSON.stringify(r.sections),
     JSON.stringify(r.tips), JSON.stringify(aiTips || []), aiTips && aiTips.length ? 'ai' : 'rules', fp])).rows[0].id);
  const row = await withUser(ENGINE, async (c) => (await c.query(
    `select * from candidate_resume_scores where id = $1`, [id])).rows[0]);
  return { row, created: true, inputs: d };
}

/** The queue: candidates whose profile or resume changed. */
export async function runResumeScoreSweep({ limit = 100 } = {}) {
  const ids = await withUser(ENGINE, async (c) => (await c.query(
    `select candidate_id from resume_score_queue_take($1)`, [limit])).rows.map((r) => r.candidate_id));
  let scored = 0;
  for (const id of ids) {
    try {
      const out = await computeAndStore(id);
      if (out && out.created) scored += 1;
      if (!out) await withUser(ENGINE, (c) => c.query(`select resume_score_queue_drop($1)`, [id]));
    } catch (err) {
      console.error('[resume-score] could not score', id, err.message);
      await withUser(ENGINE, (c) => c.query(`select resume_score_queue_drop($1)`, [id])).catch(() => {});
    }
  }
  return { taken: ids.length, scored };
}

export function startResumeScoreSweep() {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runResumeScoreSweep();
      if (r.scored) console.log(`[resume-score] scored ${r.scored} profile(s)`);
    } catch (err) {
      console.error('[resume-score] the sweep failed:', err.message);
    } finally { running = false; }
  };
  const first = setTimeout(run, Number(process.env.RESUME_SCORE_FIRST_MS || 45_000));
  const timer = setInterval(run, Number(process.env.RESUME_SCORE_SWEEP_MS || 5 * 60 * 1000));
  first.unref?.(); timer.unref?.();
  return () => { clearTimeout(first); clearInterval(timer); };
}

/** The API shape of a stored row. */
export function toScore(row, { prev = null } = {}) {
  if (!row) return null;
  const tips = list(row.tips);
  const ai = list(row.ai_tips);
  return {
    id: String(row.id),
    status: row.status,
    total: row.total_score,
    label: row.label,
    message: row.status === 'unreadable' ? UNREADABLE_MESSAGE : null,
    sections: Object.keys(WEIGHTS).map((k) => {
      const s = (row.section_scores || {})[k];
      return s ? { key: k, label: SECTION_LABELS[k], score: s.score, max: s.max } : null;
    }).filter(Boolean),
    tips: tips.slice(0, 5),
    moreTips: Math.max(0, tips.length - 5),
    aiTips: ai.slice(0, 3),
    engine: row.engine,
    scoredAt: row.scored_at ? new Date(row.scored_at).toISOString() : null,
    previous: prev,
  };
}
