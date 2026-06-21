#!/usr/bin/env node
/**
 * secret-guard / secret-scan.mjs
 *
 * Pre-commit secret gate. One engine, two entry modes:
 *
 *   (default)  Claude Code PreToolUse hook. Reads the hook JSON on stdin.
 *              If a `git commit` would carry secrets -> prints a
 *              permissionDecision:"deny" object and exits 0 (Claude Code blocks
 *              the commit and shows the reason). Otherwise exits 0 silently.
 *
 *   --staged   Native git pre-commit mode (no stdin). Scans `git diff --cached`
 *              in the current repo. On a finding -> report to stderr, exit 1
 *              (git aborts the commit). Otherwise exit 0.
 *
 * No external dependencies. Fails OPEN on internal error (a bug in this script
 * must never block every commit). Never prints raw secret values - matches are
 * redacted before they reach the transcript or terminal.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_FINDINGS_SHOWN = 10;

// Does this Bash command actually run `git commit` (allowing flags / -C path)?
const COMMIT_RE = /\bgit\s+(?:-\S+\s+|--\S+\s+|-C\s+\S+\s+)*commit\b/;

/* High-confidence secret patterns. A match blocks the commit unless the line
   carries an allow-marker or looks like a placeholder (see IGNORE below). */
const RULES = [
  { name: 'Private key block',        re: /-----BEGIN(?:[ A-Z0-9]*)PRIVATE KEY-----/ },
  { name: 'AWS access key id',        re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/ },
  { name: 'AWS secret access key',    re: /aws.{0,20}?(?:secret|access).{0,20}?[:=]\s*['"]?[A-Za-z0-9/+]{40}\b/i },
  { name: 'GitHub token',             re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { name: 'GitHub fine-grained PAT',  re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/ },
  { name: 'GitLab PAT',               re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Slack token',              re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Slack webhook',            re: /hooks\.slack\.com\/services\/T[A-Za-z0-9_]+\/B[A-Za-z0-9_]+\/[A-Za-z0-9]+/ },
  { name: 'Google API key',           re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Anthropic API key',        re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'OpenAI API key',           re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: 'Stripe secret key',        re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'JWT',                      re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/ },
  { name: 'Credentials in URL',       re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/i },
  { name: 'Hardcoded secret assignment',
    re: /\b(?:pass(?:word|wd)?|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|token)\b\s*[:=]\s*['"][^'"]{6,}['"]/i },
];

/* If a line matches any of these, a hit is treated as a placeholder / env
   reference, not a real secret. Keeps false positives from training you to
   ignore the gate. */
const IGNORE = [
  /process\.env/i, /os\.environ/i, /getenv/i, /System\.getenv/i,
  /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/,                 // ${VAR} / $VAR
  /<[^>]{1,40}>/,                                   // <your-key>
  /\b(?:changeme|change_me|example|dummy|placeholder|redacted|sample|fake|test123|todo|fixme|your[_-]?\w+)\b/i,
  /x{4,}/i, /\*{4,}/, /\u2022{3,}/, /\.{5,}/,        // xxxx / **** / masked
  /\bENC\(/,                                        // jasypt-style encrypted
];

/* Inline opt-out markers for genuine false positives. */
const ALLOW_MARKERS = [
  /secret-guard:\s*allow/i, /gitleaks:allow/i, /pragma:\s*allowlist secret/i, /noqa:\s*secret/i,
];

function redact(line, re) {
  const m = line.match(re);
  if (!m) return '(redacted)';
  const s = m[0];
  if (s.length <= 8) return s.slice(0, 2) + '\u2026 (redacted)';
  return s.slice(0, 4) + '\u2026' + s.slice(-2) + ' (redacted)';
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/* Parse a unified diff produced with -U0 and return only ADDED lines,
   carrying their file path and new-file line number. */
function addedLines(diff) {
  const out = [];
  let file = null, lineNo = 0, binary = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) { file = null; binary = false; continue; }
    if (raw.startsWith('Binary files')) { binary = true; continue; }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = (p === '/dev/null') ? null : p.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/\+(\d+)/);
      lineNo = m ? parseInt(m[1], 10) : 0;
      continue;
    }
    if (binary || file === null) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      out.push({ file, line: lineNo, text: raw.slice(1) });
      lineNo++;
    } else if (raw.startsWith(' ')) {
      lineNo++;
    }
    // '-' lines do not advance the new-file line counter
  }
  return out;
}

export function scan(diff) {
  const findings = [];
  for (const { file, line, text } of addedLines(diff)) {
    if (ALLOW_MARKERS.some((r) => r.test(text))) continue;
    if (IGNORE.some((r) => r.test(text))) continue;
    for (const rule of RULES) {
      if (rule.re.test(text)) {
        findings.push({ rule: rule.name, file, line, preview: redact(text, rule.re) });
        break; // one finding per line is enough
      }
    }
  }
  return findings;
}

function collectDiff(cwd, commitAll) {
  let diff = git(['diff', '--cached', '--no-color', '-U0'], cwd);
  if (commitAll) {
    // `git commit -a/-am` also sweeps in tracked-but-unstaged edits
    try { diff += '\n' + git(['diff', '--no-color', '-U0'], cwd); } catch { /* ignore */ }
  }
  return diff;
}

function formatFindings(findings) {
  const shown = findings.slice(0, MAX_FINDINGS_SHOWN)
    .map((f) => `  \u2022 [${f.rule}] ${f.file}:${f.line}  ${f.preview}`)
    .join('\n');
  const more = findings.length > MAX_FINDINGS_SHOWN
    ? `\n  \u2026and ${findings.length - MAX_FINDINGS_SHOWN} more`
    : '';
  return shown + more;
}

const REMEDIATION =
  'Do NOT commit these. Fix: remove the value from the file (use an env var / a ' +
  'secrets manager / a gitignored .env), unstage it (`git restore --staged <file>` ' +
  'or edit the line), then commit again. If it is a genuine false positive ' +
  '(a sample/placeholder), add `secret-guard:allow` as a comment on that line.';

/* ---- mode: native git pre-commit (--staged) ---- */
function stagedMode() {
  const cwd = process.cwd();
  let diff;
  try { diff = collectDiff(cwd, false); }
  catch { process.exit(0); } // not a repo / git error -> do not block
  const findings = scan(diff);
  if (findings.length === 0) process.exit(0);
  process.stderr.write(
    '\n\uD83D\uDD12 secret-guard blocked this commit - possible secrets in staged changes:\n' +
    formatFindings(findings) + '\n\n' + REMEDIATION + '\n' +
    '(override one commit, if you are certain: git commit --no-verify)\n\n'
  );
  process.exit(1); // any non-zero aborts a native git commit
}

/* ---- mode: Claude Code PreToolUse hook (default, reads stdin) ---- */
async function hookMode() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;

  let data;
  try { data = JSON.parse(input || '{}'); } catch { process.exit(0); }

  if (data.tool_name !== 'Bash') process.exit(0);
  const cmd = (data.tool_input && data.tool_input.command) || '';
  if (!COMMIT_RE.test(cmd)) process.exit(0); // not a commit -> no opinion

  const cwd = data.cwd || process.cwd();
  const commitAll = /(?:^|\s)(?:-a|--all|-[A-Za-z]*a[A-Za-z]*)(?:\s|$)/.test(cmd);

  let diff;
  try { diff = collectDiff(cwd, commitAll); }
  catch { process.exit(0); } // fail open

  const findings = scan(diff);
  if (findings.length === 0) process.exit(0);

  const reason =
    '\uD83D\uDD12 secret-guard: commit blocked - possible secrets in the staged changes:\n' +
    formatFindings(findings) + '\n\n' + REMEDIATION;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// Only run when invoked directly (node secret-scan.mjs ...), not when imported
// by the test, which exercises scan() with synthetic diffs.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    if (process.argv.includes('--staged')) stagedMode();
    else await hookMode();
  } catch {
    process.exit(0); // never block on an internal error
  }
}
