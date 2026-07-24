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
import { loadConfig, requireConfig, joinUrl } from './config.mjs';
import { councilModels } from './council-models.mjs';
import { pathToFileURL } from 'node:url';

const DEFAULTS = { attempts: 3, timeoutMs: 25000, slowMs: 15000 };

// Pure verdict from a list of probe attempts. Kept separate from I/O so it's unit-testable.
//   attempt = { ok, kind }  kind: 'ok' | 'http' | 'errorbody' | 'empty' | 'timeout' | 'network'
// DEAD  = the proxy/provider affirmatively rejected it (bad HTTP status, or a 2xx {error} body)
//         -> the model is gone, replace it.
// UNREACHABLE = it only ever timed out / errored on the wire / returned an empty-or-malformed 2xx
//         -> maybe transient, not a death sentence, but not council-usable right now.
// SLOW  = it answered, but the fastest good attempt was slower than slowMs.
export function classify(attempts, { slowMs } = DEFAULTS) {
  const good = attempts.filter((a) => a.ok);
  if (good.length) {
    const best = Math.min(...good.map((a) => a.ms));
    return { state: best > slowMs ? 'SLOW' : 'OK', best };
  }
  const rejected = attempts.some((a) => a.kind === 'http' || a.kind === 'errorbody');
  return { state: rejected ? 'DEAD' : 'UNREACHABLE', best: null };
}

// One cheap ping. Never throws: every failure mode becomes a tagged attempt record so the
// caller (and classify) can tell an affirmative rejection from a timeout.
export async function probe(model, { baseUrl, apiKey, timeoutMs = DEFAULTS.timeoutMs }) {
  const started = Date.now();
  const payload = { model, messages: [{ role: 'user', content: 'Reply with exactly: pong' }], max_tokens: 16, temperature: 0 };
  let res;
  try {
    res = await fetch(joinUrl(baseUrl, 'chat/completions'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const kind = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network';
    return { ok: false, kind, ms: Date.now() - started, detail: e.code || e.cause?.code || e.name || e.message };
  }
  const ms = Date.now() - started;
  // Classify on the HTTP status FIRST: a non-2xx is an affirmative rejection (404/410/500)
  // whether or not the body then reads cleanly, so a slow/failed body read on an errored
  // response can't downgrade a real death to a mere timeout. The body is read only for a detail.
  let raw = '';
  try { raw = await res.text(); } catch { /* body read failed; the status already tells us enough */ }
  if (!res.ok) return { ok: false, kind: 'http', status: res.status, ms, detail: firstLine(raw) };
  let body = null;
  try { body = JSON.parse(raw); } catch { /* non-JSON 2xx */ }
  // LiteLLM sometimes surfaces a provider error as HTTP 200 with an {error} body - that IS an
  // affirmative failure (DEAD). But an empty / malformed 2xx with no error is NOT a death: it can
  // be a transient blip or a streaming artifact, so it's a soft miss (-> UNREACHABLE), not DEAD.
  if (body?.error) return { ok: false, kind: 'errorbody', status: res.status, ms, detail: firstLine(body.error.message ?? body.error) };
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim() !== '') return { ok: true, kind: 'ok', status: res.status, ms };
  return { ok: false, kind: 'empty', status: res.status, ms, detail: firstLine(raw) || 'empty 200 response' };
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
    }
    out.push({ model, ...classify(attempts, opts), attempts });
  }
  return out;
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS, json: false }, models = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--attempts') opts.attempts = Number(argv[++i]);
    else if (a === '--timeout') opts.timeoutMs = Number(argv[++i]);
    else if (a === '--slow') opts.slowMs = Number(argv[++i]);
    else if (a === '--json') opts.json = true;
    else models.push(a);
  }
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
  const bad = results.filter((r) => r.state === 'DEAD' || r.state === 'UNREACHABLE');
  if (opts.json) process.stdout.write(JSON.stringify({ ok: bad.length === 0, results }) + '\n');
  else if (bad.length) process.stderr.write(`\n${bad.length} model(s) need replacing: ${bad.map((b) => b.model).join(', ')}\n`);
  process.exit(bad.length ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
