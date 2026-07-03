#!/usr/bin/env node
// Query ONE model on the LiteLLM proxy. Prompt on stdin, reply on stdout.
//   Usage: printf '%s' "$prompt" | node ask-model.mjs <model-id>
// Config from the environment or ~/.config/litellm-council/env (see config.mjs). Shared by the
// second-opinion / ask / debate commands so request-building and error-handling live in one place.
import { requireConfig, joinUrl, die } from './config.mjs';
import { pathToFileURL } from 'node:url';

const REASONING = /deepseek|nemotron|-r1|thinking|qwq/i; // slow reasoning models -> more output tokens

export function maxTokensFor(model) {
  return REASONING.test(model) ? 32768 : 8192;
}

// Pull the reply out of a parsed response; return null when there's nothing usable (so the
// caller can fall back to the raw body) - never an empty string that looks like a blank answer.
export function extractReply(body) {
  const chain = body?.choices?.[0]?.message?.content ?? body?.error?.message ?? body?.error ?? body?.detail;
  if (chain == null || chain === '') return null;
  return typeof chain === 'string' ? chain : JSON.stringify(chain);
}

// Query one model and return its reply text. Never throws: a network error or a non-JSON / empty
// body degrades to a bounded, human-readable string so one model failing can't abort the council.
export async function askModel(model, prompt, { baseUrl, apiKey, timeoutMs = 300000 }) {
  const payload = { model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokensFor(model), temperature: 0.3 };
  let raw;
  try {
    const res = await fetch(joinUrl(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    raw = await res.text();
  } catch (e) {
    return `(no response - request failed or timed out: ${e.code || e.cause?.code || e.name || e.message})`;
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* non-JSON body, e.g. a 502 HTML page */ }
  const reply = parsed ? extractReply(parsed) : null;
  return reply != null ? reply : String(raw || '(no response)').slice(0, 500); // bounded fallback
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
