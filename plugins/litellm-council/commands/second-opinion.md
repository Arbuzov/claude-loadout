---
description: Cross-model review of your current diff through your self-hosted LiteLLM proxy. Reads LITELLM_BASE_URL / LITELLM_API_KEY / LITELLM_COUNCIL_MODELS (nothing hardcoded), sends the diff to each configured model with curl, then reconciles their findings with your own review - agreement, disagreement, merged verdict. No MCP, no local server.
---

Get a cross-model second opinion on the current change set through the user's LiteLLM
proxy, then reconcile it with your own review. This shells out with `curl` + `jq` - there
is no MCP server and nothing endpoint-specific is baked in.

Run the numbered steps in order. **Each fenced block is one shell invocation** - variables
and the cleanup `trap` do not carry across blocks, which is why the diff is captured and
sent inside a single block in step 3.

## 1. Preflight - config and tools (never invent values)
Config comes from the environment or from `/litellm-council:setup` (saved to
`~/.config/litellm-council/env`, sourced by the block below and by the bundled scripts):

- `LITELLM_BASE_URL` - OpenAI-compatible base, e.g. `https://litellm.example.com/v1`
- `LITELLM_API_KEY` - the proxy master/virtual key. Never print or echo it.
- `LITELLM_COUNCIL_MODELS` (optional) - comma-separated model ids. Any id your proxy
  exposes works (NIM, OpenAI `gpt-*`, ...). Default when unset:
  `nvidia_nim/deepseek-ai/deepseek-r1,nvidia_nim/qwen/qwen2.5-coder-32b-instruct`.

The block fails fast and names any required value still missing - relay that, do not guess:

    CFG="${LITELLM_COUNCIL_ENV:-$HOME/.config/litellm-council/env}"; [ -f "$CFG" ] && . "$CFG"
    git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not inside a git repository - run this from your repo"; exit 1; }
    : "${LITELLM_BASE_URL:?set LITELLM_BASE_URL (or run /litellm-council:setup)}"
    : "${LITELLM_API_KEY:?set LITELLM_API_KEY (or run /litellm-council:setup)}"
    command -v curl >/dev/null || { echo "curl not on PATH"; exit 1; }
    command -v jq   >/dev/null || { echo "jq not on PATH (needed to build the request JSON)"; exit 1; }

## 2. Privacy gate (before anything is sent - do not skip)
Hosted council models (e.g. the NVIDIA NIM free tier via LiteLLM) may, per their terms of
service, use submitted content to improve their models. So this is for **non-proprietary /
OSS code only**. Company-proprietary code should be reviewed through a subscription path (the
Codex plugin) or a self-hosted model instead.

Show the user the scope first (read-only, sends nothing), then **STOP and get their explicit
confirmation** that this diff may go to hosted models - do not infer consent from context:

    BASE="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
    for R in "$BASE...HEAD" "--staged" ""; do
      S="$(git diff --stat $R 2>/dev/null)"
      [ -n "$S" ] && { printf '%s\n' "$S"; break; }
    done

Only continue to step 3 after the user has clearly approved.

## 3. Capture the diff and query each model (one block)
Prefer the branch diff (against origin's default branch, resolved at runtime — no hardcoded
`main`), fall back to staged, then the working tree. The diff goes to a temp
file (escaped safely, never interpolated); the `trap` removes it on every exit path including
an interrupted curl. Each model is queried through `ask-model.sh`, which builds the request,
bumps `max_tokens` for slow reasoning models, and prints the reply or a bounded error - so one
model failing never aborts the council. The model list comes from `council-models.sh`:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    DIFF="$(mktemp)"; trap 'rm -f "$DIFF" "$DIFF.x"' EXIT
    BASE="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
    git diff "$BASE...HEAD" > "$DIFF" 2>/dev/null
    [ -s "$DIFF" ] || git diff --staged > "$DIFF"
    [ -s "$DIFF" ] || git diff > "$DIFF"
    [ -s "$DIFF" ] || { echo "Nothing to review (clean tree)"; exit 0; }
    [ "$(wc -l < "$DIFF" | tr -d ' ')" -gt 1500 ] && { head -n 1500 "$DIFF" > "$DIFF.x"; mv "$DIFF.x" "$DIFF"; echo "(diff truncated to first 1500 lines)"; }

    PROMPT="You are a senior code reviewer. Review this diff for bugs, security issues, race conditions, and missed edge cases. Be specific and concise. Diff:

    $(cat "$DIFF")"
    bash "$ROOT/scripts/council-models.sh" | while read -r M; do
      echo "### $M"
      printf '%s' "$PROMPT" | bash "$ROOT/scripts/ask-model.sh" "$M"
      echo
    done

Reasoning models like DeepSeek-R1 can be slow; if one keeps hitting `ask-model.sh`'s
`--max-time 300` ceiling, drop it and keep a fast coder model (e.g. qwen-coder) for the review.

## 4. Present and synthesize
- Show each model's findings under its own id.
- Then synthesize: where the models AGREE (higher-confidence issues), where they DISAGREE,
  and anything they caught that your own review missed.
- Flag issues by severity (Critical / Warning / Suggestion). Attribute each claim to the
  model that made it - do not present a model's guess as established fact. End with a merged,
  prioritized verdict reconciled with your own review.
