---
name: Search page in-flight request races and how the UX suite must wait
description: Why the Search page supersedes in-flight searches, and the browser-test waiting rule that follows from it.
---

## Rule 1 — never drop a newer search

Client-side search must supersede an in-flight request, never refuse to start a
new one. A sequence counter decides who may write to the DOM, and the previous
request is aborted; superseded responses *and their error paths* return without
touching page state.

**Why:** The page used to guard re-entry by returning early while a request was
pending. Changing a filter and immediately submitting a query silently dropped the
second search, leaving the old rows on screen — a real user bug that also produced
a ~1-in-3 browser-test failure.

**How to apply:** Any new client fetch that renders into shared page state (result
tables, counts, pagination, concept cards, highlight spans) needs the same
guard. Derived UI must only ever be written by the winning request, or a late
loser half-updates the page.

## Rule 2 — a response is not a render

In Playwright tests, `waitForResponse` resolves when the HTTP response lands, which
is one or more ticks *before* the page has read the JSON body and updated the DOM.
Asserting on DOM state immediately after `waitForResponse` is a coin flip.

**Why:** After the superseding fix landed, the same "empty search state missing"
assertion still failed intermittently — the request was correct, the assertion was
just early.

**How to apply:** After `waitForResponse`, wait for the *rendered* state
(`locator.waitFor(...)`, or assert through an auto-waiting locator) before making a
non-waiting assertion such as `isVisible()` or `count()`.
