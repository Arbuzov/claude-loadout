#!/usr/bin/env node
/**
 * fork-guard.mjs - Claude Code PreToolUse gate for the corporate fork -> MR workflow.
 *
 * Blocks `git push` to your corporate GitLab UNLESS the target remote lives under
 * your fork namespace. Group/upstream projects are read-only here: push to your
 * fork and open a Merge Request.
 *
 * Reads the hook JSON on stdin. On a blocked push: prints permissionDecision:"deny"
 * and exit 0. Otherwise exit 0 silently. Fails OPEN on internal error, and no-ops
 * until configured (so installing the plugin is harmless before /corporate-gitlab:setup).
 *
 * Config (env wins; otherwise read from git config, where /corporate-gitlab:setup
 * persists them). Unset host -> the guard does nothing:
 *   CORP_GIT_HOST       corporate GitLab host        (git config corpgit.host)
 *   CORP_GIT_NAMESPACE  fork namespace to allow      (git config corpgit.namespace)
 *   CORP_GIT_ALLOW_UPSTREAM_PUSH=1   disable the block entirely (escape hatch)
 */

import { execFileSync } from 'node:child_process';

const PUSH_RE = /\bgit\s+(?:-\S+\s+|--\S+\s+|-C\s+\S+\s+)*push\b/;

let HOST = '';        // resolved in main()
let NAMESPACE = '';

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 4 * 1024 * 1024,
  }).trim();
}

// git config value, or '' if unset / git unavailable.
function gitcfg(key, cwd) {
  try { return git(['config', '--get', key], cwd); } catch { return ''; }
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

// First path segment (namespace) of a GitLab remote URL, plus whether it is corporate.
function namespaceOf(url) {
  if (!url || !url.includes(HOST)) return { corporate: false };
  let path = null;
  let m = url.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*\/(.+)$/i); // ssh:// or https://
  if (m) path = m[1];
  if (!path) { m = url.match(/:(.+)$/); if (m) path = m[1]; } // scp-style git@host:ns/repo
  if (!path) return { corporate: true, namespace: null };
  path = path.replace(/^\/+/, '').replace(/\.git$/, '');
  const seg = path.split('/')[0] || null;
  return { corporate: true, namespace: seg ? seg.toLowerCase() : null };
}

// Resolve which remote URL this push targets (or null if undeterminable).
function resolveRemoteUrl(cmd, cwd) {
  const after = cmd.replace(/^[\s\S]*?\bpush\b/, '');
  const toks = after.split(/\s+/).filter(Boolean);
  let remote = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.startsWith('-')) {
      if (/^(-o|--push-option|--repo|--receive-pack|--exec)$/.test(t)) i++; // consumes a value
      continue;
    }
    remote = t;
    break;
  }
  // direct URL on the command line
  if (remote && /(^[a-z][a-z0-9+.-]*:\/\/)|(@[^/]*:)/i.test(remote)) return remote;
  // a refspec (HEAD, branch:branch) rather than a remote name
  if (remote && (remote === 'HEAD' || (remote.includes(':') && !remote.includes('@') && !remote.includes('//')))) {
    remote = null;
  }
  try {
    if (remote) return git(['remote', 'get-url', remote], cwd);
    let name = '';
    try { name = git(['config', '--get', `branch.${git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)}.remote`], cwd); } catch { /* detached / no upstream */ }
    if (!name) name = 'origin';
    return git(['remote', 'get-url', name], cwd);
  } catch { return null; }
}

async function main() {
  if (process.env.CORP_GIT_ALLOW_UPSTREAM_PUSH === '1') process.exit(0);

  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;

  let data;
  try { data = JSON.parse(input || '{}'); } catch { process.exit(0); }
  if (data.tool_name !== 'Bash') process.exit(0);
  const cmd = (data.tool_input && data.tool_input.command) || '';
  if (!PUSH_RE.test(cmd)) process.exit(0);

  const cwd = data.cwd || process.cwd();
  HOST = (process.env.CORP_GIT_HOST || gitcfg('corpgit.host', cwd)).trim();
  NAMESPACE = (process.env.CORP_GIT_NAMESPACE || gitcfg('corpgit.namespace', cwd)).trim().toLowerCase();
  if (!HOST || !NAMESPACE) process.exit(0); // not configured -> no opinion

  const info = namespaceOf(resolveRemoteUrl(cmd, cwd) || '');

  if (!info.corporate) process.exit(0);             // not corporate GitLab -> no opinion
  if (info.namespace === NAMESPACE) process.exit(0); // pushing to your fork -> allowed

  const where = info.namespace ? `"${info.namespace}/..."` : 'the corporate project';
  deny(
    `🔱 fork-guard: push to ${where} on ${HOST} is blocked - corporate changes go through a Merge Request from your fork.\n` +
    `Do this instead:\n` +
    `  1. Fork the project in GitLab, then add the remote:\n` +
    `       git remote add fork ssh://git@${HOST}/${NAMESPACE}/<repo>.git\n` +
    `  2. Push the topic branch to your fork:  git push -u fork HEAD\n` +
    `  3. Open an MR from ${NAMESPACE}/<repo> into the upstream default branch (GitLab MCP or web UI).\n` +
    `(If you genuinely have rights to push upstream, set CORP_GIT_ALLOW_UPSTREAM_PUSH=1 for this session.)`
  );
}

main().catch(() => process.exit(0));
