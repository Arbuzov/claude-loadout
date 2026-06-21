---
description: One-time machine setup for the corporate GitLab workflow — conditional git identity, sign-off + Jira-key commit-msg hook, and attribution-off. Idempotent.
---

Run the corporate-gitlab one-time machine setup, then report what changed.

This wires the parts a plugin cannot do declaratively: the conditional git
identity for your corporate-host repos, the `commit-msg` hook (sign-off, strip AI
co-author, require a Jira key), and the Claude Code `attribution` off switch. The
fork->MR push guard is already live as this plugin's hook — it is **not** set here.

**First** make sure the required environment variables are set (the script reads
them): `CORP_GIT_HOST`, `CORP_GIT_NAMESPACE`, `CORP_GIT_NAME`, `CORP_GIT_EMAIL`
(and optionally `CORP_GIT_JIRA_KEYS`, `CORP_GIT_JIRA_URL`). See the README
(corporate-gitlab → Local setup). If any required one is missing the script stops
and lists it — relay that to the user instead of guessing values.

Detect the OS and run the matching bundled script (both are idempotent and back up
every file they edit):

- **Windows:** `pwsh -File "${CLAUDE_PLUGIN_ROOT}/setup.ps1"`
  (fall back to `powershell -File "${CLAUDE_PLUGIN_ROOT}/setup.ps1"` if `pwsh` is absent)
- **macOS / Linux / WSL:** `bash "${CLAUDE_PLUGIN_ROOT}/setup.sh"`

After it finishes: tell the user to **restart Claude Code**, show the paths the
script wrote, and confirm the fork namespace it recorded (`git config --get
corpgit.namespace`). Do not push or open anything.
