#!/usr/bin/env bash
# Print the council model list, one id per line, cleaned (commas split, whitespace and
# stray CR trimmed, blank entries dropped). Sources the same config fallback as
# ask-model.sh so the default and any saved LITELLM_COUNCIL_MODELS live in one place.

CFG="${LITELLM_COUNCIL_ENV:-$HOME/.config/litellm-council/env}"
[ -f "$CFG" ] && . "$CFG"

MODELS="${LITELLM_COUNCIL_MODELS:-nvidia_nim/deepseek-ai/deepseek-r1,nvidia_nim/qwen/qwen2.5-coder-32b-instruct}"
printf '%s\n' "$MODELS" | tr ',' '\n' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' | grep -v '^$'
