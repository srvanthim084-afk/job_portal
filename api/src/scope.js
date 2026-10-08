/**
 * "Not yours" is 403, "not there" is 404 (0118).
 *
 * Row level security already hides what a person may not read: a query
 * for another team's job finds nothing. For a candidate or a visitor that
 * stays a 404 (they are not meant to learn what exists). For staff the
 * product's rule is different: opening a record that exists but belongs
 * to somebody else is a 403, and nothing from the record is returned.
 *
 * app_row_exists() answers only yes or no.
 */
import { withUser } from './db.js';
import { forbidden } from './errors.js';

export const STAFF_ROLES = ['recruiter', 'bde', 'admin'];

/**
 * The error to throw when a record was not visible: a 403 when it exists
 * and the caller is staff, otherwise the given 404.
 *   throw await hiddenError(req.session, 'job', id, notFoundError)
 */
export async function hiddenError(session, kind, id, notFoundError) {
  if (!session || !STAFF_ROLES.includes(session.role) || session.role === 'admin') return notFoundError;
  const exists = await withUser(session, async (c) =>
    (await c.query(`select app_row_exists($1,$2) as e`, [kind, String(id).slice(0, 64)])).rows[0].e);
  return exists ? forbidden('You do not have access to this record.') : notFoundError;
}
