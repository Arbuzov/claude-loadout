# claude-loadout

[![test](https://github.com/Arbuzov/claude-loadout/actions/workflows/test.yml/badge.svg)](https://github.com/Arbuzov/claude-loadout/actions/workflows/test.yml)

Two git safety nets that run automatically inside the [Claude Code](https://code.claude.com)
AI coding agent — a pre-commit secret scanner and a corporate fork→MR push guard.
Both are **deterministic hooks**: they fire on the agent's own git commands, so the
guarantee doesn't depend on the model remembering to behave. They complement, not
replace, tools like gitleaks (the secret scanner pairs a regex gate with a semantic
review subagent).

Packaged as a **plugin marketplace** — so the loadout travels to any machine or
project with two commands instead of hand-edited settings. Three plugins (the two
git safety nets above, plus a cross-model review helper):

| Plugin | What it gives you | Setup |
|--------|-------------------|-------|
| **secret-guard** | Pre-commit secret gate (hook) + semantic review subagent | none — works on install |
| **corporate-gitlab** | fork→MR push guard (hook) + workflow skill + commit identity/sign-off/Jira gate | set `CORP_GIT_*` env, then `/corporate-gitlab:setup` once per machine |
| **litellm-council** | Cross-model council over your LiteLLM proxy — review a diff, ask, or debate (curl, no MCP) | `/litellm-council:setup` once (or set `LITELLM_*`) |

The hooks, agent, and skill **auto-load on install** — no more editing
`~/.claude/settings.json`. Paths inside the plugins resolve via
`${CLAUDE_PLUGIN_ROOT}`, so nothing is hardcoded to one computer.

---

## Install

From any project (the marketplace can be a git URL or a local clone):

```
/plugin marketplace add https://github.com/Arbuzov/claude-loadout.git
/plugin install secret-guard@claude-loadout
/plugin install corporate-gitlab@claude-loadout       # corporate machines only
/plugin install litellm-council@claude-loadout        # needs a LiteLLM proxy
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

## corporate-gitlab — configurable corporate GitLab workflow

For corporate projects (any repo whose remote is on **your configured GitLab host**):
commits are authored as **your corporate identity**, signed off, with **no AI
co-author**, and all changes go through a **Merge Request from your fork** — never a
direct push to the upstream group project. Personal repos are completely unaffected
(scoping is automatic, by remote URL). Nothing corporate is hardcoded — you supply
the host, namespace, identity, and Jira keys via environment variables at setup.

| Requirement | Mechanism | Loaded by |
|-------------|-----------|-----------|
| Block push to upstream (fork→MR) | `PreToolUse` hook | plugin hook (auto) |
| Teach Claude the fork→MR + Jira flow | skill, self-limits to your corp host | plugin skill (auto) |
| Identity = your corporate name/email | conditional git config (`includeIf hasconfig:remote.*.url`) | `/corporate-gitlab:setup` |
| `Signed-off-by` + strip AI co-author + require Jira key | native git `commit-msg` hook | `/corporate-gitlab:setup` |
| No AI co-author (defense-in-depth) | Claude `attribution.commit/pr = ""` | `/corporate-gitlab:setup` |

### Local setup — set these variables first

`setup` reads your corporate values from the environment, so they live on your
machine, never in this repo. Set them, then run `/corporate-gitlab:setup` (or call
`setup.ps1` / `setup.sh` directly). If you skip setting them, `/corporate-gitlab:setup`
asks for the values interactively. Required:

| Variable | What | Example |
|----------|------|---------|
| `CORP_GIT_HOST` | corporate GitLab host | `gitlab.example.com` |
| `CORP_GIT_NAMESPACE` | your fork namespace | `jdoe` |
| `CORP_GIT_NAME` | commit author name | `Jane Doe` |
| `CORP_GIT_EMAIL` | commit author email | `jane@example.com` |

Optional:

| Variable | What | Example |
|----------|------|---------|
| `CORP_GIT_JIRA_KEYS` | pipe-separated Jira project keys → enables the hard commit-msg gate | `ABC\|DEF\|OPS` |
| `CORP_GIT_JIRA_URL` | corporate Jira base URL (used by the skill) | `https://jira.example.com` |

```powershell
# Windows (PowerShell) — set for this session, then run setup
$env:CORP_GIT_HOST='gitlab.example.com'; $env:CORP_GIT_NAMESPACE='jdoe'
$env:CORP_GIT_NAME='Jane Doe'; $env:CORP_GIT_EMAIL='jane@example.com'
$env:CORP_GIT_JIRA_KEYS='ABC|DEF'   # optional
```

```bash
# macOS / Linux / WSL
export CORP_GIT_HOST=gitlab.example.com CORP_GIT_NAMESPACE=jdoe
export CORP_GIT_NAME='Jane Doe' CORP_GIT_EMAIL=jane@example.com
export CORP_GIT_JIRA_KEYS='ABC|DEF'   # optional
```

Then:

```
/corporate-gitlab:setup
```

The push guard and the workflow skill are live the moment you install the plugin
(they no-op until `corpgit.host` is configured). `setup` writes
`~/.config/git/corp-git.gitconfig` (identity + `hooksPath` + Jira keys), records
`corpgit.host` / `corpgit.namespace` in your global git config (read by the
push hook), **copies** the `commit-msg` hook to `~/.config/git/corp-git-hooks/` (a
stable path — so it survives plugin updates), adds the `includeIf` blocks to
`~/.gitconfig`, and sets `attribution` off. It backs up everything it touches and is
idempotent. Then restart Claude Code.

### Jira issue tracking

On corporate repos, Claude checks (via the **Jira MCP**) that the change is tracked
by a Jira issue **before committing** — reading the key from the branch name or
commit message, verifying it exists, and offering to create one if not (only after
you confirm). If you set `CORP_GIT_JIRA_KEYS`, `setup` also enables a hard gate: the
`commit-msg` hook rejects any corporate commit whose message lacks a key like
`ABC-123`. Disable the hard gate, keep the agentic check:
`git config --global --unset corpgit.jiraKeys`.

### Assumptions & escape hatches

- **Fork namespace** comes from `CORP_GIT_NAMESPACE` (stored as `corpgit.namespace`).
  Change it later with `git config --global corpgit.namespace <ns>`, or override per
  session via env `CORP_GIT_NAMESPACE` (both read by the fork-guard hook).
- Requires **git ≥ 2.36** (for `hasconfig:remote.*.url` conditional includes).
- Genuinely need to push upstream once? `CORP_GIT_ALLOW_UPSTREAM_PUSH=1` for the session.
- `attribution` and `includeCoAuthoredBy` shouldn't both be set — `setup` leaves an
  existing `includeCoAuthoredBy` alone (ensure it's `false`).
- Cryptographic signing (GPG/SSH) is separate from the `Signed-off-by` trailer — ask
  if you want that instead (`commit.gpgsign`, `gpg.format ssh`, `user.signingkey`).

---

## litellm-council — cross-model council

A second pair of eyes from models outside the Claude/GPT lineage — routed through
**your own** [LiteLLM](https://docs.litellm.ai) proxy, so one endpoint fronts whatever
catalog you point it at (NVIDIA NIM, OpenAI, OpenRouter, …). No MCP server and no local
process: the commands shell out with `curl` + `jq` via two small bundled scripts.

| Command | What it does |
|---------|--------------|
| `/litellm-council:second-opinion` | Reviews the current diff across the council, reconciles with your own review |
| `/litellm-council:ask` | Puts an arbitrary question to the council + synthesis |
| `/litellm-council:debate` | Two rounds — each model answers, then sees the others' answers and revises/rebuts |
| `/litellm-council:setup` | Saves your config once so you don't re-export it each session |

### Config

Run `/litellm-council:setup` once — it saves your values to `~/.config/litellm-council/env`
(a `0600` file the commands source automatically; the key never lands in this repo). Or set
them in the environment, which always overrides the file:

| Variable | What | Example |
|----------|------|---------|
| `LITELLM_BASE_URL` | OpenAI-compatible base of your proxy | `https://litellm.example.com/v1` |
| `LITELLM_API_KEY` | proxy master/virtual key (never printed) | `sk-…` |
| `LITELLM_COUNCIL_MODELS` | *(optional)* comma-separated model ids | `openai/gpt-5.4,nvidia_nim/qwen/qwen2.5-coder-32b-instruct` |

If `LITELLM_COUNCIL_MODELS` is unset it defaults to a DeepSeek-R1 + Qwen-Coder pair
(decorrelated lineages, free via the NIM tier). Any id your proxy exposes works, including
`gpt-*`. Requires `curl` and `jq` on PATH. Self-check the model-list parser (no proxy
needed): `bash plugins/litellm-council/scripts/test-council-models.sh`.

> **Privacy:** hosted council models (e.g. the NVIDIA NIM free tier) may use submitted
> content to improve their models per their ToS — so this is for **non-proprietary / OSS
> code only**. Review proprietary code through a subscription path (the Codex plugin) or a
> self-hosted model. `second-opinion` gets your explicit confirmation before it sends the diff.

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
   ├─ corporate-gitlab/
   │  ├─ .claude-plugin/plugin.json
   │  ├─ hooks/hooks.json             # PreToolUse → fork-guard.mjs
   │  ├─ hooks/fork-guard.mjs         # block push to upstream (fork→MR)
   │  ├─ commands/setup.md            # /corporate-gitlab:setup
   │  ├─ skills/corporate-gitlab/SKILL.md   # fork→MR + Jira workflow (self-limits)
   │  ├─ git/corp-git-hooks/commit-msg # Signed-off-by + strip AI + Jira-key gate
   │  ├─ setup.ps1                    # native-git wiring (Windows; reads CORP_GIT_*)
   │  └─ setup.sh                     # native-git wiring (macOS/Linux/WSL; needs jq)
   └─ litellm-council/
      ├─ .claude-plugin/plugin.json
      ├─ commands/second-opinion.md   # /litellm-council:second-opinion (review the diff)
      ├─ commands/ask.md              # /litellm-council:ask (any question)
      ├─ commands/debate.md           # /litellm-council:debate (two rounds, models see each other)
      ├─ commands/setup.md            # /litellm-council:setup (save LITELLM_* config)
      ├─ scripts/ask-model.sh         # query one model (curl+jq, hardened) — shared
      ├─ scripts/council-models.sh    # cleaned model list (config-sourced) — shared
      └─ scripts/test-council-models.sh # no-dep self-check for the parser
```
