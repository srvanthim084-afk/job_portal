/**
 * Every database statement the external-job layer makes.
 *
 * Collected in one file for a reason that matters more here than usual:
 * the promise this feature makes is that it cannot touch TeamLink's own
 * jobs, applications or ATS stages. That promise is only as good as
 * somebody's ability to check it - and checking it means reading one file
 * and seeing that the only existing table named anywhere is `candidates`,
 * and only ever in a `select`.
 *
 * Writes all go through the `security definer` functions in migration
 * 0049, so the API role can perform exactly those operations and nothing
 * else. There is no `insert into external_jobs` here; there is
 * `select external_job_save(...)`.
 */
import { withUser } from '../db.js';
import { newId } from './normalise.js';

/* ------------------------------------------------------------------ *
 * sources
 * ------------------------------------------------------------------ */

export async function listSources(session) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select * from job_sources order by lower(name)`);
    return rows;
  });
}

export async function getSource(session, id) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(`select * from job_sources where id = $1`, [id]);
    return rows[0] || null;
  });
}

export async function saveSource(session, input) {
  const id = input.id || newId('xsrc');
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select (external_source_save($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)).*`,
      [id, input.name, input.sourceType, input.collectionMethod, input.applicationMethod,
       input.autoApplySupported === true, input.active === true,
       input.feedUrl || null, input.credentialEnv || null, input.connector || null]);
    return rows[0];
  });
}

/**
 * Remove a source and everything collected through it.
 *
 * The cascade runs away from TeamLink, never into it: `external_*` rows
 * reference `candidates`, so deleting every source in the system leaves
 * every candidate, job, application and ATS stage exactly as it was.
 */
export async function deleteSource(session, id) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(`select * from external_source_delete($1)`, [id]);
    const r = rows[0] || {};
    return {
      removedJobs: Number(r.removed_jobs || 0),
      removedMatches: Number(r.removed_matches || 0),
      removedApplications: Number(r.removed_applications || 0),
    };
  });
}

export async function deleteJob(session, id) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(`select external_job_delete($1) as gone`, [id]);
    return rows[0]?.gone === true;
  });
}

export async function recordSyncResult(session, sourceId, { status, error, jobCount }) {
  return withUser(session, async (c) => {
    await c.query(`select external_source_sync_result($1,$2,$3,$4)`,
      [sourceId, status, error ? String(error).slice(0, 400) : null, jobCount ?? null]);
  });
}

/* ------------------------------------------------------------------ *
 * jobs
 * ------------------------------------------------------------------ */

/**
 * Upsert one normalised posting.
 *
 * The generated id is only used when the row is new; on a re-sync the
 * conflict target `(source_id, external_job_id)` wins and the existing id
 * is kept, because matches and applications point at it.
 */
export async function saveJob(session, job) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      /* 0078. The last four are the ones 0067 added and this call never
         sent, so every publisher every connector worked out was thrown
         away between here and the table. */
      `select (external_job_save($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                                 $15,$16,$17,$18,$19,$20,$21,$22,$23,
                                 $24,$25,$26,$27)).*`,
      [newId('xjob'), job.sourceId, job.externalJobId, job.title, job.company, job.location,
       job.description, job.skills, job.experience, job.expMin, job.expMax,
       job.salary, job.salaryMin, job.salaryMax, job.employmentType, job.industry,
       job.education, job.applicationUrl, job.applyEmail, job.postedAt, job.status,
       job.dedupeKey, JSON.stringify(job.raw ?? {}),
       job.originalPublisher ?? null, job.city ?? null, job.state ?? null,
       job.country ?? null]);
    return rows[0];
  });
}

/** Link same-vacancy rows together. Returns how many were linked. */
export async function relinkDuplicates(session) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(`select external_jobs_relink_duplicates() as n`);
    return Number(rows[0]?.n || 0);
  });
}

/**
 * Open external jobs, newest first.
 *
 * `canonicalOnly` hides rows that are a duplicate of another row, which is
 * what a candidate wants - one card per vacancy. A recruiter looking at
 * coverage wants all of them, so it is a parameter rather than a rule.
 */
export async function listJobs(session, {
  limit = 100, offset = 0, sourceId = null, search = '', canonicalOnly = true,
} = {}) {
  return withUser(session, async (c) => {
    const where = [`j.status = 'open'`];
    const params = [];
    if (canonicalOnly) where.push('j.duplicate_of is null');
    if (sourceId) { params.push(sourceId); where.push(`j.source_id = $${params.length}`); }
    if (search) {
      params.push(`%${String(search).toLowerCase()}%`);
      const p = `$${params.length}`;
      where.push(`(lower(j.title) like ${p} or lower(coalesce(j.company,'')) like ${p}
                   or lower(coalesce(j.location,'')) like ${p})`);
    }
    params.push(Math.min(Number(limit) || 100, 500));
    const lim = `$${params.length}`;
    params.push(Math.max(Number(offset) || 0, 0));
    const off = `$${params.length}`;

    const { rows } = await c.query(
      `select j.*, s.name as source_name, s.application_method, s.auto_apply_supported,
              (select count(*) from external_jobs d where d.duplicate_of = j.id) as also_on
         from external_jobs j
         join job_sources s on s.id = j.source_id
        where ${where.join(' and ')}
        order by coalesce(j.posted_at, j.synced_at) desc, j.id
        limit ${lim} offset ${off}`, params);
    return rows;
  });
}

export async function getJob(session, id) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select j.*, s.name as source_name, s.application_method, s.auto_apply_supported, s.active
         from external_jobs j join job_sources s on s.id = j.source_id
        where j.id = $1`, [id]);
    return rows[0] || null;
  });
}

/* ------------------------------------------------------------------ *
 * candidates — READ ONLY
 *
 * The only place this layer reads an existing TeamLink table, and there
 * is no corresponding write anywhere in this file.
 * ------------------------------------------------------------------ */

export async function readCandidate(session, id) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select id, name, email, phone, location, preferred_location, title, preferred_role,
              exp, exp_years, education, skills, technical_skills, notice_period,
              expected_ctc, preferred_work_modes, resume_file, resume_storage_path,
              resume_text
         from candidates where id = $1`, [id]);
    return rows[0] || null;
  });
}

/* ------------------------------------------------------------------ *
 * matches
 * ------------------------------------------------------------------ */

export async function saveMatch(session, m) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select (external_match_save($1,$2,$3,$4,$5,$6,$7,$8)).*`,
      [newId('xmatch'), m.candidateId, m.externalJobId, m.percentage,
       m.matchingSkills || [], m.missingSkills || [],
       JSON.stringify(m.reasons ?? []), m.autoApplyEligible === true]);
    return rows[0];
  });
}

/**
 * A candidate's best external matches.
 *
 * Joined to the job so one round trip fills a card, and left-joined to
 * any external application so the list can say "Applied" instead of
 * offering an Apply button for something already sent.
 */
export async function listMatches(session, candidateId, { minPercentage = 0, limit = 50 } = {}) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select m.*, j.title, j.company, j.location, j.salary, j.experience,
              j.application_url, j.posted_at, j.skills as job_skills,
              s.name as source_name, s.application_method,
              a.id as application_id, a.status as application_status,
              a.external_status, a.submitted_at
         from candidate_external_job_matches m
         join external_jobs j on j.id = m.external_job_id
         join job_sources  s on s.id = j.source_id
    left join external_applications a
              on a.candidate_id = m.candidate_id and a.external_job_id = m.external_job_id
        where m.candidate_id = $1
          and j.status = 'open'
          and j.duplicate_of is null
          and m.match_percentage >= $2
        order by m.match_percentage desc, coalesce(j.posted_at, j.synced_at) desc
        limit $3`,
      [candidateId, Number(minPercentage) || 0, Math.min(Number(limit) || 50, 200)]);
    return rows;
  });
}

/**
 * The candidate's recommended list: the top N, filtered, one page at a time.
 *
 * THE CAP IS APPLIED BEFORE THE PAGE, and that is the whole point. The
 * brief asks for "a maximum of 100, sorted by match, paginated 20 at a
 * time" - which only means anything if the 100 is chosen first and the
 * pages walk through THAT set. Paging a full result and stopping at 100
 * would give a different answer depending on which page was asked for.
 *
 * So: a CTE takes the top `cap` by the sort rule, and everything after
 * it - the count, the page, the filters - runs inside that.
 *
 * WHAT IS EXCLUDED, and why each one:
 *   dismissed      the candidate said no; showing it again is nagging
 *   already applied they are in the External Applications list instead
 *   duplicates     one card per vacancy, not one per board
 *   stale          a posting nobody has seen for `activeDays` is gone
 *   below minimum  a bad match is not worth a candidate's attention
 */
export async function listRecommended(session, candidateId, {
  cap = 100, minMatch = 60, activeDays = 14,
  page = 1, pageSize = 20,
  source = null, location = null, jobType = null, search = '', sort = 'match',
} = {}) {
  return withUser(session, async (c) => {
    const params = [candidateId, Number(minMatch) || 0, Number(activeDays) || 14];
    const where = [
      `m.candidate_id = $1`,
      `m.match_percentage >= $2`,
      `m.dismissed_at is null`,
      `j.status = 'open'`,
      `j.duplicate_of is null`,
      /* Live: posted or last seen inside the window. */
      `coalesce(j.posted_at, j.synced_at) >= now() - ($3 || ' days')::interval`,
      /*
       * Not one they have already applied to - unless they came back and
       * said they had NOT. "No, not yet" has to put the posting back in
       * the list, or the answer costs them the job.
       */
      `not exists (select 1 from external_applications a
                    where a.candidate_id = m.candidate_id
                      and a.external_job_id = m.external_job_id
                      and a.status <> 'not_applied')`,
    ];

    if (source) { params.push(source); where.push(`s.id = $${params.length}`); }
    if (location) {
      params.push(`%${String(location).toLowerCase()}%`);
      where.push(`lower(coalesce(j.location,'')) like $${params.length}`);
    }
    if (jobType) {
      params.push(`%${String(jobType).toLowerCase()}%`);
      where.push(`lower(coalesce(j.employment_type,'')) like $${params.length}`);
    }
    if (search) {
      params.push(`%${String(search).toLowerCase()}%`);
      const p = `$${params.length}`;
      where.push(`(lower(j.title) like ${p} or lower(coalesce(j.company,'')) like ${p})`);
    }

    /* Newest first, or best match first - and in BOTH cases the other
       one breaks the tie, so the order is total and a page boundary
       never lands in the middle of an arbitrary group. */
    const order = sort === 'posted'
      ? `coalesce(j.posted_at, j.synced_at) desc, m.match_percentage desc`
      : `m.match_percentage desc, coalesce(j.posted_at, j.synced_at) desc`;

    params.push(Math.max(1, Math.min(Number(cap) || 100, 500)));
    const capP = `$${params.length}`;

    const base = `
      select m.*, j.title, j.company, j.location, j.salary, j.experience,
             j.employment_type, j.application_url, j.posted_at, j.synced_at,
             j.skills as job_skills, j.description,
             s.id as source_id, s.name as source_name, s.application_method
        from candidate_external_job_matches m
        join external_jobs j on j.id = m.external_job_id
        join job_sources  s on s.id = j.source_id
       where ${where.join(' and ')}
       order by ${order}
       limit ${capP}`;

    const total = Number((await c.query(
      `with capped as (${base}) select count(*)::int as n from capped`, params)).rows[0].n || 0);

    const size = Math.max(1, Math.min(Number(pageSize) || 20, 100));
    const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * size);
    params.push(size, offset);

    const rows = (await c.query(
      `with capped as (${base})
       select * from capped limit $${params.length - 1} offset $${params.length}`,
      params)).rows;

    return { rows, total, page: Math.max(1, Number(page) || 1), pageSize: size };
  });
}

/**
 * The newest live India jobs, for a candidate the matcher cannot score.
 *
 * WHY THIS EXISTS. `listRecommended` reads
 * `candidate_external_job_matches`, and a candidate with no skills, no
 * title and no preferred role has no matches - so the page showed them
 * an empty list and a "complete your profile" panel, while a hundred
 * real jobs sat in the table they were not being shown. An empty
 * profile is a reason to rank badly, not a reason to be shown nothing.
 *
 * NO SCORE IS INVENTED. `match_percentage` comes back null and the card
 * shows no percentage and no reasons, because none were computed. The
 * tier is named so the page can say what this list is: the latest jobs,
 * not matches.
 *
 * The same filters, the same cap, the same paging and the same
 * exclusions as the matched list - a job they dismissed or already
 * applied to must not reappear here either.
 */
export async function listLatest(session, candidateId, {
  cap = 100, activeDays = 14, page = 1, pageSize = 20,
  source = null, location = null, jobType = null, search = '',
} = {}) {
  return withUser(session, async (c) => {
    const params = [candidateId, Number(activeDays) || 14];
    const where = [
      `j.status = 'open'`,
      `j.duplicate_of is null`,
      `coalesce(j.posted_at, j.synced_at) >= now() - ($2 || ' days')::interval`,
      `not exists (select 1 from external_applications a
                    where a.candidate_id = $1
                      and a.external_job_id = j.id
                      and a.status <> 'not_applied')`,
      /* A match row may still exist and be dismissed - "not interested"
         is about the job, not about how the job was found. */
      `not exists (select 1 from candidate_external_job_matches m
                    where m.candidate_id = $1
                      and m.external_job_id = j.id
                      and m.dismissed_at is not null)`,
    ];

    if (source) { params.push(source); where.push(`s.id = $${params.length}`); }
    if (location) {
      params.push(`%${String(location).toLowerCase()}%`);
      where.push(`lower(coalesce(j.location,'')) like $${params.length}`);
    }
    if (jobType) {
      params.push(`%${String(jobType).toLowerCase()}%`);
      where.push(`lower(coalesce(j.employment_type,'')) like $${params.length}`);
    }
    if (search) {
      params.push(`%${String(search).toLowerCase()}%`);
      const p = `$${params.length}`;
      where.push(`(lower(j.title) like ${p} or lower(coalesce(j.company,'')) like ${p})`);
    }

    params.push(Math.max(1, Math.min(Number(cap) || 100, 500)));
    const capP = `$${params.length}`;

    const base = `
      select j.id as id, j.id as external_job_id, $1::text as candidate_id,
             null::numeric as match_percentage,
             null::jsonb   as match_reasons,
             'latest'::text as tier,
             null::timestamptz as dismissed_at,
             j.title, j.company, j.location, j.salary, j.experience,
             j.employment_type, j.application_url, j.posted_at, j.synced_at,
             j.skills as job_skills, j.description,
             s.id as source_id, s.name as source_name, s.application_method
        from external_jobs j
        join job_sources s on s.id = j.source_id
       where ${where.join(' and ')}
       order by coalesce(j.posted_at, j.synced_at) desc, j.id
       limit ${capP}`;

    const total = Number((await c.query(
      `with capped as (${base}) select count(*)::int as n from capped`, params)).rows[0].n || 0);

    const size = Math.max(1, Math.min(Number(pageSize) || 20, 100));
    const offset = Math.max(0, (Math.max(1, Number(page) || 1) - 1) * size);
    params.push(size, offset);

    const rows = (await c.query(
      `with capped as (${base})
       select * from capped limit $${params.length - 1} offset $${params.length}`,
      params)).rows;

    return { rows, total, page: Math.max(1, Number(page) || 1), pageSize: size };
  });
}

/** "Not interested." Recorded on the match: it is this candidate's view. */
export async function dismissMatch(session, candidateId, externalJobId) {
  return withUser(session, async (c) => {
    /* Through the definer function: the CANDIDATE does this, and RLS on
       this table permits writes to an administrator only. A direct
       update matched no rows and raised nothing, so the endpoint
       reported success while the card stayed on screen. */
    const { rows } = await c.query(
      `select external_match_dismiss($1,$2) as gone`, [candidateId, externalJobId]);
    return rows[0]?.gone === true;
  });
}

/* ------------------------------------------------------------------ *
 * external applications
 * ------------------------------------------------------------------ */

export async function openApplication(session, a) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select (external_application_open($1,$2,$3,$4,$5,$6,$7)).*`,
      [newId('xapp'), a.candidateId, a.externalJobId, a.sourceId,
       a.matchPercentage ?? null, a.applicationType || 'manual', a.applicationUrl || null]);
    return rows[0];
  });
}

export async function setApplicationStatus(session, id, {
  status, externalStatus = null, externalApplicationId = null, failureReason = null,
} = {}) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select (external_application_status($1,$2,$3,$4,$5)).*`,
      [id, status, externalStatus, externalApplicationId,
       failureReason ? String(failureReason).slice(0, 400) : null]);
    return rows[0];
  });
}

/**
 * The candidate pressed Apply, or "Open job again".
 *
 * Never creates a second row - the unique key on (candidate, job) means
 * there is one application per posting - it records another visit to the
 * employer's page and returns how many there have now been.
 */
export async function recordOpen(session, id) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select external_application_opened($1) as n`, [id]);
    return Number(rows[0]?.n ?? -1);
  });
}

/** "Did you apply?" has been put to them. Set once; a second call does
    nothing and says so, which is what stops two tabs asking twice. */
export async function markPromptShown(session, id) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select external_application_prompt_shown($1) as first`, [id]);
    return !!rows[0]?.first;
  });
}

/**
 * The candidate's own answer, through the one function that also writes
 * the audit row and moves the match with it.
 *
 * @returns the status in force afterwards - which may not be the one
 *          asked for, if the application had already been answered. The
 *          caller reports that as the current state, not as an error:
 *          two tabs answering at once is not a failure for either of
 *          them.
 */
export async function markApplication(session, id, {
  status, actor = 'candidate', actorId = null, note = null, reopen = false,
} = {}) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select external_application_mark($1,$2,$3,$4,$5,$6) as status`,
      [id, status, actor, actorId, note ? String(note).slice(0, 500) : null, !!reopen]);
    return rows[0]?.status || null;
  });
}

/**
 * Applications still waiting for an answer.
 *
 * Older than `minutes`, because somebody who clicked ten seconds ago is
 * probably still reading the advert, and asking them then is asking
 * before they could possibly know.
 *
 * INDEPENDENT OF THE TAB THEY CLICKED IN. This is what makes the
 * question survive closing the browser, signing out, or moving to a
 * different device - none of which the in-page prompt can do.
 */
export async function listPending(session, candidateId, { minutes = 5, limit = 20 } = {}) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select a.*, j.title, j.company, j.location, j.original_publisher,
              j.application_url as job_url,
              s.name as source_name, st.label as status_label
         from external_applications a
         join external_jobs j on j.id = a.external_job_id
         join job_sources  s on s.id = a.source_id
         join external_application_statuses st on st.id = a.status
        where a.candidate_id = $1
          and a.status = 'clicked'
          and a.confirmed_at is null
          and a.created_at <= now() - make_interval(mins => $2::int)
        order by a.created_at asc
        limit $3`,
      /*
       * BOTH SIDES ON THE DATABASE'S CLOCK.
       *
       * `created_at` is set by the database. Working the cut-off out
       * here and sending it as a timestamp compares the database's clock
       * against this process's, and they do not have to agree - a second
       * of skew was enough to hide a row that had just been created,
       * which is exactly the row this is for.
       *
       * make_interval with an explicit ::int also removes the other
       * ambiguity: `($2 || ' minutes')::interval` reads correctly and
       * matched nothing, because the bound parameter arrives untyped.
       */
      [candidateId, Math.max(0, Number(minutes) || 0), Math.min(Number(limit) || 20, 50)]);
    return rows;
  });
}

/** The open application for one candidate and one job, if there is one. */
export async function findApplication(session, candidateId, externalJobId) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select a.*, j.title, j.company, j.location, j.original_publisher,
              j.application_url as job_url, s.name as source_name,
              st.label as status_label
         from external_applications a
         join external_jobs j on j.id = a.external_job_id
         join job_sources  s on s.id = a.source_id
         join external_application_statuses st on st.id = a.status
        where a.candidate_id = $1 and a.external_job_id = $2`,
      [candidateId, externalJobId]);
    return rows[0] || null;
  });
}

/**
 * What happened after the click, by publisher.
 *
 * Every "applied" counted here is the candidate's own word. The query
 * says so by name - `applied_confirmed_by_candidate` - so a report built
 * on it cannot quietly relabel the column.
 */
export async function conversionBySource(session) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select coalesce(nullif(btrim(j.original_publisher), ''), s.name, 'Unknown') as publisher,
              count(*)::int as clicked_total,
              count(*) filter (where a.status = 'applied_unconfirmed')::int
                as applied_confirmed_by_candidate,
              count(*) filter (where a.status = 'not_applied')::int as not_applied,
              count(*) filter (where a.status = 'clicked')::int as awaiting_answer,
              round(avg(extract(epoch from (a.confirmed_at - a.created_at)) / 60)
                    filter (where a.confirmed_at is not null))::int
                as avg_minutes_to_confirm
         from external_applications a
         join external_jobs j on j.id = a.external_job_id
         join job_sources  s on s.id = a.source_id
        group by 1
        order by clicked_total desc`);

    return rows.map((r) => ({
      publisher: r.publisher,
      clicked: r.clicked_total,
      appliedConfirmedByCandidate: r.applied_confirmed_by_candidate,
      notApplied: r.not_applied,
      awaitingAnswer: r.awaiting_answer,
      /* Of the clicks that got an answer either way. A rate over all
         clicks would fall every time somebody simply has not replied
         yet, which is not the source's fault. */
      confirmRate: (r.applied_confirmed_by_candidate + r.not_applied) > 0
        ? Math.round(100 * r.applied_confirmed_by_candidate
            / (r.applied_confirmed_by_candidate + r.not_applied))
        : null,
      avgMinutesToConfirm: r.avg_minutes_to_confirm,
    }));
  });
}

/** One line straight into the trail - used for the first click, which
    is not a transition and so never passes through markApplication. */
export async function logApplication(session, id, { from = null, to, actor = 'candidate',
  actorId = null, note = null } = {}) {
  return withUser(session, (c) => c.query(
    `select external_application_log($1,$2,$3,$4,$5,$6)`,
    [id, from, to, actor, actorId, note]));
}

/** The candidate's own note. Theirs, capped, and never interpreted. */
export async function setApplicationNotes(session, id, notes) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select (external_application_notes($1,$2)).*`,
      [id, notes == null ? null : String(notes).slice(0, 500)]);
    return rows[0] || null;
  });
}

/** The lifecycle of one application, for support. Never shown to the
    candidate as evidence that anything was checked. */
export async function applicationLog(session, id) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select from_status, to_status, actor, actor_id, note, created_at
         from external_application_status_log
        where application_id = $1
        order by created_at asc limit 100`, [id]);
    return rows;
  });
}

export async function getApplication(session, id) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select a.*, j.title, j.company, j.location, j.external_job_id as source_job_id,
              s.name as source_name, s.application_method, s.credential_env, s.feed_url,
              st.label as status_label
         from external_applications a
         join external_jobs j on j.id = a.external_job_id
         join job_sources  s on s.id = a.source_id
         join external_application_statuses st on st.id = a.status
        where a.id = $1`, [id]);
    return rows[0] || null;
  });
}

/**
 * The recruiter's read-only list (§10) and the candidate's own list (§9),
 * which are the same query with a different filter.
 */
export async function listApplications(session, { candidateId = null, limit = 200 } = {}) {
  return withUser(session, async (c) => {
    const params = [];
    let where = '';
    if (candidateId) { params.push(candidateId); where = `where a.candidate_id = $${params.length}`; }
    params.push(Math.min(Number(limit) || 200, 500));

    const { rows } = await c.query(
      `select a.*, c.name as candidate_name, c.email as candidate_email,
              j.title, j.company, j.location, j.application_url as job_url,
              j.external_job_id as source_job_id,
              s.name as source_name, s.application_method,
              st.label as status_label
         from external_applications a
         join candidates    c  on c.id  = a.candidate_id
         join external_jobs j  on j.id  = a.external_job_id
         join job_sources   s  on s.id  = a.source_id
         join external_application_statuses st on st.id = a.status
         ${where}
        order by coalesce(a.submitted_at, a.created_at) desc, a.id
        limit $${params.length}`, params);
    return rows;
  });
}

export async function listStatuses(session) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select * from external_application_statuses order by sort_order`);
    return rows;
  });
}

/**
 * Counts, for the recruiter header and for the integrity check.
 *
 * Deliberately counts ONLY external tables. If this ever needs a number
 * out of `applications` to make sense, something has gone wrong with the
 * separation.
 */
export async function counts(session) {
  return withUser(session, async (c) => {
    const { rows } = await c.query(
      `select (select count(*) from job_sources)                    as sources,
              (select count(*) from job_sources where active)       as active_sources,
              (select count(*) from external_jobs where status='open') as open_jobs,
              (select count(*) from external_jobs where duplicate_of is not null) as duplicates,
              (select count(*) from candidate_external_job_matches) as matches,
              (select count(*) from external_applications)          as applications`);
    return rows[0];
  });
}

/**
 * Remove a match that can no longer be justified.
 *
 * Re-running the matching must be able to TAKE AWAY as well as add: a
 * score computed under an older rule, or one the matcher now refuses to
 * give at all, has to stop being shown. Deleted rather than zeroed,
 * because a 0% row would still sit in the candidate's list.
 *
 * A dismissal is NOT resurrected by this: the row goes, and if the job
 * scores again later the candidate sees it again, which is the right
 * outcome for a posting that has changed.
 */
export async function dropMatch(session, candidateId, externalJobId) {
  return withUser(session, async (c) => {
    /* Through the definer function, like every other write to this
       table: `app_api` holds select and insert and deliberately nothing
       else, so a direct delete is refused with "permission denied". */
    const { rows } = await c.query(
      `select external_match_drop($1,$2) as gone`, [candidateId, externalJobId]);
    return rows[0]?.gone === true;
  });
}

/* ------------------------------------------------------------------ *
 * career boards
 *
 * Which companies' public Greenhouse and Lever boards to read. Data, not
 * code: a recruiter adds a company on the admin screen, and the next
 * sync collects from it.
 * ------------------------------------------------------------------ */

export async function listCareerBoards(session, { activeOnly = true } = {}) {
  return withUser(session, async (c) => (await c.query(
    `select id, name, platform, board_token, active
       from career_boards ${activeOnly ? 'where active' : ''}
      order by platform, lower(name)`)).rows);
}

export async function saveCareerBoard(session, b) {
  return withUser(session, async (c) => (await c.query(
    `select (career_board_save($1,$2,$3,$4,$5)).*`,
    [b.id || newId('cb'), b.name, b.platform, b.boardToken,
     b.active === undefined ? true : b.active === true])).rows[0]);
}

export async function removeCareerBoard(session, id) {
  return withUser(session, async (c) => (await c.query(
    `select career_board_delete($1) as gone`, [id])).rows[0]?.gone === true);
}
