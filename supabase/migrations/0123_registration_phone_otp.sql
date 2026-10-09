-- ---------------------------------------------------------------------
-- 0123 — the mobile number is verified by a one-time code before an account
--        is created from a resume
--
-- The registration draft (0117) already proves the EMAIL with a code. The
-- one-screen registration verifies the MOBILE NUMBER instead, so the
-- draft now remembers which number answered a code and when
-- (`phone`, `phone_verified_at`), and a table keeps the codes themselves
-- (hash only, 10 minutes, 5 tries, 5 codes an hour, one every 30 seconds).
--
-- The account is created by POST /auth/register, which refuses a draft whose
-- verified number is not the number being registered - so the step cannot be
-- skipped by calling the API directly.
--
-- Same shape as the email code: no table grants, every read and write goes
-- through a token-checked function.
-- ---------------------------------------------------------------------

alter table registration_drafts
  add column if not exists phone text,
  add column if not exists phone_verified_at timestamptz;

create table if not exists registration_phone_otps (
  id          bigserial primary key,
  draft_id    text not null references registration_drafts(id) on delete cascade,
  phone       text not null,                 -- last 10 digits
  code_hash   text not null,
  attempts    int not null default 0,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists rotp_by_draft on registration_phone_otps (draft_id, created_at desc);

alter table registration_phone_otps enable row level security;
alter table registration_phone_otps force  row level security;
/* No policies: nobody reads or writes it directly. */

/* last ten digits of whatever was typed: +91 98765 43210, 09876543210 and 9876543210 are one number */
create or replace function registration_phone10(p text) returns text
language sql immutable as $$ select right(regexp_replace(coalesce(p, ''), '\D', '', 'g'), 10) $$;

/* Issue a code. Returns: n >= 1 issued (the n-th this hour), -1 too many this hour,
   -2 the draft is gone, -3 asked again within 30 seconds. */
create or replace function registration_phone_otp_issue(
  p_id text, p_token_hash text, p_phone text, p_code_hash text, p_minutes int default 10)
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int; v_phone text := registration_phone10(p_phone);
begin
  if not exists (select 1 from registration_drafts
                  where id = p_id and token_hash = p_token_hash
                    and expires_at > now() and status <> 'converted') then
    return -2;
  end if;
  if exists (select 1 from registration_phone_otps
              where draft_id = p_id and created_at > now() - interval '30 seconds') then
    return -3;
  end if;
  select count(*) into v_n from registration_phone_otps
   where draft_id = p_id and created_at > now() - interval '1 hour';
  if v_n >= 5 then return -1; end if;

  update registration_phone_otps set used_at = now() where draft_id = p_id and used_at is null;
  insert into registration_phone_otps (draft_id, phone, code_hash, expires_at)
  values (p_id, v_phone, p_code_hash, now() + make_interval(mins => greatest(1, p_minutes)));
  /* a different number than the verified one is NOT verified */
  update registration_drafts
     set phone = v_phone,
         phone_verified_at = case when registration_phone10(phone) = v_phone then phone_verified_at else null end,
         updated_at = now()
   where id = p_id;
  return v_n + 1;
end $$;

/* Check a code. Returns ok | wrong | expired | locked | none. */
create or replace function registration_phone_otp_check(
  p_id text, p_token_hash text, p_phone text, p_code_hash text)
returns text
language plpgsql security definer set search_path = public as $$
declare c registration_phone_otps; v_phone text := registration_phone10(p_phone);
begin
  if not exists (select 1 from registration_drafts
                  where id = p_id and token_hash = p_token_hash
                    and expires_at > now() and status <> 'converted') then
    return 'none';
  end if;
  select * into c from registration_phone_otps
   where draft_id = p_id and phone = v_phone and used_at is null
   order by created_at desc limit 1;
  if not found then return 'none'; end if;
  if c.expires_at < now() then return 'expired'; end if;
  if c.attempts >= 5 then return 'locked'; end if;
  if c.code_hash <> p_code_hash then
    update registration_phone_otps set attempts = attempts + 1 where id = c.id;
    return case when c.attempts + 1 >= 5 then 'locked' else 'wrong' end;
  end if;
  update registration_phone_otps set used_at = now() where id = c.id;
  update registration_drafts
     set phone = v_phone, phone_verified_at = now(), updated_at = now()
   where id = p_id;
  return 'ok';
end $$;

/* The draft becomes the candidate: as 0117, and the mobile number is marked verified when it was. */
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
    mobile_verified         = (d.phone_verified_at is not null
                               and registration_phone10(d.phone) = registration_phone10(phone)),
    profile_field_sources   = coalesce(p_sources, '{}'::jsonb),
    updated_at              = now()
  where id = p_candidate_id;

  update registration_drafts
     set status = 'converted', candidate_id = p_candidate_id,
         converted_at = now(), updated_at = now()
   where id = p_id;

  return to_jsonb(d) - 'token_hash' - 'resume_text';
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      registration_phone_otp_issue(text, text, text, text, int),
      registration_phone_otp_check(text, text, text, text),
      registration_draft_convert(text, text, text, jsonb)
      to app_api;
  end if;
end $$;
