#!/usr/bin/env node
// Shared config for the litellm-council scripts. Reads LITELLM_BASE_URL / LITELLM_API_KEY /
// LITELLM_COUNCIL_MODELS from the environment, falling back to the file written by
// /litellm-council:setup (~/.config/litellm-council/env). A live env var always wins.
// Run directly (`node config.mjs`) to validate + print a non-secret summary.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG_PATH =
  process.env.LITELLM_COUNCIL_ENV || join(homedir(), '.config', 'litellm-council', 'env');

export const DEFAULT_MODELS =
  'nvidia_nim/deepseek-ai/deepseek-r1,nvidia_nim/qwen/qwen2.5-coder-32b-instruct';

// Parse a config file into { KEY: value }. Tolerant of plain dotenv (KEY=value, KEY="value")
// and the older shell form (export KEY="${KEY:-value}") so an existing file keeps working.
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let [, key, val] = m;
    val = val.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    const def = val.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*:-([\s\S]*)\}$/); // ${VAR:-default}
    if (def) val = def[1];
    out[key] = val;
  }
  return out;
}

function fileConfig() {
  try { return parseEnvFile(readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

// env-wins: a non-blank live env var overrides the file. Whitespace-only counts as unset too -
// matches councilModels' own emptiness test, so a blank-but-present env var (e.g. from a
// templating system that failed to interpolate) can't silently shadow a real saved value.
export function loadConfig(env = process.env, file = fileConfig()) {
  const pick = (k) => (env[k] != null && env[k].trim() !== '' ? env[k] : file[k]);
  return {
    baseUrl: pick('LITELLM_BASE_URL'),
    apiKey: pick('LITELLM_API_KEY'),
    models: pick('LITELLM_COUNCIL_MODELS'),
  };
}

// Join base + path with exactly one slash, so a trailing slash on the base never doubles up.
export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

export function die(msg, code = 1) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

export function requireConfig() {
  if (typeof fetch !== 'function') die('this needs Node >=18 (built-in fetch not found) - check `node --version`');
  const c = loadConfig();
  if (!c.baseUrl) die('set LITELLM_BASE_URL (or run /litellm-council:setup)');
  if (!c.apiKey) die('set LITELLM_API_KEY (or run /litellm-council:setup)');
  return c;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  if (typeof fetch !== 'function') die('this needs Node >=18 (built-in fetch not found) - check `node --version`');
  const c = loadConfig();
  const missing = [!c.baseUrl && 'LITELLM_BASE_URL', !c.apiKey && 'LITELLM_API_KEY'].filter(Boolean);
  if (missing.length) die(`missing ${missing.join(', ')} (set in env or run /litellm-council:setup)`);
  console.log(`base URL: ${c.baseUrl}`);
  console.log('api key:  set (not shown)');
  console.log(`models:   ${c.models && c.models.trim() ? c.models : '(default pair)'}`);
}
