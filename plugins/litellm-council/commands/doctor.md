---
description: Health-check the council models on your LiteLLM proxy and self-heal a dead one. Probes each configured model with retries (a NIM id can hit end-of-life / 410 Gone, get pulled / 404, or turn too slow to use), and when one is DEAD or UNREACHABLE it offers healthy replacements from the live catalog, asks which to swap in, and saves the new council. Reads LITELLM_BASE_URL / LITELLM_API_KEY / LITELLM_COUNCIL_MODELS. Node, no MCP.
---

Diagnose why the council "times out and glitches" and fix it. The usual cause is a rotted model
id: a hosted (e.g. NVIDIA NIM) model reaches end-of-life (**410 Gone**), gets pulled (**404**),
or turns so slow it blows the request timeout. `doctor.mjs` pings each council model, RETRIES
before condemning it (a transient overload is not a death), and classifies it
`OK` / `SLOW` / `DEAD` / `UNREACHABLE`.

Run the numbered steps in order. **Each fenced block is one shell invocation.**

## 1. Health-check the current council
`config.mjs` fails fast and names any missing value (never guess it). `doctor.mjs` prints a
per-model verdict to stderr and a machine-readable line to stdout; it exits non-zero if any model
is DEAD/UNREACHABLE.

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    command -v node >/dev/null || { echo "node not on PATH (the council scripts are Node)"; exit 1; }
    node "$ROOT/scripts/config.mjs" || exit 1
    node "$ROOT/scripts/doctor.mjs" --json

If every model is `OK` (or an acceptable `SLOW`), report that and **stop** — nothing to heal.

## 2. Only if a model is DEAD or UNREACHABLE — find replacements
For each bad model, pull healthy candidates from the live catalog and probe the shortlist so you
only ever offer the user models that actually answer. Filter the catalog to the dead model's
family first, then add a couple of cross-family flagships; probe them all in one shot. Replace
`<family>` (e.g. `mistral`, `qwen`, `deepseek`) and the flagship list as fits what died:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    node "$ROOT/scripts/list-models.mjs" "<family>" | head -20
    node "$ROOT/scripts/doctor.mjs" --attempts 1 --slow 15000 \
      mistralai/mistral-small-4-119b-2603 \
      meta/llama-4-maverick-17b-128e-instruct \
      nvidia/nemotron-3-super-120b-a12b \
      deepseek-ai/deepseek-v4-flash

Keep only the candidates that came back `OK`/`SLOW`. A `DEAD`/`UNREACHABLE` candidate is no better
than what you're replacing — do not offer it.

## 3. Ask which replacement to use (do not pick silently)
Use `AskUserQuestion` — one question per dead model — listing the probed-healthy candidates with
their measured latency, so the user chooses on real data. This is the "ask what to change" step:
never swap a council model without confirmation.

## 4. Save the new council
Build the new comma-separated list = the surviving healthy models + the user's chosen
replacements, then save. `save-config.mjs` reads `LITELLM_COUNCIL_MODELS` from the **environment**
(not argv), merges it over the existing file, and preserves the base URL and key:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    export LITELLM_COUNCIL_MODELS="<surviving>,<chosen-replacements>"
    node "$ROOT/scripts/save-config.mjs"

Then re-run step 1 to confirm the new council is all green. Note: `LITELLM_COUNCIL_MODELS` set as a
live env var in your shell overrides the saved file — mention that if the user exported it manually.
