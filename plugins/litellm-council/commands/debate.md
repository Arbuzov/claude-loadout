---
description: Two-round council debate - each model answers, then sees the others' answers and refines or rebuts. Surfaces where positions converge vs. hold. Reads LITELLM_* (or /litellm-council:setup config). Node, no MCP.
---

Run a two-round debate across the council models on the user's LiteLLM proxy: round 1 each
model answers blind; round 2 each model sees all round-1 answers and revises or rebuts. Then
report what shifted and what remains contested. Runs through the bundled Node scripts.

## 1. Get the question
Use the text the user passed with the command. If none, ask for one and wait. Same privacy
note as `ask`: this goes to hosted models, keep it **non-proprietary**.

## 2. Run both rounds (one block)
Round-1 answers are captured per model in a temp dir, concatenated, and fed back in round 2.
The `trap` cleans the temp dir on every exit path:

    ROOT="${CLAUDE_PLUGIN_ROOT}"
    node "$ROOT/scripts/config.mjs" >/dev/null || { echo "not configured - run /litellm-council:setup"; exit 1; }
    DIR="$(mktemp -d)"; trap 'rm -rf "$DIR"' EXIT
    Q="$(cat <<'EOF'
    <paste the user's question here, verbatim>
    EOF
    )"
    node "$ROOT/scripts/council-models.mjs" > "$DIR/models"

    echo "# Round 1 - blind answers"
    i=0
    while read -r M; do
      i=$((i+1)); printf '%s\n' "$M" > "$DIR/m.$i"
      echo "### $M"
      printf '%s' "$Q" | node "$ROOT/scripts/ask-model.mjs" "$M" | tee "$DIR/a.$i"
      echo
    done < "$DIR/models"
    N=$i

    # ponytail: concatenate ALL round-1 answers (incl. a model's own) - simpler than
    # per-model exclusion and the cross-pollination is the same.
    ALL="$(for k in $(seq 1 "$N"); do printf '\n## %s answered:\n%s\n' "$(cat "$DIR/m.$k")" "$(cat "$DIR/a.$k")"; done)"

    echo "# Round 2 - after seeing the others"
    while read -r M; do
      echo "### $M"
      printf 'Original question:\n%s\n\nAll reviewers gave these round-1 answers:\n%s\n\nWhere do you disagree, and what is your refined answer?' "$Q" "$ALL" \
        | node "$ROOT/scripts/ask-model.mjs" "$M"
      echo
    done < "$DIR/models"

## 3. Present and synthesize
- Show round 1 and round 2 grouped as above.
- Then synthesize: **consensus shifts** (who changed position and why), **surviving
  disagreements** (what no one conceded), and a final reconciled verdict. Attribute each claim
  to the model that made it.
