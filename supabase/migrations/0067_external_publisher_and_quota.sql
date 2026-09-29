-- ---------------------------------------------------------------------
-- 0067 — who actually published the advert, and not burning through a
--        paid API to find out
--
-- Four things the external-jobs tables could not express.
--
-- 1. WHO PUBLISHED IT. An aggregator hands back somebody else's advert:
--    JSearch names it in `job_publisher`, SerpApi in `via`, Jooble in
--    `source`. That name was being thrown away, so a card could only say
--    "via Remotive" when the truth was "found through JSearch, published
--    on Naukri". Attribution is not decoration - it is the condition
--    every one of these providers licenses their data under, and it is
--    the only way a candidate can tell where they are about to land.
--
-- 2. QUOTA. These APIs are metered, most of them monthly. A sync loop
--    with no idea how many calls it has already made will spend a
--    month's allowance in an afternoon and then look broken.
--
-- 3. THE SAME QUESTION, ASKED AGAIN. Search terms come from the
--    candidate pool, which barely changes between runs - so every sync
--    asked every source the same things and paid for the same answers.
--
-- 4. ONE VACANCY, SEVERAL BOARDS. A job found through three sources was
--    three rows or one row that forgot the other two. Neither is right:
--    the candidate wants one card, and the recruiter wants to know it
--    was seen in three places.
--
-- ADDITIVE ONLY. Nothing is dropped or renamed; every column is
-- nullable or defaulted, so every row already stored stays valid.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- the posting: who published it, and where it is
-- ---------------------------------------------------------------------
alter table external_jobs
  /*
   * The board the advert actually lives on, as the aggregator reported
   * it - "Naukri", "LinkedIn", the company's own careers page. NOT the
   * source we found it through, which is `source_id`. A card says
   * "via <publisher>" and the two are different facts.
   */
  add column if not exists original_publisher text,
  add column if not exists city    text,
  add column if not exists state   text,
  add column if not exists country text,
  /*
   * When this posting was last returned by a sync. `synced_at` already
   * records it and is kept; this is the name the rest of the brief uses
   * and is maintained alongside so neither reader has to know about the
   * other.
   */
  add column if not exists last_seen_at timestamptz;

update external_jobs set last_seen_at = synced_at where last_seen_at is null;

create index if not exists xjob_publisher_idx on external_jobs (original_publisher)
  where original_publisher is not null;

-- ---------------------------------------------------------------------
-- the source: a stable key, and what it is allowed to spend
-- ---------------------------------------------------------------------
alter table job_sources
  /*
   * A stable handle - "jsearch", "adzuna" - so a source can be named in
   * an API call or a cron argument without quoting a generated id. Not
   * unique-constrained as a column default because existing rows have
   * none; the partial unique index below does it without touching them.
   */
  add column if not exists key text,
  add column if not exists monthly_quota  int,
  add column if not exists monthly_used   int not null default 0,
  add column if not exists quota_reset_at timestamptz;

create unique index if not exists job_sources_key_uniq
  on job_sources (key) where key is not null;

/* Existing rows get their connector name as the key, which is what they
   would have been given. */
update job_sources set key = connector where key is null and connector is not null;

-- ---------------------------------------------------------------------
-- one vacancy, several boards
--
-- The canonical ExternalJob keeps its own row; every source it was also
-- seen through gets a line here with the apply URL THAT source gave,
-- because the two are rarely the same link.
-- ---------------------------------------------------------------------
create table if not exists external_job_sources (
  id              bigserial primary key,
  external_job_id text not null references external_jobs(id) on delete cascade,
  source_id       text not null references job_sources(id)   on delete cascade,
  apply_url       text,
  original_publisher text,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  unique (external_job_id, source_id)
);
create index if not exists xjs_job_idx on external_job_sources (external_job_id);

-- ---------------------------------------------------------------------
-- the same question, asked again
--
-- Search terms are built from the candidate pool, which barely moves
-- between runs. Without this, every sync paid every source for the same
-- answers. A hit inside the window skips the call entirely.
-- ---------------------------------------------------------------------
create table if not exists search_query_cache (
  id           bigserial primary key,
  source_id    text not null references job_sources(id) on delete cascade,
  query_hash   text not null,
  query        text,
  location     text,
  page         int  not null default 1,
  result_count int  not null default 0,
  fetched_at   timestamptz not null default now(),
  unique (source_id, query_hash)
);
create index if not exists sqc_fresh_idx on search_query_cache (source_id, fetched_at desc);

-- ---------------------------------------------------------------------
-- which companies' public boards to read
--
-- Greenhouse and Lever publish one board per company, so collecting from
-- them means knowing which companies. That list is DATA - a recruiter
-- adds a company - and lived in the source's Feed URL field as a
-- comma-separated string, which is a list pretending to be a URL.
-- ---------------------------------------------------------------------
create table if not exists career_boards (
  id          text primary key,
  name        text not null,
  platform    text not null check (platform in ('greenhouse', 'lever')),
  board_token text not null,
  active      boolean not null default true,
  added_by    uuid references users(id),
  created_at  timestamptz not null default now(),
  unique (platform, board_token)
);

-- ---------------------------------------------------------------------
-- who may read and write the three new tables
--
-- The same rule the rest of this feature follows: staff read, and the
-- only writer is the server through its own identity. A candidate has no
-- business in any of them - they see matches, not the machinery.
-- ---------------------------------------------------------------------
alter table external_job_sources enable row level security;
alter table external_job_sources force  row level security;
create policy xjs_read on external_job_sources for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde', 'candidate'));
create policy xjs_write on external_job_sources for all
  using (app_is_admin()) with check (app_is_admin());

alter table search_query_cache enable row level security;
alter table search_query_cache force  row level security;
create policy sqc_read on search_query_cache for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde'));
create policy sqc_write on search_query_cache for all
  using (app_is_admin()) with check (app_is_admin());

alter table career_boards enable row level security;
alter table career_boards force  row level security;
create policy cb_read on career_boards for select using (
  app_is_admin() or app_role() in ('recruiter', 'bde'));
create policy cb_write on career_boards for all
  using (app_is_admin()) with check (app_is_admin());

grant select on external_job_sources, search_query_cache, career_boards to app_api;
grant usage, select on sequence external_job_sources_id_seq to app_api;
grant usage, select on sequence search_query_cache_id_seq   to app_api;

-- ---------------------------------------------------------------------
-- the writes, through definer functions
--
-- Same shape as everything else in 0049: `app_api` may read these
-- tables and may not write them directly. Learnt the hard way in 0064
-- and 0066, where a direct write matched no rows, raised nothing, and
-- the feature silently did not work.
-- ---------------------------------------------------------------------
create or replace function external_job_source_seen(
  p_external_job_id text, p_source_id text, p_apply_url text, p_publisher text
) returns void
language sql security definer set search_path = public as $$
  insert into external_job_sources
    (external_job_id, source_id, apply_url, original_publisher)
  values (p_external_job_id, p_source_id, p_apply_url, p_publisher)
  on conflict (external_job_id, source_id) do update set
    apply_url = coalesce(excluded.apply_url, external_job_sources.apply_url),
    original_publisher = coalesce(excluded.original_publisher,
                                  external_job_sources.original_publisher),
    last_seen_at = now();
$$;

/** Has this exact question been asked recently enough to skip? */
create or replace function search_query_is_fresh(
  p_source_id text, p_query_hash text, p_hours int
) returns boolean
language sql security definer set search_path = public as $$
  select exists (
    select 1 from search_query_cache
     where source_id = p_source_id
       and query_hash = p_query_hash
       and fetched_at > now() - (greatest(1, coalesce(p_hours, 12)) || ' hours')::interval);
$$;

create or replace function search_query_record(
  p_source_id text, p_query_hash text, p_query text, p_location text,
  p_page int, p_count int
) returns void
language sql security definer set search_path = public as $$
  insert into search_query_cache
    (source_id, query_hash, query, location, page, result_count)
  values (p_source_id, p_query_hash, p_query, p_location,
          coalesce(p_page, 1), coalesce(p_count, 0))
  on conflict (source_id, query_hash) do update set
    query = excluded.query, location = excluded.location, page = excluded.page,
    result_count = excluded.result_count, fetched_at = now();
$$;

/**
 * Spend one source's quota, and refuse when it is gone.
 *
 * Returns the number of calls still allowed AFTER this one. A negative
 * result means the caller must not make the call. The monthly window
 * rolls over on its own, so nothing has to remember to reset it.
 */
create or replace function job_source_spend(p_source_id text, p_calls int)
returns int
language plpgsql security definer set search_path = public as $$
declare v job_sources;
begin
  select * into v from job_sources where id = p_source_id for update;
  if not found then return -1; end if;

  if v.quota_reset_at is null or v.quota_reset_at < now() then
    update job_sources
       set monthly_used = 0, quota_reset_at = date_trunc('month', now()) + interval '1 month'
     where id = p_source_id;
    v.monthly_used := 0;
  end if;

  /* No quota set means no limit: a public board costs nothing. */
  if v.monthly_quota is null then
    update job_sources set monthly_used = coalesce(monthly_used, 0) + coalesce(p_calls, 1)
     where id = p_source_id;
    return 2147483647;
  end if;

  if v.monthly_used + coalesce(p_calls, 1) > v.monthly_quota then
    return -1;
  end if;

  update job_sources set monthly_used = monthly_used + coalesce(p_calls, 1)
   where id = p_source_id;
  return v.monthly_quota - (v.monthly_used + coalesce(p_calls, 1));
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function external_job_source_seen(text, text, text, text) to app_api;
    grant execute on function search_query_is_fresh(text, text, int) to app_api;
    grant execute on function search_query_record(text, text, text, text, int, int) to app_api;
    grant execute on function job_source_spend(text, int) to app_api;
  end if;
end $$;
