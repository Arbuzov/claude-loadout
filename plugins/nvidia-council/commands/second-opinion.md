---
description: Cross-model review of your current diff straight through NVIDIA's hosted NIM endpoint - no LiteLLM proxy in the path. Reads NVIDIA_API_KEY / NVIDIA_COUNCIL_MODELS (nothing hardcoded), sends the diff to each council model, then reconciles their findings with your own review - agreement, disagreement, merged verdict. Node, no MCP, no local server.
---

Get a cross-model second opinion on the current change set from NVIDIA's council models, then
reconcile it with your own review. Everything runs through `scripts/nim.mjs` - no MCP server, no
proxy.

Run the numbered steps in order. **Each fenced block is one shell invocation** - shell variables
and the cleanup `trap` do not carry across blocks, which is why the diff is captured and sent
inside a single block in step 3.

## 1. Preflight (never invent values)
Config comes from the environment or from `/nvidia-council:setup`
(`~/.config/nvidia-council/env`):

- `NVIDIA_API_KEY` - an `nvapi-...` key from build.nvidia.com. Never print or echo it.
- `NVIDIA_COUNCIL_MODELS` (optional) - comma-separated bare NIM ids (no `nvidia_nim/` prefix).
- `NVIDIA_BASE_URL` (optional) - only for a self-hosted NIM; defaults to NVIDIA hosted.

The block fails fast and names what is missing - relay that, do not guess. `config` prints a
non-secret summary and never echoes the key:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not inside a git repository - run this from your repo"; exit 1; }
    command -v node >/dev/null || { echo "node not on PATH (the council scripts are Node)"; exit 1; }
    node "$ROOT/scripts/nim.mjs" config || exit 1

## 2. Privacy gate (before anything is sent - do not skip)
NVIDIA's API Trial terms allow using submitted content to improve their models and explicitly
forbid uploading confidential data. So this is for **non-proprietary / OSS code only**.
Company-proprietary code goes through a subscription path (the Codex plugin) or a self-hosted
model instead.

Show the user the scope first (read-only, sends nothing), then **STOP and get explicit
confirmation** that this diff may go to NVIDIA - do not infer consent from context:

    BASE=""
    for CAND in "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do
      [ -n "$CAND" ] && git rev-parse --verify --quiet "${CAND}^{commit}" >/dev/null 2>&1 && { BASE="$CAND"; break; }
    done
    S=""
    [ -n "$BASE" ] && MB="$(git merge-base "$BASE" HEAD 2>/dev/null)" && S="$(git diff --stat "$MB" 2>/dev/null)"
    [ -n "$S" ] || S="$(git diff --stat --staged 2>/dev/null)"
    [ -n "$S" ] || S="$(git diff --stat 2>/dev/null)"
    [ -n "$S" ] && printf '%s\n' "$S"

Only continue after the user has clearly approved.

## 3. Capture the diff and query the council (one block)
Diff from the **merge-base** with origin's default branch (resolved and **verified to exist** at
runtime - no hardcoded, unverified `main`) to the working tree, so committed, staged AND
uncommitted changes are all reviewed; `BASE...HEAD` would silently skip your uncommitted work.
Falls back to staged, then the working tree, when there is no such base. The diff goes to
a temp file and is piped in as stdin, never interpolated into a shell string; the `trap` removes
it on every exit path. `nim.mjs ask` fans out over the council with staggered starts (per-key
rate limit), bumps `max_tokens` for reasoning models, and prints a bounded error instead of
dying if one model fails:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    DIFF="$(mktemp)"; trap 'rm -f "$DIFF" "$DIFF.x"' EXIT
    BASE=""
    for CAND in "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do
      [ -n "$CAND" ] && git rev-parse --verify --quiet "${CAND}^{commit}" >/dev/null 2>&1 && { BASE="$CAND"; break; }
    done
    [ -n "$BASE" ] && MB="$(git merge-base "$BASE" HEAD 2>/dev/null)" && git diff "$MB" > "$DIFF" 2>/dev/null
    [ -s "$DIFF" ] || git diff --staged > "$DIFF"
    [ -s "$DIFF" ] || git diff > "$DIFF"
    [ -s "$DIFF" ] || { echo "Nothing to review (clean tree)"; exit 0; }
    [ "$(wc -l < "$DIFF" | tr -d ' ')" -gt 1500 ] && { head -n 1500 "$DIFF" > "$DIFF.x"; mv "$DIFF.x" "$DIFF"; echo "(diff truncated to first 1500 lines)"; }
    { printf '%s\n\n' "You are a senior code reviewer. Review this diff for bugs, security issues, race conditions, and missed edge cases. Be specific and concise. Diff:"; cat "$DIFF"; } \
      | node "$ROOT/scripts/nim.mjs" ask

Reasoning models like DeepSeek-R1 are slow; if one keeps hitting the 300s timeout, drop it and
keep a fast coder model for reviews.

**Read the error before reacting.** Only `HTTP 404`/`410` means the model id rotted - that is the
case for `/nvidia-council:doctor` and a replacement. `401`/`403` means the key was rejected (fix
`NVIDIA_API_KEY`; the models are fine), `429` means the free tier's ~40 req/min per-key limit
survived the built-in `Retry-After` retry (wait a minute, re-run), `5xx` is an NVIDIA-side fault,
and `(no response - timeout: ...)` means that model is too slow for the budget. Do not go
replacing council models for any of those.

## 4. Present and synthesize
- Show each model's findings under its own id.
- Then synthesize: where the models AGREE (higher-confidence issues), where they DISAGREE, and
  anything they caught that your own review missed.
- Flag issues by severity (Critical / Warning / Suggestion). Attribute each claim to the model
  that made it - do not present a model's guess as established fact. End with a merged,
  prioritized verdict reconciled with your own review.
- Models only see the diff, not the repo. Verify a claimed bug against the actual files before
  acting on it - "you dropped X" is often X living in an unchanged file.
