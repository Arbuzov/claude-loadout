---
description: Health-check telegram-notify. Verifies the bot token with getMe, then checks every configured target with getChat - so it proves each chat is reachable WITHOUT sending anyone a test message. Distinguishes a bad token from a missing chat from a blocked bot, and names the fix for each. Pass --send to deliver a real test message to every target instead.
---

Check that notifications would actually get through, before a real one needs to.

    node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" doctor

Add `--send` to post a real test message to each target (use when the user says messages are not
arriving despite a clean check - it separates "the API accepts this chat" from "the message shows
up on my phone"). Add `--json` for one JSON object per line on stdout; the human table always
goes to stderr.

## Reading the result

| State | Means | Fix |
|-------|-------|-----|
| `OK` | Token valid / chat reachable | — |
| `BAD_TOKEN` | Telegram rejected the token | Re-copy from @BotFather, `/telegram-notify:setup`. Every target is unverifiable until this is fixed. |
| `MISSING` | Chat id not found | The bot can only message a chat that contacted it first. Send `/start` to the bot, or re-add it to the group, then `/telegram-notify:setup` to re-discover the id. |
| `BLOCKED` | Bot blocked, or removed from the group | Unblock it in Telegram, or re-add it. |
| `UNREACHABLE` | Not proven either way - network, rate limit, 5xx | Nothing about the target is wrong. Retry; check connectivity to `api.telegram.org` (a corporate proxy or a country block is the usual cause). |

The distinction between `MISSING` and `UNREACHABLE` is the point of this command: **do not tell
the user to re-discover a chat id because of a network blip.** Only `MISSING` means the id is
actually wrong.

Exit code is 1 if the token fails or any target is not `OK`, so this works as a gate in a script.

If a group was promoted to a supergroup its id changed; a send reports the replacement id, and
`/telegram-notify:targets` updates the entry.
