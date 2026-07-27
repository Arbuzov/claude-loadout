---
description: Ask the NVIDIA council an arbitrary question (not tied to a diff) and get several models' answers plus a synthesis. Talks straight to NVIDIA's hosted NIM endpoint - no LiteLLM proxy in the path. Reads NVIDIA_API_KEY / NVIDIA_COUNCIL_MODELS (or the config from /nvidia-council:setup). Node, no MCP.
---

Put an arbitrary question - a design call, a debugging dead-end, a "which approach" - to the
council models on NVIDIA's hosted NIM endpoint, then synthesize their answers with your own view.

## 1. Get the question
Use the text the user passed with the command. If they invoked it with none, ask for one (one
short prompt) and wait.

## 2. Privacy note (once)
NVIDIA's API Trial terms permit using submitted content to improve their models, and explicitly
forbid uploading confidential data - so keep this **non-proprietary**. For proprietary matters
use a subscription path (the Codex plugin) or a self-hosted model. Mention it once; a general
question does not need the hard stop that `second-opinion` uses for a code diff.

## 3. Ask the council
`nim.mjs ask` fans out over the configured models itself, staggering the request starts to stay
under NVIDIA's per-key rate limit, and prints each answer under a `### <model>` heading:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    node "$ROOT/scripts/nim.mjs" config >/dev/null || { echo "not configured - run /nvidia-council:setup"; exit 1; }
    cat <<'NVQ_END' | node "$ROOT/scripts/nim.mjs" ask
    <paste the user's question here, verbatim>
    NVQ_END

The quoted here-doc (`<<'NVQ_END'`) means nothing in the question is expanded by the shell.
**Check the delimiter first:** if any line of the question is exactly `NVQ_END`, stdin would be
truncated there and the rest parsed as shell - pick a different delimiter that does not appear
in the text. A model that errors prints its error inline and the others still answer. To ask
specific models instead of the saved council, pass ids as arguments:
`... nim.mjs ask deepseek-ai/deepseek-v4-pro`.

**Read the error before reacting** - the status says which problem it is, and only one of them
is the model's fault:

| In the reply | Meaning | Do |
|---|---|---|
| `HTTP 404` / `410` | the id rotted - NVIDIA retires and renames catalog entries | `/nvidia-council:doctor` to pick a replacement |
| `HTTP 401` / `403` | the key was rejected | fix `NVIDIA_API_KEY` - the models are fine |
| `HTTP 429` | free-tier limit (~40 req/min per key) exhausted, and the built-in `Retry-After` retry did not clear it | wait a minute, re-run |
| `HTTP 5xx` | NVIDIA-side fault | retry later |
| `(no response - timeout: ...)` | the model is too slow for the 300s budget | drop it for a faster one |

Do not send the user replacing models for anything but the first row.

## 4. Present and synthesize
- Show each model's answer under its own id.
- Then synthesize: where they AGREE, where they DISAGREE and why, any unique insight, and a
  final recommendation reconciled with your own view. Attribute claims to the model that made
  them - do not present a model's guess as established fact.
