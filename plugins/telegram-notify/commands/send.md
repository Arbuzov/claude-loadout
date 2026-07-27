---
description: Send a Telegram notification. Routes to a named target (--to alerts) or the default chat, marks the level (info/ok/warn/error) with an emoji, adds an optional title, and splits anything over Telegram's 4096-character limit. Text comes from the argument or stdin, so a log tail can be piped straight in. Use --dry-run to see what would be sent without sending it.
---

Send a notification through the configured bot. Arguments: $ARGUMENTS

    node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" send [text] [flags]

| Flag | Meaning |
|------|---------|
| `--to <name\|id>` | Named target, or a raw chat id / `@channelusername`. Omit for the default chat. |
| `--title <text>` | Bold-ish first line, blank line, then the body. |
| `--level <info\|ok\|warn\|error>` | Prefixes the emoji. An unknown level is an error, not a silent no-op. |
| `--thread <id>` | Forum topic id (digits). Overrides the topic a target pins, so one target can address another topic ad hoc. |
| `--html` | Send as Telegram HTML (`<b>`, `<code>`, `<pre>`). Off by default so arbitrary text can never fail to parse. |
| `--silent` | Deliver without a notification sound. |
| `--dry-run` | Print the resolved chat and the message parts; send nothing. Anything token-shaped is masked in the preview (it would otherwise land in a terminal and this transcript), so the preview is not byte-exact in that one case. |
| `--text <text>` | The body, if passing it positionally is awkward. |

Body text comes from the positional argument, `--text`, or **stdin** - which is the useful one:

    tail -n 50 build.log | node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" send --to builds --title "Build failed" --level error
    git log --oneline -5 | node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" send --to me --title "Deployed"

## Doing this well

- **Pick the target from what the user said**, then confirm it in your reply by name. If they
  did not name one and several exist, ask rather than guessing - a deploy alert in the wrong
  channel is worse than a question. `tg.mjs targets` lists them.
- **Match the level to reality**: `error` for a failure, `warn` for something needing attention,
  `ok` for a completed success, `info` for everything else. The emoji is what the user reads on
  a phone lock screen, so a wrong one is actively misleading.
- **Do not paste a wall of text.** These land as phone notifications. Lead with the outcome, keep
  the body to what is actionable; if a long log genuinely matters, pipe the tail, not the file.
  Anything over 4096 characters is split automatically, but three buzzing messages is a bad
  notification even when it is a correct one.
- Text is sent **literally** by default - Markdown will not render, and that is deliberate. Use
  `--html` if formatting matters, and escape any `<`, `>`, `&` in the body yourself when you do.
- If it fails, the error already carries the fix (`chat not found` means the bot has never been
  contacted by that chat). Relay it plainly rather than retrying blind. Never print the token or
  any URL containing it.
