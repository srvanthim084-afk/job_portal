/**
 * One structured call to Claude, for the small AI helpers (resume tips,
 * voice search). Returns parsed JSON or throws - the callers fall back to
 * their rules engines and SAY so (engine: "rules"); nothing here pretends
 * a model answered when it did not.
 *
 *   - official @anthropic-ai/sdk, loaded lazily so a deployment without
 *     the package, or without AI_API_KEY, simply has no AI path
 *   - base URL from AI_API_BASE_URL, so tests point it at a local mock
 *     server and never the real API
 *   - structured outputs (output_config.format = JSON schema) with low
 *     effort; no assistant prefill, no thinking budget
 *   - the system prompt is frozen and marked cache_control, the
 *     per-request text goes in the user message and is treated as data
 *   - refusal fallback on (server-side-fallback-2026-07-01, "default"),
 *     and stop_reason is checked before any content is read
 */
import { config } from '../config.js';

let SdkCtor = null;
let sdkTried = false;

async function sdk() {
  if (sdkTried) return SdkCtor;
  sdkTried = true;
  try {
    const mod = await import('@anthropic-ai/sdk');
    SdkCtor = mod.default || mod.Anthropic || null;
  } catch {
    SdkCtor = null;
  }
  return SdkCtor;
}

export function aiConfigured() {
  return !!config.aiApiKey;
}

export class AiUnavailable extends Error {
  constructor(msg, code = 'AI_UNAVAILABLE') { super(msg); this.code = code; }
}

/**
 * @param o.model       model id
 * @param o.system      frozen system prompt (cached)
 * @param o.user        the per-request text (data)
 * @param o.schema      JSON schema of the answer
 * @param o.timeoutMs   per-request timeout
 * @param o.maxTokens   output cap
 * @returns { data, model, stopReason }
 */
export async function structuredCall(o) {
  if (!config.aiApiKey) throw new AiUnavailable('AI_API_KEY is not set');
  const Anthropic = await sdk();
  if (!Anthropic) throw new AiUnavailable('the @anthropic-ai/sdk package is not installed');

  const client = new Anthropic({
    apiKey: config.aiApiKey,
    baseURL: process.env.AI_API_BASE_URL || undefined,
    timeout: o.timeoutMs || 20_000,
    maxRetries: o.maxRetries ?? 0,
  });

  const msg = await client.beta.messages.create({
    model: o.model,
    max_tokens: o.maxTokens || 2048,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: [{ type: 'text', text: o.system, cache_control: { type: 'ephemeral' } }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: o.schema } },
    messages: [{ role: 'user', content: o.user }],
  });

  if (!msg || msg.stop_reason === 'refusal') {
    throw new AiUnavailable('the model declined this request', 'AI_REFUSED');
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new AiUnavailable('the model ran out of room before finishing', 'AI_TRUNCATED');
  }
  const text = (msg.content || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  let data;
  try { data = JSON.parse(text); } catch {
    throw new AiUnavailable('the model did not return valid JSON', 'AI_BAD_OUTPUT');
  }
  return { data, model: msg.model || o.model, stopReason: msg.stop_reason };
}
