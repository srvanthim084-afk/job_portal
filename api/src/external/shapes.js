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

import { checkLink } from './link.js';

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
    /* 0108 - identity, per-source configuration and health. */
    provider: r.provider || null,
    disabledReason: r.disabled_reason || null,
    disabledAt: iso(r.disabled_at),
    allowedDomains: r.allowed_domains || null,
    syncIntervalHours: num(r.sync_interval_hours),
    rateLimitPerMinute: num(r.rate_limit_per_minute),
    closeGraceDays: num(r.close_grace_days),
    monthlyQuota: num(r.monthly_quota),
    monthlyUsed: num(r.monthly_used),
    health: {
      status: r.health_status || 'unknown',
      lastSuccessfulSync: iso(r.last_success_at),
      lastAttempt: iso(r.last_attempt_at),
      successCount: Number(r.success_count || 0),
      failureCount: Number(r.failure_count || 0),
      consecutiveFailures: Number(r.consecutive_failures || 0),
      averageSyncDurationMs: num(r.avg_sync_ms),
      jobCount: num(r.open_job_count),
      nextSyncAfter: iso(r.next_sync_after),
    },
  };
}

/** A source's licence record (0108). Null when none is recorded. */
export function toLicence(l) {
  if (!l) return null;
  const day = (v) => (v ? new Date(v).toISOString().slice(0, 10) : null);
  return {
    sourceId: l.source_id,
    collectionMethod: l.collection_method,
    licenceStatus: l.licence_status,
    consentStatus: l.consent_status,
    termsUrl: l.terms_url || null,
    dataUsageAllowed: l.data_usage_allowed === true,
    applicationRedirectAllowed: l.application_redirect_allowed === true,
    effectiveFrom: day(l.effective_from),
    effectiveUntil: day(l.effective_until),
    owner: l.owner || null,
    notes: l.notes || null,
    updatedAt: iso(l.updated_at),
  };
}

/** Whether this kind of source needs a licence record to be switched on -
    the same rule as 0108's external_licence_gap_for, said for the screen. */
export function licenceRequirement(policy, method) {
  const m = String(method || 'manual');
  if (policy.kind === 'partner_feed') {
    return m === 'connector'
      ? 'not possible: no authorized API - needs a licensed partner/employer feed'
      : 'required: a complete licence record';
  }
  if (policy.kind === 'keyed_api') return 'required: a complete licence record (the API terms)';
  if (policy.kind === 'other' && m !== 'manual') return 'required: a complete licence record';
  return 'not required (documented public API or hand entry)';
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
        sourceType: 'EXTERNAL',
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

/* ------------------------------------------------------------------ *
 * the job portal's view of an external job (0088, moved here in 0108)
 * ------------------------------------------------------------------ */
const STATUS = { open: 'ACTIVE', closed: 'CLOSED', expired: 'EXPIRED', removed: 'UNAVAILABLE', archived: 'ARCHIVED' };

/** Exactly the shape GET /api/portal/external-jobs returned since 0088. */
export const toPortalJob = (r) => ({
  id: r.id,
  jobType: 'EXTERNAL',
  title: r.title,
  company: r.company || '',
  location: r.location || '',
  experience: r.experience || '',
  salary: r.salary || '',
  salaryMin: r.salary_min == null ? null : Number(r.salary_min),
  salaryMax: r.salary_max == null ? null : Number(r.salary_max),
  skills: r.skills || [],
  description: r.description || '',
  employmentType: r.employment_type || '',
  education: r.education || '',
  postedAt: r.posted_at ? new Date(r.posted_at).toISOString() : null,
  lastSyncedAt: r.synced_at ? new Date(r.synced_at).toISOString() : null,
  status: STATUS[r.status] || 'UNAVAILABLE',
  source: r.source_key,
  sourceName: r.source_name,
  publisher: r.original_publisher || null,
});

/*
 * 0108 adds keys beside those and changes none of them:
 *   origin       'EXTERNAL' - which Apply flow the job takes. TeamLink's own
 *                jobs carry their own `jobType` ('regular' | 'walk-in'), so
 *                the TeamLink/External split is called `origin`; the old
 *                `jobType: 'EXTERNAL'` stays for the clients that read it.
 *   provider     the board: NAUKRI, INDEED, SHINE, LINKEDIN, GREENHOUSE,
 *                LEVER, REMOTIVE, ADZUNA, JOOBLE, JSEARCH, SERPAPI, OTHER
 *   lastSeenAt / freshness   when a sync last saw it and how old it is
 */
export function freshnessOf(r, activeDays = 14) {
  const days = (v) => (v ? Math.max(0, Math.floor((Date.now() - new Date(v).getTime()) / 86400000)) : null);
  const seen = days(r.last_seen_at || r.synced_at);
  return {
    postedDaysAgo: days(r.posted_at),
    checkedDaysAgo: seen,
    /* Not seen by a sync for longer than a posting counts as live. */
    stale: seen != null && seen > Math.max(1, Number(activeDays) || 14),
  };
}

/* The owner's source types. Every other provider is OTHER_EXTERNAL and
   says which in jobSourceName. TeamLink's own jobs are TEAMLINK (shapes.js). */
const SOURCE_TYPE = { naukri: 'NAUKRI', shine: 'SHINE', indeed: 'INDEED', linkedin: 'LINKEDIN' };
const EXTERNAL_STATUS = { open: 'Active', closed: 'Expired', expired: 'Expired', removed: 'Unavailable', archived: 'Unavailable' };

export const toPortalJobV2 = (r, activeDays = 14) => {
  /* Apply Now opens this URL directly, so it is handed out ONLY when it
     passes the one link rule (link.js); otherwise null, and the card says
     "Application link unavailable". */
  const link = r.application_url
    ? checkLink(r.application_url, { provider: r.provider, connector: r.connector, sourceId: r.source_key,
        allowedDomains: r.allowed_domains })
    : { ok: false };
  const active = r.status === 'open';
  return {
    ...toPortalJob(r),
    origin: 'EXTERNAL',
    /* 0113: the normalised scope, the same key TeamLink jobs carry. */
    sourceType: 'EXTERNAL',
    provider: String(r.provider || 'other').toUpperCase(),
    jobSourceType: SOURCE_TYPE[r.provider] || 'OTHER_EXTERNAL',
    jobSourceName: r.source_name || null,
    externalJobId: r.source_job_id || null,
    originalJobUrl: active && link.ok ? link.url : null,
    canonicalJobUrl: active && link.ok ? (r.canonical_url || null) : null,
    applyLink: !active ? 'job_unavailable' : (link.ok ? 'available' : 'link_unavailable'),
    sourcePostedDate: iso(r.posted_at),
    externalStatus: EXTERNAL_STATUS[r.status] || 'Unavailable',
    collectedAt: iso(r.created_at),
    lastExternalSyncAt: iso(r.synced_at),
    lastExternalUpdateAt: iso(r.updated_at),
    expMin: num(r.exp_min),
    expMax: num(r.exp_max),
    lastSeenAt: iso(r.last_seen_at),
    freshness: freshnessOf(r, activeDays),
    ...(r.score != null ? { rank: Number(r.score) } : {}),
  };
};
