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
## A public projection must not echo private tokens

When a private dataset gains a *public* projection, the temptation is to pass
its canonical values straight through. Don't: a value the probe treats as a
provenance marker (the package's own internal rights vocabulary, schema tags,
layer filenames) becomes a guaranteed gate failure the moment it is published,
and the only ways out are to publish it anyway or to delete the marker — both
of which weaken the probe.

**Why:** the marker exists precisely because that string occurs nowhere except
in the private package. Publishing it makes the claim false, and the string
tells a visitor nothing the plain-language label doesn't.

**How to apply:** give the public projection its own vocabulary, mapped from the
private one at the boundary. Then add the complementary check the marker scan
cannot make: pin the **set of published field names** and fail on anything
outside it, and assert the withheld-key list and the published-field list stay
disjoint. Marker scanning catches leaked *values*; a future leak is far more
likely to arrive as a new *field* nobody thought to probe for.

Beware the haystack exemption: strings that appear anywhere under the public
asset directory are treated as already-public and dropped from the marker set.
Anything you add to a shipped client file (a translation dictionary, for
instance) silently exempts itself.
