#!/usr/bin/env node
// Query ONE model on the LiteLLM proxy. Prompt on stdin, reply on stdout.
//   Usage: printf '%s' "$prompt" | node ask-model.mjs <model-id>
// Config from the environment or ~/.config/litellm-council/env (see config.mjs). Shared by the
// second-opinion / ask / debate commands so request-building and error-handling live in one place.
import { requireConfig, joinUrl, die, redact } from './config.mjs';
import { pathToFileURL } from 'node:url';

const REASONING = /deepseek|nemotron|-r1|thinking|qwq/i; // slow reasoning models -> more output tokens
const DEFAULT_TIMEOUT_MS = 300000;
// Assumed throughput of the SLOWEST council-usable model, measured on a real review through a free
// NIM tier: deepseek-v4-flash sustains ~14 tok/s where the fast ones do 70+. Deliberately BELOW the
// measured 14, not above it - budget at 15 and the 300s deadline buys 4500 tokens that the very
// model it was measured on needs 326s to produce, which is the original bug wearing a smaller hat.
// The slack also pays for what isn't generation: prompt ingest, first-token latency, a 429 retry.
const SLOW_TOKENS_PER_SEC = 12;

// The ceiling is what a model MAY spend; the timeout decides what it CAN deliver. Asking for more
// than the deadline affords is worse than asking for less - the model generates past it, the fetch
// aborts, and a review that would have come back truncated-but-usable comes back as nothing at all.
// Measured on a 17KB diff: deepseek-v4-flash answered in 57s at max_tokens 2048 and timed out at
// 32768. So cap the ask at what the clock can actually pay for.
export function maxTokensFor(model, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ceiling = REASONING.test(model) ? 32768 : 8192;
  // Sanitize FIRST: Math.min(ceiling, NaN) is NaN and Math.max(512, NaN) is NaN too, so an
  // unvalidated timeout would ship `max_tokens: NaN` and earn a 400 from the provider - a broken
  // request dressed up as a broken model. Infinity lands here as well, and rightly so: it can't
  // buy tokens either, since AbortSignal.timeout() rejects it outright.
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  // floor at 512: a short timeout must still ask for a usable answer, and a max_tokens <= 0 is
  // rejected outright by most providers - which would turn "slow" into "broken"
  return Math.max(512, Math.min(ceiling, Math.round((ms / 1000) * SLOW_TOKENS_PER_SEC)));
}

// Pull the reply out of a parsed response; return null when there's nothing usable (so the
// caller can fall back to the raw body) - never an empty string that looks like a blank answer.
// Whitespace-only content counts as empty: a reasoning model can emit " " as content while the
// real text sits in reasoning_content, and printing the blank would look like it said nothing.
export function extractReply(body) {
  const msg = body?.choices?.[0]?.message;
  const content = typeof msg?.content === 'string' && msg.content.trim() !== '' ? msg.content : msg?.reasoning_content;
  const chain = content ?? body?.error?.message ?? body?.error ?? body?.detail;
  if (chain == null || chain === '') return null;
  return typeof chain === 'string' ? chain : JSON.stringify(chain);
}

// Query one model and return its reply text. Never throws: a network error or a non-JSON / empty
// body degrades to a bounded, human-readable string so one model failing can't abort the council.
export async function askModel(model, prompt, { baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const payload = { model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokensFor(model, timeoutMs), temperature: 0.3 };
  let res, raw;
  try {
    res = await fetch(joinUrl(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Math.round(timeoutMs)),
    });
    raw = await res.text();
  } catch (e) {
    // not e.code first: on an abort that is the legacy DOMException number, so a timeout used to
    // print the nonsense "timed out: 23" instead of naming what actually failed
    return `(no response - request failed or timed out: ${e.cause?.code || e.name || e.message})`;
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* non-JSON body, e.g. a 502 HTML page */ }
  const reply = parsed ? extractReply(parsed) : null;
  const text = redact(reply != null ? reply : String(raw || '(no response)').slice(0, 500), apiKey);
  // Keep the STATUS, not just the body: the commands tell the agent to act on 404 vs 401 vs 429
  // vs 5xx, and a bare "model not found" string gives it nothing to tell those apart with.
  return res.ok ? text : `(HTTP ${res.status}) ${text}`;
}

async function readStdin() {
  const chunks = [];
  for await (const ch of process.stdin) chunks.push(ch);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const model = process.argv[2];
  if (!model) die('usage: ask-model.mjs <model-id>  (prompt on stdin)', 2);
  const cfg = requireConfig();
  const prompt = await readStdin();
  console.log(await askModel(model, prompt, cfg));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
