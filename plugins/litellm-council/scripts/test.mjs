#!/usr/bin/env node
// Self-check for the litellm-council scripts. No proxy, no deps: exercises the pure logic
// (config parse/merge, model-list cleaning, catalog parse/filter, request heuristics, reply
// extraction). Run: node scripts/test.mjs
import assert from 'node:assert/strict';
import { parseEnvFile, loadConfig, joinUrl, requireConfig, redact } from './config.mjs';
import { councilModels } from './council-models.mjs';
import { parseModels, filterModels, statusHint } from './list-models.mjs';
import { maxTokensFor, extractReply } from './ask-model.mjs';
import { mergeConfig, serialize } from './save-config.mjs';
import { classify, httpKind, parseArgs } from './doctor.mjs';

let n = 0;
const eq = (name, a, b) => { assert.deepEqual(a, b, name); n++; };
const throws = (name, fn) => { assert.throws(fn, name); n++; };

// --- config ---
eq('parseEnvFile dotenv', parseEnvFile('LITELLM_BASE_URL=https://x/v1\nLITELLM_API_KEY="sk-1"'),
  { LITELLM_BASE_URL: 'https://x/v1', LITELLM_API_KEY: 'sk-1' });
eq('parseEnvFile shell form', parseEnvFile('export LITELLM_API_KEY="${LITELLM_API_KEY:-sk-2}"'),
  { LITELLM_API_KEY: 'sk-2' });
eq('parseEnvFile skips comments/blanks', parseEnvFile('# c\n\nA=1'), { A: '1' });
eq('loadConfig env wins over file',
  loadConfig({ LITELLM_BASE_URL: 'https://live/v1' }, { LITELLM_BASE_URL: 'https://file/v1', LITELLM_API_KEY: 'k' }),
  { baseUrl: 'https://live/v1', apiKey: 'k', models: undefined });
eq('loadConfig empty env falls back to file',
  loadConfig({ LITELLM_BASE_URL: '' }, { LITELLM_BASE_URL: 'https://file/v1' }).baseUrl, 'https://file/v1');
eq('loadConfig whitespace-only env falls back to file too (not just empty-string)',
  loadConfig({ LITELLM_COUNCIL_MODELS: ' ' }, { LITELLM_COUNCIL_MODELS: 'openai/gpt-5.4' }).models, 'openai/gpt-5.4');
eq('joinUrl trims trailing slash', joinUrl('https://x/v1/', 'models'), 'https://x/v1/models');
eq('joinUrl no double slash', joinUrl('https://x/v1', '/models'), 'https://x/v1/models');
eq('joinUrl multiple trailing', joinUrl('https://x/v1///', 'models'), 'https://x/v1/models');

// --- council-models ---
eq('councilModels cleans commas/space/CR/blanks', councilModels('a/b, c/d ,, e/f\r'), ['a/b', 'c/d', 'e/f']);
eq('councilModels default on empty', councilModels('').length, 2);
eq('councilModels default on whitespace', councilModels('   ').length, 2);
eq('councilModels single padded', councilModels('  openai/gpt-5.4  '), ['openai/gpt-5.4']);
eq('councilModels comma-only garbage falls back to default too (not an empty list)',
  councilModels(',,,').length, 2);

// --- list-models ---
eq('parseModels ids', parseModels({ data: [{ id: 'b' }, { id: 'a' }] }), ['b', 'a']);
eq('parseModels empty', parseModels({ data: [] }), []);
throws('parseModels throws on bad shape', () => parseModels({ error: 'x' }));
throws('parseModels throws on null', () => parseModels(null));
eq('parseModels drops null/missing/non-string/empty ids',
  parseModels({ data: [null, {}, { id: 123 }, { id: '' }, { id: 'good/model' }] }), ['good/model']);
eq('filterModels sort+unique', filterModels(['z', 'a', 'a'], ''), ['a', 'z']);
eq('filterModels case-insensitive substring', filterModels(['openai/GPT-5.4', 'nim/qwen'], 'gpt'), ['openai/GPT-5.4']);
eq('filterModels literal (dot is not a regex)', filterModels(['a/b', 'axb'], 'a/b'), ['a/b']);
eq('filterModels no match', filterModels(['a', 'b'], 'zzz'), []);

// --- ask-model ---
eq('maxTokensFor reasoning r1', maxTokensFor('nvidia_nim/deepseek-ai/deepseek-r1'), 32768);
eq('maxTokensFor qwq', maxTokensFor('nvidia_nim/qwen/qwq-32b'), 32768);
eq('maxTokensFor coder is NOT reasoning', maxTokensFor('nvidia_nim/qwen/qwen2.5-coder-32b-instruct'), 8192);
eq('maxTokensFor gpt', maxTokensFor('openai/gpt-5.4'), 8192);
eq('extractReply content', extractReply({ choices: [{ message: { content: 'hi' } }] }), 'hi');
eq('extractReply empty content -> null (falls back to raw)', extractReply({ choices: [{ message: { content: '' } }] }), null);
eq('extractReply falls back to reasoning_content when content is empty',
  extractReply({ choices: [{ message: { content: '', reasoning_content: 'thought' } }] }), 'thought');
eq('extractReply treats whitespace-only content as empty too (else the answer renders blank)',
  extractReply({ choices: [{ message: { content: '  \n ', reasoning_content: 'thought' } }] }), 'thought');
eq('extractReply error.message', extractReply({ error: { message: 'bad model' } }), 'bad model');
eq('extractReply error string', extractReply({ error: 'nope' }), 'nope');
eq('extractReply detail', extractReply({ detail: 'rate limited' }), 'rate limited');
eq('extractReply nothing -> null', extractReply({}), null);
eq('extractReply non-string error object -> JSON.stringify',
  extractReply({ error: { code: 'invalid_request', type: 'x' } }), JSON.stringify({ code: 'invalid_request', type: 'x' }));

// --- doctor: only a MODEL-scoped rejection counts as death ---
eq('httpKind 404 -> gone', httpKind(404), 'gone');
eq('httpKind 410 (NIM end-of-life) -> gone', httpKind(410), 'gone');
eq('httpKind 401/403 -> auth (a bad key is not a dead model)', [httpKind(401), httpKind(403)], ['auth', 'auth']);
eq('httpKind 429 -> ratelimit', httpKind(429), 'ratelimit');
eq('httpKind 500/502 -> server (proxy/provider fault, not the model)', [httpKind(500), httpKind(502)], ['server', 'server']);

eq('classify: a success is OK', classify([{ ok: true, ms: 500 }], { slowMs: 15000 }).state, 'OK');
eq('classify: slow success is SLOW', classify([{ ok: true, ms: 20000 }], { slowMs: 15000 }).state, 'SLOW');
eq('classify: fastest good attempt sets latency',
  classify([{ ok: false, kind: 'timeout' }, { ok: true, ms: 800 }], { slowMs: 15000 }), { state: 'OK', best: 800 });
eq('classify: a 404/410 rejection is DEAD',
  classify([{ ok: false, kind: 'timeout' }, { ok: false, kind: 'gone' }], { slowMs: 15000 }).state, 'DEAD');
eq('classify: a 2xx {error} body is DEAD too', classify([{ ok: false, kind: 'errorbody' }], { slowMs: 15000 }).state, 'DEAD');
eq('classify: an empty/malformed 2xx is UNREACHABLE, not DEAD (no false replace on a blip)',
  classify([{ ok: false, kind: 'empty' }], { slowMs: 15000 }).state, 'UNREACHABLE');
eq('classify: only timeouts/network -> UNREACHABLE (maybe transient, not condemned as gone)',
  classify([{ ok: false, kind: 'timeout' }, { ok: false, kind: 'network' }], { slowMs: 15000 }).state, 'UNREACHABLE');
// the one that matters most: a wrong key or a down proxy fails EVERY model at once. If those read
// as DEAD, doctor prints "3 models need replacing" and sends you rebuilding a healthy council
eq('classify: a rejected key is UNREACHABLE, never DEAD',
  classify([{ ok: false, kind: 'auth' }], { slowMs: 15000 }).state, 'UNREACHABLE');
eq('classify: a rate limit is UNREACHABLE, never DEAD',
  classify([{ ok: false, kind: 'ratelimit' }], { slowMs: 15000 }).state, 'UNREACHABLE');
eq('classify: a proxy 5xx is UNREACHABLE, never DEAD',
  classify([{ ok: false, kind: 'server' }], { slowMs: 15000 }).state, 'UNREACHABLE');

// --- doctor arg parsing: garbage must fall back, never through ---
// unvalidated, `--attempts abc` -> NaN -> the probe loop runs ZERO times -> classify([]) reports
// a model that was never contacted as UNREACHABLE
eq('parseArgs defaults', parseArgs([]).opts.attempts, 3);
eq('parseArgs accepts a real value', parseArgs(['--attempts', '1']).opts.attempts, 1);
eq('parseArgs rejects non-numeric attempts (would probe zero times)',
  parseArgs(['--attempts', 'abc']).opts.attempts, 3);
eq('parseArgs rejects zero/negative attempts',
  [parseArgs(['--attempts', '0']).opts.attempts, parseArgs(['--attempts', '-1']).opts.attempts], [3, 3]);
eq('parseArgs caps attempts', parseArgs(['--attempts', '9999']).opts.attempts, 3);
eq('parseArgs rejects a garbage timeout', parseArgs(['--timeout', 'soon']).opts.timeoutMs, 25000);
eq('parseArgs never mistakes a flag VALUE for a model id', parseArgs(['--attempts', '2']).models, []);
eq('parseArgs collects model ids', parseArgs(['--json', 'a/b', 'c/d']).models, ['a/b', 'c/d']);
// a value-taking flag must not swallow the NEXT flag: --json getting eaten means a wrapper
// gating on the JSON output gets empty stdout and no error
eq('parseArgs does not let --attempts swallow a following --json',
  parseArgs(['--attempts', '--json']).opts.json, true);
eq('parseArgs falls back when a value-flag has no value',
  parseArgs(['--attempts', '--json']).opts.attempts, 3);
eq('parseArgs handles a value-flag at the very end', parseArgs(['--slow']).opts.slowMs, 15000);
eq('parseArgs still reads a real value after a flag', parseArgs(['--json', '--attempts', '5']).opts.attempts, 5);
// AbortSignal.timeout() throws RangeError on a fractional delay, and that throw is caught as a
// "network" failure - so a fractional --timeout would report UNREACHABLE without ever probing
eq('parseArgs rounds a fractional timeout (AbortSignal.timeout rejects non-integers)',
  Number.isInteger(parseArgs(['--timeout', '1500.7']).opts.timeoutMs), true);
eq('parseArgs rounds a fractional slow', Number.isInteger(parseArgs(['--slow', '900.5']).opts.slowMs), true);

// --- list-models status hints ---
eq('statusHint names a key problem', statusHint(401), ' (fix LITELLM_API_KEY)');
eq('statusHint names a rate limit', statusHint(429), ' (rate limited - wait and re-run)');
eq('statusHint names a proxy fault', statusHint(503).includes('faulting'), true);
eq('statusHint says nothing for a non-error/unknown status', [statusHint(undefined), statusHint(404)], ['', '']);

// --- redact: a credential must never ride out in printed error text ---
eq('redact removes the key', redact('key=sk-abcdefgh12 rejected', 'sk-abcdefgh12'), 'key=[redacted] rejected');
eq('redact handles repeats', redact('sk-abcdefgh12 sk-abcdefgh12', 'sk-abcdefgh12'), '[redacted] [redacted]');
eq('redact leaves text without the key alone', redact('all fine', 'sk-abcdefgh12'), 'all fine');
eq('redact is a no-op for a missing/short secret (would blank out half the message)',
  [redact('abc', undefined), redact('abcabc', 'abc')], ['abc', 'abcabc']);
eq('redact tolerates null/undefined text', [redact(null, 'sk-abcdefgh12'), redact(undefined, 'sk-abcdefgh12')], ['', '']);

// --- save-config ---
eq('mergeConfig env overrides, preserves the rest',
  mergeConfig({ LITELLM_BASE_URL: 'u', LITELLM_API_KEY: 'k', LITELLM_COUNCIL_MODELS: 'old' },
    { LITELLM_COUNCIL_MODELS: 'new', OTHER: 'x' }),
  { LITELLM_BASE_URL: 'u', LITELLM_API_KEY: 'k', LITELLM_COUNCIL_MODELS: 'new' });
eq('mergeConfig ignores empty env value', mergeConfig({ LITELLM_API_KEY: 'k' }, { LITELLM_API_KEY: '' }), { LITELLM_API_KEY: 'k' });
// a whitespace-only value (a failed shell interpolation) must NOT overwrite a good saved key -
// loadConfig would then ignore the saved blank and the credential is gone after a "successful" save
eq('mergeConfig ignores a whitespace-only env value',
  mergeConfig({ LITELLM_API_KEY: 'k' }, { LITELLM_API_KEY: '   ' }), { LITELLM_API_KEY: 'k' });
eq('serialize only known keys, KEY=value',
  serialize({ LITELLM_BASE_URL: 'u', LITELLM_API_KEY: 'k', OTHER: 'x' }), 'LITELLM_BASE_URL=u\nLITELLM_API_KEY=k\n');
// round-trip: what save-config.mjs writes must be exactly what config.mjs reads back next run -
// tested in isolation above, but a format drift between the two would slip past that
const roundtripCfg = { LITELLM_BASE_URL: 'https://x/v1', LITELLM_API_KEY: 'sk-abc', LITELLM_COUNCIL_MODELS: 'a/b,c/d' };
eq('save->reload round-trip: serialize output parses back to the same config',
  parseEnvFile(serialize(roundtripCfg)), roundtripCfg);

// --- requireConfig: pin the Node<18 guard so a later refactor can't silently drop it -
// without this, missing fetch() would surface as a raw ReferenceError deep in ask-model.mjs
// instead of the one-line diagnostic this guard exists to give
{
  const realExit = process.exit, realFetch = globalThis.fetch;
  process.env.LITELLM_BASE_URL = 'https://x/v1'; process.env.LITELLM_API_KEY = 'k';
  process.exit = (code) => { throw new Error(`exit:${code}`); };
  delete globalThis.fetch;
  try {
    assert.throws(() => requireConfig(), /exit:1/, 'requireConfig dies when fetch is missing (Node <18)');
    n++;
  } finally {
    process.exit = realExit;
    globalThis.fetch = realFetch;
  }
}

console.log(`all ${n} litellm-council checks passed`);
