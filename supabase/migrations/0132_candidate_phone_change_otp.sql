-- ---------------------------------------------------------------------
-- 0132 - a candidate changes their mobile number only by answering an OTP
--        sent to the NEW number
--
-- The mobile number is a sign-in identity (0071: candidates sign in with it)
-- and where every SMS goes, so a typo or somebody else's number must not be
-- saved. The candidate asks for a code for the new number; the number on the
-- record changes - and mobile_verified becomes true - only when that code is
-- answered. Until then the old number stays exactly as it was.
--
-- Same rules as the registration OTP (0123): the code is stored hashed,
-- valid for the minutes the API gives (5), 5 tries, one every 30 seconds,
-- 5 an hour. No table grants: every read and write goes through a definer
-- function, and the API passes the candidate from the signed-in session.
-- ---------------------------------------------------------------------
create table if not exists candidate_phone_otps (
  id            bigserial primary key,
  candidate_id  text not null references candidates(id) on delete cascade,
  phone         text not null,                 -- last 10 digits of the NEW number
  code_hash     text not null,
  attempts      int not null default 0,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists cpotp_by_candidate on candidate_phone_otps (candidate_id, created_at desc);

alter table candidate_phone_otps enable row level security;
alter table candidate_phone_otps force  row level security;
/* No policies: nobody reads or writes it directly. */

/* Issue a code for a new number. Returns n >= 1 (the n-th this hour), -1 too many this hour,
   -2 no such candidate, -3 asked again within 30 seconds. */
create or replace function candidate_phone_otp_issue(
  p_candidate text, p_phone text, p_code_hash text, p_minutes int default 5)
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int; v_phone text := registration_phone10(p_phone);
begin
  if not exists (select 1 from candidates where id = p_candidate) then return -2; end if;
  if exists (select 1 from candidate_phone_otps
              where candidate_id = p_candidate and created_at > now() - interval '30 seconds') then
    return -3;
  end if;
  select count(*) into v_n from candidate_phone_otps
   where candidate_id = p_candidate and created_at > now() - interval '1 hour';
  if v_n >= 5 then return -1; end if;

  update candidate_phone_otps set used_at = now() where candidate_id = p_candidate and used_at is null;
  insert into candidate_phone_otps (candidate_id, phone, code_hash, expires_at)
  values (p_candidate, v_phone, p_code_hash, now() + make_interval(mins => greatest(1, p_minutes)));
  return v_n + 1;
end $$;

/* Check a code; on success the record takes the new number. Returns ok | wrong | expired | locked | none. */
create or replace function candidate_phone_otp_check(p_candidate text, p_phone text, p_code_hash text)
returns text
language plpgsql security definer set search_path = public as $$
declare c candidate_phone_otps; v_phone text := registration_phone10(p_phone);
begin
  select * into c from candidate_phone_otps
   where candidate_id = p_candidate and phone = v_phone and used_at is null
   order by created_at desc limit 1;
  if not found then return 'none'; end if;
  if c.expires_at < now() then return 'expired'; end if;
  if c.attempts >= 5 then return 'locked'; end if;
  if c.code_hash <> p_code_hash then
    update candidate_phone_otps set attempts = attempts + 1 where id = c.id;
    return case when c.attempts + 1 >= 5 then 'locked' else 'wrong' end;
  end if;
  update candidate_phone_otps set used_at = now() where id = c.id;
  /* written the way the portal shows Indian numbers (+91 98450 11223) */
  update candidates set phone = '+91 ' || substr(v_phone, 1, 5) || ' ' || substr(v_phone, 6, 5),
         mobile_verified = true, updated_at = now()
   where id = p_candidate;
  return 'ok';
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function
      candidate_phone_otp_issue(text, text, text, int),
      candidate_phone_otp_check(text, text, text)
      to app_api;
  end if;
end $$;
