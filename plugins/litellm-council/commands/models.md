---
description: Browse the models your LiteLLM proxy actually exposes and update your council selection - without redoing the base URL / key. Fetches GET /models, lets you filter and pick, and saves the choice to ~/.config/litellm-council/env. Use it to actualize the council after the proxy catalog changes.
---

Re-pick which models the council uses, from the live catalog on the user's LiteLLM proxy.
This only touches the model list - the base URL and key already saved by
`/litellm-council:setup` (or in the environment) are left alone.

## 1. Show the current selection and the live catalog
`council-models.mjs` prints what is configured now; `list-models.mjs` fetches what the proxy
actually offers (`GET /models`). Both read the saved config:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    echo "# Currently selected"; node "$ROOT/scripts/council-models.mjs"
    echo "# Available on the proxy"; node "$ROOT/scripts/list-models.mjs"

If `list-models.mjs` stops with "set LITELLM_BASE_URL ...", the proxy isn't configured yet -
tell the user to run `/litellm-council:setup` first. If it reports an empty catalog or prints
an error body, relay it (the proxy may expose models only as a wildcard the OpenAI `/models`
route does not expand - in that case the user types ids directly in step 2).

## 2. Filter and let the user pick
The NIM wildcard can expose 100+ models, so if the list is long, ask the user for a keyword
and narrow it (case-insensitive substring), then show the matches numbered:

    node "$ROOT/scripts/list-models.mjs" "coder"     # or "gpt", "deepseek", "nemotron", ...

Present the filtered ids as a numbered list and ask the user which to include (they can give
numbers or ids, comma-separated). Aim for a small, lineage-diverse council (e.g. a coder model
+ a reasoning model + a different vendor) rather than everything. Collect the chosen ids into a
comma-separated `MODELS` value.

## 3. Save
`save-config.mjs` merges over the existing file, so passing only the models keeps the base URL
and key untouched. A live `LITELLM_COUNCIL_MODELS` env var still overrides the file (same rule
as the other settings):

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    LITELLM_COUNCIL_MODELS="<the comma-separated ids the user chose>" node "$ROOT/scripts/save-config.mjs"

Then confirm the new selection with `node "$ROOT/scripts/council-models.mjs"`. No restart -
the commands read it on their next run.
