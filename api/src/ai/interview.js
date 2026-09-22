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
export async function planInterview({ job, candidate, count = 8 }) {
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
export function planFromJob({ job, candidate, count = 8 }) {
  const topics = jobTopics(job);
  const skills = (job.skills || []).slice();
  const candSkills = ((candidate?.technicalSkills?.length
    ? candidate.technicalSkills : candidate?.skills) || []).slice();

  // Which of the job's required skills the resume actually evidences, and
  // which it does not. Both are worth asking about, for opposite reasons:
  // one to test a claim, the other to probe a gap.
  const lower = (a) => a.map((x) => String(x).toLowerCase());
  const resumeBlob = [
    candSkills.join(' '), candidate?.summary, candidate?.education,
    (candidate?.previousCompanies || []).join(' '), candidate?.title,
    candidate?.currentCompany,
    (candidate?.projects || []).map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '),
  ].filter(Boolean).join(' ').toLowerCase();

  const evidenced = skills.filter((s) => resumeBlob.includes(String(s).toLowerCase()));
  const gaps = skills.filter((s) => !resumeBlob.includes(String(s).toLowerCase()));

  const qs = [];
  const add = (category, question, expects, source) => {
    if (qs.length >= count) return;
    qs.push({
      seq: qs.length + 1,
      category,
      question: clean(question).slice(0, 600),
      expects: (expects || []).map((x) => String(x).toLowerCase()),
      source: source || null,
    });
  };

  add('intro',
    `Please introduce yourself and tell me why you are a good fit for the ${job.title} role` +
      `${job.location ? ` in ${job.location}` : ''}.`,
    ['experience', 'role', 'fit', 'background'], `the ${job.title} posting`);

  if (candidate?.currentCompany || candidate?.title) {
    add('resume',
      `You are currently ${candidate.title || 'working'}` +
        `${candidate.currentCompany ? ` at ${candidate.currentCompany}` : ''}. ` +
        'Walk me through one project there, what you specifically owned, and how it turned out.',
      ['project', 'owned', 'result', 'built'], "the candidate's own profile");
  }

  // A named project from the resume. Asking about something specific on the
  // document is the difference between an interview and a questionnaire.
  const project = (candidate?.projects || [])
    .map((p) => (typeof p === 'string' ? p : (p?.name || p?.title || '')))
    .map((x) => clean(x)).filter((x) => x.length > 3)[0];
  if (project) {
    add('resume',
      `Your resume lists "${project}". What was your specific part in it, and ` +
      `what would you do differently now?`,
      ['built', 'owned', 'design', 'result', 'differently'],
      `resume: project "${project}"`);
  }

  // Where the resume DOES back a required skill, test the claim against this
  // role rather than asking in the abstract.
  for (const skill of evidenced) {
    if (qs.length >= count - 3) break;
    add('technical',
      `This role needs ${skill}, and your resume shows it` +
        `${candidate?.currentCompany ? ` at ${candidate.currentCompany}` : ''}. ` +
        'Take me through the hardest problem you solved with it.',
      [String(skill).toLowerCase(), 'problem', 'solved', 'approach'],
      `resume \u00d7 required skill: ${skill}`);
  }

  // A requirement the resume does not evidence. Asked plainly, because it
  // is the thing a recruiter most wants to know and the candidate most
  // deserves a chance to answer.
  for (const skill of gaps) {
    if (qs.length >= count - 2) break;
    if (qs.some((q) => q.question.toLowerCase().includes(String(skill).toLowerCase()))) continue;
    add('technical',
      `The role asks for ${skill}, which I could not find on your resume. ` +
      'What is your experience with it?',
      [String(skill).toLowerCase(), 'experience', 'used', 'learn'],
      `gap: ${skill} required but not evidenced on the resume`);
  }

  // One question per requirement, quoting it. This is what makes the
  // interview specific to the role.
  for (const t of topics) {
    if (qs.length >= count - 2) break;
    const subject = trimLead(t.text);
    if (!subject) continue;
    // Quoted rather than folded into the sentence: a responsibility is
    // written as an imperative ("Own the component library"), which reads
    // badly after "This role involves".
    const question = t.kind === 'responsibility'
      ? `One responsibility of this role is: "${subject}". Tell me about a time you did exactly that, and how you approached it.`
      : `The role asks for ${lowerFirst(subject)}. Describe your experience with that, with a concrete example.`;
    add('technical', question, keywordsOf(subject), `${t.kind}: ${t.text}`);
  }

  // Anything still unfilled, from the candidate's own stack.
  for (const s of candSkills) {
    if (qs.length >= count - 2) break;
    if (qs.some((q) => q.question.toLowerCase().includes(String(s).toLowerCase()))) continue;
    add('technical',
      `How have you used ${s} in production? Walk me through a specific problem it solved for you.`,
      [String(s).toLowerCase(), 'production', 'problem', 'example'],
      `resume: skill ${s}`);
  }

  add('behavioral',
    'Tell me about a time you disagreed with a colleague about a technical decision. What did you do?',
    ['listen', 'data', 'disagree', 'resolve', 'outcome'], 'standard behavioural');
  add('behavioral',
    'Describe a deadline you were at risk of missing. How did you handle it?',
    ['priorit', 'communicat', 'plan', 'deliver', 'trade-off'], 'standard behavioural');

  return qs.slice(0, count);
}

/* Lowercasing the first letter reads naturally mid-sentence, except when
   the word is a proper noun or an acronym - "TypeScript" became
   "typeScript". A capital anywhere after the first letter means leave it. */
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
        seq: a.seq, category: a.category, question: a.question,
        answered: false, score: 0, commScore: 0,
        justification: 'No spoken response — scored 0.',
      })),
      technical: 0, behavioral: 0, communication: 0, overall: 0,
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
      return { seq: a.seq, category: a.category, question: a.question, answered: false,
        score: 0, commScore: 0, justification: 'No spoken response — scored 0.' };
    }
    return {
      seq: a.seq, category: a.category, question: a.question, answered: true,
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
      return { seq: a.seq, category: a.category, question: a.question, answered: false,
        score: 0, commScore: 0, justification: 'No spoken response — scored 0.' };
    }
    const words = text.split(/\s+/).filter(Boolean);
    const expects = (a.expects || []).map((x) => String(x).toLowerCase());
    const hits = expects.filter((k) => k && text.includes(k));
    const onTopic = hits.length > 0 || !expects.length;

    const comm = clampNum(35 + Math.min(1, words.length / 45) * 55 + (/[.,]/.test(text) ? 5 : 0));

    if (!onTopic) {
      return { seq: a.seq, category: a.category, question: a.question, answered: true,
        score: Math.min(24, 8 + words.length), commScore: comm,
        justification: 'Off topic — the answer did not address what was asked.' };
    }
    const coverage = expects.length ? hits.length / expects.length : (words.length > 8 ? 0.5 : 0.25);
    const depth = Math.min(1, words.length / 50);
    const score = clampNum(coverage * 62 + depth * 28 + 6, 15, 98);
    const missed = expects.filter((k) => !hits.includes(k));

    return {
      seq: a.seq, category: a.category, question: a.question, answered: true,
      score, commScore: comm,
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

function aggregate(per) {
  const avg = (cats) => {
    const xs = per.filter((p) => cats.includes(p.category));
    return xs.length ? Math.round(xs.reduce((t, p) => t + p.score, 0) / xs.length) : 0;
  };
  const comms = per.filter((p) => p.commScore != null);
  return {
    technical: avg(['technical', 'resume']),
    behavioral: avg(['behavioral', 'intro']),
    communication: comms.length
      ? Math.round(comms.reduce((t, p) => t + Number(p.commScore), 0) / comms.length) : 0,
    overall: per.length
      ? Math.round(per.reduce((t, p) => t + p.score, 0) / per.length) : 0,
  };
}

const clamp = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
};
const clampNum = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Math.round(n)));
