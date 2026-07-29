# Lak Corpus v1.1 import payload

This directory is a versioned handoff to Replit Agent. The ZIP files contain JSONL:

- `gadzhiev_1958_lexicon.zip` — 14,373 Russian–Lak entries.
- `literary_documents.zip` — metadata for 77 works.
- `literary_sentences_candidates.zip` — 45,488 deduplicated sentence candidates.

## Required import behavior

1. Preserve every source record and ID. Never rewrite the source text.
2. Add `Gadzhiyev 1958` and `Daniel literary collection` to the source filter.
3. Mark both layers `Source import — unreviewed`.
4. Gadzhiyev may appear in default translation-first search. Preserve parenthetical senses,
   especially `луна → барз (ссавнийсса)` and `месяц → барз (шинал)`.
5. Literary candidates are opt-in. Add a clearly labeled control such as
   `Include unreviewed literary imports`; default it to off.
6. When enabled, show author, title, year, source filename, and review status with every
   literary result.
7. Keep OCR, Wikipedia audit candidates, and audio inventory out of public search.
8. Do not publish automatically. Run the existing regression suite plus new import tests,
   verify mobile behavior at 390 × 844, and report the checkpoint for review.

## Acceptance checks

- `луна` returns the Gadzhiyev sense before usage examples.
- `месяц` does not collapse into the astronomical `луна` sense.
- `солнце` returns `баргь`; `спасибо` returns `барчаллагь`.
- Default empty search does not add 45,488 literary records.
- Enabling literary imports makes source-labeled results searchable.
- Existing validated/reviewed records and review IDs are unchanged.
- Corpus counts distinguish canonical records from imported candidates.
- No horizontal overflow or open-by-default navigation at 390 × 844.

See `DATA_CARD.md` and `SOURCE_LEDGER.md` before implementation.

