---
name: Long boot work on autoscale deployments
description: Why multi-minute background work started at boot never finishes on autoscale, and the shape that does work (chunked, resumable, progress committed with the rows).
---

# Long boot work never completes on autoscale

On a Replit **autoscale** deployment the process is suspended between requests
and every new instance starts with an empty filesystem. Background work kicked
off at boot — not attached to any request — therefore gets only the CPU slices
that arriving requests happen to grant it, and can be killed at any moment.

**Why:** a large staging job written as one all-or-nothing transaction was
rolled back on every interruption, so it never landed. Because the "we're
finished" marker was only written after the whole job succeeded, each new
instance redid the entire job from scratch and died at the same place. The
public status sat on its initial placeholder value indefinitely, which read as
"hung" but was really "restarted forever". The identical code completed in
seconds in development, where the process is always on — so *"it works in dev"
proves nothing about this failure mode.*

**How to apply:** when boot work can exceed a request's lifetime, don't ask
whether the code is correct — ask whether it can survive being killed halfway.

- Commit in chunks bounded by **both** row count and wall-clock time. Rows
  alone is the wrong unit when the host decides when you run: a slow chunk can
  hold an open transaction long enough to lose all of it.
- Write the progress marker in the **same transaction** as the rows it
  describes. Then a marker can never claim more than was actually committed.
- Cache the expensive *verification* verdict before staging, not after, or an
  interrupted run re-verifies everything next boot.
- Serve status from durable database state, never from a boot-time variable.
  An in-memory placeholder on a suspended instance is indistinguishable from a
  hang, and tells the user nothing.

## The trap this opens

Once a batch/progress row is created when a unit of work *starts*, any
"is it done?" check written as *does a row exist?* silently becomes wrong — a
run interrupted during the final unit looks complete on the next boot, skips
the work entirely and strands it forever. Every completeness check must test a
terminal status, not row presence. Test it by SIGKILLing a real run mid-flight
and then driving the **full boot path**, not just the inner import function.

## Diagnosing it

Deployment logs that stop dead after a known boot line, with no error and no
completion line, mean unfinished work rather than a crash. Confirm by comparing
per-unit row counts between dev and production: a prefix of the work present
and the largest/last unit missing is the signature.
