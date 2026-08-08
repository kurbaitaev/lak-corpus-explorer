---
name: Production data jobs on Replit
description: How to run one-off write jobs (data imports) against the production database when agent access is read-only
---

Agent access to the production database is read-only (SELECT on a replica); `DATABASE_URL` is runtime-managed and its value is never visible to the agent. The Publish flow applies *schema* diffs to prod but never copies data.

**Why:** Hit during the corpus v2 release — the importer had to run against prod, and there was no agent write path. Replit docs confirm two sanctioned paths for one-off prod jobs: an external client using the connection string from the Database pane → Settings tab (user-visible), or a Shell inside the production environment.

**How to apply:** For prod data jobs, ask the user for the production connection string via `requestSecrets` (never chat), then run the existing checked-in script with that URL — do not write custom prod-migration code (database skill forbids agent-authored prod schema migrations; publish handles schema). Do not add boot-time or deploy-hook imports if the project documents "importer never runs during deployment." Record pre-job prod counts via `executeSql({environment:"production"})` first; Replit PITR (7d Core / 28d Pro) is the backup story.
