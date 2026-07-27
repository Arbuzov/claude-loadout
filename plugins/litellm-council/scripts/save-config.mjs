#!/usr/bin/env node
// Save the litellm-council config to ~/.config/litellm-council/env (0600), merging over any
// existing file so a partial update (e.g. only models) preserves the base URL and key. Values
// come from the ENVIRONMENT (LITELLM_BASE_URL / LITELLM_API_KEY / LITELLM_COUNCIL_MODELS), never
// argv - so a secret key is not exposed on the command line. Written by /litellm-council:setup
// and :models.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONFIG_PATH, parseEnvFile } from './config.mjs';

const KEYS = ['LITELLM_BASE_URL', 'LITELLM_API_KEY', 'LITELLM_COUNCIL_MODELS'];

// existing (from file) overlaid by any non-blank env value among KEYS. Whitespace-only counts as
// unset - matching loadConfig, which also ignores it. Without the trim, `LITELLM_API_KEY=' '`
// (a failed shell interpolation) overwrites a good saved key with a space, passes the truthiness
// check below, and gets written to disk: the credential is destroyed by a "successful" save.
export function mergeConfig(existing, env) {
  const out = { ...existing };
  for (const k of KEYS) if (env[k] != null && String(env[k]).trim() !== '') out[k] = env[k];
  return out;
}

export function serialize(cfg) {
  return KEYS.filter((k) => cfg[k] != null && cfg[k] !== '').map((k) => `${k}=${cfg[k]}`).join('\n') + '\n';
}

function main() {
  const existing = existsSync(CONFIG_PATH) ? parseEnvFile(readFileSync(CONFIG_PATH, 'utf8')) : {};
  const merged = mergeConfig(existing, process.env);
  if (!merged.LITELLM_BASE_URL?.trim() || !merged.LITELLM_API_KEY?.trim()) {
    process.stderr.write('need LITELLM_BASE_URL and LITELLM_API_KEY (in the environment) to save config\n');
    process.exit(1);
  }
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  if (existsSync(CONFIG_PATH)) {
    copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
    // the backup holds the key too, and copyFileSync carries the SOURCE's mode - which may be
    // loose if that file was hand-written
    try { chmodSync(CONFIG_PATH + '.bak', 0o600); } catch { /* best effort on Windows */ }
  }
  writeFileSync(CONFIG_PATH, serialize(merged), { mode: 0o600 });
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* best effort on Windows */ }
  process.stdout.write(`saved config to ${CONFIG_PATH} (key not shown); models: ${merged.LITELLM_COUNCIL_MODELS || '(default pair)'}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
