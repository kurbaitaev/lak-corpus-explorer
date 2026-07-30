---
name: Post-merge verification and stale server processes
description: Why a merged task can look "not applied" in the preview, and what to check before concluding commits are missing.
---

When post-merge verification shows old behaviour (endpoints 404, a fixed search still
returning the old result), check the age of the running server process **before**
investigating git.

**Why:** A task merge updates the working tree and HEAD but does not restart the
long-running workflow process. A process started before the merge keeps serving the
pre-merge code, which is indistinguishable from "the merge never landed" if you only
look at the app's responses. This has already cost one full investigation of git
history that turned out to be a no-op.

**How to apply:** Compare `ps -o lstart= -p <server pid>` against the merge commit
time. If the process predates the merge, restart the workflow and re-run the checks
before touching anything else. Only if the behaviour survives a restart is it worth
inspecting `git log` / the file tree.

**Related trap — probing routes from memory.** When re-running "all standard route
checks", read the actual route registrations first (`app.get('/`, `router.get('/api`).
Guessed paths produce a wall of 404s that reads like a broken app. In this project
pages are served as `*.html` (not extensionless), and several API paths differ from
the obvious guess.
