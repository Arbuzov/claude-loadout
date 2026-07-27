# claude-loadout

[![test](https://github.com/Arbuzov/claude-loadout/actions/workflows/test.yml/badge.svg)](https://github.com/Arbuzov/claude-loadout/actions/workflows/test.yml)

A pre-commit secret scanner that runs automatically inside the [Claude Code](https://code.claude.com)
AI coding agent. It is a **deterministic hook**: it fires on the agent's own git commands, so the
guarantee doesn't depend on the model remembering to behave. It complements, not
replaces, tools like gitleaks (the secret scanner pairs a regex gate with a semantic
review subagent).

Packaged as a **plugin marketplace** — so the loadout travels to any machine or
project with two commands instead of hand-edited settings. Four plugins (the secret
gate above, two cross-model review helpers, and a Telegram notifier):

| Plugin | What it gives you | Setup |
|--------|-------------------|-------|
| **secret-guard** | Pre-commit secret gate (hook) + semantic review subagent | none — works on install |
| **litellm-council** | Cross-model council over your LiteLLM proxy — review a diff, ask, or debate (Node, no MCP) | `/litellm-council:setup` once (or set `LITELLM_*`) |
| **nvidia-council** | The same council straight against NVIDIA's NIM endpoint — no proxy to keep running | `/nvidia-council:setup` once (needs a free `NVIDIA_API_KEY`) |
| **telegram-notify** | Notifications to Telegram — named targets per scenario, callable from hooks and scripts | `/telegram-notify:setup` once (it finds your chat id for you) |

The hook, agent, and commands **auto-load on install** — no more editing
`~/.claude/settings.json`. Paths inside the plugins resolve via
`${CLAUDE_PLUGIN_ROOT}`, so nothing is hardcoded to one computer.

---

## Install

From any project (the marketplace can be a git URL or a local clone):

```
/plugin marketplace add https://github.com/Arbuzov/claude-loadout.git
/plugin install secret-guard@claude-loadout
/plugin install litellm-council@claude-loadout        # needs a LiteLLM proxy
/plugin install nvidia-council@claude-loadout         # needs a free NVIDIA_API_KEY, no proxy
/plugin install telegram-notify@claude-loadout        # needs a bot from @BotFather
```

Then **restart Claude Code** (or `/hooks` to verify). Install scope: add
`--scope project` to share a plugin via a repo's `.claude/settings.json`, or
`--scope local` for a gitignored per-project enable; default is user scope (all
projects on this machine).

> Need Claude Code itself? Native installer (recommended, no Node, auto-updates):
> Windows `irm https://claude.ai/install.ps1 | iex` · macOS/Linux/WSL
> `curl -fsSL https://claude.ai/install.sh | bash`. Then `claude doctor`.
> Docs: <https://code.claude.com/docs/en/setup>. The **hooks** need `node` on PATH.

---

## secret-guard — pre-commit secret gate

Stops passwords, API keys, private keys, tokens, and other sensitive data from
being committed. Two layers, because a subagent alone cannot guarantee it runs
before every commit — the deterministic enforcement is a **hook**.

| Layer | File | What it does |
|-------|------|--------------|
| **Gate** (enforces) | `hooks/secret-scan.mjs` | `PreToolUse` hook on `Bash`. Detects `git commit`, scans the staged diff, **denies** the commit on a finding. Node, zero deps. |
| **Brains** (reviews) | `agents/secret-guard.md` | Subagent that semantically reviews the staged diff — catches the fuzzy stuff regex misses (internal hostnames, customer names, private IPs). |

The hook fires even under `git commit --no-verify` and
`--dangerously-skip-permissions` — those skip git's own hooks and Claude's
permission prompts, but **not** Claude Code hooks. That is what makes it "always".

**Use the subagent:** *"Use the secret-guard subagent to review what's staged before
I commit."* It reports `VERDICT: BLOCK` (redacted findings + remediation) or
`VERDICT: CLEAR`, and is read-only.

**False positives** — exempt a genuine sample/placeholder line inline:

```python
api_key = "AKIAIOSFODNN7EXAMPLE"  # secret-guard:allow
```

Recognized markers: `secret-guard:allow`, `gitleaks:allow`,
`pragma: allowlist secret`, `noqa: secret`. Env-var references (`process.env.X`,
`${VAR}`, `<your-key>`, `changeme`, masked `****`) are ignored automatically.
Patterns live in `RULES` / `IGNORE` at the top of `hooks/secret-scan.mjs`. The
scanner **fails open** on its own internal error — a bug in it must never block
every commit. Self-check (no deps): `node hooks/test-secret-scan.mjs`.

**Want every commit gated, any client** (terminal, VS Code — not just Claude Code)?
Add a native global git pre-commit hook pointing at the scanner. One line, but it
sets `core.hooksPath` globally (overrides per-repo `.git/hooks` everywhere; undo
with `git config --global --unset core.hooksPath`):

```bash
mkdir -p ~/.config/git/hooks
printf '#!/bin/sh\nnode "<plugin>/hooks/secret-scan.mjs" --staged\n' > ~/.config/git/hooks/pre-commit
git config --global core.hooksPath ~/.config/git/hooks
```

(`<plugin>` = the installed secret-guard dir; `node … --staged` is the scanner's
native-git mode.)

---

## litellm-council — cross-model council

A second pair of eyes from models outside the Claude/GPT lineage — routed through
**your own** [LiteLLM](https://docs.litellm.ai) proxy, so one endpoint fronts whatever
catalog you point it at (NVIDIA NIM, OpenAI, OpenRouter, …). No MCP server and no local
process: the commands run through small bundled Node scripts (built-in `fetch`, no `curl`/`jq`).

| Command | What it does |
|---------|--------------|
| `/litellm-council:second-opinion` | Reviews the current diff across the council, reconciles with your own review |
| `/litellm-council:ask` | Puts an arbitrary question to the council + synthesis |
| `/litellm-council:debate` | Two rounds — each model answers, then sees the others' answers and revises/rebuts |
| `/litellm-council:setup` | Saves your config once so you don't re-export it each session |
| `/litellm-council:models` | Browse the proxy's live catalog (`GET /models`), filter, and re-pick the council |

### Config

Run `/litellm-council:setup` once — it saves your values to `~/.config/litellm-council/env`
(a `0600` file the commands source automatically; the key never lands in this repo). Or set
them in the environment, which always overrides the file:

| Variable | What | Example |
|----------|------|---------|
| `LITELLM_BASE_URL` | OpenAI-compatible base of your proxy | `https://litellm.example.com/v1` |
| `LITELLM_API_KEY` | proxy master/virtual key (never printed) | `sk-…` |
| `LITELLM_COUNCIL_MODELS` | *(optional)* comma-separated model ids | `openai/gpt-5.4,deepseek-ai/deepseek-v4-pro` |

If `LITELLM_COUNCIL_MODELS` is unset it defaults to a DeepSeek + GLM pair
(decorrelated lineages, free via the NIM tier). Any id your proxy exposes works, including
`gpt-*` — and instead of typing ids you can browse the proxy's live catalog (`GET /models`),
filter by keyword, and pick, during `/litellm-council:setup` or later via
`/litellm-council:models`. Requires **Node ≥22** on PATH — what CI tests; the loadout already
needs node for the hooks. (Built-in `fetch` is the hard floor, so 18–20 will probably work, but
is not tested.) Self-check the scripts (no proxy needed):
`node plugins/litellm-council/scripts/test.mjs`.

> **Privacy:** hosted council models (e.g. the NVIDIA NIM free tier) may use submitted
> content to improve their models per their ToS — so this is for **non-proprietary / OSS
> code only**. Review proprietary code through a subscription path (the Codex plugin) or a
> self-hosted model. `second-opinion` gets your explicit confirmation before it sends the diff.

---

## nvidia-council — the same council, no proxy

The same idea with the middleman removed: straight to **NVIDIA's hosted NIM endpoint**
(`https://integrate.api.nvidia.com/v1`, OpenAI-compatible, free `nvapi-` key from
[build.nvidia.com](https://build.nvidia.com)). Fewer moving parts, and it still works when
your proxy is down. Same commands minus `debate`, one Node file, no dependencies.

Use `litellm-council` when you want one endpoint fronting several vendors with fallbacks;
use `nvidia-council` when NVIDIA's catalog is all you need and you'd rather not run a proxy.

| Command | What it does |
|---------|--------------|
| `/nvidia-council:second-opinion` | Reviews the current diff across the council, reconciles with your own review |
| `/nvidia-council:ask` | Puts an arbitrary question to the council + synthesis |
| `/nvidia-council:doctor` | Probes each model (retries first), then offers healthy replacements for a dead/EOL id |
| `/nvidia-council:setup` | Saves your config once so you don't re-export it each session |
| `/nvidia-council:models` | Browse NVIDIA's live catalog (`GET /models`), filter, and re-pick the council |

### Config

Export `NVIDIA_API_KEY` **before launching Claude Code** (env vars are inherited at process
start), then run `/nvidia-council:setup` once — it saves to `~/.config/nvidia-council/env`
(`0600`, never in this repo). There is no base URL to configure.

| Variable | What | Example |
|----------|------|---------|
| `NVIDIA_API_KEY` | free key from build.nvidia.com (never printed) | `nvapi-…` |
| `NVIDIA_COUNCIL_MODELS` | *(optional)* comma-separated bare NIM ids | `deepseek-ai/deepseek-v4-pro,z-ai/glm-5.2` |
| `NVIDIA_BASE_URL` | *(optional)* only for self-hosted NIM containers | `http://nim.local:8000/v1` |

Model ids carry **no `nvidia_nim/` prefix** — that prefix is a LiteLLM routing artifact.
NVIDIA's free tier rate-limits **~40 requests/min per key, account-wide**, so the fan-out
staggers its request starts and retries a `429` honouring `Retry-After` instead of dropping
a model. Requires **Node ≥22** (see above). Self-check (no key needed):
`node plugins/nvidia-council/scripts/test.mjs`.

> **Privacy:** the same ToS caveat applies, and more directly — NVIDIA's API Trial terms
> permit using submitted content to improve their models and explicitly forbid uploading
> confidential data. **Non-proprietary / OSS code only**, unless you point `NVIDIA_BASE_URL`
> at your own NIM containers.

---

## telegram-notify — notifications to your phone

Outbound Telegram messages from Claude Code, a hook, or any script. One bot, **named
targets**, so different scenarios land in different places: `--to alerts` to a private
chat, `--to builds` into a forum topic of the team group. Node, zero dependencies,
no MCP — a hook can call it directly.

The setup problem this actually solves is the **chat id**. A Telegram bot addresses
chats by a numeric id that is nowhere in the UI, so every guide sends you to a
third-party bot to look it up. Here you message your own bot once and
`/telegram-notify:setup` reads the id off the update stream and offers it to you by name.

| Command | What it does |
|---------|--------------|
| `/telegram-notify:setup` | @BotFather walkthrough → **discovers your chat id** → optional named targets → saves + verifies |
| `/telegram-notify:send` | Sends a notification: `--to`, `--title`, `--level`, `--html`, `--silent`, `--dry-run` |
| `/telegram-notify:targets` | Add / list / remove named routes without redoing setup |
| `/telegram-notify:doctor` | Verifies the token, then every target — with `getChat`, so nobody gets a test ping |

### Config

Run `/telegram-notify:setup` once — it saves to `~/.config/telegram-notify/env`
(`0600`, never in this repo). The token can come from your environment, from a hidden
terminal prompt (`node .../tg.mjs token` — never touches the transcript), or pasted in
chat if you'd rather trade privacy for speed; setup offers all three and says which is which.

| Variable | What | Example |
|----------|------|---------|
| `TELEGRAM_BOT_TOKEN` | @BotFather token (never printed) | `123456789:AA…` |
| `TELEGRAM_CHAT_ID` | default chat, used when `--to` is omitted | `123456789` |
| `TELEGRAM_TARGETS` | *(optional)* `name:chat[:topic]` routes | `alerts:-1001234567890,builds:-1001234567890:42` |
| `TELEGRAM_API_BASE` | *(optional)* only for a local Bot API server | `http://127.0.0.1:8081` |

Calling it from a script or a hook is the point — text comes from an argument or **stdin**:

```sh
ROOT=~/.claude/plugins/cache/claude-loadout/telegram-notify/1.0.0   # ${CLAUDE_PLUGIN_ROOT} inside a command
tail -n 50 build.log | node "$ROOT/scripts/tg.mjs" send --to builds --title "Build failed" --level error
node "$ROOT/scripts/tg.mjs" send --level ok "Nightly sync finished"
```

To get pinged whenever Claude finishes a long task, wire it to a `Stop` hook in
`~/.claude/settings.json` (absolute path — `${CLAUDE_PLUGIN_ROOT}` is only set for a
plugin's *own* hooks):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "node \"$HOME/.claude/plugins/cache/claude-loadout/telegram-notify/1.0.0/scripts/tg.mjs\" send --to me --level ok --text \"Claude finished\"" } ] }
    ]
  }
}
```

`--text` matters here: without it the command reads stdin, which for a hook is the hook's
own JSON payload.

Messages over Telegram's 4096-character limit are split on line boundaries, and sends are
paced under the ~1 msg/sec per-chat limit (a `429` is retried honouring `retry_after`).
Text is sent **literally** by default — `--html` opts into `<b>`/`<code>` formatting, so
arbitrary log output can never fail to parse. Requires **Node ≥22**. Self-check (no token
needed): `node plugins/telegram-notify/scripts/test.mjs`.

> **Note:** the bot token sits in the **URL path** of every Bot API call, so any error text
> that quotes a URL would leak it — every printed string is redacted. Also: a bot cannot
> start a conversation. The recipient must press Start (or add the bot to the group) first,
> which is why `doctor` reports `MISSING` rather than a wrong id.

---

## Layout

```
claude-loadout/                       (the marketplace repo)
├─ .claude-plugin/
│  └─ marketplace.json                # lists the plugins (source = ./plugins/<name>)
└─ plugins/
   ├─ secret-guard/
   │  ├─ .claude-plugin/plugin.json
   │  ├─ hooks/hooks.json             # PreToolUse → secret-scan.mjs
   │  ├─ hooks/secret-scan.mjs        # scan engine (Node; --staged for native git hook)
   │  ├─ hooks/test-secret-scan.mjs   # no-dep self-check for the scan engine
   │  └─ agents/secret-guard.md       # subagent: semantic review of staged changes
   ├─ litellm-council/
   │  ├─ .claude-plugin/plugin.json
   │  ├─ commands/second-opinion.md   # /litellm-council:second-opinion (review the diff)
   │  ├─ commands/ask.md              # /litellm-council:ask (any question)
   │  ├─ commands/debate.md           # /litellm-council:debate (two rounds, models see each other)
   │  ├─ commands/setup.md            # /litellm-council:setup (save LITELLM_* config)
   │  ├─ commands/models.md           # /litellm-council:models (browse catalog, re-pick)
   │  ├─ scripts/config.mjs           # env/file config (env-wins) + URL join — shared
   │  ├─ scripts/ask-model.mjs        # query one model (fetch, hardened) — shared
   │  ├─ scripts/council-models.mjs   # cleaned model list — shared
   │  ├─ scripts/list-models.mjs      # fetch proxy catalog GET /models (+ filter) — shared
   │  ├─ scripts/save-config.mjs      # write/merge the 0600 config file — shared
   │  └─ scripts/test.mjs             # no-dep node self-check for all of the above
   ├─ nvidia-council/
   │  ├─ .claude-plugin/plugin.json
   │  ├─ commands/second-opinion.md   # /nvidia-council:second-opinion (review the diff)
   │  ├─ commands/ask.md              # /nvidia-council:ask (any question)
   │  ├─ commands/doctor.md           # /nvidia-council:doctor (probe + swap a dead model)
   │  ├─ commands/setup.md            # /nvidia-council:setup (save NVIDIA_* config)
   │  ├─ commands/models.md           # /nvidia-council:models (browse catalog, re-pick)
   │  ├─ scripts/nim.mjs              # the whole client: config, catalog, chat, doctor
   │  └─ scripts/test.mjs             # no-dep node self-check (no key needed)
   └─ telegram-notify/
      ├─ .claude-plugin/plugin.json
      ├─ commands/setup.md            # /telegram-notify:setup (bot + chat-id discovery)
      ├─ commands/send.md             # /telegram-notify:send (notify a target)
      ├─ commands/targets.md          # /telegram-notify:targets (named routes)
      ├─ commands/doctor.md           # /telegram-notify:doctor (token + every target)
      ├─ scripts/tg.mjs               # the whole client: config, discovery, send, doctor
      └─ scripts/test.mjs             # no-dep node self-check (no token needed)
```
