/**
 * Changing a candidate's mobile number (0132): an OTP to the NEW number first.
 *
 *   POST /api/me/phone-otp     { phone }        send a 6-digit OTP by SMS to the new number (5 minutes)
 *   POST /api/me/phone-verify  { phone, code }  answer it; the profile takes the new number
 *
 * Signed-in candidates only, for themselves: the candidate comes from the session, never from the body.
 * The number on the profile does not change until the code is answered - PUT /candidates/:id and the
 * profile wizard refuse a candidate's own phone change (they point here). Staff editing a candidate's
 * record are not affected.
 *
 * Real SMS through the configured provider (registration/sms-otp.js); when none is configured the
 * candidate is told, and nothing pretends to have been sent.
 */
import { Router } from 'express';
import { randomInt, createHash } from 'node:crypto';
import { withUser } from '../db.js';
import { wrap, badRequest, ApiError, CODES } from '../errors.js';
import { requireAuth, requireRole } from '../auth.js';
import { validIndianMobile } from '../registration/settings.js';
import { sendOtpSms, OTP_MINUTES } from '../registration/sms-otp.js';
import { toCandidate } from '../shapes.js';

const last10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const codeHash = (candidateId, code) => createHash('sha256').update(`phone-change:${candidateId}:${code}`).digest('hex');

export default function phoneChangeRoutes() {
  const r = Router();

  async function current(session) {
    return withUser(session, async (c) => (await c.query(
      `select id, phone from candidates where id = $1`, [session.profileId])).rows[0]);
  }

  async function takenByOther(candidateId, phone) {
    return withUser(null, async (c) => {
      const { rows } = await c.query(`select * from auth_registration_taken($1,$2)`, ['', phone]);
      if (!(rows[0] && rows[0].phone_taken)) return false;
      /* the same number on this very candidate is not "someone else" */
      const mine = (await c.query(`select phone from candidates where id = $1`, [candidateId])).rows[0];
      return !(mine && last10(mine.phone) === last10(phone));
    });
  }

  r.post('/me/phone-otp', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const phone = String((req.body && req.body.phone) || '').trim();
    if (!validIndianMobile(phone)) {
      throw badRequest('Enter a valid 10-digit mobile number.', { phone: 'Enter a valid 10-digit mobile number.' });
    }
    const me = await current(req.session);
    if (!me) throw badRequest('Your profile could not be found.');
    if (last10(me.phone) === last10(phone)) {
      throw badRequest('That is already your mobile number.', { phone: 'That is already your mobile number.' });
    }
    if (await takenByOther(me.id, phone)) {
      throw new ApiError(409, 'PHONE_TAKEN', 'Another account already uses this mobile number.',
        { phone: 'Another account already uses this mobile number.' });
    }
    const code = String(randomInt(100000, 1000000));
    const n = await withUser(null, async (c) => (await c.query(
      `select candidate_phone_otp_issue($1,$2,$3,$4) as n`,
      [me.id, phone, codeHash(me.id, code), OTP_MINUTES])).rows[0].n);
    if (n === -3) throw new ApiError(429, CODES.RATE_LIMITED, 'Please wait 30 seconds before asking for another OTP.', { phone: 'Please wait 30 seconds before asking for another OTP.' });
    if (n === -1) throw new ApiError(429, CODES.RATE_LIMITED, 'Too many OTPs requested. Please try again in an hour.', { phone: 'Too many OTPs requested. Please try again in an hour.' });
    if (n < 0) throw badRequest('Your profile could not be found.');

    const out = await sendOtpSms(phone, code);
    res.json({ ...out, phone: last10(phone), minutes: OTP_MINUTES });
  }));

  r.post('/me/phone-verify', requireAuth(), requireRole('candidate'), wrap(async (req, res) => {
    const phone = String((req.body && req.body.phone) || '').trim();
    const code = String((req.body && req.body.code) || '').replace(/\D/g, '');
    if (!validIndianMobile(phone)) {
      throw badRequest('Enter a valid 10-digit mobile number.', { phone: 'Enter a valid 10-digit mobile number.' });
    }
    if (code.length !== 6) throw badRequest('Enter the 6-digit OTP', { code: 'Enter the 6-digit OTP' });
    const me = await current(req.session);
    if (!me) throw badRequest('Your profile could not be found.');
    if (await takenByOther(me.id, phone)) {
      throw new ApiError(409, 'PHONE_TAKEN', 'Another account already uses this mobile number.',
        { phone: 'Another account already uses this mobile number.' });
    }
    const result = await withUser(null, async (c) => (await c.query(
      `select candidate_phone_otp_check($1,$2,$3) as r`, [me.id, phone, codeHash(me.id, code)])).rows[0].r);
    const msg = {
      wrong: 'Invalid OTP', expired: 'That OTP has expired. Please request a new one.',
      locked: 'Too many wrong attempts. Please request a new OTP.', none: 'Please request an OTP first.',
    };
    if (result !== 'ok') throw badRequest(msg[result] || msg.none, { code: msg[result] || msg.none });
    const row = await withUser(req.session, async (c) => (await c.query(
      `select * from candidates where id = $1`, [me.id])).rows[0]);
    res.json({ ok: true, candidate: toCandidate(row) });
  }));

  return r;
}

/** A candidate changing their OWN number by any other route: refused, with the way to do it. */
export function refuseOwnPhoneChange(session, currentPhone, nextPhone) {
  if (!session || session.role !== 'candidate') return;
  if (nextPhone === undefined || nextPhone === null) return;
  if (last10(nextPhone) === last10(currentPhone)) return;
  throw badRequest('To change your mobile number, verify the new number with an OTP.',
    { phone: 'To change your mobile number, verify the new number with an OTP.' });
}
