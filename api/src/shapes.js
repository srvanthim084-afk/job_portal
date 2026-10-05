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
/* 0113: the 0108 jobSourceType for a jobs row the audit classified EXTERNAL,
   from its free-text `source` (the same four names external/shapes.js uses). */
const externalSourceTypeOf = (source) => {
  const s = String(source || '').toLowerCase();
  for (const k of ['naukri', 'shine', 'indeed', 'linkedin']) if (s.includes(k)) return k.toUpperCase();
  return 'OTHER_EXTERNAL';
};
const arr = (v) => (Array.isArray(v) ? v : []);
const numOrU = (v) => (v === null || v === undefined ? undefined : Number(v));

/**
 * Whole days between a timestamp and now, or undefined if there is none.
 *
 * Never negative: a clock skew that puts a row a few seconds in the
 * future must read as "today", not as "-1 days ago", which every
 * "active in the last N days" filter would then treat as a match.
 */
const daysSince = (v) => {
  if (v === null || v === undefined) return undefined;
  const t = v instanceof Date ? v.getTime() : Date.parse(v);
  if (!Number.isFinite(t)) return undefined;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
};

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

/**
 * When a walk-in ends, as an instant: 'YYYY-MM-DD' + 'HH:MM' read in IST
 * (the same rule as walkin_ends_at() in 0106). No end time means the end
 * of that day. A date that is not a calendar date gives null - an older
 * form let recruiters type "05 Oct" - and such a walk-in is never closed
 * by the clock.
 */
export function walkinEndsAt(date, to) {
  const d = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = /^\d{1,2}:\d{2}/.test(String(to || '').trim()) ? String(to).trim().slice(0, 5).padStart(5, '0') : '23:59';
  const at = Date.parse(`${d}T${t}:00+05:30`);
  return Number.isFinite(at) ? at : null;
}
export function walkinStartsAt(date, from) {
  const d = String(date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = /^\d{1,2}:\d{2}/.test(String(from || '').trim()) ? String(from).trim().slice(0, 5).padStart(5, '0') : '00:00';
  const at = Date.parse(`${d}T${t}:00+05:30`);
  return Number.isFinite(at) ? at : null;
}

function walkinShape(r, now = Date.now()) {
  const ends = walkinEndsAt(r.walkin_date, r.walkin_to);
  const open = r.status === 'open' && !r.paused && !r.archived;
  const cap = r.walkin_capacity == null ? null : Number(r.walkin_capacity);
  const taken = r.walkin_registered == null ? null : Number(r.walkin_registered);
  return {
    walkinDate: nz(r.walkin_date),
    walkinStartTime: nz(r.walkin_from),
    walkinEndTime: nz(r.walkin_to),
    walkinVenue: nz(r.walkin_venue),
    walkinAddress: nz(r.walkin_address),
    walkinMapLink: nz(r.walkin_map_link),
    walkinContactPerson: nz(r.walkin_contact),
    walkinContactNumber: nz(r.walkin_phone),
    walkinDocumentsToCarry: nz(r.walkin_documents),
    walkinInstructions: nz(r.walkin_instructions),
    walkinSlotCapacity: cap == null ? undefined : cap,
    ...(cap != null && taken != null ? {
      walkinRegistered: taken,
      walkinSlotsLeft: Math.max(0, cap - taken),
      walkinFull: taken >= cap,
    } : {}),
    walkinEndsAt: ends == null ? undefined : new Date(ends).toISOString(),
    walkinStatus: (!open || (ends != null && now > ends)) ? 'closed' : 'open',
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
    /* Stated on the advert and filterable, rather than a sentence buried
       in the description. `gender` is null on every job posted before
       0072 and stays null - nobody said, and guessing is worse. */
    gender: nz(r.gender),
    accommodation: !!r.accommodation,

    /*
     * 0083. What makes a walk-in a walk-in and an internship an
     * internship. Present ONLY when the posting has them, so a
     * full-time role does not come back carrying nine empty keys and
     * a card cannot render an empty 'Walk-in date:' line.
     */
    ...(r.walkin_date || r.walkin_venue || r.walkin_contact ? {
      walkinDate: nz(r.walkin_date),
      walkinFrom: nz(r.walkin_from),
      walkinTo: nz(r.walkin_to),
      walkinTime: [nz(r.walkin_from), nz(r.walkin_to)].filter(Boolean).join(' - ') || undefined,
      walkinVenue: nz(r.walkin_venue),
      walkinContact: nz(r.walkin_contact),
      walkinPhone: nz(r.walkin_phone),
    } : {}),

    /*
     * 0106. Walk-in is a JOB TYPE. `jobType` follows the posting kind;
     * a job that never said (every job before this) is 'regular', and
     * an internship keeps its own kind. The walk-in keys are the names
     * the owner's spec uses, beside the 0083 names above (other code
     * reads those). `walkinStatus` is derived at READ time: closed once
     * the walk-in's date and end time have passed in IST, or when the
     * posting itself is not open - no cron job, and reopening is an
     * edit of the date.
     */
    jobType: r.posting_kind === 'walkin' ? 'walk-in'
      : r.posting_kind === 'internship' ? 'internship' : 'regular',
    ...(r.posting_kind === 'walkin' ? walkinShape(r) : {}),

    ...(r.internship_duration || r.internship_type || r.stipend != null ? {
      internshipDuration: nz(r.internship_duration),
      internshipType: nz(r.internship_type),
      /* Only meaningful when it is a paid one; an unpaid internship
         has no stipend rather than a stipend of zero. */
      stipend: r.internship_type === 'Unpaid' ? undefined : numOrU(r.stipend),
    } : {}),
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
  /* 0095. The last date to apply, and urgent hiring while it lasts -
     present only when set, like the walk-in fields above. */
  if (r.expires_at) j.expiresAt = new Date(r.expires_at).toISOString();
  /* 0108: the TeamLink/external split, named as the owner names it. An
     imported job is never a row here (it is external_jobs, on the External
     Jobs page only). 0113: `sourceType` is the normalised TEAMLINK |
     EXTERNAL from jobs.source_type - TEAMLINK for everything TeamLink
     posts; EXTERNAL only for a legacy row the 0113 audit classified. */
  j.sourceType = r.source_type === 'EXTERNAL' ? 'EXTERNAL' : 'TEAMLINK';
  j.jobSourceType = j.sourceType === 'TEAMLINK' ? 'TEAMLINK' : externalSourceTypeOf(r.source);
  j.jobSourceName = j.sourceType === 'TEAMLINK' ? 'TeamLink' : (nz(r.source) || 'External');
  j.originalJobUrl = null;
  if (r.urgent && r.urgent_until && new Date(r.urgent_until) > new Date()) {
    j.urgent = true;
    j.urgentUntil = new Date(r.urgent_until).toISOString();
  }
  return j;
}

/**
 * @param r      the candidates row
 * @param opts   `{ staff: true }` when the reader is a recruiter, BDE or
 *               admin. Default false, so a caller that says nothing gets
 *               the safe shape rather than the fuller one.
 */
export function toCandidate(r, opts = {}) {
  /*
   * `rows.map(toCandidate)` passes the INDEX as the second argument, and
   * several callers do exactly that. Reading `.staff` off a number
   * happens to give undefined, so the safe shape is what comes back -
   * but relying on that is one refactor away from a leak, so anything
   * that is not an options object is treated as no options at all.
   */
  const staff = !!opts && typeof opts === 'object' && opts.staff === true;
  return {
    id: r.id,
    /* 0109: the human Candidate ID (TL-CAN-000123). `id` stays the key. */
    candidateCode: nz(r.candidate_code),
    name: r.name,
    email: r.email,
    // Whether this person can sign in. Not the account, not the address
    // it uses, and certainly not a password - just the one fact a
    // recruiter needs to answer "can they see their own profile?".
    hasPortalAccount: !!r.user_id,
    /* Where the PERSON is, as distinct from where any one of their
       applications is. Sourced, spoken to, interested, invited,
       registered — see migration 0048. */
    poolStatus: nz(r.pool_status) || 'sourced',
    importId: nz(r.import_id),
    phone: nz(r.phone),
    location: nz(r.location),
    gender: nz(r.gender),
    title: nz(r.title),

    // Strings, not undefined - the Resume page prints these directly, and
    // a candidate with neither showed the word "undefined" on screen.
    exp: r.exp == null ? '' : r.exp,
    // The NUMBER, not just the label. Its absence made every consumer
    // that asks "how many years" - job matching, screening, the calling
    // agent's plan - treat a candidate with four years on file as having
    // no experience at all.
    expYears: r.exp_years == null ? undefined : Number(r.exp_years),
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
    /* 0018 / 0102: the language to use with them (en | te | hi) - not
       `languages`, the ones they speak. NULL = never chosen: English in
       the portal, the admin's default language on an AI call (agent.js). */
    preferredLanguage: ['en', 'te', 'hi'].includes(r.preferred_language) ? r.preferred_language : null,
    projects: r.projects || [],
    /* 0087: what a resume has and the profile had nowhere to keep. */
    internships: Array.isArray(r.internships) ? r.internships : [],
    achievements: Array.isArray(r.achievements) ? r.achievements : [],
    otherLinks: Array.isArray(r.other_links) ? r.other_links : [],
    preferredJoiningDate: r.preferred_joining_date
      ? new Date(r.preferred_joining_date).toISOString().slice(0, 10) : '',
    additionalInfo: nz(r.additional_info),
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
    // Asked not to be called. Carried to the screen so the button is not
    // offered in the first place, rather than refused after the click.
    doNotContact: !!r.do_not_contact,
    /* 0074. How many times they have put off filling the profile in, and
       when they last did. On the record rather than in the browser, so
       saying "later" on a phone is still "later" on a borrowed laptop. */
    onboardingLaterCount: Number(r.profile_onboarding_later_count || 0),
    onboardingDismissedAt: r.profile_onboarding_dismissed_at
      ? new Date(r.profile_onboarding_dismissed_at).toISOString() : undefined,
    preferredLanguage: nz(r.preferred_language),

    /* ---- what the manual entry form records (migration 0057) ---------
     *
     * Additive, and nullable to a row: every candidate that existed
     * before the form did reads these as '' or undefined, exactly as it
     * reads every other optional field here. Nothing on screen is
     * required to show them; they are carried so that what a recruiter
     * typed can be read back rather than only stored.
     */
    dateOfBirth: nz(r.date_of_birth),
    /* 0109: what the multi-step registration asks that had no column. */
    firstName: nz(r.first_name),
    middleName: nz(r.middle_name),
    lastName: nz(r.last_name),
    whatsappNumber: nz(r.whatsapp_number),
    city: nz(r.city),
    country: nz(r.country),
    preferredEmploymentTypes: arr(r.preferred_employment_types),
    altPhone: nz(r.alt_phone),
    altEmail: nz(r.alt_email),
    state: nz(r.state),
    district: nz(r.district),
    address: nz(r.address),
    pincode: nz(r.pincode),
    nationality: nz(r.nationality),
    relevantExpYears: numOrU(r.relevant_exp_years),
    employmentType: nz(r.employment_type),
    availableFrom: nz(r.available_from),
    immediateJoiner: !!r.immediate_joiner,
    jobStatus: nz(r.job_status),
    jobChangeReason: nz(r.job_change_reason),
    preferredShift: nz(r.preferred_shift),
    willingToRelocate: r.willing_to_relocate === null ? undefined : !!r.willing_to_relocate,
    relocationLocation: nz(r.relocation_location),
    softSkills: arr(r.soft_skills),
    tools: arr(r.tools),
    source: nz(r.source),
    sourceDetails: nz(r.source_details),
    /* 0075. When this person entered the pool — reported beside where
       they came from, because "Job Board, two years ago" and "Job Board,
       yesterday" are not the same fact. */
    addedOn: r.created_at ? new Date(r.created_at).toISOString() : undefined,
    hiringType: nz(r.hiring_type),
    priority: nz(r.priority),
    availability: nz(r.availability),
    candidateReference: nz(r.candidate_reference),
    referredBy: nz(r.referred_by),
    assignedRecruiterId: nz(r.assigned_recruiter_id),
    resumeVersion: nz(r.resume_version),
    resumeSource: nz(r.resume_source),
    coverLetter: nz(r.cover_letter),
    emailOptIn: r.email_opt_in === undefined ? true : !!r.email_opt_in,
    smsOptIn: r.sms_opt_in === undefined ? true : !!r.sms_opt_in,
    preferredContactMethod: nz(r.preferred_contact_method),
    candidateNotes: nz(r.candidate_notes),
    /*
     * RECRUITER NOTES AND INTERNAL REMARKS ARE STAFF-ONLY.
     *
     * `GET /candidates/:id` and `GET /auth/me` both hand a candidate
     * their own row through this function, so anything listed
     * unconditionally here is something the candidate reads about
     * themselves. "Internal remarks" that the subject can read are not
     * internal. They appear only when the caller says the reader is
     * staff, and the default is that they are not - so a caller that
     * forgets to ask leaks nothing.
     */
    ...(staff ? {
      recruiterNotes: nz(r.recruiter_notes),
      internalRemarks: nz(r.internal_remarks),
    } : {}),
    tags: arr(r.tags),
    entryMethod: nz(r.entry_method),
    photoFile: nz(r.photo_file),
    /* Agreed on a call, not booked in a diary - see migration 0058. */
    interviewPrefs: r.interview_prefs || undefined,

    daysSilent: numOrU(r.days_silent),
    followUpSent: !!r.follow_up_sent,
    isPrivate: !!r.is_private,
    /*
     * HOW RECENTLY THIS PROFILE WAS TOUCHED, measured rather than stored.
     *
     * Both columns were only ever written by the demo seed. Every real
     * candidate - imported from a job board, or self-registered - has
     * had them NULL since the day they arrived, and Find Candidates
     * reads a missing value as 999 days. Its default filter is "active
     * in the last 6 months", so the search returned NOBODY, whatever was
     * typed into it: a recruiter searching for a skill saw "No
     * candidates match the current search criteria" and there were a
     * hundred and fifteen candidates behind it.
     *
     * Falling back to the row's own timestamps is the honest answer to
     * the question being asked. A candidate created this morning was
     * active today; one whose record has not changed in a year was not.
     * The stored column still wins where something has set it
     * deliberately.
     */
    profileActiveDaysAgo: numOrU(r.profile_active_days_ago)
      ?? daysSince(r.updated_at ?? r.created_at),
    profileUpdatedDaysAgo: numOrU(r.profile_updated_days_ago)
      ?? daysSince(r.updated_at ?? r.created_at),

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
    // TL-APP-2026-00452: what a candidate quotes on the phone and what
    // every message about this application carries. The row id is
    // internal; this is the one people use.
    reference: nz(r.reference),
    importMethod: nz(r.import_method),
    importedAt: r.imported_at ? new Date(r.imported_at).toISOString() : undefined,
    // When the AI interview window closes. Two days from the invitation,
    // set by the database, so the screen states a deadline rather than
    // counting down from whenever the tab happened to open.
    aiInterviewDueAt: r.ai_interview_due_at
      ? new Date(r.ai_interview_due_at).toISOString() : undefined,
    resumeFile: nz(r.resume_path),
    primary: !!r.is_primary,
    /* 0107: the walk-in ATS. `version` is what a stage save quotes back
       (23.8); status is derived from the stage, never set on its own. */
    ...(r.version != null ? { version: Number(r.version) } : {}),
    ...(r.application_status ? { applicationStatus: r.application_status } : {}),
    ...(r.checked_in_at ? { checkedInAt: new Date(r.checked_in_at).toISOString() } : {}),
    ...(r.attended_at ? { attendedAt: new Date(r.attended_at).toISOString() } : {}),
    ...(r.interviewed_at ? { interviewedAt: new Date(r.interviewed_at).toISOString() } : {}),
  };
}

/**
 * One job alert, as the ATS needs to read it.
 *
 * Everything the specification asks to be kept for every notification:
 * the candidate, the job, the score, the skills that matched, when, on
 * which channels, what each channel reported, whether they clicked and
 * whether they applied.
 */
export function toJobMatch(r) {
  return {
    id: r.id,
    jobId: r.job_id,
    jobTitle: nz(r.job_title),
    candidateId: r.candidate_id,
    candidateName: nz(r.candidate_name),
    candidateEmail: nz(r.candidate_email),
    candidatePhone: nz(r.candidate_phone),

    score: r.score == null ? null : Number(r.score),
    threshold: r.threshold == null ? null : Number(r.threshold),
    matchedSkills: arr(r.matched_skills),
    reason: nz(r.reason),
    breakdown: r.breakdown || undefined,
    matchedAt: r.matched_at ? new Date(r.matched_at).toISOString() : undefined,

    notified: !!r.notified,
    notifiedAt: r.notified_at ? new Date(r.notified_at).toISOString() : undefined,
    channels: {
      email:    nz(r.email_status),
      sms:      nz(r.sms_status),
      whatsapp: nz(r.whatsapp_status),
    },

    clicked: !!r.clicked_at,
    clickedAt: r.clicked_at ? new Date(r.clicked_at).toISOString() : undefined,
    applied: !!r.applied_at,
    appliedAt: r.applied_at ? new Date(r.applied_at).toISOString() : undefined,
    applicationId: nz(r.application_id),
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
/**
 * Education and work history rows, as the candidate portal reads them.
 *
 * Two callers need the identical shape - the single-candidate GET and the
 * bootstrap payload the portal renders from - and when they disagreed the
 * profile page silently showed nothing for rows that were in the
 * database. Kept here so there is one answer.
 */
export function toEducationRecord(e) {
  return {
    qualification: e.qualification || '', specialization: e.specialization || '',
    institution: e.institution || '',
    passingYear: e.passing_year == null ? undefined : Number(e.passing_year),
    score: e.score || '', educationType: e.education_type || '',
  };
}

export function toExperienceRecord(e) {
  return {
    company: e.company || '', jobTitle: e.job_title || '',
    startDate: e.start_date || '', endDate: e.end_date || '',
    currentlyWorking: !!e.currently_working, location: e.location || '',
    employmentType: e.employment_type || '', responsibilities: e.responsibilities || '',
    leavingReason: e.leaving_reason || '',
  };
}

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
  /*
   * A CANDIDATE WITH APPLICATIONS IS NOT "NOT APPLIED YET".
   *
   * 'registered' renders as "Not applied yet" (stageBadge), and it used
   * to be given to every candidate without a PRIMARY application. Nothing
   * marks an application primary any more - the flag belongs to the
   * prototype's one-application-per-candidate model, and applications now
   * arrive from the portal, from Easy Apply and from two job boards. So
   * in this deployment not one of a hundred and eighteen applications was
   * primary, and all hundred and twenty-nine candidates read "Not applied
   * yet" - including people who had applied, been screened, been
   * shortlisted and finished an AI interview.
   *
   * When there is no primary, the candidate's stage is taken from the
   * application that has got the FURTHEST, which is what a recruiter
   * means by "where is this person up to". 'registered' now means what it
   * says: no applications at all.
   */
  const byCandidate = new Map();
  for (const a of applications) {
    const list = byCandidate.get(a.candidateId) || [];
    list.push(a);
    byCandidate.set(a.candidateId, list);
  }

  for (const c of candidates) {
    if (c.appliedJobId) continue;               // a real primary already set it
    /*
     * appliedJobId is deliberately left null. It is what makes the
     * candidate screen synthesise a 'primary__<id>' row on top of
     * DATA.applications, so filling it in here would show one
     * application twice. Only the stage and the score are borrowed.
     */
    c.appliedJobId = null;
    const best = furthestAlong(byCandidate.get(c.id));
    /* 0107: a walk-in stage is read here as its regular equivalent. The
       candidate-level 'registered' means "no applications at all" and a
       walk-in applicant at Registered has applied. */
    c.stage = best ? (WALKIN_EQUIV[best.stage] || best.stage) : 'registered';
    c.matchScore = best ? (best.matchScore ?? 0) : (c.matchScore ?? 0);
  }
  return extra;
}

/*
 * How far down the pipeline each stage is.
 *
 * Hold and Rejected are absent on purpose: neither is progress, and a
 * candidate rejected for one role and shortlisted for another is
 * shortlisted, not rejected. They are used only when every application a
 * candidate has is in one of those states.
 */
const PROGRESS = {
  applied: 10, ai_screening: 20, shortlisted: 30, with_bde: 35,
  interview_scheduled: 40, ai_interview_done: 50, client_review: 60,
  offer_extended: 70, selected: 80, joined: 90,
  /* 0107 walk-in stages; No Show, like Rejected, is not progress */
  registered: 10, attended: 30, interviewed: 40,
};
const WALKIN_EQUIV = { registered: 'applied', attended: 'shortlisted', interviewed: 'interview_scheduled', no_show: 'rejected' };

/** The application that best answers "where is this person up to?". */
function furthestAlong(apps) {
  if (!apps || !apps.length) return null;
  const live = apps.filter((a) => PROGRESS[a.stage] != null);
  if (live.length) {
    return live.reduce((best, a) =>
      (PROGRESS[a.stage] > PROGRESS[best.stage] ? a : best));
  }
  // Everything is on hold or closed: the most recent of them.
  return apps.reduce((best, a) =>
    (String(a.appliedAt || '') > String(best.appliedAt || '') ? a : best));
}
