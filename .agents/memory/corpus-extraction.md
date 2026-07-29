---
name: Corpus data extraction
description: How to correctly extract DATA/STATS/ALIASES from the original index.html
---

The original index.html script has a single `const` declaration:
  `const DATA=[...], STATS={...}, ALIASES={...};`

**Not** three separate `const` blocks.

Boundary markers (raw bytes):
- `b'const DATA='` → value starts immediately after
- `b'], STATS='` → DATA array ends at this `]`; STATS value follows after `], STATS=`
- `b'}, ALIASES='` → STATS ends at `}`; ALIASES value follows

`b'STATS='` (without `const`) appears only once and is correct, but `const STATS=` returns -1 — do not search for it.

**Why:** The original minified script puts all three vars in one declaration with commas. Search for the boundary tokens above, not for `const` keywords per variable.

**How to apply:** Use this in any future extraction/rebuild script. Implemented in `scripts/extract-corpus.py`.

Also: ALIASES string values contain `;`, so never scan for the statement-terminating semicolon to find the object end — use `json.JSONDecoder().raw_decode` on the text starting at the ALIASES value.
