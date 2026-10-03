/**
 * The interview prep kit: likely questions (with "why they ask this"),
 * tips and a bring-list, for ONE interview.
 *
 * Two engines:
 *
 *   RULES  always available. Templates by interview type, filled from the
 *          job's title, skills and experience band.
 *   AI     when AI_API_KEY is set: the official Anthropic SDK, structured
 *          output, low effort, server-side refusal fallback. It is sent the
 *          job title, skills, experience range, interview type and a
 *          description with the company name (and any email, phone or
 *          link) removed - never the client's name, never the candidate's
 *          contact details, never an id. Its answer is validated (count,
 *          length, no company name, no salary promise) and anything wrong,
 *          a refusal, an error or 15 seconds of silence falls back to the
 *          rules. `generatedBy` records which engine produced the kit.
 *
 * THE CLIENT IS NEVER NAMED. Candidates must not learn which company the
 * job is for (0051). The rules engine has no company input at all; the AI
 * engine has the name scrubbed from its input and its output checked for
 * it. Questions say "this role", tips say "the interviewer".
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { mentionsCompany, companyTokens } from '../screening/questions.js';

/* ------------------------------------------------------------------ *
 * the interview, classified
 * ------------------------------------------------------------------ */

export function locationTypeFor(iv = {}) {
  if (iv.locationType || iv.location_type) return iv.locationType || iv.location_type;
  const m = String(iv.mode || '').toLowerCase();
  if (/teamlink ai|ai interview/.test(m) || /ai interview/i.test(String(iv.type || ''))) return 'teamlink_ai';
  if (/person|walk|office|venue/.test(m)) return 'in_person';
  if (/phone|call$/.test(m) && !/video/.test(m)) return 'phone';
  return 'video';
}

export function roundFor(iv = {}) {
  const t = String(iv.type || '').toLowerCase();
  if (/ai interview/.test(t) || locationTypeFor(iv) === 'teamlink_ai') return 'ai';
  if (/hr/.test(t)) return 'hr';
  return 'technical';         // Technical (Human), Client Round, anything else
}

/** fresher / mid / senior from "0-2 yrs", "5+ years", "Fresher". */
export function levelFor(job = {}) {
  const label = String(job.exp || job.exp_label || '').toLowerCase();
  if (/fresher|entry|graduate|0\s*-\s*1\b|^0\b/.test(label)) return 'fresher';
  const nums = (label.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!nums.length) return 'mid';
  const min = Math.min(...nums); const max = Math.max(...nums);
  if (max <= 1) return 'fresher';
  if (min >= 5) return 'senior';
  return 'mid';
}

const skillsOf = (job = {}) => (Array.isArray(job.skills) ? job.skills : [])
  .map((s) => String(s).trim()).filter(Boolean).slice(0, 8);

/* ------------------------------------------------------------------ *
 * RULES
 * ------------------------------------------------------------------ */

function technicalQuestions(job) {
  const level = levelFor(job);
  const skills = skillsOf(job).slice(0, 4);
  const title = job.title || 'this role';
  const q = [];
  q.push({ q: `Tell me about yourself, focusing on what prepares you for the ${title} role.`,
    why: 'An opener: they want a two-minute summary that connects your background to this job.', topic: 'Introduction' });
  for (const s of skills) {
    if (level === 'fresher') {
      q.push({ q: `Explain the basics of ${s}. Where have you used it - in coursework, a project or an internship?`,
        why: `They check that you understand the fundamentals of ${s}, not just the name.`, topic: s });
    } else if (level === 'senior') {
      q.push({ q: `Describe a difficult problem you solved with ${s}. What trade-offs did you make, and what would you change now?`,
        why: `At your level they look for judgement and depth in ${s}, not only hands-on use.`, topic: s });
    } else {
      q.push({ q: `Walk me through recent work where you used ${s}. What exactly did you do yourself?`,
        why: `They want concrete, hands-on experience with ${s} and your own part in it.`, topic: s });
    }
  }
  if (!skills.length) {
    q.push({ q: `What are the most important day-to-day tasks in a ${title} role, and how have you handled them before?`,
      why: 'They check that you understand what the job involves.', topic: 'Role knowledge' });
  }
  q.push({ q: 'Walk me through one project from your resume from start to finish: the goal, your part, and the result.',
    why: 'A project walkthrough shows how you work, how you explain things, and what you actually owned.', topic: 'Project walkthrough' });
  q.push({ q: level === 'fresher'
    ? 'Tell me about a time you had to learn something new quickly. How did you go about it?'
    : 'Tell me about a time something went wrong at work and you had to find the cause. How did you approach it?',
  why: 'A problem-solving question: they listen for a clear, step-by-step way of thinking.', topic: 'Problem solving' });
  q.push({ q: `Why are you interested in this ${title} role?`,
    why: 'They want to hear that you know what the role involves and that it fits your plans.', topic: 'Motivation' });
  q.push({ q: 'Do you have any questions for us?',
    why: 'Asking one or two thoughtful questions about the work or the team shows genuine interest.', topic: 'Your questions' });
  return q.slice(0, 10);
}

function hrQuestions(job) {
  const title = job.title || 'this role';
  const q = [
    { q: 'Please introduce yourself.', why: 'They want a short, clear summary of your experience and what you are looking for.', topic: 'Introduction' },
    { q: 'Why are you looking for a change now?', why: 'They check that your reasons are positive and that this role fits them.', topic: 'Motivation' },
    { q: 'What is your notice period, and when could you join?', why: 'Joining date matters to the hiring plan; be exact, including any buyout option.', topic: 'Notice period' },
    { q: 'What are your current and expected CTC?', why: 'They need to know whether the role fits your expectations. Know your current figure and a realistic range.', topic: 'Compensation' },
    { q: 'What are your main strengths, and one area you are working to improve?', why: 'They look for self-awareness, backed by a real example.', topic: 'Strengths and weaknesses' },
    { q: `Where do you see yourself in three years, and how does this ${title} role fit?`, why: 'They want to know you are likely to stay and grow in the role.', topic: 'Career plans' },
  ];
  if (job.location) {
    q.push({ q: `Are you comfortable working from ${job.location}${job.mode ? ` (${job.mode})` : ''}? If you need to relocate, when could you?`,
      why: 'Location and relocation are practical deal-breakers; answer honestly.', topic: 'Relocation' });
  }
  q.push({ q: 'Do you have any questions for us?', why: 'A good question about the team or the first months in the role leaves a strong last impression.', topic: 'Your questions' });
  return q.slice(0, 10);
}

/* What the AI interview already does - docs/AI-INTERVIEW.md and the
   proctoring in teamlink-interview-integrity.js. Nothing invented. */
function aiQuestions(job) {
  const skills = skillsOf(job);
  const s1 = skills[0] || 'the main skill this role needs';
  const s2 = skills[1] || 'a tool you use often';
  return [
    { q: 'How the TeamLink AI interview works', why: 'It runs in your browser: about 15 spoken questions on your background, this role and your resume, taking around 20 minutes. You cannot go back to a previous question.', topic: 'How it works' },
    { q: 'Practice: introduce yourself and the work you do now, in about one minute.', why: 'The interview opens with you; practise saying it out loud and on time.', topic: 'Practice' },
    { q: `Practice: describe a piece of work where you used ${s1}.`, why: 'Technical questions come from the skills on your profile and in the job.', topic: 'Practice' },
    { q: `Practice: what would you do if ${s2} did not behave the way you expected?`, why: 'Problem-solving questions are scored on clarity as well as content.', topic: 'Practice' },
    { q: 'Rules you must follow', why: 'Keep the interview in a single tab - leaving it ends the session. Keep your camera on and uncovered. Find a quiet room: continuous background noise ends it too.', topic: 'Integrity' },
    { q: 'Answer on your own', why: 'Another person or another voice in the room is flagged: the first time is a warning, the second suspends the interview for a recruiter to review.', topic: 'Integrity' },
  ];
}

const TIPS = {
  in_person: [
    'Reach the venue 15 minutes early.',
    'Save the venue address on your phone so you have it offline.',
    'Wear formal clothes.',
    'Switch your phone to silent before you go in.',
  ],
  video: [
    'Test your camera, microphone and internet 10 minutes before.',
    'Sit in a quiet room with a plain background and good light on your face.',
    'Join 5 minutes early.',
    'Keep your charger plugged in.',
  ],
  phone: [
    'Take the call from a quiet place.',
    'Make sure your phone is fully charged.',
    'Keep your resume in front of you.',
    'Answer in full sentences - the interviewer cannot see you.',
  ],
  teamlink_ai: [
    'Use a laptop or phone with a working camera and microphone.',
    'Keep the interview open in a single tab until you finish.',
    'Find a quiet room where nobody else will speak.',
    'Speak clearly and take a moment before each answer.',
  ],
};
const GENERAL_TIPS = [
  'Read the job description again and prepare two or three examples that match it.',
  'Keep your answers specific: what you did, how, and the result.',
];

const BRING = {
  in_person: [
    ['resume_copies', 'Two printed copies of your resume'],
    ['photo_id', 'A government photo ID'],
    ['passport_photos', 'Two passport-size photographs'],
    ['certificates', 'Your qualification certificates (originals and copies)'],
    ['venue_offline', 'The venue address saved offline'],
    ['formal_dress', 'Formal clothes, ready the night before'],
  ],
  video: [
    ['test_av', 'Camera, microphone and internet tested'],
    ['quiet_room', 'A quiet room with a plain background'],
    ['charger', 'Charger plugged in'],
    ['resume_open', 'Your resume open to refer to'],
    ['photo_id', 'A photo ID nearby, in case you are asked'],
    ['join_early', 'Ready to join 5 minutes early'],
  ],
  phone: [
    ['phone_charged', 'Phone fully charged'],
    ['quiet_place', 'A quiet place to take the call'],
    ['resume_in_front', 'Your resume in front of you'],
    ['notes', 'Pen and paper for notes'],
    ['questions_ready', 'Two questions to ask the interviewer'],
    ['answer_promptly', 'Ready to answer from an unknown number'],
  ],
  teamlink_ai: [
    ['device_ready', 'Laptop or phone with camera and microphone'],
    ['quiet_room', 'A quiet room where nobody else will speak'],
    ['single_tab', 'Only the interview tab open'],
    ['camera_on', 'Camera on and uncovered'],
    ['charger', 'Charger plugged in'],
    ['time_20', 'About 20 uninterrupted minutes'],
  ],
};

/** The rules kit. Pure: same interview and job, same kit. */
export function rulesKit(interview = {}, job = {}) {
  const lt = locationTypeFor(interview);
  const round = roundFor(interview);
  const questions = round === 'ai' ? aiQuestions(job) : round === 'hr' ? hrQuestions(job) : technicalQuestions(job);
  return {
    questions,
    tips: [...(TIPS[lt] || TIPS.video), ...(round === 'ai' ? [] : GENERAL_TIPS)],
    bringList: (BRING[lt] || BRING.video).map(([key, text]) => ({ key, text })),
    generatedBy: 'rules',
  };
}

/* ------------------------------------------------------------------ *
 * AI
 * ------------------------------------------------------------------ */

/** The description, without the company, contact details or links. */
export function scrubDescription(text, companyName) {
  let t = String(text || '').slice(0, 4000);
  t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email removed]')
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, '[link removed]')
    .replace(/(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g, '[phone removed]');
  for (const w of companyTokens(companyName)) {
    const re = new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    t = t.replace(re, 'the company');
  }
  return t;
}

/** Exactly what the model is sent. Exported so a test can inspect it. */
export function aiInput(interview = {}, job = {}, companyName = '') {
  return {
    jobTitle: String(job.title || '').replace(new RegExp(companyTokens(companyName).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '^$', 'gi'), 'the company'),
    skills: skillsOf(job),
    experienceRange: String(job.exp || job.exp_label || ''),
    interviewType: String(interview.type || 'Interview'),
    round: roundFor(interview),
    description: scrubDescription(job.description || job.desc || '', companyName),
  };
}

const SYSTEM = [
  'You write interview preparation material for job candidates in India who applied through a recruitment consultancy.',
  'You are given a job title, skills, an experience range, the interview type and a job description.',
  'Write 6 to 10 likely interview questions for that round, each with a one-line hint explaining why interviewers ask it, and a short topic label.',
  'Also write 3 to 6 short, practical preparation tips.',
  'Rules: never name or guess the hiring company - say "the company", "the hiring team" or "the interviewer". Never mention salary figures or promise any outcome, offer, salary or hike.',
  'Match the experience level: basics and learning for freshers, hands-on depth for mid-level, judgement and trade-offs for senior roles.',
  'For a technical round: hands-on questions per key skill, one project walkthrough, one problem-solving question.',
  'For an HR round: introduction, reason for change, notice period and joining, expected CTC discussion, strengths and weaknesses, relocation.',
  'Plain, friendly English. Keep each question under 220 characters and each hint under 160.',
].join('\n');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['questions', 'tips'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['q', 'why', 'topic'],
        properties: { q: { type: 'string' }, why: { type: 'string' }, topic: { type: 'string' } },
      },
    },
    tips: { type: 'array', items: { type: 'string' } },
  },
};

const PROMISE = /\b(guarantee[ds]?|assured?|promised?|will (?:get|receive) (?:an? )?(?:offer|hike|raise))\b|₹\s?\d|\brs\.?\s?\d|\b\d+\s?(?:lpa|lakhs?|k per month)\b/i;
const CONTACT = /@|https?:\/\/|www\.|\b\d{10}\b/i;

/** Throws on anything a candidate must not be shown. */
export function validateKitContent(kit, companyName = '', { minQuestions = 6, minTips = 1 } = {}) {
  if (!kit || !Array.isArray(kit.questions) || !Array.isArray(kit.tips)) throw new Error('missing questions or tips');
  if (kit.questions.length < minQuestions || kit.questions.length > 10) throw new Error(`has ${kit.questions.length} questions (${minQuestions}-10 allowed)`);
  if (kit.tips.length < minTips || kit.tips.length > 10) throw new Error(`has ${kit.tips.length} tips (${minTips}-10 allowed)`);
  const all = [];
  for (const x of kit.questions) {
    if (!x || typeof x.q !== 'string' || x.q.trim().length < 8 || x.q.length > 300) throw new Error('a question is empty or too long');
    if (typeof x.why !== 'string' || x.why.length > 220) throw new Error('a hint is too long');
    all.push(x.q, x.why, String(x.topic || ''));
  }
  for (const t of kit.tips) {
    if (typeof t !== 'string' || !t.trim() || t.length > 220) throw new Error('a tip is empty or too long');
    all.push(t);
  }
  for (const s of all) {
    if (companyName && mentionsCompany(s, companyName)) throw new Error('names the company');
    if (/\bclient\b/i.test(s)) throw new Error('uses the word "client"');
    if (PROMISE.test(s)) throw new Error('mentions a salary figure or promises an outcome');
    if (CONTACT.test(s)) throw new Error('contains contact details or a link');
  }
  return true;
}

export function aiAvailable() {
  return !!(process.env.AI_API_KEY || config.aiApiKey);
}

/**
 * @returns { questions, tips, generatedBy:'ai' } or throws (the caller
 *          falls back to the rules)
 * @param opts.onRequest  test hook: receives the exact request body
 */
export async function aiKit(interview, job, companyName, opts = {}) {
  const timeout = Number(process.env.AI_PREP_TIMEOUT_MS || 15000);
  const client = new Anthropic({
    apiKey: process.env.AI_API_KEY || config.aiApiKey,
    baseURL: process.env.AI_API_BASE_URL || undefined,
    timeout,
    maxRetries: 0,
  });
  const input = aiInput(interview, job, companyName);
  const request = {
    model: process.env.AI_PREP_MODEL || 'claude-opus-5-5',
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: JSON.stringify(input) }],
  };
  if (opts.onRequest) opts.onRequest(request);

  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), timeout + 500); });
  let res;
  try {
    res = await Promise.race([client.beta.messages.create(request), deadline]);
  } finally { clearTimeout(timer); }

  if (!res || res.stop_reason === 'refusal') throw new Error('the model declined');
  if (res.stop_reason === 'max_tokens') throw new Error('the answer was cut off');
  const block = (res.content || []).find((b) => b.type === 'text');
  if (!block) throw new Error('no text in the answer');
  let parsed;
  try { parsed = JSON.parse(block.text); } catch { throw new Error('the answer was not JSON'); }
  const kit = {
    questions: (parsed.questions || []).map((x) => ({
      q: String(x.q || '').trim(), why: String(x.why || '').trim(), topic: String(x.topic || '').trim().slice(0, 40),
    })),
    tips: (parsed.tips || []).map((t) => String(t).trim()).filter(Boolean),
  };
  validateKitContent(kit, companyName);
  return { ...kit, generatedBy: 'ai' };
}

/**
 * The kit for an interview: AI when configured and it behaves, else the
 * rules. Location tips and the bring-list always come from the rules -
 * they are facts about the format, not something to improvise.
 */
export async function buildKit(interview, job, companyName, opts = {}) {
  const rules = rulesKit(interview, job);
  if (!aiAvailable() || opts.rulesOnly) {
    return { ...rules, engineNote: aiAvailable() ? null : 'AI_API_KEY is not set: rules engine' };
  }
  try {
    const ai = await aiKit(interview, job, companyName, opts);
    const lt = locationTypeFor(interview);
    return {
      questions: ai.questions,
      tips: [...(TIPS[lt] || TIPS.video), ...ai.tips].slice(0, 10),
      bringList: rules.bringList,
      generatedBy: 'ai',
      engineNote: null,
    };
  } catch (err) {
    return { ...rules, engineNote: `AI engine not used (${err.message}): rules engine` };
  }
}
