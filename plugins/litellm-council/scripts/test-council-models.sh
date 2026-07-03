#!/usr/bin/env bash
# Self-check for council-models.sh parsing. No proxy, no deps beyond bash.
#   Run: bash test-council-models.sh
# LITELLM_COUNCIL_ENV=/dev/null keeps it hermetic - council-models.sh only sources
# CFG when [ -f "$CFG" ], and /dev/null is a device, not a regular file, so no real
# config leaks in and the env var we pass wins.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
SUT="$DIR/council-models.sh"
fail=0

check() { # name  expected  actual
  if [ "$2" = "$3" ]; then
    printf '  ok - %s\n' "$1"
  else
    printf '  FAIL - %s\n    expected: %q\n    actual:   %q\n' "$1" "$2" "$3"; fail=1
  fi
}

# commas + inner/outer spaces + a blank entry + a trailing CR -> one clean id per line
got="$(LITELLM_COUNCIL_ENV=/dev/null LITELLM_COUNCIL_MODELS=$'a/b, c/d ,, e/f\r' bash "$SUT")"
check "cleans commas/space/CR/blanks" $'a/b\nc/d\ne/f' "$got"

# unset -> the built-in default NIM pair
got="$(LITELLM_COUNCIL_ENV=/dev/null bash "$SUT")"
check "defaults to the NIM pair" \
  $'nvidia_nim/deepseek-ai/deepseek-r1\nnvidia_nim/qwen/qwen2.5-coder-32b-instruct' "$got"

# a single padded id -> trimmed, one line
got="$(LITELLM_COUNCIL_ENV=/dev/null LITELLM_COUNCIL_MODELS='  openai/gpt-5.4  ' bash "$SUT")"
check "trims a single padded id" 'openai/gpt-5.4' "$got"

if [ "$fail" = 0 ]; then echo "all council-models checks passed"; else echo "FAILURES"; exit 1; fi
