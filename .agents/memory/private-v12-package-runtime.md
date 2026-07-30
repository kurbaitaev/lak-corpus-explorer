---
name: Private v1.2 research package is runtime-only
description: Why the audited private source package disappears, and how it is restored and verified.
---

The audited processed-only research package lives **only** in gitignored paths: the
uploaded ZIP under `attached_assets/` and the extracted tree under `private/`. Neither
is ever committed.

**Why:** That exclusion is what keeps unlicensed/permission-pending rows out of the
repo. The cost is that the package is not part of any checkout — a container rebuild,
fresh clone, or new workspace comes up with `package_present=false`, all sources
`awaiting_manifest`, and `ingestion_blocked=true`. That state is *correct*, not a bug:
it is the fail-closed default when no package is on disk. Do not "fix" it by
synthesizing rows from the audited counts — the counts are expectations to check
against, never data.

**How to apply:** When the status endpoint reports the package missing, the only
remedy is re-uploading the ZIP; say so plainly rather than reconstructing anything.
After upload: checksum the archive against the recorded digest, extract into the
gitignored runtime dir, restart the workflow (verification runs at startup, not on
request), then confirm `git status` is still clean.

Verification is layered and any single failure blocks *everything*, not just one
source: archive digest mismatch, missing/unreadable `stats.json`, a package that does
not declare Bible exclusion, or a per-source count that disagrees with the declaration.
Duplicate spellings across lexical sources are linked as corroboration only — never
merged, since identical normalized forms are not evidence of identical meaning.
