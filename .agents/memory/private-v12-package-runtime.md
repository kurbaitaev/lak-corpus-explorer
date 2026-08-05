---
name: Private research packages: persistent storage and disposable cache
description: Where the audited private packages actually live, and why the extracted tree may be deleted freely.
---

The audited private research packages never enter git. Their **archives** are the
persistent artifact and live in persistent private storage, reachable only through the
server-side database pool. The extracted tree under `private/<id>/` is a **disposable
cache**: deleting it is safe and expected — boot restores any missing package from
persistent storage, re-hashing the archive before extracting it.

**Why:** an earlier arrangement kept the packages only in gitignored workspace paths
(`attached_assets/*.zip` plus `private/`), so a container rebuild came up with nothing
staged and the only remedy was asking the user to re-upload. Persistent storage removes
that failure mode without putting a single permission-pending row into the repo.

**How to apply:**
- Never synthesize rows from the audited counts. The counts are expectations to check a
  package against; if no package can be restored, `ingestion_blocked` with a reason is the
  *correct* state.
- When adding a new package, register it with its recorded archive digest and let the
  boot pipeline upload/restore it. Do not hand-copy files into `private/`.
- Verification results are cached by a digest over every file the verifier reads — not by
  package name or mtime. That is what lets an unchanged package skip re-parsing while
  guaranteeing a changed, missing or tampered file can never reuse a stale "verified"
  answer. If you add a file to the verifier's inputs, add it to that list too or the cache
  becomes a hole.
- Any single failure blocks the whole package, not one layer: archive digest mismatch,
  missing report, count disagreement, or a tampered record.
- Extraction staging must happen on the same filesystem as the destination. `/tmp` and the
  workspace are different devices in this container, so `rename()` across them fails with
  `EXDEV`.
