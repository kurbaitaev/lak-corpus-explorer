---
name: Release test suites
description: Two suites must pass before any release; anti-gaming thresholds are env-overridable by design.
---

Before declaring a release done, BOTH suites must pass:
1. `node scripts/regression-check.js` — corpus search/reviews, runs against the main server (port 5000, or BASE_URL override).
2. `node scripts/test-validation.js` — validation/gamification; spawns its OWN server on port 5055 and self-cleans `test-val:*` rows.

**Why:** the suites catch different classes of breakage; test-validation depends on fast
anti-gaming thresholds that must not change production behavior.

A suite that spawns its own server and registers accounts must clean up at BOTH ends: in a
`finally` block and again at the start of the next run. A run killed part-way (the classic cause
is piping its output into `head`, which closes the pipe and takes the process down with EPIPE
before cleanup) otherwise leaves accounts and decision rows behind, and the next run fails on
"account already exists" or on another suite's "everything is still pending" assertion. Make each
cleanup statement independent, and restore every table the feature writes to — including the
queue/review tables a decision endpoint updates alongside the main row.

**How to apply:** when adding points/rate-limit/anomaly logic, keep the thresholds
env-overridable (`VALIDATION_MIN_INTERVAL_MS`, `VALIDATION_RAPID_MS`, `VALIDATION_DAILY_CAP`,
`VALIDATION_DIMINISH_AFTER`, `AUTH_RATE_MAX`) — the suite overrides them for its spawned
server instead of changing defaults. Tests assert on real DB state via SQL; keep cleanup
covering every new table the feature writes to.
