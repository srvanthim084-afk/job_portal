/**
 * External rows as the browser sees them.
 *
 * A separate file from `api/src/shapes.js` on purpose. That one defines
 * the objects the prototype's 700 synchronous call sites already read, and
 * every field in it is load-bearing for a screen somebody is using today.
 * Adding external shapes to it would mean editing a file the existing UI
 * depends on, for the sake of objects no existing screen reads.
 *
 * Nothing here exposes a storage path, a credential, or the name of an
 * environment variable: a source's `credential_env` never leaves the
 * server, so no browser and no API response can be used to discover what
 * secrets a deployment holds.
 */

const iso = (v) => (v ? new Date(v).toISOString() : null);
const num = (v) => (v == null || v === '' ? null : Number(v));

export function toSource(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    sourceType: r.source_type,
    collectionMethod: r.job_collection_method,
    applicationMethod: r.application_method,
    autoApplySupported: r.auto_apply_supported === true,
    active: r.active === true,
    feedUrl: r.feed_url || null,
    /* Which adapter collects for this source (0062). The admin screen
       needs it to ask the connector registry whether the source can
       actually run - a `connector` source's credentials belong to the
       connector, not to this row's credential_env. */
    connector: r.connector || null,
    /* Whether a key is configured, NOT which variable holds it and
       certainly not its value. The recruiter screen needs to know a
       source is ready; it does not need to know how. */
    credentialConfigured: !!(r.credential_env && process.env[r.credential_env]),
    lastSyncAt: iso(r.last_sync_at),
    lastSyncStatus: r.last_sync_status || null,
    lastSyncError: r.last_sync_error || null,
    lastSyncJobCount: r.last_sync_job_count == null ? null : Number(r.last_sync_job_count),
  };
}

export function toExternalJob(r) {
  if (!r) return null;
  return {
    id: r.id,
    sourceId: r.source_id,
    sourceName: r.source_name || null,
    sourceJobId: r.external_job_id,
    title: r.title,
    company: r.company || null,
    location: r.location || null,
    description: r.description || null,
    skills: r.skills || [],
    experience: r.experience || null,
    expMin: num(r.exp_min),
    expMax: num(r.exp_max),
    salary: r.salary || null,
    employmentType: r.employment_type || null,
    industry: r.industry || null,
    education: r.education || null,
    applicationUrl: r.application_url || null,
    applicationMethod: r.application_method || null,
    autoApplySupported: r.auto_apply_supported === true,
    postedAt: iso(r.posted_at),
    syncedAt: iso(r.synced_at),
    status: r.status,
    /* How many OTHER boards carry the same vacancy. The duplicates are
       kept, so this is a real count and not a guess. */
    alsoOn: r.also_on == null ? 0 : Number(r.also_on),
    duplicateOf: r.duplicate_of || null,
  };
}

export function toMatch(r) {
  if (!r) return null;
  return {
    id: r.id,
    candidateId: r.candidate_id,
    externalJobId: r.external_job_id,
    matchPercentage: num(r.match_percentage),
    matchingSkills: r.matching_skills || [],
    missingSkills: r.missing_skills || [],
    matchReasons: Array.isArray(r.match_reasons) ? r.match_reasons : [],
    autoApplyEligible: r.auto_apply_eligible === true,
    updatedAt: iso(r.updated_at),

    /* Present when the query joined the job in, so one card needs one
       request. Absent rather than null-filled when it did not. */
    ...(r.title ? {
      job: {
        id: r.external_job_id,
        title: r.title,
        company: r.company || null,
        location: r.location || null,
        salary: r.salary || null,
        experience: r.experience || null,
        skills: r.job_skills || [],
        applicationUrl: r.application_url || null,
        applicationMethod: r.application_method || null,
        sourceName: r.source_name || null,
        postedAt: iso(r.posted_at),
      },
    } : {}),

    /* Whether they have already been put forward, so the list shows a
       status instead of an Apply button. */
    ...(r.application_id ? {
      application: {
        id: r.application_id,
        status: r.application_status,
        externalStatus: r.external_status || null,
        submittedAt: iso(r.submitted_at),
      },
    } : {}),
  };
}

export function toExternalApplication(r) {
  if (!r) return null;
  return {
    id: r.id,
    candidateId: r.candidate_id,
    candidateName: r.candidate_name || null,
    candidateEmail: r.candidate_email || null,
    externalJobId: r.external_job_id,
    jobTitle: r.title || null,
    company: r.company || null,
    location: r.location || null,
    sourceId: r.source_id,
    sourceName: r.source_name || null,
    sourceJobId: r.source_job_id || null,
    matchPercentage: num(r.match_percentage),
    applicationType: r.application_type,
    externalApplicationId: r.external_application_id || null,
    applicationUrl: r.application_url || r.job_url || null,
    /* OUR vocabulary and THEIRS, side by side and never merged. */
    status: r.status,
    statusLabel: r.status_label || r.status,
    externalStatus: r.external_status || null,
    submittedAt: iso(r.submitted_at),

    /* ---- what TeamLink actually knows (0076) ---------------------- *
     *
     * WHOSE STATEMENT THIS IS. An 'applied_unconfirmed' row exists
     * because the CANDIDATE said so; nothing checked it and nothing
     * could. Every response carries that fact beside the status, so no
     * screen can render "Applied" without also having been handed the
     * word that qualifies it.
     */
    confirmedBy: (r.status === 'applied_unconfirmed' || r.status === 'not_applied')
      ? 'candidate' : null,
    confirmedAt: iso(r.confirmed_at),
    promptShownAt: iso(r.prompt_shown_at),
    reminderSentAt: iso(r.reminder_sent_at),
    lastOpenedAt: iso(r.last_opened_at),
    openCount: Number(r.open_count || 0),
    /* The board the advert lives on, so the prompt can say "via Naukri"
       rather than "via our Greenhouse connector". */
    originalPublisher: r.original_publisher || null,
    /*
     * Only ever what an employer actually told us - which, for a
     * redirect, is nothing at all. It is `external_status`, the source's
     * own unmapped words, under the name the screen uses; there is no
     * separate column because there is no second thing to store. Null
     * means null: the screen says "No response recorded" and never
     * infers one.
     */
    employerResponse: r.external_status || null,
    notes: r.notes || null,
    lastStatusCheckAt: iso(r.last_status_check_at),
    failureReason: r.failure_reason || null,
    createdAt: iso(r.created_at),
  };
}
