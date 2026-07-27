---
description: Browse the NVIDIA NIM catalog your key can actually see and update the council selection - without redoing setup. Fetches GET /v1/models from NVIDIA directly, lets you filter and pick, and saves the choice to ~/.config/nvidia-council/env. Use it to refresh the council after NVIDIA rotates the catalog.
---

Re-pick the council models from what NVIDIA's catalog exposes right now. Only the model list
changes; the key is untouched.

## 1. List the catalog
The catalog is 100+ ids, so start with a keyword filter (case-insensitive literal substring). No
argument lists everything:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    node "$ROOT/scripts/nim.mjs" config >/dev/null || { echo "not configured - run /nvidia-council:setup"; exit 1; }
    node "$ROOT/scripts/nim.mjs" models "<keyword>"

Ids are bare NIM names (`deepseek-ai/deepseek-v4-pro`) - there is **no `nvidia_nim/` prefix** when
talking to NVIDIA directly; that prefix only exists to route through LiteLLM.

## 2. Let the user pick
Show the matches numbered and let them choose by number or id. Aim for a small **lineage-diverse**
set - decorrelated training is the whole point, so DeepSeek + Mistral + Qwen beats three Llama
derivatives. Keep it to ~3: every extra model is another request against the ~40 req/min per-key
limit, and every review round pays for all of them.

Show the current council alongside the candidates (`node "$ROOT/scripts/nim.mjs" council`) so the
user can see what they are changing.

## 3. Save and verify
`save` reads `NVIDIA_COUNCIL_MODELS` from the **environment**, merges over the existing file, and
keeps a `.bak`:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    NVIDIA_COUNCIL_MODELS="<comma-separated picks>" node "$ROOT/scripts/nim.mjs" save
    node "$ROOT/scripts/nim.mjs" doctor

Being in the catalog does not mean a model answers - the `doctor` run is what proves it. If one
comes back DEAD, follow `/nvidia-council:doctor` to pick a replacement. Note that a live
`NVIDIA_COUNCIL_MODELS` env var overrides the saved file.
