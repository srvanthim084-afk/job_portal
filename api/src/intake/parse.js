/**
 * Reading a Naukri application email.
 *
 * Two jobs, and the first one matters more than the second:
 *
 *   1. DECIDE whether this message is a candidate application at all.
 *      A recruiter's inbox holds invoices, calendar invites, newsletters
 *      and colleagues asking about lunch. Importing any of those as a
 *      candidate is worse than importing nothing, because somebody then
 *      has to find and delete a person who does not exist.
 *
 *   2. EXTRACT what is actually there. Never infer. A field that is not
 *      in the email stays empty and the candidate fills it in on the
 *      portal - a guessed notice period is worse than a blank one,
 *      because a recruiter will act on it.
 *
 * Naukri's templates change, so the rules are data (`rules` on the
 * mailbox row) with sensible defaults here, and the label matching is
 * deliberately loose: "Candidate Name", "Name of Candidate", "Applicant
 * Name" and "Name" all mean the same thing.
 */

export const DEFAULT_RULES = {
  // Any ONE of these is enough to look closer.
  senderDomains: ['naukri.com', 'infoedge.com', 'resdex.com'],
  subjectPatterns: [
    'naukri', 'application received', 'candidate applied', 'job application',
    'new application', 'applied for', 'resume for', 'response for',
  ],
  bodyKeywords: [
    'naukri', 'candidate name', 'applied role', 'applied for', 'job applied',
    'candidate profile', 'resume attached', 'applicant',
  ],
  // A message must have at least this much to be treated as an
  // application: a name plus a way to contact them.
  requireContact: true,
};

const lc = (v) => String(v || '').toLowerCase();

/**
 * Is this an application email?
 *
 * @returns {{isApplication:boolean, confidence:number, why:string}}
 */
export function classify(message, rules = DEFAULT_RULES) {
  const r = { ...DEFAULT_RULES, ...(rules || {}) };
  const from = lc(message.from);
  const subject = lc(message.subject);
  const body = lc(message.text || message.raw || '');
  const reasons = [];
  let score = 0;

  if ((r.senderDomains || []).some((d) => from.includes(lc(d)))) {
    score += 3; reasons.push('sender is a job board');
  }
  if ((r.subjectPatterns || []).some((p) => subject.includes(lc(p)))) {
    score += 2; reasons.push('subject looks like an application');
  }
  const hits = (r.bodyKeywords || []).filter((k) => body.includes(lc(k)));
  if (hits.length) { score += Math.min(2, hits.length); reasons.push(`body mentions ${hits.slice(0, 3).join(', ')}`); }

  // A labelled candidate block is the strongest single signal: nothing
  // else in a mailbox is laid out like this.
  if (/(candidate|applicant)\s*(name|email|mobile|phone)\s*[:\-]/i.test(body)) {
    score += 3; reasons.push('has a labelled candidate block');
  }

  // Things that are definitely NOT applications, however they score.
  if (/\b(unsubscribe|newsletter|invoice|receipt|payment due|webinar|out of office)\b/.test(subject)) {
    return { isApplication: false, confidence: 0, why: 'looks like a bulk or administrative email' };
  }
  if (/\b(no-?reply@|mailer-daemon|postmaster)\b/.test(from) && score < 4) {
    return { isApplication: false, confidence: 0, why: 'automated sender with no application content' };
  }

  return {
    isApplication: score >= 4,
    confidence: Math.min(1, score / 8),
    why: reasons.join('; ') || 'nothing in it looks like an application',
  };
}

/* ------------------------------------------------------------------ *
 * extraction
 * ------------------------------------------------------------------ */

/** Labelled values: "Candidate Name: Rahul Kumar", across line breaks. */
function labelled(text, labels) {
  for (const label of labels) {
    const re = new RegExp(
      `(?:^|\\n)\\s*${label}\\s*[:\\-–]\\s*(.+?)\\s*(?:\\n|$)`, 'i');
    const m = re.exec(text);
    if (m && m[1]) {
      const v = m[1].trim();
      // "Candidate Name:" followed by nothing useful.
      if (v && !/^[-–—.]+$/.test(v) && !/^n\/?a$/i.test(v)) return v;
    }
  }
  return '';
}

const EMAIL_RE = /[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/i;
// Indian mobiles, with or without +91, spaces, dashes or a leading 0.
const PHONE_RE = /(?:\+?91[\s-]?)?(?:0)?([6-9]\d{4}[\s-]?\d{5})\b/;

const cleanName = (v) => String(v || '')
  .replace(/\b(mr|mrs|ms|dr)\.?\s+/i, '')
  .replace(/\s*\(.*?\)\s*/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 120);

const cleanPhone = (v) => {
  const m = PHONE_RE.exec(String(v || ''));
  if (!m) return '';
  return '+91 ' + m[1].replace(/[\s-]/g, '');
};

/**
 * Pull the candidate out of the message.
 *
 * @returns {object} only the fields that were actually present
 */
export function extractCandidate(message) {
  const text = String(message.text || message.raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ');

  const out = {};

  const name = labelled(text, [
    'candidate name', 'applicant name', 'name of (?:the )?candidate',
    'candidate', 'applicant', 'name',
  ]);
  if (name) out.name = cleanName(name);

  const email = labelled(text, ['candidate email', 'email(?: id| address)?', 'e-?mail'])
    || (EMAIL_RE.exec(text) || [])[0] || '';
  const cleanEmail = (EMAIL_RE.exec(email) || [])[0] || '';
  // The board's own address is not the candidate's.
  if (cleanEmail && !/naukri|infoedge|resdex|no-?reply/i.test(cleanEmail)) {
    out.email = cleanEmail.toLowerCase();
  }

  const phone = labelled(text, ['mobile(?: number| no\\.?)?', 'phone(?: number| no\\.?)?', 'contact(?: number| no\\.?)?'])
    || (PHONE_RE.exec(text) || [])[0] || '';
  const p = cleanPhone(phone);
  if (p) out.phone = p;

  const role = labelled(text, [
    'applied (?:role|for|position|job)', 'role applied(?: for)?', 'job title',
    'position', 'requirement', 'role', 'designation applied',
  ]);
  if (role) out.appliedRole = role.replace(/\s*[-–]\s*(job|requirement)\s*id.*$/i, '').trim().slice(0, 160);

  const reqId = labelled(text, ['requirement id', 'req id', 'job id', 'job code', 'requirement code']);
  if (reqId) out.requirementId = reqId.slice(0, 64);

  const client = labelled(text, ['client', 'client name', 'company(?: name)?', 'hiring company']);
  if (client && !/naukri/i.test(client)) out.client = client.slice(0, 160);

  // The rest: taken when present, never inferred.
  const take = (key, labels, clean) => {
    const v = labelled(text, labels);
    if (v) out[key] = clean ? clean(v) : v.slice(0, 200);
  };

  take('currentCompany', ['current company', 'present company', 'employer', 'current employer']);
  take('title', ['current designation', 'designation', 'current role', 'present designation']);
  take('location', ['current location', 'location', 'city', 'based (?:at|in)']);
  take('preferredLocation', ['preferred location', 'preferred city', 'desired location']);
  take('education', ['education', 'qualification', 'highest qualification', 'degree']);
  take('noticePeriod', ['notice period', 'notice']);
  take('currentCtc', ['current ctc', 'current salary', 'present ctc']);
  take('expectedCtc', ['expected ctc', 'expected salary']);
  take('workMode', ['work mode', 'preferred work mode', 'employment mode']);
  take('gender', ['gender']);
  take('dob', ['date of birth', 'dob']);
  take('summary', ['profile summary', 'summary', 'about the candidate']);
  take('naukriProfile', ['naukri profile', 'profile link', 'profile url']);

  const exp = labelled(text, [
    'total experience', 'experience', 'exp', 'total exp', 'years of experience',
  ]);
  if (exp) {
    out.experience = exp.slice(0, 60);
    const years = /(\d+(?:\.\d+)?)\s*(?:\+)?\s*(?:years?|yrs?)/i.exec(exp)
      || /^(\d+(?:\.\d+)?)$/.exec(exp.trim());
    if (years) out.expYears = Number(years[1]);
  }
  const rel = labelled(text, ['relevant experience', 'relevant exp']);
  if (rel) out.relevantExperience = rel.slice(0, 60);

  const skills = labelled(text, ['key skills', 'skills', 'technical skills', 'skill set']);
  if (skills) {
    out.skills = skills.split(/[,;|/]/).map((s) => s.trim()).filter(Boolean).slice(0, 30);
  }

  const resume = labelled(text, ['resume', 'cv', 'attachment', 'resume file']);
  if (resume && /\.(pdf|docx?|rtf|txt)\b/i.test(resume)) {
    out.resumeName = (/([\w\-. ]+\.(?:pdf|docx?|rtf|txt))/i.exec(resume) || [])[1] || resume;
  }
  if (message.attachmentName) out.resumeName = message.attachmentName;

  return out;
}

/**
 * Everything about one message, in one call.
 *
 * @returns {{isApplication, confidence, why, candidate, problems:string[]}}
 */
export function parseMessage(message, rules) {
  const verdict = classify(message, rules);
  if (!verdict.isApplication) {
    return { ...verdict, candidate: {}, problems: [] };
  }

  const candidate = extractCandidate(message);
  const problems = [];

  if (!candidate.name) problems.push('no candidate name');
  if (!candidate.email && !candidate.phone) {
    problems.push('no email and no mobile number');
  } else if (!candidate.email) {
    // Worth saying on its own: without an address there is no portal
    // account and no registration email.
    problems.push('no email address');
  }
  if (!candidate.appliedRole && !candidate.requirementId) {
    problems.push('no applied role');
  }

  return { ...verdict, candidate, problems };
}

/**
 * Match the role in the email to a requirement we actually have.
 *
 * Deliberately conservative: a wrong requirement puts a candidate in
 * front of the wrong client, so anything short of a confident match goes
 * to the recruiter's queue instead.
 *
 * @param jobs  [{id, title, reference?, location, status, companyName}]
 * @returns {{job:object|null, confidence:number, why:string}}
 */
export function matchRequirement(
  { appliedRole, requirementId, client }, jobs, { preferRecruiterId } = {}
) {
  const open = (jobs || []).filter((j) => j.status === 'open' && !j.paused && !j.archived);
  if (!open.length) return { job: null, confidence: 0, why: 'no open requirements' };

  /*
   * When several open requirements share a title - which happens
   * constantly, because "Java Developer" is posted for three clients at
   * once - the application arrived in a PARTICULAR recruiter's inbox.
   * That recruiter's own requirement is the right answer far more often
   * than a coin toss, and a coin toss puts a candidate in front of the
   * wrong client.
   */
  const preferMine = (list) => {
    if (!preferRecruiterId || list.length < 2) return list;
    const mine = list.filter((j) => j.recruiterId === preferRecruiterId);
    return mine.length ? mine : list;
  };
  const newest = (list) => list.slice().sort((a, b) =>
    String(b.publishedAt || b.createdAt || '').localeCompare(String(a.publishedAt || a.createdAt || '')));

  // 1. An explicit id wins outright.
  if (requirementId) {
    const byId = open.find((j) =>
      lc(j.id) === lc(requirementId) || lc(j.reference || '') === lc(requirementId));
    if (byId) return { job: byId, confidence: 1, why: `requirement id ${requirementId}` };
  }

  if (!appliedRole) return { job: null, confidence: 0, why: 'the email names no role' };

  const want = lc(appliedRole).replace(/[^a-z0-9+#. ]/g, ' ').replace(/\s+/g, ' ').trim();
  const words = want.split(' ').filter((w) => w.length > 2);

  // 2. Exact title.
  const exact = open.filter((j) => lc(j.title) === want);
  if (exact.length === 1) return { job: exact[0], confidence: 1, why: 'exact title match' };
  if (exact.length > 1) {
    const byClient = client && exact.find((j) => lc(j.companyName || '').includes(lc(client)));
    if (byClient) return { job: byClient, confidence: 0.9, why: 'title and client match' };

    const mine = preferMine(exact);
    if (mine.length === 1) {
      return { job: mine[0], confidence: 0.85, why: "title match on this recruiter's own requirement" };
    }
    if (mine.length > 1 && preferRecruiterId) {
      // Still several of theirs: the one they posted most recently is
      // the one they are hiring for now.
      const latest = newest(mine)[0];
      return {
        job: latest,
        confidence: 0.7,
        why: `${mine.length} of this recruiter's requirements share that title - took the most recent`,
      };
    }
    return { job: null, confidence: 0.5, why: `${exact.length} requirements share that exact title` };
  }

  // 3. Every word of the role appears in the title.
  const scored = open.map((j) => {
    const title = lc(j.title);
    const hit = words.filter((w) => title.includes(w)).length;
    return { job: j, score: words.length ? hit / words.length : 0 };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const runnerUp = scored[1];
  if (best && best.score >= 0.8 && (!runnerUp || best.score - runnerUp.score >= 0.2)) {
    return { job: best.job, confidence: best.score, why: `title matches "${best.job.title}"` };
  }
  if (best && best.score >= 0.8) {
    return {
      job: null,
      confidence: best.score,
      why: `"${appliedRole}" matches more than one requirement equally well`,
    };
  }
  return { job: null, confidence: best ? best.score : 0, why: `no requirement matches "${appliedRole}"` };
}
