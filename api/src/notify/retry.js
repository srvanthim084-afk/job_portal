/**
 * Going back for the people a provider outage silently skipped.
 *
 * Every message is recorded, and a failure is recorded honestly. What was
 * missing is what happens next: while EmailJS refused server-side calls,
 * one candidate's application confirmation, AI interview invitation and
 * two-day deadline were all refused with a 403 - and when the setting was
 * fixed, nothing went back for them. From her side, TeamLink had simply
 * never written.
 *
 * A provider outage is the normal case for this, not the exception: a
 * rate limit, an expired token, a mail server down for an hour. Without a
 * retry, everybody who applied during that window is lost, and nobody
 * finds out until a candidate complains.
 *
 * NOT A REPLAY. The message sent is the one for the candidate's CURRENT
 * state, because a three-day-old "your interview is scheduled" is worse
 * than silence if the interview has since moved. The queue answers "who
 * never heard from us", and the answer to that is to tell them where
 * things stand now.
 */
import { withUser } from '../db.js';
import { dispatchEvent } from './events.js';
import { providers } from './providers.js';

const ENGINE = { userId: '', role: 'admin', profileId: null };

/** Which message suits an application sitting at this stage. */
function eventForStage(stage) {
  switch (stage) {
    case 'applied':
    case 'ai_screening':
      // They applied and never heard back at all: the invitation, with
      // its deadline, is the useful thing to send.
      return 'AI_INTERVIEW_INVITED';
    case 'shortlisted':
    case 'interview_scheduled':
    case 'ai_interview_done':
    case 'client_review':
      return 'STAGE_CHANGED';
    case 'offer_extended':
      return 'OFFER_EXTENDED';
    case 'selected':
    case 'rejected':
      return 'STAGE_CHANGED';
    default:
      return 'STAGE_CHANGED';
  }
}

/**
 * Retry everything that failed and has not since succeeded.
 *
 * @returns {Promise<{considered:number, sent:number, stillFailing:number}>}
 */
export async function retryFailedDeliveries({ channel = 'email', limit = 50 } = {}) {
  /*
   * A channel with no credentials is not retried at all.
   *
   * Retrying it would record `not_configured` again, and three of those
   * in a row spend the whole retry budget - so the day somebody finally
   * sets up WhatsApp, everybody who was waiting for it is already
   * excluded. Leaving the queue untouched is what keeps them in it.
   */
  if (!providers[channel] || !providers[channel].configured()) {
    return { considered: 0, sent: 0, stillFailing: 0, skipped: 0, notConfigured: true };
  }

  const rows = await withUser(ENGINE, async (c) => (await c.query(
    `select * from failed_deliveries_pending($1)`, [channel])).rows);

  const out = { considered: rows.length, sent: 0, stillFailing: 0, skipped: 0 };

  for (const row of rows.slice(0, limit)) {
    const event = eventForStage(row.stage);

    // The stage label the candidate would recognise, so a STAGE_CHANGED
    // message reads as an update rather than a code name.
    const label = await withUser(ENGINE, async (c) => (await c.query(
      `select label from stages where id=$1`, [row.stage])).rows[0]?.label) || row.stage;

    try {
      const res = await dispatchEvent(ENGINE, event, {
        applicationId: row.application_id,
        candidateId: row.candidate_id,
        jobId: row.job_id,
        stage: row.stage,
        stageLabel: label,
        retry: true,
        // Only the channel this queue is for; see dispatchEvent.
        channels: [channel],
      });

      const status = (res.delivery_status || {})[channel];
      if (status === 'sent' || status === 'delivered') out.sent++;
      else if (status === 'failed') out.stillFailing++;
      else out.skipped++;
    } catch (err) {
      out.stillFailing++;
      console.error(`[retry] ${row.application_id} failed again:`, err.message);
    }
  }

  return out;
}

/**
 * The background pass.
 *
 * Deliberately slow - every fifteen minutes, fifty at a time per
 * channel. The point is to catch up after an outage, and a burst of a
 * thousand messages the moment a provider recovers is its own kind of
 * failure.
 */
export function startRetrySweep() {
  const every = Number(process.env.DELIVERY_RETRY_MS || 15 * 60 * 1000);
  let stopped = false;
  let running = false;

  /*
   * Every channel, not just email.
   *
   * The sweep covered email alone, which left the other three with the
   * fault it was built to fix: an SMS gateway down for an hour dropped
   * every message in that window and nothing went back for them. A
   * candidate who only reads WhatsApp heard nothing at all.
   *
   * A channel with no credentials costs one query and returns an empty
   * queue, so there is nothing to gain by naming the configured ones.
   */
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      for (const channel of ['email', 'sms', 'whatsapp', 'ivr']) {
        const out = await retryFailedDeliveries({ channel });
        if (out.sent || out.stillFailing) {
          console.log(`[retry] ${channel}: ${out.sent} delivered on a later attempt`
            + (out.stillFailing ? `, ${out.stillFailing} still failing` : ''));
        }
      }
    } catch (err) {
      console.error('[retry] the sweep failed:', err.message);
    } finally {
      running = false;
    }
  };

  const first = setTimeout(run, Number(process.env.DELIVERY_RETRY_FIRST_MS || 60_000));
  const timer = setInterval(run, every);
  first.unref?.();
  timer.unref?.();

  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
