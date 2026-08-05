---
name: Publish diff proposes dropping production tables
description: With an imperative (code-created) schema, a development database that has not run the app makes the publish diff propose DROPs against production.
---

# Publish diff proposes dropping production tables

Publishing introspects the development and production databases and applies the
difference to production. When production has objects development lacks, the
generated migration **drops them**.

That is fine for a declarative schema, but this project creates and evolves
every table imperatively in the database module, executed by the server at
boot. So a development database in which the app has never run — or which is
behind the current code — looks empty of the newest tables and columns, while
production, which has run them, still has them. The diff then proposes dropping
exactly the newest tables plus columns and constraints on evolved ones.

**Why:** the drop list included the tables holding the private package
archives. Approving it would have destroyed data that exists nowhere else in
the production environment.

**How to apply:**
- Never approve destructive drops at the publish approval gate. Read the list:
  if it names your newest tables, development is behind, not production wrong.
- Keep the development database level with the code by running the schema
  bootstrap from the post-merge setup script. That is the sanctioned
  development-side application point; the bootstrap is idempotent, so it is
  safe to repeat.
- Never run DDL against production, never put schema pushes in the deploy build
  command, and never add new self-healing DDL to the entrypoint. The supported
  path is: converge development, then re-publish.
- The convergence lands when the task merges, so the correct order is merge
  first, publish second.
