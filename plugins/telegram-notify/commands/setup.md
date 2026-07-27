---
description: Friendly one-time setup for telegram-notify. Walks you through creating a bot with @BotFather, then DISCOVERS your chat id automatically (message the bot, we read it off getUpdates) instead of making you hunt for it. Optionally names targets for different scenarios (alerts, deploys, a forum topic). Saves to a 0600 config file (~/.config/telegram-notify/env) that every command reads. Idempotent - safe to re-run to add a target or replace the token.
---

Set up outbound Telegram notifications. Two things are needed: a **bot token** (identifies the
sender) and a **chat id** (identifies the recipient). The second is the part people get stuck on,
so this command finds it for the user rather than asking them to know it.

Values are written to `~/.config/telegram-notify/env`, which `scripts/tg.mjs` reads; a live env
var always wins. The file is `0600` under the home dir - never in a repo, never printed.

Every step runs `node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" <subcommand>`. That is the bash
form; in **PowerShell** the variable is `$env:CLAUDE_PLUGIN_ROOT` - use whichever matches the
shell you are actually invoking, and do not introduce a `ROOT=...` alias (assignment-prefix and
`$VAR` expansion are bash-isms that fail there).

## 0. Is it already configured?

    node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" config

If that prints a token and at least one target, this is a **re-run**. Ask what they want to
change - add a target (jump to step 3), replace the token (step 2), or re-check everything
(step 5) - and skip the rest. Do not walk a configured user through the whole wizard again.

## 1. The bot

Ask whether they already have a bot. If not, give them these steps verbatim - it takes ~30
seconds and must happen in the Telegram app, not here:

1. Open Telegram, search for **@BotFather**, press Start.
2. Send `/newbot`.
3. Give it a display name (anything, e.g. `Serge's Claude notifier`).
4. Give it a username ending in `bot` (e.g. `serge_claude_notify_bot`).
5. BotFather replies with a line like `123456789:AA...` - that is the token.

Mention the two things that surprise people later: a bot **cannot start a conversation**, so the
recipient must message it first (step 3 handles this), and the token can be revoked any time with
`/revoke` in @BotFather.

## 2. The token

Check whether `TELEGRAM_BOT_TOKEN` is set in this session's environment - **presence only, never
print the value**. If it is set, go straight to step 3; `tg.mjs save` will pick it up.

If it is not set, offer the three ways to supply it with one **AskUserQuestion**. Present them in
this order and say plainly what the trade-off is - do not pretend the last one is dangerous, and
do not pretend it is free either:

- **"Type it in my terminal (Recommended)"** - the token never touches this chat. Give them this
  exact line to paste into their own terminal (a VS Code terminal is fine); it prompts with the
  input hidden, verifies the token against Telegram, and saves it:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" token

  Wait for them to confirm it printed `saved ... - bot @yourbot`, then continue at step 3.
- **"Export it and restart Claude Code"** - the classic env route. Best if they want the token
  available to other tools too. Environment variables are inherited only when a process
  **starts**, so this needs a restart:

      # Windows PowerShell
      $env:TELEGRAM_BOT_TOKEN = '123456789:AA...'
      # macOS / Linux / WSL (bash/zsh)
      export TELEGRAM_BOT_TOKEN='123456789:AA...'

  Then exit, relaunch Claude Code, and re-run this command.
- **"Paste it here"** - fastest, and the token lands in this conversation's context and
  transcript. Reasonable for a throwaway notifier bot (it can only message chats that opted in,
  and `/revoke` in @BotFather invalidates it instantly); a poor idea for a bot with admin rights
  in real groups. If they choose this, pass the token through the **environment** of the save
  command, never as an argument - argv is visible in the process list. Use the form that matches
  the shell you are actually invoking (PowerShell has no inline `VAR=value` prefix - that is a
  parse error there, not a portable idiom):

      # bash / zsh
      TELEGRAM_BOT_TOKEN='<pasted>' node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" save
      # PowerShell
      $env:TELEGRAM_BOT_TOKEN = '<pasted>'; node "$env:CLAUDE_PLUGIN_ROOT/scripts/tg.mjs" save

Then confirm the token works and name the bot back to them:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" whoami

## 3. The chat id - discovered, not typed

**This is the step that matters.** Do not ask the user for a numeric id, and do not send them to
@userinfobot. Tell them to do exactly one thing:

> Open **@\<the bot's username\>** in Telegram and press **Start** (or send any message).
> For a group or channel: add the bot to it, then post any message there.

Then read the id off the update stream:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" discover

Output is `id`, `type`, `name` per line. Show the chats **numbered with their names**, and let the
user pick by number - they should never have to copy a negative 13-digit number by hand. If they
only see one and it is their own name, just confirm it rather than asking.

If it prints nothing, the cause is one of these - check them in order rather than guessing:

- They have not messaged the bot yet, or messaged a **different** bot (compare the username
  against `whoami` in step 2).
- Something else is already consuming this bot's updates - the other Telegram plugin, an n8n
  Telegram trigger, or any running poller. Telegram hands each update to **one** reader.
  A `conflict` error says this outright. Either stop that consumer for a moment, or skip
  discovery and take the id from that tool's own config.
- A **webhook** is registered on the bot (same effect, permanent). `discover` reports the
  conflict; deleting the webhook would break whatever set it, so ask before touching it.
- The message is older than ~24h - Telegram drops pending updates after that. Send a fresh one.

Note for groups: if the bot has **privacy mode** on (the BotFather default), it does not see
ordinary group messages - but it does see being *added*, which `discover` also reports, so adding
the bot to the group is enough.

## 4. Targets for different scenarios

Ask whether all notifications go to one place, or whether they want to split by scenario
(one **AskUserQuestion**: "One chat for everything (Recommended)" / "Name several targets").

- **One chat** - it becomes the default; `tg.mjs send` with no `--to` uses it.
- **Named targets** - `name:chat_id` pairs, comma-separated, e.g.
  `me:123456789,alerts:-1001234567890`. Callers then say `--to alerts`. Suggest names after the
  scenario, not the room (`alerts`, `deploys`, `builds`), because the routing is the point.
  For a **forum group** (topics enabled), a target may pin a topic with a third field -
  `builds:-1001234567890:42` sends into topic 42, so one group holds several streams without
  extra chats. The topic id is the number in a topic's `t.me/c/<chat>/<topic>` link.

## 5. Save, verify, report

    node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" save --chat "<default id>" --targets "<name:id,...>"

Both flags are optional; omitting one leaves that setting untouched, and passing `""` clears it.
The existing file is merged, not replaced, and a `.bak` is kept.

The **token** is the one value `save` will not take as an argument - it comes from the
environment only, because argv is visible in the process list. That is also why the chat id and
targets are flags: `VAR=value command` is a bash-ism and a **parse error in PowerShell**, so a
single line here works in every shell.

Verify - this checks every target with `getChat`, so it does **not** send anyone a test message:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" doctor

Then send exactly one real message so they see it land:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" send --level ok --title "telegram-notify" "Setup complete."

Report the config path, the bot's `@username`, and the target names - **never the token**. Close
by showing how they will actually use it, with their real target names:

    # ad hoc, from a command
    /telegram-notify:send --to alerts --level error "Nightly job failed"
    # from a script or hook, piping a log tail
    tail -n 50 build.log | node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" send --to builds --title "Build failed" --level error

Mention `/telegram-notify:targets` for adding a route later without redoing setup, and that
wiring it to a hook (a notification when Claude finishes a long task) is one entry in
`settings.json` - offer to set that up, don't do it unasked.
