/**
 * Test harness: runs the REAL API against a REAL Postgres.
 *
 * PGlite is Postgres compiled to WASM; pglite-socket puts it behind the
 * actual wire protocol, so `pg.Pool` connects to it exactly as it would to
 * a production database. Nothing is mocked — the code under test is the
 * code that ships, including every RLS policy.
 *
 * The one accommodation: PGlite connects as a superuser, and superusers
 * bypass RLS. DB_ROLE=app_api makes the pool drop to the unprivileged role
 * on connect, which is what the policies are written against.
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from THIS FILE, not from cwd — the suite must behave the same
// whether it is run from api/ or from the repo root via npm --prefix.
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = resolve(HERE, '../../supabase/migrations');
const UPLOAD_DIR = resolve(HERE, '../var/test-uploads');

export async function startTestDb(port = 5433) {
  const db = await new PGlite();

  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  // app_api needs LOGIN to be reachable over the wire
  await db.exec(`alter role app_api login password 'test_only_password';`);

  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();

  return {
    db,
    port,
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}

/** Applies the env the API reads, before any of its modules are imported. */
export const MOCK_PROVIDER_PORT = 9877;

/**
 * A stand-in delivery provider.
 *
 * Without something that actually answers, the suite would only ever
 * prove that unconfigured and broken channels report themselves
 * correctly — the case where a message really is accepted would go
 * untested, which is the one everybody assumes works.
 */
export async function startMockProvider(port = MOCK_PROVIDER_PORT) {
  const { createServer } = await import('node:http');
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try { received.push({ url: req.url, body: JSON.parse(body || '{}') }); }
      catch { received.push({ url: req.url, body }); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock_' + received.length }));
    });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { received, stop: () => new Promise((r) => server.close(r)) };
}

export function applyTestEnv(dbUrl, extra = {}) {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: dbUrl,
    DB_ROLE: 'app_api',
    // pglite-socket serves one connection at a time (real Postgres does not)
    DB_POOL_MAX: '1',
    AUTH_SECRET: 'test-secret-that-is-definitely-long-enough-000000',
    PUBLIC_ORIGIN: 'http://127.0.0.1:9999',
    STORAGE_DRIVER: 'local',
    STORAGE_LOCAL_DIR: UPLOAD_DIR,
    BCRYPT_ROUNDS: '4',            // keep the suite fast; production uses 12
    LOGIN_RATE_LIMIT_MAX: '1000',
    RATE_LIMIT_MAX: '100000',
    // All three delivery states are exercised:
    //   sms       -> a mock provider that answers 200        => 'sent'
    //   whatsapp  -> a host that never answers               => 'failed'
    //   email +
    //   naukri    -> no credentials at all                   => 'not_configured'
    // Without the first of these the success path would never be tested.
    SMS_API_KEY: 'test-key',
    SMS_API_URL: `http://127.0.0.1:${MOCK_PROVIDER_PORT}/send`,
    WHATSAPP_API_KEY: 'test-key',
    WHATSAPP_PHONE_ID: '1234567890',
    WHATSAPP_API_URL: 'http://127.0.0.1:9',
    ...extra,
  });
}

/**
 * A tiny cookie-aware fetch client, so tests exercise the same
 * cookie + CSRF path a browser uses.
 */
export function makeClient(baseUrl) {
  const jar = new Map();

  const cookieHeader = () =>
    [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

  const absorb = (res) => {
    const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const idx = pair.indexOf('=');
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      if (v === '' ) jar.delete(k); else jar.set(k, v);
    }
  };

  async function call(method, path, body, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const cookies = cookieHeader();
    if (cookies) headers.cookie = cookies;
    if (jar.has('tl_csrf')) headers['x-csrf-token'] = jar.get('tl_csrf');

    let payload = body;
    if (body !== undefined && !(body instanceof FormData)) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const res = await fetch(baseUrl + path, { method, headers, body: payload });
    absorb(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
    return { status: res.status, body: json, headers: res.headers };
  }

  return {
    get:  (p, o)    => call('GET', p, undefined, o),
    post: (p, b, o) => call('POST', p, b, o),
    put:  (p, b, o) => call('PUT', p, b, o),
    del:  (p, o)    => call('DELETE', p, undefined, o),
    jar,
    clear: () => jar.clear(),
  };
}
