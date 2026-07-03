#!/usr/bin/env node
// Print the council model list, one id per line, cleaned (commas split, whitespace/CR
// trimmed, blank entries dropped). Falls back to a decorrelated NIM pair when unset.
import { loadConfig, DEFAULT_MODELS } from './config.mjs';
import { pathToFileURL } from 'node:url';

// .trim() also drops a stray \r. Falls back to the default whenever the CLEANED list is empty
// (not just when raw itself is blank) - so garbage like ",,," degrades safely instead of
// silently returning zero models.
const clean = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

export function councilModels(raw) {
  const cleaned = clean(raw);
  return cleaned.length ? cleaned : clean(DEFAULT_MODELS);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  for (const m of councilModels(loadConfig().models)) console.log(m);
}
