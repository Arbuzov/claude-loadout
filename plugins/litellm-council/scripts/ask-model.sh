#!/usr/bin/env bash
# Query ONE model on the LiteLLM proxy. Prompt on stdin, reply on stdout.
#   Usage: printf '%s' "$prompt" | bash ask-model.sh <model-id>
# Config: reads LITELLM_BASE_URL / LITELLM_API_KEY from the environment, or from
# ~/.config/litellm-council/env (written by /litellm-council:setup) as a fallback -
# a live env var always wins because that file only assigns with ${VAR:-...}.
# Needs curl + jq on PATH. Shared by the second-opinion / ask / debate commands so the
# request-building and error-handling live in one place.

CFG="${LITELLM_COUNCIL_ENV:-$HOME/.config/litellm-council/env}"
[ -f "$CFG" ] && . "$CFG"

MODEL="${1:?usage: ask-model.sh <model-id>  (prompt on stdin)}"
: "${LITELLM_BASE_URL:?set LITELLM_BASE_URL (or run /litellm-council:setup)}"
: "${LITELLM_API_KEY:?set LITELLM_API_KEY (or run /litellm-council:setup)}"
command -v curl >/dev/null || { echo "curl not on PATH" >&2; exit 1; }
command -v jq   >/dev/null || { echo "jq not on PATH (needed to build the request JSON)" >&2; exit 1; }

PROMPT="$(cat)"
# ponytail: crude id-substring match for "slow reasoning model" -> more output tokens;
# narrow LITELLM_COUNCIL_MODELS rather than growing this list if it misfires.
case "$MODEL" in *deepseek*|*nemotron*|*-r1*|*thinking*|*qwq*) MAXTOK=32768 ;; *) MAXTOK=8192 ;; esac

BODY="$(jq -n --arg m "$MODEL" --arg c "$PROMPT" --argjson t "$MAXTOK" \
  '{model:$m, messages:[{role:"user",content:$c}], max_tokens:$t, temperature:0.3}' \
  | curl -sS --max-time 300 "$LITELLM_BASE_URL/chat/completions" \
      -H "Authorization: Bearer $LITELLM_API_KEY" \
      -H "Content-Type: application/json" -d @-)"
[ -n "$BODY" ] || BODY='(no response - curl failed or timed out)'

# extract the reply; on empty content or a non-JSON body (e.g. a 502 HTML page),
# fall back to the raw body, bounded - never a silent blank line
printf '%s' "$BODY" \
  | jq -er '(.choices[0].message.content // .error.message // .error // .detail) | select(. != null and . != "")' 2>/dev/null \
  || { printf '%s' "$BODY" | head -c 500; echo; }
