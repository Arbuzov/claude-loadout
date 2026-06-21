---
name: corporate-gitlab
description: >-
  Workflow rules for your corporate GitLab repositories. Use BEFORE committing or
  pushing in any repo whose git remote host matches your configured corporate host
  (`git config --get corpgit.host`): the fork->Merge Request flow (never push to the
  upstream group project), corporate commit identity + sign-off with no AI co-author,
  and a Jira tracking-issue check via the Jira MCP. Self-limits — ignore for repos on
  any other host (GitHub, personal GitLab). Quick check: `git remote -v`.
---

# Corporate GitLab workflow

These rules apply **only** when the current repository's remote is on your corporate
GitLab host. Resolve it at runtime:

- Corporate host: `git config --get corpgit.host`
- Your fork namespace: `git config --get corpgit.namespace`
- (Optional) corporate Jira base URL: `git config --get corpgit.jiraUrl`

If `corpgit.host` is empty, the corporate-gitlab plugin isn't configured on this
machine (run `/corporate-gitlab:setup`) — treat every repo as personal and ignore
this skill. For any remote that isn't on the corporate host, ignore this skill too.
Quick check: `git remote -v`.

## Contribution model: fork -> MR (never push to upstream)

The group/canonical project is read-only for you. Every change lands through a Merge
Request from your fork (the `corpgit.namespace` namespace).

1. Work on a topic branch — never commit on `master`/`main` of the upstream.
2. Make sure a fork remote exists (fork the project in GitLab first if needed):
   `git remote add fork ssh://git@<corp-host>/<your-namespace>/<repo>.git`
3. Push the branch to **your fork only**: `git push -u fork HEAD`.
   Do not `git push origin <branch>` when `origin` is the group project — it is
   blocked by the fork-guard hook anyway.
4. Open a Merge Request from `<your-namespace>/<repo>:<branch>` into the upstream
   default branch. Prefer the GitLab MCP for the corporate host. **Ask before creating
   the MR** — opening it is an action taken on the user's behalf.

## Jira issue tracking (check at commit time)

Every corporate change must be tracked by a Jira issue. Use the corporate Jira
(`git config --get corpgit.jiraUrl` if set; otherwise ask the user). Issue keys look
like `ABC-123` — the valid project keys are in `git config --get corpgit.jiraKeys`
(pipe-separated) when the hard gate is enabled. **Before committing**, use the **Jira
MCP** to make sure an issue exists:

1. Find the issue key (pattern like `ABC-123`): from the current branch name
   (e.g. `ABC-123-short-desc`) or from the commit message the user supplied.
2. Verify it with the Jira MCP — fetch the issue and confirm it actually exists and
   looks like the right one (open, sensible summary).
3. If there is **no key**, or the key does not resolve to a real issue:
   - Do **not** commit yet. Tell the user no tracking issue was found.
   - **Offer to create one** via the Jira MCP: propose a summary (from the staged
     change / branch) and an issue type, ask which project if unclear, and create
     it **only after the user confirms** — creating an issue is an action on their
     behalf.
4. Put the key in the commit subject (e.g. `ABC-123: <summary>`), ideally name the
   branch after it, and reference it in the MR title/description.

This check is agentic: only Claude (via the Jira MCP) can verify an issue exists and
offer to create it — a git hook has no MCP access. The `commit-msg` hook installed by
`/corporate-gitlab:setup` additionally *enforces* that a key is present when
`corpgit.jiraKeys` is set (disable with `git config --global --unset corpgit.jiraKeys`).

## Commits

- Author/committer is your configured corporate identity (set automatically for
  corporate-host repos via conditional git config — do not override it).
- Sign off every commit: use `git commit -s` (a `Signed-off-by:` line is also
  enforced by the commit-msg hook).
- **Never** add an AI/Claude co-author or "Generated with Claude Code" attribution
  to commits or MR descriptions. No `Co-Authored-By: Claude`, no Anthropic noreply
  address, no robot/credit line.
