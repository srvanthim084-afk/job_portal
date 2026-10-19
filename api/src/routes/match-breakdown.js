/**
 * "How was this score worked out?" - the screening / match score on a candidate, taken apart for a recruiter.
 *
 *   GET /api/candidates/:id/match-breakdown?applicationId=&score=
 *
 * It re-runs the SAME scorer that screens an application (ai/screening.js, over the same matcher the job alerts use) on the
 * candidate and the job they applied to, with the admin's AI-settings weights, and reports its working: points for skills,
 * experience, education and location, which of the job's skills were found and which were not, and the skills ceiling that holds
 * a score down when few of the job's own skills are present ("20% at most when none of them are"). It writes nothing and changes no
 * score: the number on the card is the one stored when the application was screened; this shows what the scorer says now, and
 * says so when the two differ (a resume added since, a job whose skills were edited).
 *
 * Staff only (recruiter, BDE, administrator). The candidate must be one the caller can see; their resume text is read here,
 * server-side, for scoring and is never returned.
 */
import { Router } from 'express';
import { withUser } from '../db.js';
import { wrap, notFound, forbidden } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { toJob, toCandidate } from '../shapes.js';
import { matchCandidate } from '../ai/match.js';
import { scoreApplication, loadAiSettings } from '../ai/screening.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

const LABEL = { skills: 'Skills', experience: 'Experience', education: 'Education', location: 'Location' };

function why(key, b) {
  if (key === 'skills') {
    const s = b.skills || {};
    if (s.stated === false) return 'The job lists no skills, so skills are not counted.';
    const n = (s.matched || []).length + (s.implied || []).length + (s.missing || []).length;
    return `${(s.matched || []).length} of ${n} required skills are on the profile`
      + ((s.implied || []).length ? `, ${s.implied.length} more are mentioned in the resume (counted at half)` : '')
      + ((s.missing || []).length ? `; ${s.missing.length} not found` : '') + '.';
  }
  if (key === 'experience') {
    const e = b.experience || {};
    const band = e.band ? `${e.band.min}-${e.band.max} years` : null;
    if (e.fit === 'inside') return `${e.years} years, inside the ${band} the job asks for.`;
    if (e.fit === 'near') return `${e.years} years, just outside the ${band} the job asks for.`;
    if (e.fit === 'outside' || e.fit === 'far') return `${e.years} years, outside the ${band} the job asks for.`;
    if (e.fit === 'unknown') return 'No experience on the profile.';
    if (e.fit === 'unstated') return 'The job states no experience band, so this scores half.';
    return '';
  }
  if (key === 'education') {
    const r = (b.education || {}).reason;
    return { 'not specified': 'The job does not state a qualification.', 'any degree': 'Any degree is accepted.',
      'qualification matches': 'The qualification matches the one the job asks for.',
      'different qualification': 'The profile shows a different qualification from the one the job asks for.' }[r] || '';
  }
  if (key === 'location') {
    const r = (b.location || {}).reason;
    return { remote: 'The job is remote.', unstated: 'The job states no location, so this scores half.',
      'same city': `Same city${(b.location || {}).city ? ` (${b.location.city})` : ''}.`,
      'open to remote': 'Different city, but the candidate is open to remote work.' }[r]
      || 'The candidate is not in the job\'s location and has not said they would relocate.';
  }
  return '';
}

export default function matchBreakdownRoutes() {
  const r = Router();

  r.get('/candidates/:id/match-breakdown', requireAuth(), requireRole('recruiter', 'bde', 'admin'), wrap(async (req, res) => {
    const id = req.params.id;
    const seen = await withUser(req.session, async (c) => (await c.query(`select id, name from candidates where id = $1`, [id])).rows[0]);
    if (!seen) throw notFound('That candidate could not be found.');

    const apps = await withUser(req.session, async (c) => (await c.query(
      `select a.id, a.job_id, a.stage, a.match_score, a.ai_screened_at, a.applied_at, j.title as job_title
         from applications a join jobs j on j.id = a.job_id
        where a.candidate_id = $1 order by a.applied_at desc limit 12`, [id])).rows);

    const wantApp = String(req.query.applicationId || '');
    const wantScore = Number(req.query.score);
    const order = apps.slice().sort((x, y) => {
      const rank = (a) => (a.id === wantApp ? 0 : Number.isFinite(wantScore) && Number(a.match_score) === wantScore ? 1 : 2);
      return rank(x) - rank(y);
    });
    if (!order.length) {
      return res.json({ candidate: { id: seen.id, name: seen.name }, applications: [], preferred: null,
        note: `${seen.name} has not applied to any job, so there is no screening score to explain.` });
    }

    const settings = await loadAiSettings();
    const { candRow, jobs, stages } = await withUser(ENGINE, async (c) => ({
      candRow: (await c.query(`select * from candidates where id = $1`, [id])).rows[0],
      jobs: new Map((await c.query(
        `select j.*, co.name as company_name from jobs j left join companies co on co.id = j.company_id where j.id = any($1)`,
        [order.map((a) => a.job_id)])).rows.map((j) => [j.id, j])),
      stages: new Map((await c.query(`select id, label from stages`)).rows.map((s) => [s.id, s.label])),
    }));
    if (!candRow) throw notFound('That candidate could not be found.');
    const candidate = { ...toCandidate(candRow), resumeText: candRow.resume_text || '' };

    const out = order.map((a) => {
      const jr = jobs.get(a.job_id);
      if (!jr) return null;
      const job = { ...toJob(jr), companyName: jr.company_name };
      const m = matchCandidate(job, candidate, { threshold: settings.autoShortlistThreshold });
      const sc = scoreApplication({ job, candidate, settings });
      const b = m.breakdown || {};
      const stated = !(b.skills && b.skills.stated === false);
      const parts = ['skills', 'experience', 'education', 'location'].map((k) => ({
        key: k, label: LABEL[k], of: sc.breakdown[k].of, scored: sc.breakdown[k].scored,
        counted: k === 'skills' ? stated : true, note: why(k, b),
      }));
      const counted = parts.filter((p) => p.counted && p.of > 0);
      const totalOf = counted.reduce((t, p) => t + p.of, 0);
      const weighted = totalOf ? Math.round(counted.reduce((t, p) => t + p.scored, 0) / totalOf * 100) : 0;
      const ceiling = m.basis ? m.basis.ceiling : null;
      const s = b.skills || {};
      const stored = a.match_score == null ? null : Number(a.match_score);
      return {
        applicationId: a.id, jobId: a.job_id, jobTitle: a.job_title, stage: a.stage, stageLabel: stages.get(a.stage) || a.stage,
        appliedAt: a.applied_at, screenedAt: a.ai_screened_at || null,
        storedScore: stored, liveScore: sc.score, differs: stored != null && stored !== sc.score,
        weightedScore: weighted, ceiling, cappedBySkills: !!(m.basis && m.basis.cappedBySkills),
        verdict: sc.verdict, threshold: sc.threshold,
        parts,
        skills: { stated, matched: s.matched || [], implied: s.implied || [], missing: s.missing || [] },
        resumeRead: !!(candRow.resume_text && String(candRow.resume_text).trim()),
      };
    }).filter(Boolean);

    res.json({ candidate: { id: seen.id, name: seen.name }, applications: out, preferred: out[0] ? out[0].applicationId : null,
      weights: { skills: settings.weightSkills, experience: settings.weightExperience, education: settings.weightEducation, location: settings.weightLocation } });
  }));

  return r;
}
