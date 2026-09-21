/**
 * Creates the first administrator, exactly as docs/DEPLOYMENT.md step 6
 * describes: insert the admin profile, then hash a password into `users`.
 *
 * Run once, BEFORE the API starts. It opens a single connection and closes
 * it cleanly, which matters against the embedded staging database — that
 * server handles one connection at a time and does not recover from one
 * that is abandoned.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... node tools/staging-seed-admin.mjs
 */
import pg from 'pg';
import bcrypt from '../api/node_modules/bcryptjs/index.js';

const URL = process.env.ADMIN_DATABASE_URL
  || 'postgres://postgres:postgres@127.0.0.1:5440/postgres';
const EMAIL = process.env.ADMIN_EMAIL || 'admin@teamlink.local';
const PASSWORD = process.env.ADMIN_PASSWORD;
const NAME = process.env.ADMIN_NAME || 'Platform Administrator';

if (!PASSWORD || PASSWORD.length < 10) {
  console.error('ADMIN_PASSWORD is required and must be at least 10 characters.');
  process.exit(1);
}

const c = new pg.Client({ connectionString: URL });
await c.connect();

try {
  await c.query(
    `insert into admins (id, name, email, title, initials)
     values ('a1', $1, $2, 'Platform Administrator', 'PA')
     on conflict (id) do update set name = excluded.name, email = excluded.email`,
    [NAME, EMAIL]);

  const existing = await c.query(`select id from users where lower(email)=lower($1)`, [EMAIL]);
  const hash = await bcrypt.hash(PASSWORD, 12);

  let userId;
  if (existing.rowCount) {
    userId = existing.rows[0].id;
    await c.query(`update users set password_hash=$1, role='admin' where id=$2`, [hash, userId]);
    console.log(`  updated the password for ${EMAIL}`);
  } else {
    const r = await c.query(
      `insert into users (email, password_hash, role) values ($1,$2,'admin') returning id`,
      [EMAIL, hash]);
    userId = r.rows[0].id;
    console.log(`  created ${EMAIL} as an admin`);
  }
  await c.query(`update admins set user_id=$1 where id='a1'`, [userId]);

  const check = await c.query(`
    select a.id, a.email, u.role, (u.password_hash like '$2%') as hashed
      from admins a join users u on u.id = a.user_id where a.id='a1'`);
  const row = check.rows[0];
  console.log(`  verified: ${row.email} · role=${row.role} · bcrypt=${row.hashed}`);
} finally {
  // Closing cleanly is the whole point — see the header note.
  await c.end();
}
