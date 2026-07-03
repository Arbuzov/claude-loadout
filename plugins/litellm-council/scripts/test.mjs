#!/usr/bin/env node
// Self-check for the litellm-council scripts. No proxy, no deps: exercises the pure logic
// (config parse/merge, model-list cleaning, catalog parse/filter, request heuristics, reply
// extraction). Run: node scripts/test.mjs
import assert from 'node:assert/strict';
import { parseEnvFile, loadConfig, joinUrl, requireConfig } from './config.mjs';
import { councilModels } from './council-models.mjs';
import { parseModels, filterModels } from './list-models.mjs';
import { maxTokensFor, extractReply } from './ask-model.mjs';
import { mergeConfig, serialize } from './save-config.mjs';

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
eq('extractReply error.message', extractReply({ error: { message: 'bad model' } }), 'bad model');
eq('extractReply error string', extractReply({ error: 'nope' }), 'nope');
eq('extractReply detail', extractReply({ detail: 'rate limited' }), 'rate limited');
eq('extractReply nothing -> null', extractReply({}), null);
eq('extractReply non-string error object -> JSON.stringify',
  extractReply({ error: { code: 'invalid_request', type: 'x' } }), JSON.stringify({ code: 'invalid_request', type: 'x' }));

// --- save-config ---
eq('mergeConfig env overrides, preserves the rest',
  mergeConfig({ LITELLM_BASE_URL: 'u', LITELLM_API_KEY: 'k', LITELLM_COUNCIL_MODELS: 'old' },
    { LITELLM_COUNCIL_MODELS: 'new', OTHER: 'x' }),
  { LITELLM_BASE_URL: 'u', LITELLM_API_KEY: 'k', LITELLM_COUNCIL_MODELS: 'new' });
eq('mergeConfig ignores empty env value', mergeConfig({ LITELLM_API_KEY: 'k' }, { LITELLM_API_KEY: '' }), { LITELLM_API_KEY: 'k' });
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
