# Lak Corpus Explorer

Public deployment of the searchable, source-aware Lak research corpus.

## Setup

The corpus data files (`public/data/corpus-data.json`, `public/data/corpus-meta.json`) are generated and not committed to git. After cloning, build them once from the canonical `index.html` at the project root:

```
python3 scripts/extract-corpus.py
```

The server (`node server.js`) also runs this automatically at startup if the files are missing, and exits with a clear error if they cannot be regenerated.

## Structured corpus v2 (default off)

Release 1 adds a PostgreSQL-backed PCMLBE learning layer without changing the
legacy 24,403-record endpoint or importing private sources. It provides exact
wordform, lemma, and grammatical-feature search plus an authenticated proposal
review loop. The feature is fail-closed unless `CORPUS_V2_ENABLED=true`.

Local preparation and verification:

```bash
npm run migrate
npm run corpus:v2:import
npm run corpus:v2:reconcile -- --database
npm run test:corpus-v2
```

The importer verifies every SHA-256 before opening a transaction, rejects
stable-ID content conflicts, reconciles exact counts before commit, and is
idempotent. It does not run during deployment. `scripts/post-merge.sh` applies
only additive schema migrations; run the importer as an explicit controlled
job after inspecting the database backup and migration diff.

Important boundaries:

- PCMLBE preliminary annotations are source evidence, not expert truth.
- Predictions are never returned by anonymous search APIs.
- A proposal applies to a wordform type and is not propagated to all tokens.
- Public search requires both public access and cleared/open rights; training
  permission remains a separate false-by-default field.
