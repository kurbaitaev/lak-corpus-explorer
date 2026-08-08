# Lexicon synthesis v1

## Public data inventory

| Source layer | Entries |
| --- | ---: |
| Gadzhiyev Russian to Lak dictionary | 14,373 |
| Khaydakov Lak to Russian dictionary | 9,294 |
| LexCauc Lak dataset | 2,246 |
| Komen Lak dictionary | 1,881 |
| Intercontinental Dictionary Series | 5,157 |
| Uslar historical lexicon | 1,469 |
| Digiev Russian to Lak phrasebook | 5,383 |
| Total | 39,803 |

The committed bundle also contains 47,489 source senses, 73,978 explicit forms, 33,696 entry-to-lemma links, and 162,207 search terms. The importer materializes 25,015 conservative source-backed form-to-lemma relations.

## Data model

- Source entries are preserved separately. Homonyms are not merged.
- Every structured form must occur explicitly in a source. The public layer does not generate forms.
- Canonical lemma keys connect source entries, dictionary forms, and corpus word forms without replacing the original evidence.
- Russian inflection matching uses exact forms first and deterministic stemming only as a fallback.
- Corpus occurrences remain distinct from dictionary evidence. A source-backed paradigm can connect an attested word form to a lemma, but it does not create a token occurrence.
- Raw source rows remain available in the database for audit. The public interface displays normalized glosses and citations instead of raw JSON.

## Reproducibility

`npm run lexicon:build` recreates the checksummed bundle from the seven source layers. `npm run test:lexicon` verifies source counts, record hashes, explicit-form provenance, homonym separation, Russian plural lookup, and the `махъру` paradigm. `npm run lexicon:import` verifies every checksum before an atomic, idempotent database import and exact reconciliation.

## Acceptance example

The Russian query `слова` must rank the Gadzhiyev entry `слово́ мн. слова, ср. махъ, калима.` first. The `махъ` lemma page must keep Khaydakov homonyms 1 and 2 separate and list the explicit paradigm `махъ`, `мукъул`, `махъру`, `мукъурттил`.
