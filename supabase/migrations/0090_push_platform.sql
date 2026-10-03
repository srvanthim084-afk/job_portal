-- ---------------------------------------------------------------------
-- 0090 — which kind of device a push subscription is
--
-- iPhone and iPad behave differently enough (Home Screen install first,
-- permission only from a tap, Apple's own push service) that the device
-- list and the support desk both need to know. Set from the browser's
-- user agent when it subscribes: 'ios', 'android' or 'desktop'.
-- A separate migration so 0089, already applied, is not edited.
-- ---------------------------------------------------------------------

alter table push_subscriptions
  add column if not exists platform text
    check (platform is null or platform in ('ios', 'android', 'desktop'));

create or replace function push_subscribe(
  p_id text, p_endpoint text, p_p256dh text, p_auth text, p_user_agent text, p_platform text
) returns push_subscriptions
language plpgsql security definer set search_path = public as $$
declare v_cand text := app_candidate_id(); v_row push_subscriptions;
begin
  if v_cand is null then
    raise exception 'only a signed-in candidate can turn on phone notifications' using errcode = '42501';
  end if;
  insert into push_subscriptions (id, candidate_id, endpoint, p256dh, auth, user_agent, platform)
  values (p_id, v_cand, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 400), p_platform)
  on conflict (endpoint) do update
     set candidate_id = v_cand, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, platform = excluded.platform, failed_count = 0
  returning * into v_row;
  return v_row;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant execute on function push_subscribe(text, text, text, text, text, text) to app_api;
  end if;
end $$;
