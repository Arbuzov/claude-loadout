#!/usr/bin/env node
// List the model ids the proxy exposes (GET {LITELLM_BASE_URL}/models), one per line, sorted
// and de-duplicated. Optional arg is a case-insensitive literal substring filter.
//   Usage: node list-models.mjs [filter]
import { requireConfig, joinUrl, die, redact } from './config.mjs';
import { pathToFileURL } from 'node:url';

// Extract ids from the OpenAI-compatible {"data":[{"id":...}]} shape; throw on any other shape.
export function parseModels(json) {
  if (!json || !Array.isArray(json.data)) throw new Error('no data array');
  return json.data.map((m) => m && m.id).filter((x) => typeof x === 'string' && x !== '');
}

// Say which KIND of failure it was, so a key problem doesn't read as a broken catalog.
export function statusHint(status) {
  if (status === 401 || status === 403) return ' (fix LITELLM_API_KEY)';
  if (status === 429) return ' (rate limited - wait and re-run)';
  if (status >= 500) return ' (the proxy or provider is faulting - check the proxy is up)';
  return '';
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
    if (!res.ok) throw new Error('http');
    return parseModels(JSON.parse(raw));
  } catch {
    // carry the STATUS through: a 401 here is a key problem and a 5xx is a proxy problem, and
    // flattening both into "unreadable model list" hides which one it is
    const e = new Error(res.ok ? 'unreadable model list' : 'the proxy rejected the request');
    e.raw = raw;
    e.url = url;
    e.status = res.ok ? undefined : res.status;
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
      const status = e.status ? `HTTP ${e.status} - ` : '';
      process.stderr.write(`could not read a model list from ${e.url}: ${status}${e.message}${statusHint(e.status)}\n${redact(String(e.raw).slice(0, 300), cfg.apiKey)}\n`);
      process.exit(1);
    }
    die(`could not reach the proxy: ${e.cause?.code || e.name || e.message}`);
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
