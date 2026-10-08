-- ---------------------------------------------------------------------
-- 0117 — the resume comes first, and it is kept from the first second
--
-- A candidate registering uploaded a resume, the page read it, and the
-- reading lived only in that browser tab until the account was created
-- three requests later. Close the tab, lose the network, fail one of the
-- three - and the resume and everything read out of it were gone, with a
-- half-made account or none at all.
--
-- A DRAFT, ON THE SERVER. The moment a resume is uploaded it becomes a
-- registration_drafts row: the file in storage, the text, what the
-- parser and the model read out of it, how sure each field is, and which
-- fields the candidate has to confirm. The browser holds only the
-- draft's id and a bearer token for it. Creating the account converts
-- the draft; nothing about a draft can create an account by itself.
--
-- THE EMAIL IS PROVED BEFORE THE ACCOUNT EXISTS. An address read from a
-- resume may be old or mistyped. A six-digit code goes to it, and the
-- account can only be created from a draft whose address answered.
--
-- WHERE EACH VALUE CAME FROM. candidates.profile_field_sources records,
-- per field, whether the resume supplied it (EXTRACTED) or the candidate
-- typed it (USER_PROVIDED), so "complete your profile" can ask for what
-- is genuinely missing and nothing else.
--
-- Drafts are never readable through a table grant: every read and write
-- goes through the functions below, which check the token. A draft
-- expires after seven days.
-- ---------------------------------------------------------------------

create table if not exists registration_drafts (
  id                  text primary key,
  token_hash          text not null,
  status              text not null default 'pending'
    check (status in ('pending', 'extracted', 'failed', 'converted')),
  resume_file         text,
  resume_storage_path text,
  resume_mime         text,
  resume_size         int,
  resume_sha256       text,
  resume_text         text,
  -- {fields, confidence, needsVerification, source, parser, chars, overall, aiError}
  extraction          jsonb not null default '{}'::jsonb,
  -- what the candidate confirmed or corrected, keyed like extraction.fields
  corrections         jsonb not null default '{}'::jsonb,
  extraction_code     text,
  extraction_error    text,
  attempts            int not null default 0,
  email               text,
  email_verified_at   timestamptz,
  candidate_id        text references candidates(id) on delete set null,
  converted_at        timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  expires_at          timestamptz not null default now() + interval '7 days'
);
create index if not exists rdraft_expires on registration_drafts (expires_at) where status <> 'converted';

create table if not exists registration_email_codes (
  id          bigserial primary key,
  draft_id    text not null references registration_drafts(id) on delete cascade,
  email       text not null,
  code_hash   text not null,
  attempts    int not null default 0,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists rcode_by_draft on registration_email_codes (draft_id, created_at desc);

alter table registration_drafts      enable row level security;
alter table registration_drafts      force  row level security;
alter table registration_email_codes enable row level security;
alter table registration_email_codes force  row level security;
/* No policies: nobody reads or writes these tables directly. */

alter table candidates
  add column if not exists profile_field_sources jsonb not null default '{}'::jsonb;

comment on column candidates.profile_field_sources is
  'Per profile field, EXTRACTED (read from the resume at registration) or USER_PROVIDED (typed by the candidate). A field not listed and empty is MISSING (0117).';

/* ---------------------------------------------------------------- *
 * create / read / update a draft, token-checked
 * ---------------------------------------------------------------- */
create or replace function registration_draft_save(p_id text, p_token_hash text, p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v registration_drafts;
begin
  select * into v from registration_drafts where id = p_id;
  if not found then
    insert into registration_drafts (id, token_hash) values (p_id, p_token_hash)
    returning * into v;
  elsif v.token_hash <> p_token_hash or v.expires_at < now() or v.status = 'converted' then
    return null;
  end if;

  update registration_drafts set
    status              = coalesce(p_data->>'status', status),
    resume_file         = case when p_data ? 'resume_file' then p_data->>'resume_file' else resume_file end,
    resume_storage_path = case when p_data ? 'resume_storage_path' then p_data->>'resume_storage_path' else resume_storage_path end,
    resume_mime         = case when p_data ? 'resume_mime' then p_data->>'resume_mime' else resume_mime end,
    resume_size         = case when p_data ? 'resume_size' then (p_data->>'resume_size')::int else resume_size end,
    resume_sha256       = case when p_data ? 'resume_sha256' then p_data->>'resume_sha256' else resume_sha256 end,
    resume_text         = case when p_data ? 'resume_text' then p_data->>'resume_text' else resume_text end,
    extraction          = case when p_data ? 'extraction' then p_data->'extraction' else extraction end,
    corrections         = case when p_data ? 'corrections' then corrections || (p_data->'corrections') else corrections end,
    extraction_code     = case when p_data ? 'extraction_code' then p_data->>'extraction_code' else extraction_code end,
    extraction_error    = case when p_data ? 'extraction_error' then p_data->>'extraction_error' else extraction_error end,
    attempts            = attempts + coalesce((p_data->>'attempt')::int, 0),
    -- a changed address must answer a code again
    email_verified_at   = case when p_data ? 'email'
                                and lower(coalesce(p_data->>'email', '')) <> lower(coalesce(email, ''))
                               then null else email_verified_at end,
    email               = case when p_data ? 'email' then nullif(btrim(p_data->>'email'), '') else email end,
    updated_at          = now()
  where id = p_id
  returning * into v;

  return to_jsonb(v) - 'token_hash';
end $$;

create or replace function registration_draft_read(p_id text, p_token_hash text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(d) - 'token_hash'
    from registration_drafts d
   where d.id = p_id and d.token_hash = p_token_hash
     and d.expires_at > now() and d.status <> 'converted'
$$;

/* ---------------------------------------------------------------- *
 * the email code: at most 5 sent per draft per hour, 5 tries each,
 * 10 minutes. Returns the number sent in the last hour, or -1 when
 * the limit is reached (nothing stored then).
 * ---------------------------------------------------------------- */
create or replace function registration_email_code_issue(
  p_id text, p_token_hash text, p_email text, p_code_hash text, p_minutes int default 10)
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not exists (select 1 from registration_drafts
                  where id = p_id and token_hash = p_token_hash
                    and expires_at > now() and status <> 'converted') then
    return -2;
  end if;
  select count(*) into v_n from registration_email_codes
   where draft_id = p_id and created_at > now() - interval '1 hour';
  if v_n >= 5 then return -1; end if;

  update registration_email_codes set used_at = now()
   where draft_id = p_id and used_at is null;
  insert into registration_email_codes (draft_id, email, code_hash, expires_at)
  values (p_id, lower(btrim(p_email)), p_code_hash, now() + make_interval(mins => greatest(1, p_minutes)));
  update registration_drafts
     set email = btrim(p_email),
         email_verified_at = case when lower(coalesce(email, '')) = lower(btrim(p_email))
                                  then email_verified_at else null end,
         updated_at = now()
   where id = p_id;
  return v_n + 1;
end $$;

/* 'ok' | 'wrong' | 'expired' | 'locked' | 'none' */
create or replace function registration_email_code_check(
  p_id text, p_token_hash text, p_email text, p_code_hash text)
returns text
language plpgsql security definer set search_path = public as $$
declare c registration_email_codes;
begin
  if not exists (select 1 from registration_drafts
                  where id = p_id and token_hash = p_token_hash
                    and expires_at > now() and status <> 'converted') then
    return 'none';
  end if;
  select * into c from registration_email_codes
   where draft_id = p_id and email = lower(btrim(p_email)) and used_at is null
   order by created_at desc limit 1;
  if not found then return 'none'; end if;
  if c.expires_at < now() then return 'expired'; end if;
  if c.attempts >= 5 then return 'locked'; end if;
  if c.code_hash <> p_code_hash then
    update registration_email_codes set attempts = attempts + 1 where id = c.id;
    return case when c.attempts + 1 >= 5 then 'locked' else 'wrong' end;
  end if;
  update registration_email_codes set used_at = now() where id = c.id;
  update registration_drafts
     set email = btrim(p_email), email_verified_at = now(), updated_at = now()
   where id = p_id;
  return 'ok';
end $$;

/* ---------------------------------------------------------------- *
 * convert: the account exists now. Links the draft, puts the resume
 * and its reading on the new record, marks the address verified, and
 * records where each value came from. Only a candidate created in the
 * last fifteen minutes, only once - the 0109 rule for writes made on
 * the anonymous connection at registration.
 * ---------------------------------------------------------------- */
create or replace function registration_draft_convert(
  p_id text, p_token_hash text, p_candidate_id text, p_sources jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare d registration_drafts;
begin
  select * into d from registration_drafts
   where id = p_id and token_hash = p_token_hash and status <> 'converted'
   for update;
  if not found then return null; end if;
  if not exists (select 1 from candidates
                  where id = p_candidate_id
                    and created_at > now() - interval '15 minutes'
                    and resume_storage_path is null) then
    return null;
  end if;

  update candidates set
    resume_file             = d.resume_file,
    resume_storage_path     = d.resume_storage_path,
    resume_mime             = d.resume_mime,
    resume_size             = d.resume_size,
    resume_uploaded_at      = d.created_at,
    resume_text             = d.resume_text,
    resume_parsed_at        = case when d.status = 'extracted' then d.updated_at else null end,
    resume_parser           = d.extraction->>'parser',
    resume_chars            = nullif(d.extraction->>'chars', '')::int,
    resume_fields_detected  = nullif(d.extraction->>'found', '')::int,
    resume_parse_confidence = nullif(d.extraction->>'overall', '')::int,
    resume_parse_error      = d.extraction_error,
    email_verified          = (d.email_verified_at is not null
                               and lower(coalesce(d.email, '')) = lower(coalesce(email, ''))),
    profile_field_sources   = coalesce(p_sources, '{}'::jsonb),
    updated_at              = now()
  where id = p_candidate_id;

  update registration_drafts
     set status = 'converted', candidate_id = p_candidate_id,
         converted_at = now(), updated_at = now()
   where id = p_id;

  return to_jsonb(d) - 'token_hash' - 'resume_text';
end $$;

/* Expired, never converted: returns the storage paths to remove. */
create or replace function registration_drafts_purge()
returns setof text
language plpgsql security definer set search_path = public as $$
begin
  return query
    delete from registration_drafts
     where expires_at < now() and status <> 'converted'
    returning resume_storage_path;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      registration_draft_save(text, text, jsonb),
      registration_draft_read(text, text),
      registration_email_code_issue(text, text, text, text, int),
      registration_email_code_check(text, text, text, text),
      registration_draft_convert(text, text, text, jsonb),
      registration_drafts_purge()
      to app_api;
  end if;
end $$;
