#!/usr/bin/env node
// Health-check the council models on the LiteLLM proxy and flag which ones can't serve.
// A model in LITELLM_COUNCIL_MODELS can silently rot: NVIDIA NIM ids reach end-of-life
// (410 Gone), get pulled (404), or turn so slow they blow the request timeout. The council
// commands then "time out and glitch" with no clear cause. This probes each model with a
// cheap ping, RETRIES before condemning it (transient overload != dead), and classifies it
// OK / SLOW / DEAD / UNREACHABLE so a command can decide whether to trigger a replacement.
//
//   node doctor.mjs [--attempts N] [--timeout MS] [--slow MS] [--json] [model ...]
//
// Models default to the configured council list. Exit code: 0 if every model is OK/SLOW,
// 1 if any is DEAD/UNREACHABLE (so a wrapper can gate on `node doctor.mjs || heal`).
import { loadConfig, requireConfig, joinUrl, redact } from './config.mjs';
import { councilModels } from './council-models.mjs';
import { pathToFileURL } from 'node:url';

const DEFAULTS = { attempts: 3, timeoutMs: 25000, slowMs: 15000 };

// Only a MODEL-scoped rejection means the id is gone. A rejected key (401/403), a rate limit
// (429) or a proxy/provider fault (5xx) says nothing about the model - and those fail every
// model at once, so reading them as death would print "3 models need replacing" for a healthy
// council whose real problem is one wrong key.
export function httpKind(status) {
  if (status === 404 || status === 410) return 'gone';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'ratelimit';
  return 'server';
}

// Pure verdict from a list of probe attempts. Kept separate from I/O so it's unit-testable.
//   attempt = { ok, kind }
//   kind: 'ok' | 'gone' | 'auth' | 'ratelimit' | 'server' | 'errorbody' | 'empty' | 'timeout' | 'network'
// DEAD  = affirmatively rejected as a model: 404/410, or a 2xx {error} body -> replace it.
// UNREACHABLE = everything else unproven - timeout, wire error, empty/malformed 2xx, bad key,
//         rate limit, proxy 5xx -> not council-usable right now, but NOT a reason to swap it.
// SLOW  = it answered, but the fastest good attempt was slower than slowMs.
export function classify(attempts, { slowMs } = DEFAULTS) {
  const good = attempts.filter((a) => a.ok);
  if (good.length) {
    const best = Math.min(...good.map((a) => a.ms));
    return { state: best > slowMs ? 'SLOW' : 'OK', best };
  }
  const rejected = attempts.some((a) => a.kind === 'gone' || a.kind === 'errorbody');
  return { state: rejected ? 'DEAD' : 'UNREACHABLE', best: null };
}

// One cheap ping. Never throws: every failure mode becomes a tagged attempt record so the
// caller (and classify) can tell an affirmative rejection from a timeout.
export async function probe(model, { baseUrl, apiKey, timeoutMs = DEFAULTS.timeoutMs }) {
  const started = Date.now();
  // 512, not 16: a reasoning model (deepseek-r1, qwq, nemotron) spends its first tokens on a
  // <think> block, so a 16-token budget truncates it to an empty content and the probe reports
  // a healthy model as UNREACHABLE. Big enough that an empty reply now means actually empty.
  const payload = { model, messages: [{ role: 'user', content: 'Reply with exactly: pong' }], max_tokens: 512, temperature: 0 };
  let res;
  try {
    res = await fetch(joinUrl(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // e.code on an abort is the legacy DOMException number (23), which reads as a nonsense
    // "timed out: 23" - the cause's errno or the name is what actually says what broke.
    const kind = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network';
    return { ok: false, kind, ms: Date.now() - started, detail: e.cause?.code || e.name || e.message };
  }
  const ms = Date.now() - started;
  // Classify on the HTTP status FIRST: a non-2xx is an affirmative rejection (404/410/500)
  // whether or not the body then reads cleanly, so a slow/failed body read on an errored
  // response can't downgrade a real death to a mere timeout. The body is read only for a detail.
  let raw = '';
  try { raw = await res.text(); } catch { /* body read failed; the status already tells us enough */ }
  if (!res.ok) return { ok: false, kind: httpKind(res.status), status: res.status, ms, detail: firstLine(redact(raw, apiKey)) };
  let body = null;
  try { body = JSON.parse(raw); } catch { /* non-JSON 2xx */ }
  // LiteLLM sometimes surfaces a provider error as HTTP 200 with an {error} body - that IS an
  // affirmative failure (DEAD). But an empty / malformed 2xx with no error is NOT a death: it can
  // be a transient blip or a streaming artifact, so it's a soft miss (-> UNREACHABLE), not DEAD.
  if (body?.error) return { ok: false, kind: 'errorbody', status: res.status, ms, detail: firstLine(redact(body.error.message ?? body.error, apiKey)) };
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim() !== '') return { ok: true, kind: 'ok', status: res.status, ms };
  return { ok: false, kind: 'empty', status: res.status, ms, detail: firstLine(redact(raw, apiKey)) || 'empty 200 response' };
}

function firstLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

// Probe each model up to `attempts` times, short-circuiting on the first success.
export async function runDoctor(models, cfg, opts = DEFAULTS) {
  const out = [];
  for (const model of models) {
    const attempts = [];
    for (let i = 0; i < opts.attempts; i++) {
      const a = await probe(model, { ...cfg, timeoutMs: opts.timeoutMs });
      attempts.push(a);
      if (a.ok) break; // no need to keep probing a healthy model
      // a rejected key and a rate limit will not change within this run, and hammering either is
      // exactly the wrong move - the verdict is UNREACHABLE after one attempt just the same
      if (a.kind === 'auth' || a.kind === 'ratelimit') break;
    }
    out.push({ model, ...classify(attempts, opts), attempts });
  }
  return out;
}

// Out-of-range values fall back to the default rather than through. Unvalidated, `--attempts abc`
// makes attempts NaN, the probe loop runs ZERO times, and classify([]) then reports a model that
// was never contacted as UNREACHABLE - a confident verdict from no evidence at all.
const bounded = (v, dflt, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
};

export function parseArgs(argv) {
  const opts = { ...DEFAULTS, json: false }, models = [];
  // Only swallow the next token as a flag's value when it actually looks like one. Consuming it
  // blind means `doctor.mjs --attempts --json` eats the --json, so a wrapper that gates on the
  // JSON output gets an empty stdout and no error - the silent kind of broken.
  const NUM = {
    '--attempts': ['attempts', DEFAULTS.attempts, 1, 10],
    '--timeout': ['timeoutMs', DEFAULTS.timeoutMs, 1000, 600000],
    '--slow': ['slowMs', DEFAULTS.slowMs, 0, 600000],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.hasOwn(NUM, a)) {
      const [key, dflt, min, max] = NUM[a];
      const next = argv[i + 1];
      const isValue = next !== undefined && !String(next).startsWith('--');
      if (isValue) i++;
      opts[key] = bounded(isValue ? next : undefined, dflt, min, max);
    } else if (a === '--json') opts.json = true;
    else models.push(a);
  }
  // integers, all of them: AbortSignal.timeout() throws RangeError on a fractional delay, and
  // that throw is caught as a "network" failure - so `--timeout 100.5` would report UNREACHABLE
  // without ever having probed anything
  opts.attempts = Math.round(opts.attempts);
  opts.timeoutMs = Math.round(opts.timeoutMs);
  opts.slowMs = Math.round(opts.slowMs);
  return { opts, models };
}

async function main() {
  const { opts, models: argModels } = parseArgs(process.argv.slice(2));
  const cfg = requireConfig();
  const models = argModels.length ? argModels : councilModels(loadConfig().models);
  const results = await runDoctor(models, cfg, opts);

  for (const r of results) {
    const lat = r.best != null ? `${(r.best / 1000).toFixed(1)}s` : '-';
    const why = r.state === 'OK' || r.state === 'SLOW' ? '' : `  <- ${r.attempts.at(-1)?.detail || r.attempts.at(-1)?.kind || ''}`;
    process.stderr.write(`${r.state.padEnd(11)} ${r.model.padEnd(45)} ${lat}${why}\n`);
  }
  // A council that fails all at once nearly always has ONE cause, not N dead models - name it,
  // otherwise the next step is a pointless hunt for replacements.
  const lastKind = (r) => r.attempts.at(-1)?.kind;
  if (results.some((r) => lastKind(r) === 'auth')) {
    process.stderr.write('\nthe proxy rejected the key - fix LITELLM_API_KEY; the models are not the problem\n');
  } else if (results.some((r) => lastKind(r) === 'ratelimit')) {
    process.stderr.write('\nrate limited - wait and re-run before replacing anything\n');
  } else if (results.some((r) => lastKind(r) === 'server')) {
    process.stderr.write('\nthe proxy/provider returned a 5xx - that is upstream, not a dead model\n');
  }
  const bad = results.filter((r) => r.state === 'DEAD' || r.state === 'UNREACHABLE');
  if (opts.json) process.stdout.write(JSON.stringify({ ok: bad.length === 0, results }) + '\n');
  else if (bad.some((b) => b.state === 'DEAD')) {
    const dead = bad.filter((b) => b.state === 'DEAD');
    process.stderr.write(`\n${dead.length} model(s) need replacing: ${dead.map((b) => b.model).join(', ')}\n`);
  }
  process.exit(bad.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
