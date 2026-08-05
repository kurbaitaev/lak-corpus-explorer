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

## English became binding too

Once the nav carries nine destinations plus brand, auth link and language
toggle, **English is at the limit as well** — the overflow shows up as the
language toggle being pushed past the right edge, or the auth link breaking
into three lines.

**Why:** shaving one label at a time turns into several rounds of guessing, and
each round costs a full browser-test run.

**How to apply:** don't shave labels past the first obvious win. Add a
viewport-scoped rule that tightens `.nav-link` horizontal padding between the
mobile drawer breakpoint and a comfortably wide screen; ten links times a few
pixels buys far more room than any single label. Note that the route-level
overflow assertion does **not** catch a link wrapping onto extra lines, so read
a screenshot as well as the test result. To find the real culprit, enumerate
elements whose `getBoundingClientRect().right` exceeds the viewport rather than
inferring it from the labels.
