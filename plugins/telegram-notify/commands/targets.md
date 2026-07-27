---
description: List, add, or remove the named targets that route notifications to different chats or forum topics - without redoing setup. A target is a name plus a chat id (plus an optional topic id), so callers say `--to alerts` instead of carrying a 13-digit number around. Edits go through the script, so adding one route can never drop the others.
---

Manage where notifications go. Arguments: $ARGUMENTS

    node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" targets                              # list
    node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" targets add <name> <chat id> [topic] # add or replace
    node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" targets rm <name>                    # remove

The saved config is rewritten in place, keeping a `.bak`; the token and the default chat are
untouched. `add` with an existing name replaces that entry.

## Doing this well

- **Never invent a chat id.** If the user wants a target for a chat whose id is unknown, run
  `/telegram-notify:setup` (step 3) to discover it - the bot must have been contacted by that
  chat anyway, so a hand-typed id would fail at the first send regardless.
- **Name for the scenario, not the room**: `alerts`, `deploys`, `builds`, `cron`. The point of a
  named target is that the caller says *what happened* and the config decides *where it lands* -
  a target called `main_group` puts the routing decision back at the call site.
- **A topic id needs a forum group.** `targets add builds -1001234567890 42` sends into topic 42
  of that group, which is how one group carries several streams. The id is the number in the
  topic's `t.me/c/<chat>/<topic>` link. Sending a topic id to a non-forum chat is an API error.
- After adding, confirm it is actually reachable rather than assuming:

      node "${CLAUDE_PLUGIN_ROOT}/scripts/tg.mjs" doctor

  `MISSING` here means the bot has never been contacted by that chat - the id is not the problem
  to fix first.
