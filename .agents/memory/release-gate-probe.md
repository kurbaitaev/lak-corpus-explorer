---
name: Release gate leak probe
description: How the public-surface leak probe stays honest — sampled markers, echoed-input exemption, and what is legitimately public.
---

# Release gate leak probe

The probe samples its private markers **from the packages that are actually
staged**, then discards any candidate string that already occurs in the public
corpus or the shipped client files. A hardcoded marker list is not acceptable:
it goes stale the moment a package changes, and it silently stops testing.

**Why:** a gate that passes because it is checking for strings nobody holds any
more is worse than no gate — it reports safety it never measured.

**How to apply:** build the marker set at run time from the private layers,
filter against a haystack of everything already public, and assert a minimum
marker count so an empty sample fails loudly instead of passing vacuously.

## Echoed input is not a leak

Search and the Lab repeat the caller's query back in their response. Scanning
that response for the term you just sent will always "find" it. Exempt the
echoed input from the scan; treat every other marker as a real hit.

## What is legitimately public

Curated source-family **titles** and the aggregate count keys are published on
purpose. Raw source paths, candidate ids, extracted-text pointers and the
package's own internal rights vocabulary never are. A probe that flags the
first group is a false alarm and will get the gate ignored.
