---
description: Guided one-time machine setup for the corporate GitLab workflow. Collects your CORP_GIT_* values interactively (or uses ones already set), then runs the bundled setup script to wire the conditional git identity, the sign-off + Jira-key commit-msg hook, and the attribution-off setting. Idempotent.
---

Run the corporate-gitlab one-time machine setup as a short guided dialog, then report
what changed.

This wires the parts a plugin cannot do declaratively: the conditional git identity for
your corporate-host repos, the `commit-msg` hook (sign-off, strip AI co-author, require a
Jira key), and the Claude Code `attribution` off switch. The fork->MR push guard is
already live as this plugin's hook - it is **not** set here. Nothing corporate is
hardcoded: the bundled script reads only `CORP_GIT_*` environment variables.

## 1. Gather configuration
First read what's already known so you prefill rather than interrogate:

- env vars `CORP_GIT_HOST` / `CORP_GIT_NAMESPACE` / `CORP_GIT_NAME` / `CORP_GIT_EMAIL`
- `git config --get corpgit.host` and `corpgit.namespace` (set by a previous setup)
- `git config --global user.name` / `user.email` (sensible identity defaults)

You still need all four required values as `CORP_GIT_*` in step 2 **even if
`corpgit.*` is already configured** — the script reads the environment, not the
existing config. So collect every required value that isn't already in the
environment, using whatever you read above as the default.

Match the tool to the field:

- **Host** and **fork namespace** are free-form with no natural options — just **ask
  in plain text** (one short message): e.g. "Corporate GitLab host? (e.g.
  `gitlab.example.com`)" and "Your fork namespace on it? (e.g. `jdoe`)". Don't force
  these into AskUserQuestion — a list of invented hosts is noise.
- **Commit name / email** — use **AskUserQuestion**, offering the `git config` value as
  the first (Recommended) option so one click confirms; "Other" lets them override.
- **Optional Jira gate** (only if the user wants it) — one **AskUserQuestion** call:
  "Enforce a Jira key in every corporate commit?" `No` / `Yes`. If `Yes`, ask in plain
  text for the pipe-separated keys (e.g. `ABC|DEF`) and, optionally, the Jira URL
  (`https://jira.example.com`).

Never invent values. If a required value is still blank, stop and say which.

## 2. Run the bundled setup with those values
Pass the collected values as `CORP_GIT_*` in the **same** command that runs the script
(a separate `export` step won't survive into the script's process). Pick the script by
OS; both are idempotent and back up every file they edit.

Windows (PowerShell):

    $env:CORP_GIT_HOST='<host>'; $env:CORP_GIT_NAMESPACE='<ns>';
    $env:CORP_GIT_NAME='<name>'; $env:CORP_GIT_EMAIL='<email>';
    # optional: $env:CORP_GIT_JIRA_KEYS='ABC|DEF'; $env:CORP_GIT_JIRA_URL='https://jira.example.com';
    pwsh -File "$env:CLAUDE_PLUGIN_ROOT/setup.ps1"
    # fall back to `powershell -File "$env:CLAUDE_PLUGIN_ROOT/setup.ps1"` if pwsh is absent

macOS / Linux / WSL:

    CORP_GIT_HOST='<host>' CORP_GIT_NAMESPACE='<ns>' \
    CORP_GIT_NAME='<name>' CORP_GIT_EMAIL='<email>' \
    bash "${CLAUDE_PLUGIN_ROOT}/setup.sh"
    # prepend CORP_GIT_JIRA_KEYS='ABC|DEF' (and CORP_GIT_JIRA_URL=...) too if the user set them

The script stops and lists any required variable still missing - relay that to the user
instead of guessing.

## 3. Report
Tell the user to **restart Claude Code**, show the paths the script wrote, and confirm the
recorded fork namespace (`git config --get corpgit.namespace`). Do not push or open anything.
