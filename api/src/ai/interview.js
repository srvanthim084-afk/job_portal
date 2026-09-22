/**
 * The AI interviewer: what to ask, what to ask next, and what it was worth.
 *
 * WHAT WAS THERE BEFORE
 * ---------------------
 * The prototype generated questions in the browser from a fixed pool of
 * templates parameterised by the candidate's skills (prototype.html:22126).
 * Two consequences, both of which the specification rules out:
 *
 *   - the questions never looked at the JOB DESCRIPTION. Two different
 *     roles asking for the same skill got the same interview.
 *   - there were no follow-ups. The interview could not react to anything
 *     the candidate actually said.
 *
 * Scoring was keyword coverage, also in the browser, which meant the score
 * was computed by the party being scored.
 *
 * WHAT HAPPENS NOW
 * ----------------
 * Planning and evaluation happen here, on the server. Two paths:
 *
 *   with AI_API_KEY     a model reads the job description and the
 *                       candidate's profile and writes the questions, asks
 *                       follow-ups from the actual answer, and grades the
 *                       transcript.
 *   without             questions are MINED FROM THE JOB DESCRIPTION -
 *                       its requirements, responsibilities and skills -
 *                       so they still differ per role, follow-ups come
 *                       from what the answer left out, and scoring is
 *                       coverage-based.
 *
 * Which one produced a result is recorded and reported. "AI evaluated your
 * interview" when no model was involved is exactly the claim this codebase
 * refuses to make.
 *
 * NOTHING here invents a score. An unanswered question scores zero, and an
 * interview with no answers cannot be scored at all.
 */
import { config } from '../config.js';

const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-5';
const API_URL = process.env.AI_API_URL || 'https://api.anthropic.com/v1/messages';
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 25_000);

export const aiConfigured = () => !!config.aiApiKey;

export function interviewEngine() {
  return aiConfigured()
    ? { engine: 'model', model: MODEL }
    : { engine: 'rules', reason: 'AI_API_KEY is not set — questions come from the job description and scoring is coverage-based' };
}

/* ------------------------------------------------------------------ *
 * talking to the model
 * ------------------------------------------------------------------ */

async function ask(system, user, maxTokens = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.aiApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL, max_tokens: maxTokens, system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`the model returned ${res.status}`);
    const body = await res.json();
    return body?.content?.[0]?.text ?? '';
  } finally {
    clearTimeout(timer);
  }
}

function jsonFrom(raw) {
  const tryIt = (s) => { try { return JSON.parse(String(s).trim()); } catch { return null; } };
  return tryIt(raw)
    || tryIt((/```(?:json)?\s*([\s\S]*?)```/.exec(raw) || [])[1])
    || tryIt(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1))
    || tryIt(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
}

/* ------------------------------------------------------------------ *
 * reading the job description
 * ------------------------------------------------------------------ */

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * The phrases a job description is actually about.
 *
 * Requirements and responsibilities are already one-per-line in the schema,
 * so they are the best source. The free-text description is mined only when
 * those are empty.
 */
export function jobTopics(job) {
  const out = [];
  const push = (text, kind) => {
    const t = clean(text);
    if (t.length >= 12 && t.length <= 220) out.push({ text: t, kind });
  };

  for (const r of job.requirements || []) push(r, 'requirement');
  for (const r of job.responsibilities || []) push(r, 'responsibility');

  if (out.length < 4 && job.desc) {
    for (const line of String(job.desc).split(/[\n•·]|(?<=\.)\s+/)) push(line, 'description');
  }
  return out.slice(0, 12);
}

/** "5+ years of React and Node.js experience" -> "React and Node.js experience" */
const trimLead = (s) => clean(s)
  .replace(/^(?:strong|proven|solid|excellent|good|hands[- ]on|demonstrated)\s+/i, '')
  .replace(/^(?:experience\s+(?:with|in|of)\s+)/i, '')
  .replace(/^\d+\+?\s*(?:years?|yrs?)\s*(?:of\s*)?/i, '')
  // "4+ years with React" leaves "with React", which reads badly after
  // "The role asks for ...". Drop the dangling preposition too.
  .replace(/^(?:with|in|of|on|using)\s+/i, '')
  .replace(/[.;]+$/, '');

/* ------------------------------------------------------------------ *
 * planning the interview
 * ------------------------------------------------------------------ */

/**
 * @returns [{ seq, category, question, expects[], source }]
 *          `source` says where the question came from, so a recruiter
 *          reading the transcript can see it was tied to the role.
 */
/**
 * The shape of every interview.
 *
 * Fixed on purpose. "About eight questions, mostly technical" cannot be
 * compared between two candidates, and cannot be scored per section: JD
 * relevance and resume relevance are different signals - a candidate can
 * know the stack the job needs and be vague about their own project - and
 * separating them needs a known number of questions from each source.
 *
 * `category` stays within the four values the database and the prototype
 * already use; `section` records which part of the blueprint produced the
 * question.
 */
export const BLUEPRINT = [
  { section: 'intro',      category: 'intro',      count: 2 },
  { section: 'jd',         category: 'technical',  count: 5 },
  { section: 'resume',     category: 'resume',     count: 5 },
  { section: 'behavioral', category: 'behavioral', count: 3 },
];

export const BLUEPRINT_TOTAL = BLUEPRINT.reduce((t, b) => t + b.count, 0);   // 15

export async function planInterview({ job, candidate, count = BLUEPRINT_TOTAL }) {
  if (aiConfigured()) {
    try {
      const planned = await planWithModel({ job, candidate, count });
      if (planned && planned.length >= 4) return planned;
    } catch (err) {
      // Fall through. An interview that cannot start is worse than one
      // planned from the job description.
      console.error('[ai] interview planning failed, using the job description:', err.message);
    }
  }
  return planFromJob({ job, candidate, count });
}

/**
 * The candidate's resume, as the interviewer needs to see it.
 *
 * This is the PARSED resume - the same fields api/src/resume/fields.js
 * extracts from the uploaded file and stores on the candidate - so the
 * interviewer is working from the document the candidate actually
 * submitted, not from a job title.
 */
export function resumeBrief(candidate) {
  if (!candidate) return '(no profile on file)';
  const c = candidate;
  const lines = [];
  const add = (label, v) => { if (v && String(v).trim()) lines.push(`- ${label}: ${clean(v)}`); };

  add('Current', [c.title, c.currentCompany && `at ${c.currentCompany}`].filter(Boolean).join(' '));
  add('Experience', c.expYears ? `${c.expYears} years` : c.exp);
  add('Skills', (c.technicalSkills?.length ? c.technicalSkills : c.skills || []).join(', '));
  add('Previous employers', (c.previousCompanies || []).join(', '));
  add('Education', c.education);
  add('Certifications', (c.certifications || []).join(', '));
  add('Summary', String(c.summary || '').slice(0, 600));

  const projects = (c.projects || [])
    .map((p) => (typeof p === 'string' ? p : [p?.name, p?.title, p?.description].filter(Boolean).join(' — ')))
    .filter(Boolean).slice(0, 5);
  if (projects.length) lines.push(`- Projects: ${projects.join(' | ')}`);

  return lines.length ? lines.join('\n') : '(the profile has no detail on file)';
}

async function planWithModel({ job, candidate, count }) {
  const topics = jobTopics(job).map((t) => `- (${t.kind}) ${t.text}`).join('\n');

  const raw = await ask(
    'You are a technical interviewer. You write interview questions for ONE ' +
    'specific role, grounded in that role\'s description. Return ONLY a JSON array.',
    `Write ${count} interview questions for this role and this candidate.\n\n` +
    `ROLE: ${job.title}\n` +
    `LOCATION: ${job.location || 'unspecified'}\n` +
    `REQUIRED SKILLS: ${(job.skills || []).join(', ') || 'unspecified'}\n` +
    `FROM THE JOB DESCRIPTION:\n${topics || '(none given)'}\n\n` +
    `FROM THE CANDIDATE'S RESUME:\n${resumeBrief(candidate)}\n\n` +
    'Rules:\n' +
    '- 1 intro question, 1-2 about their own background, the rest technical ' +
    'and behavioural, IN THAT ORDER.\n' +
    '- Ground every question in BOTH sides: something the job asks for AND ' +
    'something on the resume. Name the project, employer or skill you are ' +
    'asking about so the candidate knows why.\n' +
    '- Where the role requires something the resume does not evidence, ask ' +
    'about that gap directly rather than avoiding it.\n' +
    '- Do not ask about technology the role does not mention.\n' +
    '- Ask one thing at a time. No compound questions.\n' +
    '- `expects` lists the specific points a strong answer would cover.\n\n' +
    'Format: [{"category":"intro|resume|technical|behavioral","question":"...",' +
    '"expects":["...","..."],"source":"the requirement it came from"}]',
    2500);

  const arr = jsonFrom(raw);
  if (!Array.isArray(arr)) return null;

  return arr
    .filter((q) => q && typeof q.question === 'string' && q.question.trim().length > 10)
    .slice(0, count)
    .map((q, i) => ({
      seq: i + 1,
      category: ['intro', 'resume', 'technical', 'behavioral'].includes(q.category)
        ? q.category : 'technical',
      question: clean(q.question).slice(0, 600),
      expects: Array.isArray(q.expects)
        ? q.expects.filter((x) => typeof x === 'string').map((x) => clean(x).toLowerCase()).slice(0, 8)
        : [],
      source: clean(q.source || '').slice(0, 200) || null,
    }));
}

/**
 * No model: build the interview out of the job description itself.
 *
 * This is not a fixed script. Each technical question quotes a specific
 * requirement or responsibility from THIS job, so two roles produce two
 * different interviews - which is the part of the specification that
 * matters most here.
 */
export function planFromJob({ job, candidate, count = BLUEPRINT_TOTAL }) {
  const topics = jobTopics(job);
  const jobSkills = (job.skills || []).slice();
  const candSkills = ((candidate?.technicalSkills?.length
    ? candidate.technicalSkills : candidate?.skills) || []).slice();

  const resumeBlob = [
    candSkills.join(' '), candidate?.summary, candidate?.education,
    (candidate?.previousCompanies || []).join(' '), candidate?.title,
    candidate?.currentCompany,
    (candidate?.projects || []).map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '),
  ].filter(Boolean).join(' ').toLowerCase();

  const evidenced = jobSkills.filter((x) => resumeBlob.includes(String(x).toLowerCase()));
  const gaps = jobSkills.filter((x) => !resumeBlob.includes(String(x).toLowerCase()));

  /* ---- the four sections, each filled from its own source ------------- */

  // 2 · introduction — the candidate in their own words
  const intro = [
    {
      // Names the role on purpose: the candidate should hear which
      // interview this is, and every interview must be about ONE job.
      question: `Thanks for joining the interview for the ${job.title} role. ` +
                'Please introduce yourself and tell me about your professional background.',
      expects: ['experience', 'background', 'role', 'years'],
      source: `introduction: ${job.title}`,
    },
    {
      question: 'Please walk me through your resume — your education, your experience, ' +
                'the projects you have worked on and your key skills.',
      expects: ['education', 'project', 'skill', 'experience'],
      source: 'introduction',
    },
  ];

  // 5 · from the job description — never about technology the role does not mention
  const jd = [];
  for (const t of topics) {
    if (jd.length >= 5) break;
    const subject = trimLead(t.text);
    if (!subject) continue;
    jd.push({
      question: t.kind === 'responsibility'
        ? `One responsibility of this role is: "${subject}". Tell me about a time you did exactly that, and how you approached it.`
        : `The role asks for ${lowerFirst(subject)}. Describe your experience with that, with a concrete example.`,
      expects: keywordsOf(subject),
      source: `${t.kind}: ${t.text}`,
    });
  }
  // A requirement the resume does not evidence is the most useful question
  // a recruiter can have asked, so gaps fill the remaining JD slots first.
  for (const skill of gaps) {
    if (jd.length >= 5) break;
    if (jd.some((q) => q.question.toLowerCase().includes(String(skill).toLowerCase()))) continue;
    jd.push({
      question: `The role asks for ${skill}, which I could not find on your resume. ` +
                'What is your experience with it?',
      expects: [String(skill).toLowerCase(), 'experience', 'used', 'learn'],
      source: `gap: ${skill} required but not evidenced on the resume`,
    });
  }
  for (const skill of jobSkills) {
    if (jd.length >= 5) break;
    if (jd.some((q) => q.question.toLowerCase().includes(String(skill).toLowerCase()))) continue;
    jd.push({
      question: `How would you use ${skill} in this role, and where have you used it before?`,
      expects: [String(skill).toLowerCase(), 'project', 'example'],
      source: `required skill: ${skill}`,
    });
  }

  // 5 · from the resume — about what the candidate actually wrote
  const resume = [];
  const projects = (candidate?.projects || [])
    .map((p) => (typeof p === 'string' ? p : (p?.name || p?.title || '')))
    .map((x) => clean(x)).filter((x) => x.length > 3);

  for (const project of projects) {
    if (resume.length >= 3) break;
    resume.push({
      question: `You mentioned "${project}" on your resume. Can you explain your role in that project?`,
      expects: ['built', 'owned', 'designed', 'responsible'],
      source: `resume: project "${project}"`,
    });
    if (resume.length < 5) {
      resume.push({
        question: `What was the hardest problem you hit while building "${project}", and how did you solve it?`,
        expects: ['problem', 'solved', 'approach', 'fix'],
        source: `resume: project "${project}"`,
      });
    }
  }
  if (candidate?.currentCompany || candidate?.title) {
    if (resume.length < 5) {
      resume.push({
        question: `You are ${candidate.title || 'working'}` +
                  `${candidate.currentCompany ? ` at ${candidate.currentCompany}` : ''}. ` +
                  'What do you own day to day, and what has been your biggest contribution there?',
        expects: ['own', 'built', 'result', 'responsible'],
        source: "resume: current role",
      });
    }
  }
  for (const skill of evidenced.concat(candSkills)) {
    if (resume.length >= 5) break;
    if (resume.some((q) => q.question.toLowerCase().includes(String(skill).toLowerCase()))) continue;
    resume.push({
      question: `Your resume lists ${skill}. Walk me through where you used it and what you built with it.`,
      expects: [String(skill).toLowerCase(), 'used', 'built', 'project'],
      source: `resume: skill ${skill}`,
    });
  }
  if (candidate?.education && resume.length < 5) {
    resume.push({
      question: 'Tell me about your education and how it prepared you for this kind of work.',
      expects: ['degree', 'studied', 'learn', 'applied'],
      source: 'resume: education',
    });
  }

  // 3 · behavioural
  const behavioral = [
    { question: 'Tell me about a difficult problem you faced at work or in a project, and how you solved it.',
      expects: ['problem', 'approach', 'solved', 'result'], source: 'behavioural' },
    { question: 'Tell me about a time you had to work with someone whose approach was different from yours.',
      expects: ['listen', 'perspective', 'agree', 'outcome'], source: 'behavioural' },
    { question: 'Describe a time you had to learn something new quickly. How did you handle it?',
      expects: ['learn', 'quickly', 'applied', 'result'], source: 'behavioural' },
  ];

  /* ---- every section must reach its count ----------------------------- */
  /*
   * A thin resume or a job posted with two lines of description would
   * otherwise produce a 10-question interview, and two candidates for the
   * same role could be asked a different NUMBER of questions - which makes
   * the scores incomparable, which is the whole reason the blueprint
   * exists.
   *
   * So a short section is topped up from a fallback that is still about
   * the right thing, and the source says plainly that the resume or the
   * job description did not carry enough detail. Nothing here invents a
   * project or a skill the candidate never claimed.
   */
  const RESUME_FALLBACK = [
    { question: 'Walk me through the most substantial piece of work on your resume — ' +
                'what was it, and what was your part in it?',
      expects: ['built', 'owned', 'role', 'project'],
      source: 'resume: no project named on the resume' },
    { question: 'Which of the skills on your resume are you strongest in, and where did you use it?',
      expects: ['skill', 'used', 'project', 'built'],
      source: 'resume: skills not itemised on the resume' },
    { question: 'Tell me about your education and how it prepared you for this kind of work.',
      expects: ['degree', 'studied', 'learn', 'applied'],
      source: 'resume: education not detailed on the resume' },
    { question: 'What have you spent most of your time on in your current or most recent role?',
      expects: ['day', 'own', 'responsible', 'work'],
      source: 'resume: no current role on the resume' },
    { question: 'What is something you built or contributed to that you are proud of, and why?',
      expects: ['built', 'proud', 'result', 'impact'],
      source: 'resume: not enough detail on the resume' },
  ];

  const JD_FALLBACK = [
    { question: `What do you understand this ${job.title} role to involve, ` +
                'and which part of it are you strongest at?',
      expects: ['role', 'experience', 'strong'],
      source: 'requirement: the job description is brief' },
    { question: `What experience do you have that is closest to this ${job.title} role?`,
      expects: ['experience', 'similar', 'role'],
      source: 'requirement: the job description is brief' },
    { question: 'Which tools and technologies do you work with day to day?',
      expects: ['tool', 'used', 'work'],
      source: 'required skill: none listed on the job' },
    { question: 'How do you decide an approach when a task can be done more than one way?',
      expects: ['approach', 'trade', 'decide', 'why'],
      source: 'responsibility: the job description is brief' },
    { question: 'What would you want to know about this role before you started?',
      expects: ['question', 'team', 'expect', 'scope'],
      source: 'requirement: the job description is brief' },
  ];

  const BEHAVIORAL_FALLBACK = [
    { question: 'Tell me about a time you made a mistake at work. What did you do about it?',
      expects: ['mistake', 'fixed', 'learn', 'told'], source: 'behavioural' },
    { question: 'Describe a time you had to deliver under a tight deadline.',
      expects: ['deadline', 'priorit', 'delivered', 'result'], source: 'behavioural' },
  ];

  const topUp = (pool, spare, want) => {
    for (const q of spare) {
      if (pool.length >= want) break;
      if (pool.some((x) => x.question === q.question)) continue;
      pool.push(q);
    }
    return pool;
  };
  topUp(jd, JD_FALLBACK, 5);
  topUp(resume, RESUME_FALLBACK, 5);
  topUp(behavioral, BEHAVIORAL_FALLBACK, 3);

  /* ---- assemble, in blueprint order ----------------------------------- */
  const pools = { intro, jd, resume, behavioral };
  const out = [];
  for (const part of BLUEPRINT) {
    const pool = pools[part.section];
    for (let i = 0; i < part.count && i < pool.length; i++) {
      out.push({
        seq: out.length + 1,
        category: part.category,
        section: part.section,
        question: clean(pool[i].question).slice(0, 600),
        expects: (pool[i].expects || []).map((x) => String(x).toLowerCase()),
        source: pool[i].source || null,
      });
      if (out.length >= count) return out;
    }
  }
  return out;
}

const lowerFirst = (s) => {
  if (!s) return s;
  const first = s.split(/\s+/)[0] || '';
  if (/[A-Z]/.test(first.slice(1))) return s;
  return s[0].toLowerCase() + s.slice(1);
};

/** The words a strong answer to this requirement would plausibly contain. */
function keywordsOf(text) {
  const stop = new Set(['with', 'and', 'the', 'for', 'you', 'your', 'have', 'from', 'that',
    'this', 'will', 'able', 'work', 'working', 'experience', 'strong', 'good', 'years',
    'using', 'used', 'must', 'should', 'plus', 'etc', 'other', 'across', 'within']);
  return clean(text).toLowerCase().replace(/[^a-z0-9+#. ]/g, ' ')
    .split(/\s+/).filter((w) => w.length >= 3 && !stop.has(w)).slice(0, 6);
}

/* ------------------------------------------------------------------ *
 * reacting to an answer
 * ------------------------------------------------------------------ */

/**
 * A follow-up, or null when the answer does not warrant one.
 *
 * The rules path is not a pretend follow-up: it looks at what the answer
 * actually left out relative to `expects`, and asks about that. A thorough
 * answer gets no follow-up, which is the correct behaviour.
 */
export async function followUp({ question, answer, job }) {
  const text = clean(answer);
  if (!text) return null;                       // silence is scored, not probed

  // A one-word answer is the case that most needs a follow-up, so it is
  // handled before anything else. The earlier guard treated "Yes." as
  // nothing to dig into and let the thinnest answers through unchallenged.
  if (text.split(/\s+/).length < 8) {
    return 'That was very brief — could you walk me through a specific example, ' +
           'and what you personally did?';
  }

  if (aiConfigured()) {
    try {
      const raw = await ask(
        'You are interviewing a candidate. Decide whether ONE short follow-up ' +
        'question would reveal something the answer left unclear. Return ONLY ' +
        'JSON: {"followUp": "..."} or {"followUp": null}.',
        `ROLE: ${job.title}\nQUESTION: ${question.question}\n` +
        `ANSWER: ${text.slice(0, 3000)}\n\n` +
        'Ask a follow-up only if the answer was vague, skipped the "how", or ' +
        'claimed a result without saying how it was achieved. Otherwise return null.',
        400);
      const out = jsonFrom(raw);
      const f = out && typeof out.followUp === 'string' ? clean(out.followUp) : null;
      return f && f.length > 10 ? f.slice(0, 400) : null;
    } catch (err) {
      console.error('[ai] follow-up failed:', err.message);
      // fall through to the rules
    }
  }

  const said = text.toLowerCase();
  const missed = (question.expects || []).filter((k) => k && !said.includes(k));
  const words = text.split(/\s+/).length;

  if (words < 25) {
    return 'That was quite brief — can you give me a specific example, and what you personally did?';
  }
  if (missed.length) {
    return `You did not mention ${missed.slice(0, 2).join(' or ')}. How did that come into it?`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * grading
 * ------------------------------------------------------------------ */

/**
 * Scores the actual answers.
 *
 * @param answers [{ seq, category, question, expects, answered, transcript }]
 * @returns { perQuestion[], technical, behavioral, communication, overall,
 *            contentScored, engine, feedback }
 */
export async function evaluate({ job, answers }) {
  const given = (answers || []).filter((a) => a && a.answered && clean(a.transcript));

  // Requirement: silence scores zero, and an interview with nothing said
  // has no score at all rather than a generous one.
  if (!given.length) {
    return {
      perQuestion: (answers || []).map((a) => ({
        seq: a.seq, category: a.category, section: a.section, question: a.question,
        answered: false, score: 0, commScore: 0,
        justification: 'No spoken response — scored 0.',
      })),
      technical: 0, behavioral: 0, communication: 0, overall: 0,
      jdRelevance: 0, resumeRelevance: 0,
      contentScored: false,
      engine: 'none',
      feedback: 'No questions were answered, so there is nothing to assess.',
    };
  }

  if (aiConfigured()) {
    try {
      const graded = await gradeWithModel({ job, answers });
      if (graded) return graded;
    } catch (err) {
      console.error('[ai] grading failed, falling back to coverage:', err.message);
    }
  }
  return gradeByCoverage({ answers });
}

async function gradeWithModel({ job, answers }) {
  const transcript = answers.map((a) =>
    `Q${a.seq} (${a.category}): ${a.question}\n` +
    `A${a.seq}: ${a.answered && clean(a.transcript) ? clean(a.transcript).slice(0, 4000) : '[no response]'}`
  ).join('\n\n');

  const raw = await ask(
    'You grade interview transcripts. Score ONLY what the candidate actually ' +
    'said. An unanswered question scores 0. Never reward fluency over ' +
    'substance. Return ONLY JSON.',
    `ROLE: ${job.title}\nREQUIRED SKILLS: ${(job.skills || []).join(', ')}\n\n` +
    `TRANSCRIPT:\n${transcript}\n\n` +
    'Return: {"perQuestion":[{"seq":1,"score":0-100,"commScore":0-100,' +
    '"justification":"one sentence naming what the answer did or did not cover"}],' +
    '"feedback":"two sentences for the hiring team"}',
    3000);

  const out = jsonFrom(raw);
  if (!out || !Array.isArray(out.perQuestion)) return null;

  const bySeq = new Map(out.perQuestion.map((p) => [Number(p.seq), p]));
  const perQuestion = answers.map((a) => {
    const g = bySeq.get(a.seq);
    const answered = !!(a.answered && clean(a.transcript));
    if (!answered) {
      return { seq: a.seq, category: a.category, section: a.section, question: a.question,
        answered: false, score: 0, commScore: 0,
        justification: 'No spoken response — scored 0.' };
    }
    return {
      seq: a.seq, category: a.category, section: a.section, question: a.question, answered: true,
      score: clamp(g?.score),
      commScore: clamp(g?.commScore),
      justification: clean(g?.justification || '').slice(0, 600)
        || 'Scored from the transcript.',
    };
  });

  return { ...aggregate(perQuestion), perQuestion, contentScored: true, engine: 'model',
    feedback: clean(out.feedback || '').slice(0, 1200) || null };
}

/**
 * No model: score by how much of what the question expected the answer
 * actually covered, plus how much was said. Same rules the prototype used,
 * but on the server where the candidate cannot reach them.
 */
function gradeByCoverage({ answers }) {
  const perQuestion = answers.map((a) => {
    const text = clean(a.transcript).toLowerCase();
    if (!a.answered || !text) {
      return { seq: a.seq, category: a.category, section: a.section, question: a.question,
        answered: false, score: 0, commScore: 0,
        justification: 'No spoken response — scored 0.' };
    }
    const words = text.split(/\s+/).filter(Boolean);
    const expects = (a.expects || []).map((x) => String(x).toLowerCase());
    const hits = expects.filter((k) => k && text.includes(k));
    const onTopic = hits.length > 0 || !expects.length;

    const comm = clampNum(35 + Math.min(1, words.length / 45) * 55 + (/[.,]/.test(text) ? 5 : 0));

    if (!onTopic) {
      return { seq: a.seq, category: a.category, section: a.section, question: a.question,
        answered: true, score: Math.min(24, 8 + words.length), commScore: comm,
        justification: 'Off topic — the answer did not address what was asked.',
        detail: { technicalRelevance: 1, completeness: 1, accuracy: 2,
                  communication: Math.round(comm / 10) } };
    }
    const coverage = expects.length ? hits.length / expects.length : (words.length > 8 ? 0.5 : 0.25);
    const depth = Math.min(1, words.length / 50);
    const score = clampNum(coverage * 62 + depth * 28 + 6, 15, 98);
    const missed = expects.filter((k) => !hits.includes(k));

    return {
      seq: a.seq, category: a.category, section: a.section, question: a.question, answered: true,
      score, commScore: comm,
      // The per-answer breakdown the report shows, out of 10.
      detail: {
        technicalRelevance: Math.round(coverage * 10),
        completeness: Math.round(depth * 10),
        accuracy: Math.round((coverage * 0.7 + depth * 0.3) * 10),
        communication: Math.round(comm / 10),
      },
      justification:
        `Covered ${hits.length}/${expects.length || '?'} expected points` +
        (hits.length ? ` (${hits.slice(0, 4).join(', ')})` : '') +
        (missed.length ? `; missed ${missed.slice(0, 3).join(', ')}` : '') +
        `. ${words.length < 15 ? 'Answer was brief.' : 'Explanation had reasonable depth.'}`,
    };
  });

  return { ...aggregate(perQuestion), perQuestion, contentScored: true, engine: 'rules',
    feedback: null };
}

/**
 * Five scores, because they answer different questions.
 *
 * JD relevance and resume relevance are deliberately separate. A candidate
 * can know the stack the job asks for and be vague about the project on
 * their own resume - or the reverse - and averaging those into one
 * "technical" number throws away the most useful thing the interview
 * found. The blueprint guarantees five questions from each source, so both
 * are computed from a known sample rather than from whatever happened to
 * get asked.
 */
function aggregate(per) {
  const mean = (xs) => (xs.length
    ? Math.round(xs.reduce((t, p) => t + Number(p.score), 0) / xs.length) : 0);
  const bySection = (name) => mean(per.filter((p) => p.section === name));
  const byCategory = (cats) => mean(per.filter((p) => cats.includes(p.category)));
  const sectioned = per.some((p) => p.section);
  const comms = per.filter((p) => p.commScore != null);

  return {
    technical: sectioned
      ? mean(per.filter((p) => p.section === 'jd' || p.section === 'resume'))
      : byCategory(['technical', 'resume']),
    jdRelevance: bySection('jd'),
    resumeRelevance: bySection('resume'),
    behavioral: sectioned ? bySection('behavioral') : byCategory(['behavioral', 'intro']),
    communication: comms.length
      ? Math.round(comms.reduce((t, p) => t + Number(p.commScore), 0) / comms.length) : 0,
    overall: mean(per),
  };
}

const clamp = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
};
const clampNum = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));
