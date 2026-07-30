---
name: Localization canonical values
description: Durable boundary between translated interface labels and language-neutral application data.
---

Localize only the displayed label for statuses, roles, categories, rights/access values, validation kinds, vote options, and filters. Keep the canonical value unchanged in form controls, requests, storage, database rows, provenance, and exports.

**Why:** Filters, validation workflows, permissions, and regression tests rely on exact canonical values. Translating those values instead of their labels silently breaks behavior and can alter research data.

**How to apply:** Add maintained labels to the centralized dictionary and map canonical values at render time. For dynamically constructed key families, test every value defined by constants, seeds, and stored enumerations—not just literal translation keys found by grep.