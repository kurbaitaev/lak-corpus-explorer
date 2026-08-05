---
name: No Object Storage bucket in this project
description: Why persistent private blobs go to Postgres here, and how to check before assuming otherwise.
---

This project has **no Replit Object Storage bucket** and one could not be provisioned:
`.replit` carries no `[objectStorage]` section, and the sidecar's default-bucket lookup
returns an empty bucket id. Integration search surfaces only third-party file connectors
(Drive, Box, Dropbox, OneDrive), which are not a private server-side blob store.

**Why:** persistent private storage for the research package archives still had to exist,
so it is implemented as chunked binary blobs in the already-provisioned Postgres, behind a
small pluggable interface with a backend registry. Object Storage can be dropped in later
by adding a backend and selecting it with an environment variable — callers do not change.

**How to apply:** before reaching for Object Storage in this repl, actually check for the
`[objectStorage]` config and a non-empty bucket id rather than assuming availability.
Digests are always recomputed from the bytes written or read back, never trusted from the
caller, so swapping backends cannot silently weaken verification.
