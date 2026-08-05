---
name: Private research layer conventions
description: How third-party research packages enter this project — verify-then-ingest, fail closed, never merge.
---

Third-party linguistic packages (copyrighted lexicons, OCR, audio) enter the app only as a
**private staging layer**, never as corpus records.

The rule: **a quoted count is not data.** Ingestion runs only against a package that is
physically present in the workspace and passes machine verification — record counts vs. the
package's own stats file, provenance identifiers, a checksum of every received source file, and
fail-closed policy fields on *every* record. Any failure stops ingestion for that source and is
surfaced as a reason string; the audited count is then displayed as an expectation, not as
holdings.

**Why:** an earlier pass of this work had to ship with no data at all because only the
description of the package existed. The verification path must therefore be the normal path,
not a special case, and the UI must be able to say honestly "expected N, staged 0".

**How to apply:**
- Keep packages out of `public/` and out of git (`private/`, plus the archive in
  `attached_assets/`). Protected binaries are never served or referenced by URL.
- Rights, access, review and training are four independent decisions. Raising exposure
  (public access or training-ready) requires expert authority **and** cleared rights **and** an
  accepted review **and** settled consent — checked server-side, not in the UI.
- Bible exclusion is a claim about the *source*, not about vocabulary: match it on
  source/title/author fields only. A dictionary entry for "библия" is ordinary lexicography and
  must not reject a whole source. It is also **package-specific**, not a global rule: a later
  package may legitimately hold restricted religious material that is staged privately and never
  published. Applying the older package's exclusion to it would block the whole package.
- Non-language material (system metadata, research administration, non-Lak comparative,
  archive containers) may be inventoried as reference/control records but must never feed a Lak
  language layer. Where a package's own routing already honours that, encode it as a hard
  verification check rather than trusting it.
- Do not store absolute filesystem paths from the sender's machine; they leak the sender's home
  directory. Keep the package-relative path only.
- Identical normalized spellings across sources are linked as corroboration rows with an
  explicit "not semantic deduplication" note. Never merge candidates into canonical records.
- Consent stays `unknown` unless the package documents it; audio inventories must not assert
  speaker, dialect, or row/time alignment.
- Relationships between private sources (translation, parallel text, transliteration, alternate
  edition, duplicate) are machine *proposals*: store the signals that fired and the measurements
  behind them, and keep every response flagged as not-validated. Acceptance by a reviewer clears a
  candidate for further work; it never certifies a translation, and no alignment a human has
  touched may be regenerated away.
- A scan whose result is cached by an input key must also remove its own stale output when the
  input set shrinks (a file withdrawn, or an artefact the scanner stops treating as a work) —
  otherwise withdrawn material lingers as live candidates. Delete only untouched machine output:
  anything a human has moved, seeded, or built on stays.
