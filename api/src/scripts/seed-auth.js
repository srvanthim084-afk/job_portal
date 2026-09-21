/**
 * Creates login accounts for the seeded profiles.
 *
 * Passwords are NEVER written into a migration — they are bcrypt-hashed
 * here at run time, from the environment or from a generated random value
 * that is printed once. This is what replaces the prototype's
 * ROLE_CREDENTIALS block, which shipped Admin@123 in plain JavaScript.
 *
 *   node src/scripts/seed-auth.js
 *
 * Reads optional SEED_<ROLE>_PASSWORD variables; anything not supplied
 * gets a strong random password printed to stdout once and never stored.
 */
import { randomBytes } from 'node:crypto';
import { config, assertConfig } from '../config.js';
import { getPool, closePool } from '../db.js';
import { hashPassword } from '../auth.js';

// profile table -> role, and the column holding the address people log in with
const ACCOUNTS = [
  { table: 'admins',       role: 'admin',     envKey: 'ADMIN' },
  { table: 'recruiters',   role: 'recruiter', envKey: 'RECRUITER' },
  { table: 'client_users', role: 'client',    envKey: 'CLIENT' },
  { table: 'candidates',   role: 'candidate', envKey: 'CANDIDATE' },
];

const strongPassword = () =>
  randomBytes(12).toString('base64url').replace(/[^A-Za-z0-9]/g, '') + 'a1';

async function main() {
  assertConfig();
  const pool = getPool();
  const client = await pool.connect();
  const created = [];

  try {
    await client.query('begin');

    for (const acc of ACCOUNTS) {
      const { rows } = await client.query(
        `select id, email, name from ${acc.table} where user_id is null order by id`);

      for (const profile of rows) {
        if (!profile.email) {
          console.warn(`  skip ${acc.table}.${profile.id} — no email on the profile`);
          continue;
        }

        const exists = await client.query(
          `select id from users where lower(email)=lower($1)`, [profile.email]);
        if (exists.rowCount) {
          await client.query(`update ${acc.table} set user_id=$1 where id=$2`,
            [exists.rows[0].id, profile.id]);
          console.log(`  link ${acc.table}.${profile.id} -> existing user`);
          continue;
        }

        // One shared password per role keeps the demo logins usable;
        // candidates each get their own.
        const envName = `SEED_${acc.envKey}_PASSWORD`;
        const plain = process.env[envName] || strongPassword();
        const hash = await hashPassword(plain);

        const ins = await client.query(
          `insert into users (email, password_hash, role) values ($1,$2,$3) returning id`,
          [profile.email, hash, acc.role]);
        await client.query(`update ${acc.table} set user_id=$1 where id=$2`,
          [ins.rows[0].id, profile.id]);

        created.push({
          role: acc.role, id: profile.id, email: profile.email,
          password: process.env[envName] ? '(from ' + envName + ')' : plain,
        });
      }
    }

    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }

  if (created.length) {
    console.log(`\nCreated ${created.length} account(s).`);
    console.log('These passwords are shown ONCE and are not stored anywhere in plain text:\n');
    for (const c of created) {
      console.log(`  ${c.role.padEnd(10)} ${String(c.email).padEnd(42)} ${c.password}`);
    }
    console.log('\nRecord them now, then change them from the app.');
  } else {
    console.log('Nothing to do — every seeded profile already has a login.');
  }

  await closePool();
}

main().catch(async (err) => {
  console.error('seed-auth failed:', err.message);
  await closePool().catch(() => {});
  process.exit(1);
});
