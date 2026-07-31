---
name: Post-merge verification and stale server processes
description: Why a merged task can look "not applied" in the preview, why a workflow hangs on startup, and what to check before blaming commits or slow boot.
---

## Orphaned process holding the port

A workflow stuck "starting for a long time" is usually not slow startup — check the
log for `EADDRINUSE` on the app port first.

**Why:** A previous restart can leave an orphaned server process alive. It keeps the
port bound, so every new workflow start dies immediately on bind while the workflow
sits retrying. The trap is that the orphan is still serving normal 200s, so the
preview looks perfectly healthy and the instinct is to blame whatever data or feature
was added most recently for "slowing down boot".

**How to apply:** List processes with their start times, compare against the workflow
start time, kill the orphan (SIGTERM, then SIGKILL if it survives), confirm the port
is free, then restart. Before blaming boot-time work for slowness, measure it directly
— requiring the module and timing the function is cheap and usually exonerates it.

## Stale process after a merge

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
