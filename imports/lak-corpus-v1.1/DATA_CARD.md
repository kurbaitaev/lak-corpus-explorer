# Data card: Lak Corpus v1.1 candidate layer

## Purpose

The dataset supports Lak–Russian search, source-aware concordance, expert validation,
and future teaching tools. It is an enrichment layer for the existing Lak Corpus Explorer,
not a replacement for its validated records.

## Composition

- Dictionary: 14,373 Gadzhiyev-derived records.
- Literary corpus: 77 source documents and 45,488 candidate sentence segments,
  approximately 607,507 tokens.
- Duplicate ledger: 3,781 normalized duplicates excluded from the candidate set.
- Audio inventory: 53 archive rows and 41 unique media signatures.
- OCR pilot: ten sample pages, excluded from search.
- Historical Wikipedia audit: 1,590 old-only candidates, excluded from search.

## Record status

Dictionary and literary imports use `source_import_unreviewed`. Audio uses
`unknown_check_with_provider` for consent. OCR and historical reconciliation outputs are
explicitly audit-only.

## Processing

The literary pipeline extracts files, joins spreadsheet metadata, segments text, preserves
source hashes, normalizes palochka variants for duplicate comparison, and removes exact
normalized duplicates against both the existing corpus and earlier records in the import.
It does not modernize spelling or claim semantic equivalence.

## Limitations

- Dictionary parsing is mechanical; parenthetical sense information must be preserved.
- Literary segmentation inherits punctuation and front-matter noise from source files.
- There is no aligned Russian translation for most literary sentences.
- Rights and permission status are not established for unrestricted public distribution.
- Audio language and duplicate assessments are filename/archive-based.
- OCR is unsuitable for publication without Lak-aware correction.
- The dataset is biased toward available written sources and Quba-area recordings.

## Responsible use

Display source and review status beside every result. Keep expert corrections as separate
versioned assertions. Never infer speaker consent, dialect identity, or translation quality
from filenames. Do not train or publish a model from restricted layers without permission
and a documented evaluation.

## Validation priorities

1. Expert-review the most searched dictionary entries and ambiguous senses.
2. Resolve literary metadata mismatches and remove front matter.
3. Sample each author/work for segmentation and orthography quality.
4. Confirm audio consent and dialect labels with providers.
5. Build a Lak-specific OCR correction set from the two scanned books.

