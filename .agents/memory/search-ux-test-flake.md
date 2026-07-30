---
name: Search UX browser test is intermittently flaky
description: A known race in the Search page that makes the UX suite fail roughly one run in three.
---

The Search page's browser UX suite fails intermittently (~1 run in 3) on the
"empty search state missing" assertion. It is a real race, not a broken assertion.

**Why:** The client's search function guards re-entry by returning early when a
request is already in flight. The test changes a filter (firing one search) and then
immediately submits a query (firing another). When the second call lands while the
first is still pending it is silently dropped, the table keeps the previous rows, and
the expected empty state never renders. A user typing quickly right after touching a
filter hits the same dropped-search behaviour.

**How to apply:** Do not treat a single failure of this suite as a regression from
whatever you just changed — re-run it two or three times before investigating. Before
blaming a recent merge, check whether the page script actually changed; this race
predates the word-order search work and the private research layer. The durable fix is
to supersede an in-flight search rather than drop the new one, which is a real code
change and should be scoped as its own task.
