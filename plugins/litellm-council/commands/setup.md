---
description: Guided one-time setup for litellm-council. Collects your LITELLM_BASE_URL / LITELLM_COUNCIL_MODELS and saves them (with your already-exported LITELLM_API_KEY) to a 0600 config file (~/.config/litellm-council/env) that the commands read automatically. For security the API key is never typed into chat - it must already be in this Claude Code session's environment (exported before launch). A live env var still overrides the file. Idempotent.
---

Persist the litellm-council configuration so `second-opinion` / `ask` / `debate` / `models`
work without exporting variables each session. The values are written to
`~/.config/litellm-council/env`, which the bundled Node scripts read; a live env var always
wins (the scripts prefer `process.env`). The file is `0600` under the home dir - never in
this repo, never printed.

**Security rule for the API key: never collect it as chat text.** A value typed into chat is
visible to Claude's context and, once inlined into an executed command, also to that command's
transcript - an unnecessary duplication for a bearer credential. Environment variables are
inherited only when a process **starts**, so the key must be exported in the user's shell
**before Claude Code was launched**; a value exported afterward, in a still-running session,
will not be visible here.

## 1. Gather configuration
- **API key** - check whether `LITELLM_API_KEY` is already set in this session's environment
  (do **not** print its value - just note presence). If it is **not** set, **STOP** here. Tell
  the user to export it in their terminal, matching their shell:

      # macOS / Linux / WSL (bash/zsh)
      export LITELLM_API_KEY='sk-...'
      # Windows PowerShell
      $env:LITELLM_API_KEY = 'sk-...'
      # Windows cmd.exe
      set LITELLM_API_KEY=sk-...

  then **exit and restart Claude Code** (`claude`) so the new session inherits it, and run
  `/litellm-council:setup` again. Do not proceed to step 2 without the key already present.
- **Base URL** - free-form, ask in plain text: "LiteLLM base URL? (OpenAI-compatible, e.g.
  `https://litellm.example.com/v1`)". Not secret - fine to collect and inline. Never invent one.
  If `~/.config/litellm-council/env` already has one, offer it as the default.
- **Models** - one **AskUserQuestion**: "Which council models?" Options: "Default NIM pair
  (Recommended) - DeepSeek + GLM, free via NIM" / "Browse my proxy's catalog" /
  "Custom list".
    - **Browse** - list what the proxy actually exposes. The config isn't saved yet, so the
      script needs the base URL; the key is already inherited from the environment (never
      inline it):

          LITELLM_BASE_URL="<url>" node "${CLAUDE_PLUGIN_ROOT}/scripts/list-models.mjs"

      If the list is long (the NIM wildcard can be 100+), ask for a keyword and re-run with it
      as an argument (e.g. `... list-models.mjs coder`). Show the matches numbered and let the
      user pick (numbers or ids); aim for a small lineage-diverse set. Join the picks into a
      comma-separated `MODELS`.
    - **Custom** - ask in plain text for a comma-separated list (any ids your proxy exposes,
      e.g. `openai/gpt-5.4,deepseek-ai/deepseek-v4-pro`). Take ids from the catalog listing
      rather than from memory - hosted ids get retired and renamed.

If Base URL is still blank, stop and say so - do not guess.

## 2. Write the config
`save-config.mjs` reads values from its **environment** and merges over any existing file
(0600, with a `.bak` backup). The key is already inherited - never inline it. For "Default NIM
pair", set
`LITELLM_COUNCIL_MODELS=deepseek-ai/deepseek-v4-pro,z-ai/glm-5.2`:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    LITELLM_BASE_URL="<url>" LITELLM_COUNCIL_MODELS="<models>" node "$ROOT/scripts/save-config.mjs"

## 3. Report
Tell the user it is saved and that **no restart is needed for future config changes** - the
commands read the file on their next run (a restart is only needed the one time the API key
itself changes, per the rule above). Show the config path and the model list (from
`save-config.mjs`'s output), and confirm the key is set **without printing it**. To change the
base URL or models later, re-run `/litellm-council:setup`, or use `/litellm-council:models` for
just the model list. To override for one session, export the variable - it wins over the file.
