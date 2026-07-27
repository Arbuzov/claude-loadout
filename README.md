# claude-loadout

[![test](https://github.com/Arbuzov/claude-loadout/actions/workflows/test.yml/badge.svg)](https://github.com/Arbuzov/claude-loadout/actions/workflows/test.yml)

A pre-commit secret scanner that runs automatically inside the [Claude Code](https://code.claude.com)
AI coding agent. It is a **deterministic hook**: it fires on the agent's own git commands, so the
guarantee doesn't depend on the model remembering to behave. It complements, not
replaces, tools like gitleaks (the secret scanner pairs a regex gate with a semantic
review subagent).

Packaged as a **plugin marketplace** — so the loadout travels to any machine or
project with two commands instead of hand-edited settings. Two plugins (the secret
gate above, plus a cross-model review helper):

| Plugin | What it gives you | Setup |
|--------|-------------------|-------|
| **secret-guard** | Pre-commit secret gate (hook) + semantic review subagent | none — works on install |
| **litellm-council** | Cross-model council over your LiteLLM proxy — review a diff, ask, or debate (Node, no MCP) | `/litellm-council:setup` once (or set `LITELLM_*`) |
| **nvidia-council** | The same council straight against NVIDIA's NIM endpoint — no proxy to keep running | `/nvidia-council:setup` once (needs a free `NVIDIA_API_KEY`) |

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
`/litellm-council:models`. Requires **Node ≥18** on PATH (for built-in `fetch`; the loadout
already needs node for the hooks). Self-check the scripts (no proxy needed):
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
a model. Requires **Node ≥18**. Self-check (no key needed):
`node plugins/nvidia-council/scripts/test.mjs`.

> **Privacy:** the same ToS caveat applies, and more directly — NVIDIA's API Trial terms
> permit using submitted content to improve their models and explicitly forbid uploading
> confidential data. **Non-proprietary / OSS code only**, unless you point `NVIDIA_BASE_URL`
> at your own NIM containers.

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
   └─ nvidia-council/
      ├─ .claude-plugin/plugin.json
      ├─ commands/second-opinion.md   # /nvidia-council:second-opinion (review the diff)
      ├─ commands/ask.md              # /nvidia-council:ask (any question)
      ├─ commands/doctor.md           # /nvidia-council:doctor (probe + swap a dead model)
      ├─ commands/setup.md            # /nvidia-council:setup (save NVIDIA_* config)
      ├─ commands/models.md           # /nvidia-council:models (browse catalog, re-pick)
      ├─ scripts/nim.mjs              # the whole client: config, catalog, chat, doctor
      └─ scripts/test.mjs             # no-dep node self-check (no key needed)
```
