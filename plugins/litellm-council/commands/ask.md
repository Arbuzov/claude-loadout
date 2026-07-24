---
description: Ask your LiteLLM council an arbitrary question (not tied to a diff) and get several models' answers plus a synthesis. Reads LITELLM_BASE_URL / LITELLM_API_KEY / LITELLM_COUNCIL_MODELS (or the config from /litellm-council:setup). Node, no MCP.
---

Put an arbitrary question - a design call, a debugging dead-end, a "which approach" - to the
council models on the user's LiteLLM proxy, then synthesize their answers with your own view.
Runs through the bundled Node scripts; nothing endpoint-specific is baked in.

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
model's config, request-building, and error-handling live in `ask-model.mjs`; the model list
(with the default) comes from `council-models.mjs`:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    node "$ROOT/scripts/config.mjs" >/dev/null || { echo "not configured - run /litellm-council:setup"; exit 1; }
    Q="$(cat <<'EOF'
    <paste the user's question here, verbatim>
    EOF
    )"
    node "$ROOT/scripts/council-models.mjs" | while read -r M; do
      echo "### $M"
      printf '%s' "$Q" | node "$ROOT/scripts/ask-model.mjs" "$M"
      echo
    done

A model that errors prints its error and the loop continues. The preflight `config.mjs` stops
early (naming the missing variable) if the proxy isn't configured - then run
`/litellm-council:setup`.

**Self-heal on error:** if a model's reply looks like an error (a 4xx/5xx body, `410 Gone` /
end-of-life, or a `(no response - ... timed out)` line) rather than an answer, don't just drop
it — the council model has likely rotted. Run `/litellm-council:doctor` (probes with retries,
then offers healthy replacements and asks which to swap in) before trusting the synthesis.

## 4. Present and synthesize
- Show each model's answer under its own id.
- Then synthesize: where they AGREE, where they DISAGREE and why, any unique insight, and a
  final recommendation reconciled with your own view. Attribute claims to the model that made
  them - do not present a model's guess as established fact.
