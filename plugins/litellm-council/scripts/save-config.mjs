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

// existing (from file) overlaid by any non-empty env value among KEYS
export function mergeConfig(existing, env) {
  const out = { ...existing };
  for (const k of KEYS) if (env[k] != null && env[k] !== '') out[k] = env[k];
  return out;
}

export function serialize(cfg) {
  return KEYS.filter((k) => cfg[k] != null && cfg[k] !== '').map((k) => `${k}=${cfg[k]}`).join('\n') + '\n';
}

function main() {
  const existing = existsSync(CONFIG_PATH) ? parseEnvFile(readFileSync(CONFIG_PATH, 'utf8')) : {};
  const merged = mergeConfig(existing, process.env);
  if (!merged.LITELLM_BASE_URL || !merged.LITELLM_API_KEY) {
    process.stderr.write('need LITELLM_BASE_URL and LITELLM_API_KEY (in the environment) to save config\n');
    process.exit(1);
  }
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  if (existsSync(CONFIG_PATH)) copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
  writeFileSync(CONFIG_PATH, serialize(merged), { mode: 0o600 });
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* best effort on Windows */ }
  process.stdout.write(`saved config to ${CONFIG_PATH} (key not shown); models: ${merged.LITELLM_COUNCIL_MODELS || '(default pair)'}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
