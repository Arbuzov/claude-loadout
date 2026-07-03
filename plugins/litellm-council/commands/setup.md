---
description: Guided one-time setup for litellm-council. Collects your LITELLM_BASE_URL / LITELLM_API_KEY / LITELLM_COUNCIL_MODELS and saves them to a 0600 config file (~/.config/litellm-council/env) that the commands source automatically - so you do not re-export them every session. A live env var still overrides the file. Idempotent.
---

Persist the litellm-council configuration so `second-opinion` / `ask` / `debate` work
without exporting variables each session. The values are written to
`~/.config/litellm-council/env`, which the bundled scripts source; a live env var always
wins (the file only assigns with `${VAR:-...}`). The key is stored in a `0600` file under
your home dir - never in this repo, never printed.

## 1. Gather configuration
Prefill from what is already known, then ask only for the gaps:

- Read the current environment: `LITELLM_BASE_URL`, `LITELLM_API_KEY` (do **not** print it -
  just note whether it is set), `LITELLM_COUNCIL_MODELS`.
- If `~/.config/litellm-council/env` already exists, its values are the current defaults.

Collect:

- **Base URL** - free-form, ask in plain text: "LiteLLM base URL? (OpenAI-compatible, e.g.
  `https://litellm.example.com/v1`)". Never invent one.
- **API key** - if `LITELLM_API_KEY` is already in the environment, reuse it silently (do not
  echo or re-ask). Otherwise ask for it; treat it as a secret - do not print it back.
- **Models** - one **AskUserQuestion**: "Which council models?" Options: "Default NIM pair
  (Recommended) - DeepSeek-R1 + Qwen-Coder, free via NIM" / "Custom list". For "Custom", ask
  in plain text for a comma-separated list (any ids your proxy exposes, e.g.
  `openai/gpt-5.4,nvidia_nim/qwen/qwen2.5-coder-32b-instruct`).

If Base URL or key is still blank, stop and say which is missing - do not guess.

## 2. Write the config
Set `URL`, `KEY`, and `MODELS` in the shell to the collected values (for "Default NIM pair",
`MODELS=nvidia_nim/deepseek-ai/deepseek-r1,nvidia_nim/qwen/qwen2.5-coder-32b-instruct`; if the
key was reused from the environment, `KEY="$LITELLM_API_KEY"`), then run this block. It backs
up any existing file and writes `0600`. Keys are expected to be plain `sk-...`/`nvapi-...`
tokens (no shell-special characters):

    mkdir -p "$HOME/.config/litellm-council"
    CFG="$HOME/.config/litellm-council/env"
    [ -f "$CFG" ] && cp "$CFG" "$CFG.bak"
    umask 077
    cat > "$CFG" <<EOF
    # written by /litellm-council:setup - a live env var still wins (\${VAR:-...})
    export LITELLM_BASE_URL="\${LITELLM_BASE_URL:-$URL}"
    export LITELLM_API_KEY="\${LITELLM_API_KEY:-$KEY}"
    export LITELLM_COUNCIL_MODELS="\${LITELLM_COUNCIL_MODELS:-$MODELS}"
    EOF
    chmod 600 "$CFG" 2>/dev/null
    echo "wrote $CFG (key not shown); models: $MODELS"

## 3. Report
Tell the user it is saved and that **no restart is needed** - the commands source the file on
their next run. Show the config path and the model list, and confirm the key is set **without
printing it**. To change a value later, re-run `/litellm-council:setup` or edit that file. To
override for one session, export the variable - it wins over the file.
