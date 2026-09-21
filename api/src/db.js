/**
 * Database access.
 *
 * Every application query runs inside `withUser`, which opens a
 * transaction and binds the caller's identity to it:
 *
 *     set_config('app.user_id', <uuid>, true)   -- `true` = transaction-local
 *     set_config('app.role',    <role>, true)
 *
 * The policies in 0002_rls.sql read those two settings. Because the pool
 * connects as the unprivileged `app_api` role, the database re-checks every
 * row against them — so a missing permission check in a route handler
 * cannot leak another tenant's data. That is the point of requirement 5's
 * "not only frontend hiding".
 *
 * The settings are transaction-LOCAL, so a pooled connection handed to the
 * next request never carries the previous caller's identity.
 */
import pg from 'pg';
import { config } from './config.js';

// Postgres returns numerics as strings to avoid precision loss. The
// prototype does arithmetic on salaries and scores, so parse them.
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10))); // int8

// DATE (oid 1082) stays a plain 'YYYY-MM-DD' string.
//
// By default node-postgres turns it into a JS Date at LOCAL midnight. Any
// server east of UTC then formats it back a day early — an interview booked
// for the 15th is stored correctly and displayed as the 14th. A calendar
// date has no time zone, so it should never become an instant at all.
pg.types.setTypeParser(1082, (v) => v);

let pool = null;

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: config.dbPoolMax,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined,
    });

    // Optional privilege drop on every new connection.
    //
    // Preferred deployment is to connect AS app_api directly. This exists
    // for the case where the platform hands you a privileged connection
    // string you cannot change (several managed Postgres products do), and
    // for the test harness. SET ROLE changes current_user, and RLS is
    // evaluated against current_user — so after this the policies apply.
    // SET ROLE cannot take a bind parameter, so the name is whitelisted by
    // pattern rather than escaped — the only safe way to interpolate an
    // identifier. Validated once here; applied per-transaction in withUser.
    if (config.dbRole && !/^[a-z_][a-z0-9_]{0,62}$/i.test(config.dbRole)) {
      throw new Error(`DB_ROLE "${config.dbRole}" is not a valid role name.`);
    }

    pool.on('error', (err) => console.error('[db] idle client error:', err.message));
  }
  return pool;
}

/**
 * Refuses to start if the API is pointed at a privileged role.
 *
 * A superuser (or a role with BYPASSRLS) ignores every policy, which would
 * silently turn the whole security model off while everything still
 * appeared to work. Failing loudly at boot is the only safe behaviour.
 */
export async function assertUnprivileged(client) {
  // Check the role the application will ACTUALLY run as. With DB_ROLE set
  // the connection may start privileged and drop per transaction, so
  // inspecting the raw connection would report the wrong answer.
  if (config.dbRole) {
    await client.query('begin');
    await client.query(`set local role "${config.dbRole}"`);
  }
  const { rows } = await client.query(`
    select current_user as who,
           coalesce((select rolsuper      from pg_roles where rolname = current_user), false) as super,
           coalesce((select rolbypassrls  from pg_roles where rolname = current_user), false) as bypass`);
  if (config.dbRole) await client.query('rollback');

  const r = rows[0];
  if (r.super || r.bypass) {
    throw new Error(
      `DATABASE_URL connects as "${r.who}" (superuser=${r.super}, bypassrls=${r.bypass}). ` +
      `Row-level security does not apply to such roles, so every access policy would be ` +
      `silently disabled. Connect as app_api instead (see supabase/migrations/0004_roles.sql).`
    );
  }
  return r.who;
}

/**
 * Runs `fn` in a transaction bound to `session` ({ userId, role }).
 * Pass null for an anonymous caller — the public job board still works,
 * governed by the anon branch of the policies.
 */
export async function withUser(session, fn) {
  const client = await getPool().connect();
  try {
    await client.query('begin');

    // Drop privileges INSIDE the transaction, not on connect.
    //
    // A connection-level SET ROLE looks equivalent but is not: it survives
    // release back into the pool, so any code that later runs RESET ROLE
    // on a borrowed client silently hands the next request a superuser
    // connection — with RLS disabled and everything still appearing to
    // work. SET LOCAL is scoped to this transaction and cannot leak.
    if (config.dbRole) {
      await client.query(`set local role "${config.dbRole}"`);
    }

    // parameterised, never interpolated — these values come from a cookie
    await client.query(
      `select set_config('app.user_id', $1, true), set_config('app.role', $2, true)`,
      [session?.userId ?? '', session?.role ?? 'anon']
    );
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    try { await client.query('rollback'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

/** Convenience for a single query as one identity. */
export async function query(session, sql, params) {
  return withUser(session, (c) => c.query(sql, params));
}

export async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}
