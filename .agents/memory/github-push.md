---
name: GitHub push authentication
description: GitHub HTTPS push fails; requires PAT or SSH.
---

The repo remote is `https://github.com/kurbaitaev/lak-corpus-explorer`.

GitHub no longer accepts password auth for HTTPS pushes. The push will fail with:
  `remote: Invalid username or token. Password authentication is not supported.`

**Why:** GitHub deprecated password-based HTTPS auth in 2021.

**How to apply:** User must either:
1. Set up a Personal Access Token (PAT) and configure it as a Replit secret, then use `https://<token>@github.com/...` as the remote URL; or
2. Switch the remote to SSH: `git remote set-url origin git@github.com:kurbaitaev/lak-corpus-explorer.git` and add an SSH key.
