---
description: Ask your LiteLLM council an arbitrary question (not tied to a diff) and get several models' answers plus a synthesis. Reads LITELLM_BASE_URL / LITELLM_API_KEY / LITELLM_COUNCIL_MODELS (or the config from /litellm-council:setup). curl + jq, no MCP.
---

Put an arbitrary question - a design call, a debugging dead-end, a "which approach" - to the
council models on the user's LiteLLM proxy, then synthesize their answers with your own view.
Shells out via the bundled scripts (`curl` + `jq`); nothing endpoint-specific is baked in.

## 1. Get the question
Use the text the user passed with the command as the question. If they invoked it with no
question, ask them for one (one short prompt) and wait.

## 2. Privacy note (once)
The question and any context you paste go to hosted models that may train on submitted
content - keep it **non-proprietary**. For proprietary matters use a subscription path (the
Codex plugin) or a self-hosted model. Mention this once; you do not need a hard stop for a
general question the way `second-opinion` does for a code diff.

## 3. Ask each council model
Put the question in a quoted here-doc (so any characters in it are safe), then fan out. Each
model's config/preflight and error-handling live in `ask-model.sh`; the list (with the
default) comes from `council-models.sh`:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    Q="$(cat <<'EOF'
    <paste the user's question here, verbatim>
    EOF
    )"
    bash "$ROOT/scripts/council-models.sh" | while read -r M; do
      echo "### $M"
      printf '%s' "$Q" | bash "$ROOT/scripts/ask-model.sh" "$M"
      echo
    done

A model that errors prints its error and the loop continues. If `ask-model.sh` stops with
"set LITELLM_BASE_URL ..." tell the user to run `/litellm-council:setup` (or export the vars).

## 4. Present and synthesize
- Show each model's answer under its own id.
- Then synthesize: where they AGREE, where they DISAGREE and why, any unique insight, and a
  final recommendation reconciled with your own view. Attribute claims to the model that made
  them - do not present a model's guess as established fact.
