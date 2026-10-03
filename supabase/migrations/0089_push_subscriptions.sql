-- ---------------------------------------------------------------------
-- 0089 — phone notifications (Web Push)
--
-- A candidate's browser or installed app can receive saved-search alerts
-- as push notifications. One row per device subscription: the endpoint
-- the push service gave the browser, and the two keys the message is
-- encrypted with (RFC 8291). Nothing here is a credential of ours; the
-- server's own VAPID keys live in the environment.
--
-- A candidate reads and removes only their own devices. The alert engine
-- reads them through push_engine_subscriptions(), which admits only the
-- engine (role admin, no user id) - the same rule as saved searches.
-- ---------------------------------------------------------------------

create table if not exists push_subscriptions (
  id              text primary key,
  candidate_id    text not null references candidates(id) on delete cascade,
  endpoint        text not null unique check (endpoint ~ '^https?://'),
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_success_at timestamptz,
  failed_count    int not null default 0
);
create index if not exists push_subscriptions_candidate on push_subscriptions (candidate_id);

alter table push_subscriptions enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies
                  where tablename = 'push_subscriptions' and policyname = 'push_own') then
    create policy push_own on push_subscriptions for all
      using (candidate_id = app_candidate_id())
      with check (candidate_id = app_candidate_id());
  end if;
end $$;

/* A browser that subscribes again gets the same endpoint: that is the same
   device, so the row is refreshed rather than duplicated. A subscription
   moving to another candidate (shared phone, new login) moves with it. */
create or replace function push_subscribe(
  p_id text, p_endpoint text, p_p256dh text, p_auth text, p_user_agent text
) returns push_subscriptions
language plpgsql security definer set search_path = public as $$
declare v_cand text := app_candidate_id(); v_row push_subscriptions;
begin
  if v_cand is null then
    raise exception 'only a signed-in candidate can turn on phone notifications' using errcode = '42501';
  end if;
  insert into push_subscriptions (id, candidate_id, endpoint, p256dh, auth, user_agent)
  values (p_id, v_cand, p_endpoint, p_p256dh, p_auth, left(p_user_agent, 400))
  on conflict (endpoint) do update
     set candidate_id = v_cand, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, failed_count = 0
  returning * into v_row;
  return v_row;
end $$;

create or replace function push_engine_ok() returns boolean
language sql stable as $$ select app_role() = 'admin' and app_user_id() is null $$;

/** Every device of these candidates, for the alert engine. */
create or replace function push_engine_subscriptions(p_candidates text[])
returns setof push_subscriptions
language plpgsql security definer set search_path = public as $$
begin
  if not push_engine_ok() then
    raise exception 'push subscriptions are read by the alert engine only' using errcode = '42501';
  end if;
  return query select * from push_subscriptions where candidate_id = any(p_candidates);
end $$;

/**
 * What a send said about a device: delivered, gone (404/410: the browser
 * unsubscribed - delete it), or failed (count it; five in a row and it
 * is removed). Returns the row's state after the update.
 */
create or replace function push_engine_result(p_id text, p_outcome text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_failed int;
begin
  if not push_engine_ok() then
    raise exception 'push subscriptions are updated by the alert engine only' using errcode = '42501';
  end if;
  if p_outcome = 'sent' then
    update push_subscriptions set last_success_at = now(), failed_count = 0 where id = p_id;
    return 'kept';
  elsif p_outcome = 'gone' then
    delete from push_subscriptions where id = p_id;
    return 'deleted';
  else
    update push_subscriptions set failed_count = failed_count + 1 where id = p_id
      returning failed_count into v_failed;
    if v_failed >= 5 then
      delete from push_subscriptions where id = p_id;
      return 'deleted';
    end if;
    return 'kept';
  end if;
end $$;

/* "push" is a channel a saved search can choose, and a delivery can record. */
alter table candidate_saved_searches drop constraint if exists candidate_saved_searches_channels_check;
alter table candidate_saved_searches add constraint candidate_saved_searches_channels_check
  check (channels <@ array['email','sms','whatsapp','push']::text[]);
alter table candidate_saved_search_deliveries drop constraint if exists candidate_saved_search_deliveries_channel_check;
alter table candidate_saved_search_deliveries add constraint candidate_saved_search_deliveries_channel_check
  check (channel in ('email','sms','whatsapp','push'));

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'app_api') then
    grant select, delete on push_subscriptions to app_api;
    grant execute on function push_subscribe(text, text, text, text, text) to app_api;
    grant execute on function push_engine_subscriptions(text[]) to app_api;
    grant execute on function push_engine_result(text, text) to app_api;
  end if;
end $$;
