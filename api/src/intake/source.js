/**
 * Which job board sent this, and how to read it.
 *
 * The intake understood Naukri and nothing else - the sender domains,
 * the subject patterns and the keywords were all Naukri's, so a Shine
 * response landing in the same mailbox scored too low to be looked at
 * and was filed as "not an application". A recruiter using both boards
 * saw half their candidates.
 *
 * Detection is by SENDER FIRST, because that is the fact that cannot be
 * faked by a candidate writing "Naukri" in their covering note. Subject
 * and body are the fallback for a forwarded message, where the original
 * sender is gone from the envelope.
 *
 * ONE HONEST CAVEAT, recorded here rather than discovered later: the
 * Naukri shapes below were built against real emails from a live
 * mailbox. The Shine shapes were not - no Shine message has been seen
 * yet. They follow Shine's documented labelled format and the same
 * labelled-block parser that already reads Naukri's per-candidate
 * mails, so they are a reasonable reading rather than a guess - but
 * `verified` says which is which, and nothing here pretends otherwise.
 */

export const SOURCES = {
  naukri: {
    id: 'naukri',
    label: 'Naukri',
    verified: true,
    domains: ['naukri.com', 'infoedge.com', 'resdex.com'],
    subject: [
      'naukri', 'responses received', 'candidates applied',
      'application received', 'candidate applied', 'resume for',
    ],
    body: ['naukri', 'top candidates who applied', 'candidates applied to your job'],
  },
  shine: {
    id: 'shine',
    label: 'Shine',
    verified: false,
    domains: ['shine.com', 'my.shine.com', 'shinemail.com', 'shinelearning.in'],
    subject: [
      'shine', 'new application', 'applied for', 'job application',
      'candidate response', 'applicant details',
    ],
    body: ['shine.com', 'shine job', 'applicant details', 'candidate details'],
  },
};

const lc = (v) => String(v || '').toLowerCase();

/** The address inside "Name <a@b.c>". */
function addressOf(from) {
  const m = /<([^>]+)>/.exec(String(from || ''));
  return lc(m ? m[1] : from);
}

/**
 * Which board sent this message.
 *
 * @returns {{ id, label, verified, why }|null}
 */
export function detectSource(message) {
  const from = addressOf(message && message.from);
  const subject = lc(message && message.subject);
  const body = lc((message && (message.text || message.raw)) || '').slice(0, 20000);

  // The sender is the strongest signal and the hardest to fake.
  for (const key of Object.keys(SOURCES)) {
    const s = SOURCES[key];
    if (s.domains.some((d) => from.endsWith('@' + d) || from.endsWith('.' + d))) {
      return { ...s, why: `sent by ${from}` };
    }
  }

  /*
   * A forwarded message has the recruiter's own address on the envelope,
   * so the board only survives in the text. Two hits are required, not
   * one: a candidate who writes "I found this on Shine" in a covering
   * note is not a Shine response.
   */
  for (const key of Object.keys(SOURCES)) {
    const s = SOURCES[key];
    let hits = 0;
    if (s.subject.some((p) => subject.includes(p))) hits++;
    if (s.body.some((p) => body.includes(p))) hits++;
    if (s.domains.some((d) => body.includes(d))) hits++;
    if (hits >= 2) return { ...s, why: 'named in the subject and body' };
  }

  return null;
}

/**
 * The rules the existing classifier should use for this message.
 *
 * Merges the detected board's patterns into the defaults, so a Shine
 * email is scored against Shine's wording rather than Naukri's.
 */
export function rulesFor(source, defaults) {
  if (!source) return defaults;
  return {
    ...defaults,
    senderDomains: [...new Set([...(defaults.senderDomains || []), ...source.domains])],
    subjectPatterns: [...new Set([...(defaults.subjectPatterns || []), ...source.subject])],
    bodyKeywords: [...new Set([...(defaults.bodyKeywords || []), ...source.body])],
  };
}

/** Does this sync want this message? `all` wants everything. */
export function wantedBy(provider, source) {
  const want = lc(provider || 'all');
  if (!want || want === 'all') return true;
  return !!source && source.id === want;
}
