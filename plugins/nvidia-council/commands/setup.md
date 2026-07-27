---
description: One-time setup for nvidia-council. Saves your council model list (and, for a self-hosted NIM, a base URL override) plus your already-exported NVIDIA_API_KEY to a 0600 config file (~/.config/nvidia-council/env) that the commands read automatically. No proxy and no base URL to configure - the endpoint defaults to NVIDIA's hosted https://integrate.api.nvidia.com/v1. For security the API key is never typed into chat: it must already be in this session's environment. A live env var still overrides the file. Idempotent.
---

Persist the nvidia-council configuration so `ask` / `second-opinion` / `doctor` / `models` work
without exporting variables each session. Values are written to `~/.config/nvidia-council/env`,
which `scripts/nim.mjs` reads; a live env var always wins. The file is `0600` under the home
dir - never in a repo, never printed.

Unlike a proxy-backed council there is **no base URL to collect**: the endpoint defaults to
NVIDIA's hosted `https://integrate.api.nvidia.com/v1`. Only override it (`NVIDIA_BASE_URL`) if
the user runs their own NIM containers.

**Security rule for the API key: never collect it as chat text.** A key typed into chat lands in
Claude's context and, once inlined into a command, in that command's transcript too - needless
duplication for a bearer credential. Environment variables are inherited only when a process
**starts**, so the key must have been exported **before Claude Code was launched**.

## 1. Check the key
Check whether `NVIDIA_API_KEY` is set in this session's environment (note presence only - never
print the value). Keys come free from build.nvidia.com and start with `nvapi-`.

If it is **not** set, **STOP**. Tell the user to export it, matching their shell:

    # macOS / Linux / WSL (bash/zsh)
    export NVIDIA_API_KEY='nvapi-...'
    # Windows PowerShell
    $env:NVIDIA_API_KEY = 'nvapi-...'
    # Windows cmd.exe
    set NVIDIA_API_KEY=nvapi-...

then **exit and restart Claude Code** so the new session inherits it, and re-run this command.
Do not proceed without the key present.

## 2. Pick the council
One **AskUserQuestion**: "Which council models?" Options: "Default trio (Recommended) -
DeepSeek + Mistral + GLM, lineage-diverse and free" / "Browse the NVIDIA catalog" /
"Custom list".

- **Browse** - the key is already in the environment (never inline it):

      node "${CLAUDE_PLUGIN_ROOT}/scripts/nim.mjs" models

  The catalog is 100+ ids; ask for a keyword and re-run with it as an argument (e.g.
  `... nim.mjs models coder`). Show the matches numbered, let the user pick by number or id, and
  aim for a **lineage-diverse** set - the point of a council is decorrelated training, so three
  Llama derivatives are worth less than DeepSeek + Mistral + Qwen. Join the picks with commas.
- **Custom** - ask in plain text for a comma-separated list of bare NIM ids, e.g.
  `deepseek-ai/deepseek-v4-pro,z-ai/glm-5.2`. Take the ids from the catalog listing above rather
  than from memory - NVIDIA renames and retires them. Note there is **no `nvidia_nim/`
  prefix** here - that prefix is a LiteLLM routing artifact; talking to NVIDIA directly, ids are
  exactly as printed in the catalog.

## 3. Save
`nim.mjs save` reads values from its **environment** (never argv, so the key stays off the
command line) and merges over any existing file, keeping a `.bak`:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    NVIDIA_COUNCIL_MODELS="<models>" node "$ROOT/scripts/nim.mjs" save

For a self-hosted NIM, add `NVIDIA_BASE_URL="http://<host>:8000/v1"` to that same line.

## 4. Verify and report
    node "${CLAUDE_PLUGIN_ROOT}/scripts/nim.mjs" doctor

Report the config path, the model list, and that the key is set - **without printing it**. Say
that no restart is needed for future config changes (only for a new key, per the rule above),
and that `/nvidia-council:models` re-picks the council later without redoing setup.
