---
name: Desktop nav width budget
description: The shared top nav is at its 1280px limit — a new nav entry must be short in Russian or the i18n overflow check fails.
---

The shared top navigation is already at its width budget at a 1280px viewport. Adding one more
nav entry overflows the page in Russian (the i18n route check asserts
`clientWidth === scrollWidth` on every route, at desktop and at 390x844).

**Why:** Russian labels are much longer than their English counterparts, and a nav link can only
wrap between words — a single long word (e.g. a 12-letter noun) sets the link's minimum width, so
shortening a two-word label to one long word saves nothing. English labels are effectively free;
Russian ones are the binding constraint.

**How to apply:** when adding a nav entry, choose a Russian label whose *longest single word* is
short (~6-8 letters), then measure the real rendered widths at 1280px before running the suite.
Sum the `.nav-links a` widths in a headless page rather than guessing from character counts.
