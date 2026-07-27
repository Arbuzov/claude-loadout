---
description: Health-check the NVIDIA council models and self-heal a dead one. Probes each configured model with retries (a NIM id can hit end-of-life / 410 Gone, get pulled / 404, or turn too slow to use), and when one is genuinely DEAD (404/410) it offers healthy replacements from the live NVIDIA catalog, asks which to swap in, and saves the new council - while a rejected key, a rate limit or a 5xx is reported as such instead of condemning the models. Reads NVIDIA_API_KEY / NVIDIA_COUNCIL_MODELS. Node, no MCP.
---

Diagnose why the council "times out and glitches" and fix it. The usual cause is a rotted model
id: NVIDIA retires a hosted model (**410 Gone**), pulls it (**404**), renames it, or it turns so
slow it blows the timeout. `nim.mjs doctor` pings each council model, RETRIES before condemning
it (a transient overload is not a death), and classifies it `OK` / `SLOW` / `DEAD` /
`UNREACHABLE`.

A probe asks only "does this id still serve?" - any **parseable** 2xx without an error body
passes, even when the message content is empty, so a reasoning model that spends its whole budget
on `<think>` is never mistaken for dead. (A blank or non-JSON 2xx is `UNREACHABLE`, not `DEAD`.)

Only a model-scoped rejection (**404**/**410**) or an error body marks a model `DEAD`. A rejected
key, a 429, a 5xx and every timeout land on `UNREACHABLE` - the script prints an extra line
naming a key or rate-limit problem, so read that before you go hunting for replacements.

Run the numbered steps in order. **Each fenced block is one shell invocation.**

## 1. Health-check the current council
`config` fails fast and names any missing value (never guess it). `doctor` prints a per-model
verdict to stderr and a machine-readable line to stdout with `--json`; it exits non-zero if any
model is DEAD/UNREACHABLE.

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    command -v node >/dev/null || { echo "node not on PATH (the council scripts are Node)"; exit 1; }
    node "$ROOT/scripts/nim.mjs" config || exit 1
    node "$ROOT/scripts/nim.mjs" doctor --json

If every model is `OK` (or an acceptable `SLOW`), report that and **stop** - nothing to heal.

Read the states literally: `UNREACHABLE` means *unproven*, not *gone*. On NVIDIA's free tier a
whole council can come back UNREACHABLE simply because the ~40 req/min per-key limit was already
spent by another command - wait a minute and re-run before replacing anything.

## 2. Only if a model is DEAD (or repeatably UNREACHABLE) - find replacements
Pull healthy candidates from the live catalog and probe the shortlist, so you only ever offer
models that actually answer. Filter to the dead model's family first, then add a couple of
cross-family flagships (a council of one lineage is not a council); probe them in one shot.
Replace `<family>` (e.g. `mistral`, `qwen`, `deepseek`) and the flagship list as fits what died:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    node "$ROOT/scripts/nim.mjs" models "<family>" | head -20
    node "$ROOT/scripts/nim.mjs" doctor --attempts 1 --slow 15000 \
      <candidate-id-1> <candidate-id-2> <candidate-id-3>

Take the candidate ids from the catalog listing above - do not invent them. Keep only those that
came back `OK`/`SLOW`; a `DEAD`/`UNREACHABLE` candidate is no better than what you are replacing.

## 3. Ask which replacement to use (do not pick silently)
Use `AskUserQuestion` - one question per dead model - listing the probed-healthy candidates with
their measured latency, so the user chooses on real data. Never swap a council model without
confirmation.

## 4. Save the new council
The new list = surviving healthy models + the user's chosen replacements. `nim.mjs save` reads
`NVIDIA_COUNCIL_MODELS` from the **environment** (not argv), merges over the existing file, and
preserves the key:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    NVIDIA_COUNCIL_MODELS="<surviving>,<chosen-replacements>" node "$ROOT/scripts/nim.mjs" save

Then re-run step 1 to confirm the new council is green. Note: `NVIDIA_COUNCIL_MODELS` exported as
a live env var overrides the saved file - mention that if the user set it manually.
