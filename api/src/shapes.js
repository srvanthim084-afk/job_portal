/**
 * Database rows -> the EXACT object shapes the prototype already uses.
 *
 * This module is the reason the UI does not have to change. Every render
 * function in prototype.html reads fields like `job.companyId`,
 * `cand.resumeFile`, `cand.appliedJobId` and `app.matchScore`. The API
 * speaks that language, so hydrated rows drop straight into DATA and every
 * template keeps working untouched.
 *
 * Field names here are NOT a style choice — they are a compatibility
 * contract with prototype.html. Do not "tidy" them to camelCase-from-snake
 * or the templates break.
 */

const nz = (v) => (v === null || v === undefined ? undefined : v);
const arr = (v) => (Array.isArray(v) ? v : []);
const numOrU = (v) => (v === null || v === undefined ? undefined : Number(v));

/** '2 days ago' — the prototype prints job.posted verbatim. */
export function postedLabel(days) {
  if (days === null || days === undefined) return '';
  const d = Number(days);
  if (d <= 0) return 'Today';
  if (d === 1) return '1 day ago';
  if (d < 7) return `${d} days ago`;
  if (d < 14) return '1 week ago';
  if (d < 30) return `${Math.floor(d / 7)} weeks ago`;
  if (d < 60) return '1 month ago';
  return `${Math.floor(d / 30)} months ago`;
}

export function toCompany(r) {
  return {
    id: r.id,
    name: r.name,
    industry: nz(r.industry),
    hq: nz(r.hq),
    founded: numOrU(r.founded),
    size: nz(r.size_label),          // prototype calls it `size`
    color1: nz(r.color1),
    color2: nz(r.color2),
    about: nz(r.about),
  };
}

export function toJob(r) {
  const j = {
    id: r.id,
    title: r.title,
    companyId: r.company_id,
    location: nz(r.location),
    mode: nz(r.mode),
    exp: nz(r.exp_label),            // display string '3–5 yrs'
    pay: nz(r.pay_label),            // display string '₹12–18 LPA'
    type: nz(r.employment_type),
    status: r.status === 'open' ? 'open' : r.status,
    skills: arr(r.skills),
    desc: nz(r.description),         // prototype calls it `desc`
    responsibilities: arr(r.responsibilities),
    requirements: arr(r.requirements),
    featured: !!r.featured,
    easyApply: !!r.easy_apply,
    department: nz(r.department),
    education: nz(r.education),
    salaryMin: numOrU(r.salary_min),
    salaryMax: numOrU(r.salary_max),
    postingKind: nz(r.posting_kind),
    // applicants is DERIVED server-side (DATA-MAPPING §3.2) — the prototype
    // used to increment a stored counter that drifted on every refresh.
    applicants: Number(r.applicants || 0),
    postedDaysAgo: numOrU(r.posted_days_ago),
    posted: postedLabel(r.posted_days_ago),
    publishedAt: nz(r.published_at),
  };
  // DATA.openJobs() tests `!j.paused` and `!j.archived`, so only set them
  // when true — an explicit `false` is harmless but this keeps the objects
  // byte-comparable with the prototype's own seed objects.
  if (r.paused) j.paused = true;
  if (r.archived) j.archived = true;
  return j;
}

export function toCandidate(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    phone: nz(r.phone),
    location: nz(r.location),
    gender: nz(r.gender),
    title: nz(r.title),

    // Strings, not undefined - the Resume page prints these directly, and
    // a candidate with neither showed the word "undefined" on screen.
    exp: r.exp == null ? '' : r.exp,
    ctc: nz(r.ctc),
    expectedCtc: numOrU(r.expected_ctc),
    noticePeriod: nz(r.notice_period),
    currentCompany: nz(r.current_company),
    previousCompanies: arr(r.previous_companies),
    careerGoal: nz(r.career_goal),
    preferredRole: nz(r.preferred_role),
    preferredLocation: nz(r.preferred_location),
    candidateType: nz(r.candidate_type),
    preferredWorkModes: arr(r.preferred_work_modes),

    skills: arr(r.skills),
    technicalSkills: arr(r.technical_skills),
    // A STRING, always - never undefined.
    //
    // prototype.html:3870 does `cand.education.split(',')` on the Resume
    // page. Every seeded candidate has an education line, so it never
    // failed; a newly registered one does not, and the whole page threw
    // and rendered the router's "Something needs a fresh click" fallback.
    // Field names here are a compatibility contract with the prototype,
    // and so are the TYPES.
    education: r.education == null ? '' : r.education,
    summary: nz(r.summary),
    certifications: arr(r.certifications),
    languages: arr(r.languages),
    projects: r.projects || [],
    linkedin: nz(r.linkedin),
    github: nz(r.github),
    portfolio: nz(r.portfolio),

    resumeFile: r.resume_file == null ? '' : r.resume_file,
    resumeUploadedAt: nz(r.resume_uploaded_at),
    // What the parser actually managed with THIS file (0013). The page
    // reports these instead of asserting a confidence nothing measured.
    resumeParse: r.resume_parsed_at || r.resume_parse_error ? {
      parsedAt: nz(r.resume_parsed_at),
      parser: nz(r.resume_parser),
      chars: numOrU(r.resume_chars),
      fieldsDetected: numOrU(r.resume_fields_detected),
      confidence: numOrU(r.resume_parse_confidence),
      error: nz(r.resume_parse_error),
    } : undefined,
    naukri: nz(r.naukri),
    indeed: nz(r.indeed),

    aiInterviewScore: numOrU(r.ai_interview_score),
    qualified: r.qualified === null ? undefined : r.qualified,

    emailVerified: !!r.email_verified,
    mobileVerified: !!r.mobile_verified,
    smsVerified: !!r.sms_verified,
    whatsappOptIn: !!r.whatsapp_opt_in,

    daysSilent: numOrU(r.days_silent),
    followUpSent: !!r.follow_up_sent,
    isPrivate: !!r.is_private,
    profileActiveDaysAgo: numOrU(r.profile_active_days_ago),
    profileUpdatedDaysAgo: numOrU(r.profile_updated_days_ago),

    // appliedJobId / stage / matchScore are NOT columns. They are the
    // candidate's PRIMARY application, re-attached by attachPrimary()
    // below so the ~100 call sites that read cand.stage keep working.
    // See DATA-MAPPING §3.1.
  };
}

export function toApplication(r) {
  return {
    id: r.id,
    candidateId: r.candidate_id,
    jobId: r.job_id,
    recruiterId: nz(r.recruiter_id),
    stage: r.stage,
    matchScore: numOrU(r.match_score),
    aiScore: numOrU(r.ai_score),
    source: nz(r.source),
    postingType: nz(r.posting_type),
    // date columns arrive as 'YYYY-MM-DD' strings (see the type parser in
    // db.js); the Date branch is a fallback for any caller that bypasses it
    appliedOn: r.applied_on
      ? String(r.applied_on instanceof Date
          ? r.applied_on.toISOString().slice(0, 10)
          : r.applied_on).slice(0, 10)
      : undefined,
    appliedAt: r.applied_at ? new Date(r.applied_at).toISOString() : undefined,
    // When the AI interview window closes. Two days from the invitation,
    // set by the database, so the screen states a deadline rather than
    // counting down from whenever the tab happened to open.
    aiInterviewDueAt: r.ai_interview_due_at
      ? new Date(r.ai_interview_due_at).toISOString() : undefined,
    resumeFile: nz(r.resume_path),
    primary: !!r.is_primary,
  };
}

export function toInterview(r) {
  return {
    id: r.id,
    candidateId: r.candidate_id,
    jobId: r.job_id,
    applicationId: nz(r.application_id),
    type: nz(r.type),
    date: r.scheduled_date
      ? (r.scheduled_date instanceof Date
          ? r.scheduled_date.toISOString().slice(0, 10)
          : String(r.scheduled_date).slice(0, 10))
      : undefined,
    time: nz(r.scheduled_time),
    mode: nz(r.mode),
    status: r.status,
    interviewer: nz(r.interviewer),
    aiScore: numOrU(r.ai_score),
    feedback: r.feedback || undefined,
  };
}

export function toOffer(r) {
  return {
    id: r.id,
    applicationId: r.application_id,
    candidateId: r.candidate_id,
    jobId: r.job_id,
    ctc: numOrU(r.ctc),
    joiningDate: r.joining_date
      ? String(r.joining_date instanceof Date
          ? r.joining_date.toISOString().slice(0, 10)
          : r.joining_date).slice(0, 10)
      : undefined,
    status: r.status,
    notes: nz(r.notes),
    extendedBy: nz(r.extended_by),
  };
}

/** Matches createNotification() at prototype.html:17679 field for field. */
export function toNotification(r) {
  return {
    id: r.id,
    recipientId: r.recipient_id,
    recipientRole: r.recipient_role,
    type: r.type,
    title: nz(r.title) || '',
    message: nz(r.message) || '',
    jobId: r.job_id || null,
    applicationId: r.application_id || null,
    candidateId: r.candidate_id != null ? String(r.candidate_id) : String(r.recipient_id),
    recruiterId: r.recruiter_id || null,
    read: !!r.read,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : undefined,
    metadata: r.metadata || {},
    system: !!r.system,
  };
}

export function toPerson(r) {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    companyId: nz(r.company_id),
    title: nz(r.title),
    initials: nz(r.initials),
  };
}

/**
 * Re-attaches the primary application onto its candidate.
 *
 * The prototype stores a candidate's pipeline position ON the candidate
 * (`cand.appliedJobId`, `cand.stage`, `cand.matchScore`) and ALSO keeps
 * extra applications in DATA.applications — the double-modelling described
 * in DATA-MAPPING §3.1. The database has one normalised table; this puts
 * the two views back so both keep working.
 *
 * Returns only the NON-primary applications, which is exactly what
 * DATA.applications should hold.
 */
export function attachPrimary(candidates, applications) {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const extra = [];
  for (const a of applications) {
    if (a.primary) {
      const c = byId.get(a.candidateId);
      if (c) {
        c.appliedJobId = a.jobId;
        c.stage = a.stage;
        c.matchScore = a.matchScore;
        // The prototype addresses this application as 'primary__<candId>'
        // (findAppRecord, prototype.html:4153) because it had no real id.
        // The client keeps this mapping so a stage move can name the real
        // row; it is stripped before the object reaches any render code.
        c.__primaryApplicationId = a.id;
      }
    } else {
      extra.push(a);
    }
  }
  // A candidate who registered but never applied shows as 'registered',
  // which stageBadge() renders as "Not applied yet" (prototype.html:1213).
  for (const c of candidates) {
    if (!c.appliedJobId) {
      c.appliedJobId = null;
      c.stage = 'registered';
      c.matchScore = c.matchScore ?? 0;
    }
  }
  return extra;
}
