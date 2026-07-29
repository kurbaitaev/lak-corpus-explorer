---
name: GitHub push authentication
description: gitPush via the git-remote skill works; raw git push over HTTPS fails.
---

The repo remote is `https://github.com/kurbaitaev/lak-corpus-explorer`.

Raw `git push` from the shell fails:
  `remote: Invalid username or token. Password authentication is not supported.`

**But** the Replit GitHub integration works: `gitPush({})` from the git-remote
skill (CodeExecution) pushed `main` successfully on 2026-07-29.

**Why:** GitHub deprecated password-based HTTPS auth; the integration supplies
its own credentials.

**How to apply:** Always use the `gitPush`/`gitPull`/`createPullRequest`
callbacks (git-remote skill) for remote sync. Never promise shell `git push`
will work; if `gitPush` returns NO_CREDENTIALS, tell the user to connect their
GitHub account to Replit.
