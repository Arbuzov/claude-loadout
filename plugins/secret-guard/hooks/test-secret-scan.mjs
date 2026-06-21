#!/usr/bin/env node
/**
 * Self-check for secret-scan's scan(): feeds synthetic -U0 diffs and asserts the
 * security-relevant behavior. Run: node test-secret-scan.mjs  (no framework, no deps).
 */
import assert from 'node:assert/strict';
import { scan } from './secret-scan.mjs';

// Build a minimal `git diff -U0`-style hunk for one file with the given lines.
// Each line is the raw diff line, e.g. '+secret = "..."' (added) or '-old' (removed).
function diff(file, ...lines) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,0 +1,${lines.length} @@`,
    ...lines,
  ].join('\n');
}

const KEY = 'AKIA1234567890ABCD12'; // matches "AWS access key id", no placeholder word

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('  ok -', name); }

check('catches a hardcoded AWS access key id on an added line', () => {
  const f = scan(diff('config.js', `+const key = "${KEY}"`));
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'AWS access key id');
  assert.ok(!f[0].preview.includes(KEY), 'preview must be redacted');
});

check('catches a private key block', () => {
  const f = scan(diff('id_rsa', '+-----BEGIN RSA PRIVATE KEY-----'));
  assert.equal(f.length, 1);
  assert.equal(f[0].rule, 'Private key block');
});

check('ignores env-var references (not a real secret)', () => {
  assert.equal(scan(diff('app.js', '+const key = process.env.SECRET_KEY')).length, 0);
});

check('ignores placeholders', () => {
  assert.equal(scan(diff('readme.md', '+api_key = "<your-key-here>"')).length, 0);
});

check('respects an inline allow-marker', () => {
  assert.equal(scan(diff('sample.js', `+const key = "${KEY}" // secret-guard:allow`)).length, 0);
});

check('only scans ADDED lines, not removed ones', () => {
  assert.equal(scan(diff('cleanup.js', `-const key = "${KEY}"`)).length, 0);
});

console.log(`\n${passed} checks passed.`);
