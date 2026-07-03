#!/usr/bin/env node
// List the model ids the proxy exposes (GET {LITELLM_BASE_URL}/models), one per line, sorted
// and de-duplicated. Optional arg is a case-insensitive literal substring filter.
//   Usage: node list-models.mjs [filter]
import { requireConfig, joinUrl, die } from './config.mjs';
import { pathToFileURL } from 'node:url';

// Extract ids from the OpenAI-compatible {"data":[{"id":...}]} shape; throw on any other shape.
export function parseModels(json) {
  if (!json || !Array.isArray(json.data)) throw new Error('no data array');
  return json.data.map((m) => m && m.id).filter((x) => typeof x === 'string' && x !== '');
}

export function filterModels(ids, filter) {
  const uniqueSorted = [...new Set(ids)].sort();
  if (!filter) return uniqueSorted;
  const f = filter.toLowerCase();
  return uniqueSorted.filter((id) => id.toLowerCase().includes(f)); // literal substring, no regex
}

// Fetch + parse the catalog. Returns the raw id list (may be [] for an empty catalog). Throws on
// a network error, or on a non-JSON / wrong-shape body (with `.raw`/`.url` attached for context).
export async function fetchModelIds({ baseUrl, apiKey, timeoutMs = 30000 }) {
  const url = joinUrl(baseUrl, 'models');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
  const raw = await res.text();
  try {
    return parseModels(JSON.parse(raw));
  } catch {
    const e = new Error('unreadable model list');
    e.raw = raw;
    e.url = url;
    throw e;
  }
}

async function main() {
  const filter = process.argv[2] || '';
  const cfg = requireConfig();
  let ids;
  try {
    ids = await fetchModelIds(cfg);
  } catch (e) {
    if (e.raw !== undefined) {
      process.stderr.write(`could not read a model list from ${e.url}\n${String(e.raw).slice(0, 300)}\n`);
      process.exit(1);
    }
    die(`could not reach the proxy: ${e.code || e.cause?.code || e.name || e.message}`);
  }
  if (ids.length === 0) {
    // an empty catalog is NOT an error - the proxy may expose models only behind a wildcard the
    // OpenAI /models route does not expand; tell the user so they can type ids directly
    process.stderr.write('the proxy returned an empty catalog (models may be exposed only behind a wildcard) - type ids manually\n');
    process.exit(0);
  }
  for (const id of filterModels(ids, filter)) console.log(id);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
