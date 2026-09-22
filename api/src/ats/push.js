/**
 * Assembling a candidate for an external ATS, and sending it there.
 *
 * The ATS is a separate product. This module does two things:
 *
 *   buildExport()  gathers one candidate from the live database - profile,
 *                  application, pipeline stage, AI interview scores, resume
 *                  reference - into one object with real ids on it.
 *   pushToAts()    hands that object to a destination.
 *
 * There is exactly one destination that always works: 'download', which
 * returns the payload for the BDE to save. A real provider needs its API
 * credentials, and until those exist it reports `not_configured` - the same
 * contract the notification providers use. Nothing here claims a record was
 * delivered when it was not.
 *
 * Every query runs on the caller's connection, so row-level security
 * decides what a BDE may assemble. There is no privileged read here.
 */
import { toCandidate } from '../shapes.js';

/**
 * @param c              a client inside withUser() - RLS applies
 * @param candidateId    who to export
 * @param applicationId  which application; defaults to their most recent
 * @returns null when the caller may not see that candidate
 */
export async function buildExport(c, candidateId, applicationId) {
  const cand = await c.query(`select * from candidates where id=$1`, [candidateId]);
  if (!cand.rowCount) return null;              // absent, or RLS hid it

  const apps = await c.query(
    `select * from applications where candidate_id=$1 order by applied_at desc`, [candidateId]);
  const application = applicationId
    ? apps.rows.find((a) => a.id === applicationId) || null
    : apps.rows[0] || null;

  const job = application
    ? (await c.query(`select * from jobs_with_counts where id=$1`, [application.job_id])).rows[0] || null
    : null;

  const company = job
    ? (await c.query(`select id, name, industry, hq from companies where id=$1`, [job.company_id])).rows[0] || null
    : null;

  // The AI interview is the reason a BDE is exporting at all: the score is
  // what the agency's ATS wants alongside the resume.
  const ai = await c.query(
    `select id, application_id, status, technical_score, behavioral_score,
            communication_score, overall_percentage, content_scored, completed_at
       from ai_interviews
      where candidate_id=$1
      order by completed_at desc nulls last`, [candidateId]);
  const interview = application
    ? ai.rows.find((x) => x.application_id === application.id) || ai.rows[0] || null
    : ai.rows[0] || null;

  const history = application
    ? (await c.query(
        `select from_stage, to_stage, note, created_at
           from application_stage_history
          where application_id=$1 order by id`, [application.id])).rows
    : [];

  const shaped = toCandidate(cand.rows[0]);

  return {
    exportedAt: new Date().toISOString(),
    candidate: {
      id: shaped.id,
      name: shaped.name,
      email: shaped.email,
      phone: shaped.phone,
      location: shaped.location,
      title: shaped.title,
      currentCompany: shaped.currentCompany,
      previousCompanies: shaped.previousCompanies || [],
      experience: shaped.exp,
      expYears: shaped.expYears,
      skills: shaped.skills || [],
      education: shaped.education,
      noticePeriod: shaped.noticePeriod,
      expectedSalary: shaped.expectedSalary,
      // A reference, not the bytes. The file stays in this system's storage
      // and is fetched with a normal authenticated request.
      resume: shaped.resumeFile
        ? { fileName: shaped.resumeFile, url: `/api/uploads/resume/${shaped.id}` }
        : null,
    },
    application: application ? {
      id: application.id,
      jobId: application.job_id,
      stage: application.stage,
      appliedAt: application.applied_at,
      source: application.source,
    } : null,
    job: job ? { id: job.id, title: job.title, location: job.location, type: job.type } : null,
    client: company ? { id: company.id, name: company.name, industry: company.industry, hq: company.hq } : null,
    aiInterview: interview ? {
      id: interview.id,
      status: interview.status,
      technical: num(interview.technical_score),
      behavioral: num(interview.behavioral_score),
      communication: num(interview.communication_score),
      overall: num(interview.overall_percentage),
      // Surfaced deliberately: a score computed without a transcript is not
      // the same thing as one computed from what the candidate said, and an
      // ATS receiving it should be able to tell the difference.
      contentScored: !!interview.content_scored,
      completedAt: interview.completed_at,
    } : null,
    pipeline: history.map((h) => ({
      from: h.from_stage, to: h.to_stage, note: h.note, at: h.created_at,
    })),
  };
}

const num = (v) => (v == null ? null : Number(v));

/* ------------------------------------------------------------------ *
 * destinations
 * ------------------------------------------------------------------ */

/**
 * A generic HTTP destination, configured by environment variables:
 *
 *   ATS_NAME       what to call it in the UI (e.g. "ceipal")
 *   ATS_URL        where to POST the payload
 *   ATS_API_KEY    sent as a bearer token
 *
 * Most ATS products accept a JSON POST like this. When yours needs a
 * different shape, the mapping belongs here, in one function, rather than
 * spread through the routes.
 */
const provider = () => ({
  name: process.env.ATS_NAME || 'ats',
  url: process.env.ATS_URL || '',
  key: process.env.ATS_API_KEY || '',
});

export function atsDestinations() {
  const p = provider();
  return [
    { id: 'download', label: 'Download (JSON)', configured: true },
    {
      id: p.name,
      label: p.name.toUpperCase(),
      configured: !!(p.url && p.key),
      reason: p.url && p.key ? null : 'ATS_URL and ATS_API_KEY are not set',
    },
  ];
}

export async function pushToAts(destination, payload) {
  if (!destination || destination === 'download') {
    // Nothing leaves the building; the BDE saves the file. Recorded as
    // delivered because it genuinely was - to the person who asked for it.
    return { status: 'delivered', detail: 'downloaded by the BDE' };
  }

  const p = provider();
  if (destination !== p.name) {
    return { status: 'failed', detail: `unknown destination "${destination}"` };
  }
  if (!p.url || !p.key) {
    return { status: 'not_configured', detail: 'ATS_URL and ATS_API_KEY are not set' };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Number(process.env.ATS_TIMEOUT_MS || 20_000));
  try {
    const res = await fetch(p.url, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.key}` },
      body: JSON.stringify(payload),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      return { status: 'failed', detail: `${p.name} returned ${res.status}: ${text.slice(0, 200)}` };
    }
    return { status: 'delivered', detail: text.slice(0, 200) || `${p.name} accepted the record` };
  } catch (err) {
    return {
      status: 'failed',
      detail: err.name === 'AbortError' ? `${p.name} did not respond in time` : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}
