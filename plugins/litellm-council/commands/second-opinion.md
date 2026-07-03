---
description: Cross-model review of your current diff through your self-hosted LiteLLM proxy. Reads LITELLM_BASE_URL / LITELLM_API_KEY / LITELLM_COUNCIL_MODELS (nothing hardcoded), sends the diff to each configured model, then reconciles their findings with your own review - agreement, disagreement, merged verdict. Node, no MCP, no local server.
---

Get a cross-model second opinion on the current change set through the user's LiteLLM
proxy, then reconcile it with your own review. The heavy lifting runs through the bundled
Node scripts (`scripts/*.mjs`) - no MCP server, nothing endpoint-specific baked in.

Run the numbered steps in order. **Each fenced block is one shell invocation** - the shell
variables and the cleanup `trap` do not carry across blocks, which is why the diff is
captured and sent inside a single block in step 3.

## 1. Preflight - config and tools (never invent values)
Config comes from the environment or from `/litellm-council:setup` (saved to
`~/.config/litellm-council/env`, read by the Node scripts):

- `LITELLM_BASE_URL` - OpenAI-compatible base, e.g. `https://litellm.example.com/v1`
- `LITELLM_API_KEY` - the proxy master/virtual key. Never print or echo it.
- `LITELLM_COUNCIL_MODELS` (optional) - comma-separated model ids. Any id your proxy
  exposes works (NIM, OpenAI `gpt-*`, ...). Default when unset:
  `nvidia_nim/deepseek-ai/deepseek-r1,nvidia_nim/qwen/qwen2.5-coder-32b-instruct`.

The block fails fast and names any required value still missing - relay that, do not guess.
`config.mjs` prints a non-secret summary (it never echoes the key):

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not inside a git repository - run this from your repo"; exit 1; }
    command -v node >/dev/null || { echo "node not on PATH (the council scripts are Node)"; exit 1; }
    node "$ROOT/scripts/config.mjs" || exit 1

## 2. Privacy gate (before anything is sent - do not skip)
Hosted council models (e.g. the NVIDIA NIM free tier via LiteLLM) may, per their terms of
service, use submitted content to improve their models. So this is for **non-proprietary /
OSS code only**. Company-proprietary code should be reviewed through a subscription path (the
Codex plugin) or a self-hosted model instead.

Show the user the scope first (read-only, sends nothing), then **STOP and get their explicit
confirmation** that this diff may go to hosted models - do not infer consent from context:

    BASE=""
    for CAND in "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do
      [ -n "$CAND" ] && git rev-parse --verify --quiet "${CAND}^{commit}" >/dev/null 2>&1 && { BASE="$CAND"; break; }
    done
    S=""
    [ -n "$BASE" ] && S="$(git diff --stat "$BASE...HEAD" 2>/dev/null)"
    [ -n "$S" ] || S="$(git diff --stat --staged 2>/dev/null)"
    [ -n "$S" ] || S="$(git diff --stat 2>/dev/null)"
    [ -n "$S" ] && printf '%s\n' "$S"

Only continue to step 3 after the user has clearly approved.

## 3. Capture the diff and query each model (one block)
Prefer the branch diff (against origin's default branch, resolved and **verified to exist**
at runtime - no hardcoded, unverified `main`), fall back to staged, then the working tree. The
diff goes to a temp file (escaped safely, never interpolated); the `trap` removes it on every
exit path. Each model is queried through `ask-model.mjs`, which builds the request, bumps
`max_tokens` for slow reasoning models, and prints the reply or a bounded error - so one model
failing never aborts the council. The model list comes from `council-models.mjs`:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    DIFF="$(mktemp)"; trap 'rm -f "$DIFF" "$DIFF.x"' EXIT
    BASE=""
    for CAND in "$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do
      [ -n "$CAND" ] && git rev-parse --verify --quiet "${CAND}^{commit}" >/dev/null 2>&1 && { BASE="$CAND"; break; }
    done
    [ -n "$BASE" ] && git diff "$BASE...HEAD" > "$DIFF" 2>/dev/null
    [ -s "$DIFF" ] || git diff --staged > "$DIFF"
    [ -s "$DIFF" ] || git diff > "$DIFF"
    [ -s "$DIFF" ] || { echo "Nothing to review (clean tree)"; exit 0; }
    [ "$(wc -l < "$DIFF" | tr -d ' ')" -gt 1500 ] && { head -n 1500 "$DIFF" > "$DIFF.x"; mv "$DIFF.x" "$DIFF"; echo "(diff truncated to first 1500 lines)"; }

    PROMPT="You are a senior code reviewer. Review this diff for bugs, security issues, race conditions, and missed edge cases. Be specific and concise. Diff:

    $(cat "$DIFF")"
    node "$ROOT/scripts/council-models.mjs" | while read -r M; do
      echo "### $M"
      printf '%s' "$PROMPT" | node "$ROOT/scripts/ask-model.mjs" "$M"
      echo
    done

Reasoning models like DeepSeek-R1 can be slow; if one keeps hitting `ask-model.mjs`'s 300s
timeout, drop it and keep a fast coder model (e.g. qwen-coder) for the review.

## 4. Present and synthesize
- Show each model's findings under its own id.
- Then synthesize: where the models AGREE (higher-confidence issues), where they DISAGREE,
  and anything they caught that your own review missed.
- Flag issues by severity (Critical / Warning / Suggestion). Attribute each claim to the
  model that made it - do not present a model's guess as established fact. End with a merged,
  prioritized verdict reconciled with your own review.
