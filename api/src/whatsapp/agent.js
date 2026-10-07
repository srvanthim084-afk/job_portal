/**
 * The AI WhatsApp Agent's brain - one engine for every channel.
 *
 * The same function answers
 *   - the chat on the "AI WhatsApp Agent" page (a signed-in candidate, or a
 *     visitor), and
 *   - a real WhatsApp message arriving at the webhook (the sender's phone
 *     number identifies the candidate).
 *
 * It answers from REAL data only, through the reads the AI Career Assistant
 * already uses (api/src/ai/career-assistant-tools.js), so row-level security
 * applies exactly as it does everywhere else:
 *
 *   "jobs for React developer" / "jobs in Hyderabad"   open TeamLink jobs
 *   "details 2"                                         that job, and the
 *                                                       candidate's AI Match
 *   "apply 2"                                           the job's apply link
 *                                                       (the existing TeamLink
 *                                                       application form does
 *                                                       the applying - this
 *                                                       never submits one)
 *   "what is my application status"                     the candidate's own
 *   "schedule an interview"                             the candidate's own
 *                                                       interviews and any
 *                                                       AI interview waiting
 *
 * Anything else goes to the Career Assistant: the AI model when AI_API_KEY is
 * set, its labelled rules engine otherwise. A visitor with no TeamLink
 * profile can search the open jobs; everything personal asks them to sign in
 * or register first. Nothing here invents a job, a candidate or a status.
 */
import { withUser } from '../db.js';
import { reads, runTool } from '../ai/career-assistant-tools.js';
import { aiConfigured, askModel, rulesReply } from '../ai/career-assistant.js';

const STOP = new Set(('show me find any are there is a an the please vacancies vacancy openings opening job jobs for in at near '
  + 'around from role roles position positions hiring available i want need looking look search list some all give tell about '
  + 'work works working of to and with can you do u have has what which where ur my').split(' '));

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function parseJobQuestion(text) {
  const raw = clean(text).toLowerCase();
  let location = '';
  const m = /\b(?:in|at|near|around|from)\s+([a-z][a-z .'-]{1,40}?)(?=\s+(?:for|with|jobs?|vacanc|openings?|hiring)\b|[?.!,]|$)/i.exec(raw);
  if (m) location = clean(m[1]).replace(/\s+(jobs?|please)$/, '');
  const rest = raw.replace(m ? m[0] : '', ' ');
  const words = rest.replace(/[^a-z0-9+#. ]/g, ' ').split(' ').filter((w) => w && !STOP.has(w));
  return { query: words.join(' ').trim(), location, words };
}

async function findJobs(session, { query, location, words }) {
  return withUser(session || null, async (c) => {
    let r = await reads.searchOpenJobs(c, { query, location, limit: 5 });
    let note = '';
    if (!r.count && query && words.length > 1) {          // "react developer" -> any of its words
      const hit = new Map();
      for (const w of words.slice(0, 3)) {
        const x = await reads.searchOpenJobs(c, { query: w, location, limit: 10 });
        x.jobs.forEach((j) => hit.set(j.job_id, { j, n: (hit.get(j.job_id)?.n || 0) + 1 }));
      }
      const jobs = [...hit.values()].sort((a, b) => b.n - a.n).slice(0, 5).map((v) => v.j);
      r = { count: jobs.length, jobs };
    }
    if (!r.count && location && (query || true)) {          // nothing in that place: say so, then show the role elsewhere
      const x = await reads.searchOpenJobs(c, { query, location: '', limit: 5 });
      if (x.count) { r = x; note = `elsewhere`; }
    }
    return { ...r, note };
  });
}

const link = (base, id) => `${base}/job/${encodeURIComponent(id)}`;
const jobLine = (j, i, base) => [
  `${i + 1}. *${j.title}*${j.company ? ` - ${j.company}` : ''}`,
  [j.location && `📍 ${j.location}`, j.experience && `💼 ${j.experience}`, j.pay && `💰 ${j.pay}`].filter(Boolean).join('  ·  '),
  `🔗 ${link(base, j.job_id)}`,
].filter(Boolean).join('\n');

const shapeJob = (j, base) => ({
  id: j.job_id, title: j.title, company: j.company, location: j.location, pay: j.pay, experience: j.experience,
  link: link(base, j.job_id),
});

export const HELP = [
  'Hi! 👋 I\'m the TeamLink AI Assistant. I can help you with:',
  '• *Jobs* - e.g. "jobs for React developer" or "any jobs in Hyderabad?"',
  '• *Details* - reply "details 2" for a job from the list',
  '• *Apply* - reply "apply 2" and I\'ll send the apply link',
  '• *Your applications* - "what is my application status?"',
  '• *Interviews* - "schedule an interview"',
].join('\n');

function jobNumber(t, ids) {
  const m = /\b(?:job\s*)?#?(\d{1,2})\b/.exec(t);
  if (m) { const n = Number(m[1]); if (n >= 1 && n <= ids.length) return ids[n - 1]; return null; }
  if (/\b(this|that|it|first|the job)\b/.test(t) && ids.length === 1) return ids[0];
  if (/\b(first)\b/.test(t) && ids.length) return ids[0];
  return null;
}

/**
 * @param {object}  p
 * @param {object|null} p.session   { userId, role:'candidate', profileId } or null for a visitor
 * @param {string}  p.text
 * @param {string}  p.base          public origin used for links
 * @param {string[]} [p.jobIds]     the jobs listed in the previous answer, in order
 * @returns {{reply:string, jobs:object[], usedTools:string[], engine:string, identity:'candidate'|'guest'}}
 */
export async function agentReply({ session, text, base, jobIds = [] }) {
  const t = clean(text).toLowerCase();
  const candidate = !!(session && session.role === 'candidate');
  const identity = candidate ? 'candidate' : 'guest';
  const out = (reply, extra = {}) => ({ reply, jobs: [], usedTools: [], engine: 'rules', identity, ...extra });
  const needSignIn = () => out('To see your own details I need to know who you are. Please sign in to TeamLink'
    + ` (${base}) or register - then message me again. You can still search open jobs without an account.`);

  if (!t) return out(HELP);
  if (/^(hi+|hello|hey|namaste|namaskaram|help|menu|start|hola)\b/.test(t) && t.split(' ').length <= 3) return out(HELP);

  // "details 2" / "2"
  if (/^(?:details?|more|info|tell me about|about)?\s*(?:job\s*)?#?\d{1,2}$/.test(t) || /\bdetails?\b/.test(t)) {
    const id = jobNumber(t, jobIds);
    if (!id) return out(jobIds.length ? `Which job? Reply with a number from 1 to ${jobIds.length}, e.g. "details 1".`
      : 'Ask me for jobs first - e.g. "jobs in Hyderabad" - then reply "details 1".');
    return withUser(session || null, async (c) => {
      const used = ['get_job'];
      let j;
      try { j = await runTool(c, 'get_job', { job_id: id }); } catch { return out('That job is no longer open.'); }
      const lines = [`*${j.title}*${j.company ? ` - ${j.company}` : ''}`,
        [j.location && `📍 ${j.location}`, j.experience && `💼 ${j.experience}`, j.pay && `💰 ${j.pay}`, j.work_mode && `🏢 ${j.work_mode}`]
          .filter(Boolean).join('  ·  ')];
      if (j.skills && j.skills.length) lines.push(`🧩 Skills: ${j.skills.slice(0, 8).join(', ')}`);
      if (j.requirements && j.requirements.length) lines.push('', '*Requirements*', ...j.requirements.slice(0, 4).map((x) => `• ${x}`));
      if (j.walkin) lines.push('', `🚶 Walk-in: ${[j.walkin.date, j.walkin.time].filter(Boolean).join(' ')}${j.walkin.venue ? ` - ${j.walkin.venue}` : ''}`);
      if (candidate) {
        used.push('match_me_to_job');
        try {
          const m = await runTool(c, 'match_me_to_job', { job_id: id });
          if (m.score != null) lines.push('', `🎯 Your AI Match: *${m.score}%*${m.missing_skills.length ? ` - missing: ${m.missing_skills.slice(0, 4).join(', ')}` : ''}`);
        } catch { /* no profile data to match yet */ }
      }
      lines.push('', `🔗 ${link(base, id)}`, 'Reply "apply" to get the apply link.');
      return out(lines.join('\n'), { usedTools: used, jobs: [shapeJob(j, base)] });
    });
  }

  if (/\b(apply|applying)\b/.test(t)) {
    const id = jobNumber(t, jobIds);
    if (!id) return out(jobIds.length ? `Which job should I send the apply link for? Reply "apply 1" to "apply ${jobIds.length}".`
      : 'Tell me which job first - e.g. "jobs in Hyderabad" - then reply "apply 1".');
    return withUser(session || null, async (c) => {
      let j;
      try { j = await runTool(c, 'get_job', { job_id: id }); } catch { return out('That job is no longer open.'); }
      const lines = [`To apply for *${j.title}*${j.company ? ` at ${j.company}` : ''}, open this link and tap *Apply Now*:`, `🔗 ${link(base, id)}`];
      const used = ['get_job'];
      if (candidate) {
        used.push('get_my_profile');
        const p = await reads.getMyProfile(c);
        lines.push(p.missing_fields.length
          ? `\nBefore you apply, your profile still needs: ${p.missing_fields.slice(0, 4).join(', ')}.`
          : '\nYour profile and resume are on file ✓ - the form will only ask for what is missing.');
      } else {
        lines.push('\nYou\'ll be asked to sign in or register, then fill one short form.');
      }
      return out(lines.join('\n'), { usedTools: used, jobs: [shapeJob(j, base)] });
    });
  }

  if (/\b(status|track|my applications?|applied|application)\b/.test(t) && !/\b(jobs?|openings?)\b.*\b(in|for)\b/.test(t)) {
    if (!candidate) return needSignIn();
    return withUser(session, async (c) => {
      const r = await reads.getMyApplications(c);
      if (!r.count) return out('You haven\'t applied to any job yet. Ask me for jobs - e.g. "jobs in Hyderabad".', { usedTools: ['get_my_applications'] });
      const lines = [`*Your applications (${r.count})*`, ...r.applications.slice(0, 8).map((a, i) =>
        `${i + 1}. *${a.title}*${a.company ? ` - ${a.company}` : ''}\n   Status: *${a.stage}*  ·  applied ${a.applied_on}${a.last_update && a.last_update !== a.applied_on ? `  ·  updated ${a.last_update}` : ''}`)];
      if (r.count > 8) lines.push(`…and ${r.count - 8} more in your TeamLink dashboard.`);
      return out(lines.join('\n'), { usedTools: ['get_my_applications'] });
    });
  }

  if (/\b(interview|schedule|reschedule|slot)\b/.test(t)) {
    if (!candidate) return needSignIn();
    return withUser(session, async (c) => {
      const iv = await reads.getMyInterviews(c);
      const pending = (await c.query(
        `select j.title from applications a join jobs j on j.id = a.job_id
          where a.candidate_id = app_candidate_id() and a.ai_interview_due_at is not null
            and a.stage in ('applied','ai_screening')
            and not exists (select 1 from ai_interviews i where i.application_id = a.id and i.status = 'completed')
          order by a.ai_interview_due_at limit 5`)).rows;
      const lines = [];
      if (iv.upcoming.length) {
        lines.push(`*Your upcoming interviews*`, ...iv.upcoming.slice(0, 5).map((i, n) =>
          `${n + 1}. *${i.job_title || 'Interview'}* - ${i.type}\n   ${[i.date, i.time, i.mode].filter(Boolean).join(' · ')}`));
      }
      if (pending.length) {
        if (lines.length) lines.push('');
        lines.push(`*AI interview waiting for you* (${pending.map((p) => p.title).join(', ')})`,
          `Open ${base}/#/candidate/home and tap *Attend AI Interview* under Action Required. You can take it any time before the deadline.`);
      }
      if (!lines.length) lines.push('You have no interview scheduled or waiting right now.',
        'Interviews are set up by the recruiter once your application is shortlisted, and I\'ll show them here as soon as they exist.');
      else lines.push('', 'To change a time, ask your recruiter - they can reschedule it in TeamLink.');
      return out(lines.join('\n'), { usedTools: ['get_my_interviews'] });
    });
  }

  const looksLikeJobs = /\b(jobs?|vacanc\w*|openings?|hiring|positions?|roles?|developer|engineer|nurse|doctor|recruiter|driver|executive|analyst|manager|fresher|walk.?in|remote|wfh)\b/.test(t);
  if (looksLikeJobs) {
    const p = parseJobQuestion(text);
    const r = await findJobs(session, p);
    const what = [p.query && `"${p.query}"`, p.location && `in ${p.location}`].filter(Boolean).join(' ');
    const forWhat = what ? (p.query ? ` for ${what}` : ` ${what}`) : '';
    if (!r.count) return out(`I couldn't find any open jobs${forWhat} right now. Try a different role or city, or ask for "latest jobs".`, { usedTools: ['search_open_jobs'] });
    const head = r.note === 'elsewhere'
      ? `No open jobs${p.location ? ` in ${p.location}` : ''} right now. Here ${r.count === 1 ? 'is' : 'are'} ${r.count} for ${p.query ? `"${p.query}"` : 'you'} in other places:`
      : `*${r.count} open job${r.count === 1 ? '' : 's'}*${forWhat}:`;
    return out([head, '', r.jobs.map((j, i) => jobLine(j, i, base)).join('\n\n'), '',
      'Reply "details 1" for more, or "apply 1" to get the apply link.'].join('\n'),
    { usedTools: ['search_open_jobs'], jobs: r.jobs.map((j) => shapeJob(j, base)) });
  }

  if (!candidate) return out(`I can search open jobs for you - try "jobs in Hyderabad" or "jobs for React developer". For anything about you (applications, interviews, profile) please sign in at ${base} first.`);

  // Everything else about a candidate: the Career Assistant (AI when a key is set, its labelled rules otherwise).
  try {
    if (aiConfigured()) {
      const ans = await askModel(session, { history: [], text, context: null });
      return out(typeof ans === 'string' ? ans : ans.reply, { engine: 'ai', usedTools: ans.usedTools || [] });
    }
    const ans = await rulesReply(session, text, {});
    return out(ans.reply, { usedTools: ans.usedTools || [] });
  } catch (err) {
    console.error('[whatsapp-agent] assistant failed:', err && err.message);
    return out('Sorry, I couldn\'t answer that just now. Please try again in a moment, or ask me about jobs, your applications or interviews.');
  }
}
