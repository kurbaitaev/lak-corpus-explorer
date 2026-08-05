---
name: Deployment image lacks workspace-only binaries
description: Tools resolved from the workspace runtime path (unzip, etc.) may be missing in the published image; do the work in-process instead.
---

# Deployment image lacks workspace-only binaries

A command that resolves to `/nix/store/...-replit-runtime-path/bin/<tool>` in the
workspace is a *workspace* convenience, not a declared dependency. The published
image can be missing it, so code that shells out works perfectly in development
and fails only in production.

**Why:** a private package restore shelled out to `unzip`. Development restored
fine; production reported the package blocked. `spawnSync` on a missing binary
returns a non-zero status with **empty stderr**, so the failure surfaced as a
bare "unzip failed" with no cause — the hardest kind to diagnose remotely.

**How to apply:**
- Prefer an in-process library over a subprocess for anything on a boot or
  restore path. Zip extraction has a pure-Node reader; use it.
- If you must spawn, report `result.error.code` (ENOENT) alongside stderr, or
  the production log will say nothing useful.
- Guard it in the release gate: assert the restore path contains no
  `child_process` / `spawn` reference, so the dependency cannot creep back.

## Production data is not copied from development

Publishing migrates the *schema* to the production database; it does not
guarantee your rows arrive. Before blaming a seeding step, read the deployment
logs and query production read-only — the blobs may already be there and the
real fault may be in the code that consumes them.
