#!/usr/bin/env node
// Self-check for nvidia-council. No network, no deps, no key: exercises the pure logic
// (config parse/merge, model-list cleaning, catalog parse/filter, reply extraction incl. the
// reasoning/<think> shapes, Retry-After parsing, doctor classification, arg parsing).
// Run: node scripts/test.mjs
import assert from 'node:assert/strict';

// Every request takes a slot in the shared rate-limit queue - at the shipped 1600ms that would
// make this suite ~15s of pure waiting. Shrink the interval BEFORE importing (the module reads
// it once at load), which also exercises the env override. The pacing test asserts a property
// relative to MIN_INTERVAL_MS, so it proves the same thing at any interval.
// 150ms, not 20ms: Windows' timer granularity is ~16ms, which at 20ms would be most of the gap.
process.env.NVIDIA_MIN_INTERVAL_MS ||= '150';
const {
  parseEnvFile, loadConfig, joinUrl, requireConfig, mergeConfig, serialize,
  councilModels, parseModels, filterModels, maxTokensFor, stripThink, extractReply,
  retryAfterMs, httpKind, classify, parseDoctorArgs, chat, MIN_INTERVAL_MS,
  DEFAULT_INTERVAL_MS, DEFAULT_BASE_URL, DEFAULT_MODELS, intervalFrom, redact,
} = await import('./nim.mjs');

let n = 0;
const eq = (name, a, b) => { assert.deepEqual(a, b, name); n++; };
const throws = (name, fn) => { assert.throws(fn, name); n++; };

// --- config ---
eq('parseEnvFile dotenv', parseEnvFile('NVIDIA_API_KEY=nvapi-1\nNVIDIA_COUNCIL_MODELS="a/b,c/d"'),
  { NVIDIA_API_KEY: 'nvapi-1', NVIDIA_COUNCIL_MODELS: 'a/b,c/d' });
eq('parseEnvFile shell form', parseEnvFile('export NVIDIA_API_KEY="${NVIDIA_API_KEY:-nvapi-2}"'),
  { NVIDIA_API_KEY: 'nvapi-2' });
eq('parseEnvFile skips comments/blanks', parseEnvFile('# c\n\nA=1'), { A: '1' });
eq('loadConfig env wins over file',
  loadConfig({ NVIDIA_API_KEY: 'live' }, { NVIDIA_API_KEY: 'file' }).apiKey, 'live');
eq('loadConfig blank env falls back to file',
  loadConfig({ NVIDIA_API_KEY: '  ' }, { NVIDIA_API_KEY: 'file' }).apiKey, 'file');
eq('loadConfig defaults to the hosted NVIDIA endpoint', loadConfig({}, {}).baseUrl, DEFAULT_BASE_URL);
eq('loadConfig honours a self-hosted NIM override',
  loadConfig({ NVIDIA_BASE_URL: 'http://nim.local:8000/v1' }, {}).baseUrl, 'http://nim.local:8000/v1');
eq('loadConfig blank base URL override falls back to hosted',
  loadConfig({ NVIDIA_BASE_URL: '' }, {}).baseUrl, DEFAULT_BASE_URL);
eq('joinUrl trims trailing slash', joinUrl('https://x/v1/', 'models'), 'https://x/v1/models');
eq('joinUrl no double slash', joinUrl('https://x/v1', '/models'), 'https://x/v1/models');

eq('mergeConfig env overrides, preserves the rest',
  mergeConfig({ NVIDIA_API_KEY: 'k', NVIDIA_COUNCIL_MODELS: 'old' }, { NVIDIA_COUNCIL_MODELS: 'new', OTHER: 'x' }),
  { NVIDIA_API_KEY: 'k', NVIDIA_COUNCIL_MODELS: 'new' });
eq('mergeConfig ignores an empty env value', mergeConfig({ NVIDIA_API_KEY: 'k' }, { NVIDIA_API_KEY: '' }), { NVIDIA_API_KEY: 'k' });
eq('serialize writes only known keys', serialize({ NVIDIA_API_KEY: 'k', OTHER: 'x' }), 'NVIDIA_API_KEY=k\n');
// save -> reload round-trip: a format drift between serialize and parseEnvFile would slip past
// testing either one alone
const rt = { NVIDIA_API_KEY: 'nvapi-abc', NVIDIA_COUNCIL_MODELS: 'a/b,c/d', NVIDIA_BASE_URL: 'https://x/v1' };
eq('serialize output parses back identically', parseEnvFile(serialize(rt)), rt);

// --- council / catalog ---
eq('councilModels cleans commas/space/CR/blanks', councilModels('a/b, c/d ,, e/f\r'), ['a/b', 'c/d', 'e/f']);
eq('councilModels default on empty', councilModels('').length, 3);
eq('councilModels comma-only garbage falls back to the default trio', councilModels(',,,').length, 3);
eq('parseModels ids', parseModels({ data: [{ id: 'b' }, { id: 'a' }] }), ['b', 'a']);
throws('parseModels throws on bad shape', () => parseModels({ error: 'x' }));
eq('parseModels drops null/non-string/empty ids',
  parseModels({ data: [null, {}, { id: 7 }, { id: '' }, { id: 'good/model' }] }), ['good/model']);
eq('filterModels sort+unique', filterModels(['z', 'a', 'a'], ''), ['a', 'z']);
eq('filterModels case-insensitive substring', filterModels(['DeepSeek/R1', 'qwen/x'], 'deepseek'), ['DeepSeek/R1']);
eq('filterModels literal (dot is not a regex)', filterModels(['a/b', 'axb'], 'a/b'), ['a/b']);

// --- chat plumbing ---
eq('maxTokensFor reasoning r1', maxTokensFor('deepseek-ai/deepseek-r1'), 32768);
eq('maxTokensFor nemotron', maxTokensFor('nvidia/llama-3.3-nemotron-super-49b-v1.5'), 32768);
eq('maxTokensFor plain instruct', maxTokensFor('mistralai/mistral-large-3-675b-instruct-2512'), 8192);
eq('stripThink drops the scratchpad', stripThink('<think>musing</think>\nanswer'), 'answer');
eq('stripThink keeps a think-only reply (budget ran out mid-thought)',
  stripThink('<think>musing</think>'), '<think>musing</think>');
eq('stripThink leaves an unterminated think block alone', stripThink('<think>cut off'), '<think>cut off');
eq('extractReply content', extractReply({ choices: [{ message: { content: 'hi' } }] }), 'hi');
eq('extractReply falls back to reasoning_content when content is empty',
  extractReply({ choices: [{ message: { content: '', reasoning_content: 'thought' } }] }), 'thought');
eq('extractReply treats whitespace-only content as empty too (else the answer renders blank)',
  extractReply({ choices: [{ message: { content: '  \n ', reasoning_content: 'thought' } }] }), 'thought');
eq('extractReply strips <think> from content', extractReply({ choices: [{ message: { content: '<think>x</think>y' } }] }), 'y');
eq('extractReply error.message', extractReply({ error: { message: 'bad model' } }), 'bad model');
eq('extractReply NVIDIA 410 detail', extractReply({ status: 410, title: 'Gone', detail: 'model retired' }), 'model retired');
eq('extractReply title when there is no detail', extractReply({ title: 'Not Found' }), 'Not Found');
eq('extractReply nothing -> null (caller falls back to the raw body)', extractReply({}), null);
eq('extractReply non-string error -> JSON', extractReply({ error: { code: 'x' } }), JSON.stringify({ code: 'x' }));

// --- Retry-After (the free tier's normal failure mode) ---
eq('retryAfterMs seconds', retryAfterMs('7'), 7000);
eq('retryAfterMs missing header -> default', retryAfterMs(null), 5000);
eq('retryAfterMs garbage -> default', retryAfterMs('soon'), 5000);
eq('retryAfterMs HTTP-date', retryAfterMs('Sun, 26 Jul 2026 10:00:10 GMT', Date.parse('Sun, 26 Jul 2026 10:00:00 GMT')), 10000);
eq('retryAfterMs past date -> default (never negative)',
  retryAfterMs('Sun, 26 Jul 2026 09:00:00 GMT', Date.parse('Sun, 26 Jul 2026 10:00:00 GMT')), 5000);
eq('retryAfterMs absurd value is clamped to 60s', retryAfterMs('99999'), 60000);

// --- doctor: what counts as "the model is gone" vs "we just couldn't prove it" ---
eq('httpKind 404 -> gone', httpKind(404), 'gone');
eq('httpKind 410 (NIM end-of-life) -> gone', httpKind(410), 'gone');
eq('httpKind 401/403 -> auth (a bad key is not a dead model)', [httpKind(401), httpKind(403)], ['auth', 'auth']);
eq('httpKind 429 -> ratelimit', httpKind(429), 'ratelimit');
eq('httpKind 500/502 -> server (provider fault, not the model)', [httpKind(500), httpKind(502)], ['server', 'server']);

eq('classify: a success is OK', classify([{ ok: true, ms: 500 }], { slowMs: 15000 }).state, 'OK');
eq('classify: slow success is SLOW', classify([{ ok: true, ms: 20000 }], { slowMs: 15000 }).state, 'SLOW');
eq('classify: fastest good attempt sets latency',
  classify([{ ok: false, kind: 'timeout' }, { ok: true, ms: 800 }], { slowMs: 15000 }), { state: 'OK', best: 800 });
eq('classify: a 404/410 rejection is DEAD',
  classify([{ ok: false, kind: 'timeout' }, { ok: false, kind: 'gone' }], { slowMs: 15000 }).state, 'DEAD');
eq('classify: a 2xx {error} body is DEAD too', classify([{ ok: false, kind: 'errorbody' }], { slowMs: 15000 }).state, 'DEAD');
eq('classify: an unparseable 2xx is UNREACHABLE, not DEAD (no false replace on a blip)',
  classify([{ ok: false, kind: 'empty' }], { slowMs: 15000 }).state, 'UNREACHABLE');
eq('classify: timeouts/network only -> UNREACHABLE',
  classify([{ ok: false, kind: 'timeout' }, { ok: false, kind: 'network' }], { slowMs: 15000 }).state, 'UNREACHABLE');
eq('classify: an exhausted rate limit is UNREACHABLE, never DEAD (would swap a healthy model out)',
  classify([{ ok: false, kind: 'ratelimit' }], { slowMs: 15000 }).state, 'UNREACHABLE');
// the one that matters most: a wrong key fails EVERY model at once. If that read as DEAD, the
// doctor would walk the user through replacing a perfectly good council instead of fixing the key
eq('classify: a rejected key is UNREACHABLE, never DEAD',
  classify([{ ok: false, kind: 'auth' }], { slowMs: 15000 }).state, 'UNREACHABLE');
eq('classify: a provider 5xx is UNREACHABLE, never DEAD',
  classify([{ ok: false, kind: 'server' }], { slowMs: 15000 }).state, 'UNREACHABLE');

// --- the 429 retry loop, against a stubbed fetch (no network, no key) ---
{
  const realFetch = globalThis.fetch;
  const cfg = { baseUrl: 'https://x/v1', apiKey: 'k' };
  const reply = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', ...headers },
  });
  try {
    // a 429 carrying Retry-After is retried once and the second answer is the one returned
    let calls = 0;
    globalThis.fetch = async () => (++calls === 1
      ? reply({ error: 'slow down' }, 429, { 'retry-after': '0' })
      : reply({ choices: [{ message: { content: 'second try' } }] }));
    const r = await chat('m', 'p', { ...cfg, retries: 1 });
    eq('chat retries a 429 and returns the retry answer', [r.ok, r.text, calls], [true, 'second try', 2]);

    // ...but only `retries` times: a second 429 is surfaced as ratelimit, not retried forever
    calls = 0;
    globalThis.fetch = async () => { calls++; return reply({ error: 'slow down' }, 429, { 'retry-after': '0' }); };
    const r2 = await chat('m', 'p', { ...cfg, retries: 1 });
    eq('chat gives up after the configured retries', [r2.ok, r2.kind, calls], [false, 'ratelimit', 2]);

    // a 404 is model-scoped: reported as `gone` so the doctor may condemn the id
    globalThis.fetch = async () => reply({ detail: 'model retired' }, 404);
    const r3 = await chat('m', 'p', cfg);
    eq('chat maps 404 to gone', [r3.ok, r3.kind], [false, 'gone']);

    // a 401 must NOT be model-scoped, or a typo'd key condemns the whole council
    globalThis.fetch = async () => reply({ detail: 'invalid key' }, 401);
    const r4 = await chat('m', 'p', cfg);
    eq('chat maps 401 to auth, not gone', [r4.ok, r4.kind], [false, 'auth']);

    // a backoff longer than the remaining budget must report the truth (rate limited) rather
    // than sleep the budget away and then blame a timeout
    calls = 0;
    globalThis.fetch = async () => { calls++; return reply({ error: 'x' }, 429, { 'retry-after': '60' }); };
    const t0 = Date.now();
    const r5 = await chat('m', 'p', { ...cfg, retries: 5, timeoutMs: 50 });
    eq('chat refuses a backoff that outlasts the budget, and says ratelimit not timeout',
      [r5.kind, calls], ['ratelimit', 1]);
    assert.ok(Date.now() - t0 < 5000, 'chat returned immediately instead of sleeping out the backoff');
    n++;
  } finally {
    globalThis.fetch = realFetch;
  }
}

// --- the shared rate-limit queue (the one NVIDIA-specific behaviour worth the wall clock) ---
// Two models fan out concurrently and one of them retries a 429. All THREE request starts must
// be MIN_INTERVAL_MS apart: the bug this guards against is a retry landing on top of a later
// model's first attempt, which is exactly how a ~40 req/min per-key budget gets blown.
{
  const realFetch = globalThis.fetch;
  const starts = [];
  let first429 = true;
  try {
    globalThis.fetch = async () => {
      starts.push(Date.now());
      if (first429) { // only model A's first attempt is throttled
        first429 = false;
        return new Response(JSON.stringify({ error: 'slow down' }),
          { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const cfg = { baseUrl: 'https://x/v1', apiKey: 'k' };
    await Promise.all(['a/one', 'b/two'].map((m) => chat(m, 'p', cfg)));
    eq('shared queue: two models + one retry = three paced request starts', starts.length, 3);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    const slack = 25; // one OS timer tick (~16ms on Windows), not a proportion of the interval
    assert.ok(gaps.every((g) => g >= MIN_INTERVAL_MS - slack),
      `every request start is ~MIN_INTERVAL_MS apart (gaps: ${gaps}, interval: ${MIN_INTERVAL_MS})`);
    n++;
  } finally {
    globalThis.fetch = realFetch;
  }
}

// the interval this suite runs at is an override; the SHIPPED default is what has to respect
// NVIDIA's ~40 req/min per key, so pin that separately
eq('NVIDIA_MIN_INTERVAL_MS override is honoured', MIN_INTERVAL_MS, 150);
// a garbage override must fall back, never through: NaN would poison the queue clock on the
// first claim and silently drop ALL pacing - failing open on the rate limit
eq('intervalFrom rejects non-numeric', intervalFrom('abc'), DEFAULT_INTERVAL_MS);
eq('intervalFrom rejects zero/negative', [intervalFrom('0'), intervalFrom('-5')], [DEFAULT_INTERVAL_MS, DEFAULT_INTERVAL_MS]);
eq('intervalFrom rejects unset/blank', [intervalFrom(undefined), intervalFrom('')], [DEFAULT_INTERVAL_MS, DEFAULT_INTERVAL_MS]);
eq('intervalFrom rejects Infinity', intervalFrom('Infinity'), DEFAULT_INTERVAL_MS);
eq('intervalFrom accepts a real override', intervalFrom('250'), 250);
assert.ok(60000 / DEFAULT_INTERVAL_MS <= 40,
  `the shipped interval must stay under ~40 req/min (is ${60000 / DEFAULT_INTERVAL_MS})`);
n++;

// --- defaults sanity: the shipped council must look like real bare NIM ids ---
eq('DEFAULT_MODELS is a lineage-diverse trio', DEFAULT_MODELS.split(',').length, 3);
eq('DEFAULT_MODELS carries no nvidia_nim/ prefix (that is a LiteLLM routing artifact)',
  DEFAULT_MODELS.includes('nvidia_nim/'), false);
eq('DEFAULT_MODELS entries are all vendor/model shaped',
  DEFAULT_MODELS.split(',').every((m) => /^[\w.-]+\/[\w.-]+$/.test(m)), true);

eq('parseDoctorArgs defaults', parseDoctorArgs([]), { json: false, attempts: 2, slowMs: 15000, models: [] });
eq('parseDoctorArgs flags + models',
  parseDoctorArgs(['--json', '--attempts', '1', '--slow', '9000', 'a/b', 'c/d']),
  { json: true, attempts: 1, slowMs: 9000, models: ['a/b', 'c/d'] });
eq('parseDoctorArgs never mistakes a flag VALUE for a model id',
  parseDoctorArgs(['--attempts', '1']).models, []);
// garbage must fall back to the default, not through: 0 or -1 attempts probes nothing and then
// reports an UNTESTED model UNREACHABLE; Infinity never stops retrying
eq('parseDoctorArgs rejects zero/negative attempts', parseDoctorArgs(['--attempts', '-1']).attempts, 2);
eq('parseDoctorArgs rejects zero attempts', parseDoctorArgs(['--attempts', '0']).attempts, 2);
eq('parseDoctorArgs rejects Infinity attempts', parseDoctorArgs(['--attempts', 'Infinity']).attempts, 2);
eq('parseDoctorArgs rejects a non-numeric attempts', parseDoctorArgs(['--attempts', 'lots']).attempts, 2);
eq('parseDoctorArgs caps attempts', parseDoctorArgs(['--attempts', '999']).attempts, 2);
eq('parseDoctorArgs rounds a fractional attempts', parseDoctorArgs(['--attempts', '2.6']).attempts, 3);
eq('parseDoctorArgs allows --slow 0 (every latency counts as slow) but not a negative',
  [parseDoctorArgs(['--slow', '0']).slowMs, parseDoctorArgs(['--slow', '-5']).slowMs], [0, 15000]);
// a value-taking flag must not swallow the NEXT flag: --json getting eaten means a caller
// gating on the JSON output gets empty stdout and no error
eq('parseDoctorArgs does not let --attempts swallow a following --json',
  parseDoctorArgs(['--attempts', '--json']).json, true);
eq('parseDoctorArgs falls back when a value-flag has no value',
  parseDoctorArgs(['--attempts', '--json']).attempts, 2);
eq('parseDoctorArgs handles a value-flag at the very end', parseDoctorArgs(['--slow']).slowMs, 15000);
eq('parseDoctorArgs still reads a real value after a flag',
  parseDoctorArgs(['--json', '--attempts', '5']).attempts, 5);

// --- redact: a credential must never ride out in printed error text ---
eq('redact removes the key', redact('key=nvapi-abcdefgh rejected', 'nvapi-abcdefgh'), 'key=[redacted] rejected');
eq('redact handles repeats', redact('nvapi-abcdefgh nvapi-abcdefgh', 'nvapi-abcdefgh'), '[redacted] [redacted]');
eq('redact leaves text without the key alone', redact('all fine', 'nvapi-abcdefgh'), 'all fine');
eq('redact is a no-op for a missing/short secret (would blank out half the message)',
  [redact('abc', undefined), redact('abcabc', 'abc')], ['abc', 'abcabc']);
eq('redact tolerates null/undefined text', [redact(null, 'nvapi-abcdefgh'), redact(undefined, 'nvapi-abcdefgh')], ['', '']);

// --- requireConfig: pin the Node<18 guard, else a missing fetch() surfaces as a raw
// ReferenceError deep inside chat() instead of the one-line diagnostic
{
  const realExit = process.exit, realFetch = globalThis.fetch;
  process.env.NVIDIA_API_KEY = 'nvapi-test';
  process.exit = (code) => { throw new Error(`exit:${code}`); };
  delete globalThis.fetch;
  try {
    assert.throws(() => requireConfig(), /exit:1/, 'requireConfig dies when fetch is missing (Node <18)');
    n++;
  } finally {
    process.exit = realExit;
    globalThis.fetch = realFetch;
    delete process.env.NVIDIA_API_KEY;
  }
}

console.log(`all ${n} nvidia-council checks passed`);
