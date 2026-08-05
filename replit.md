# Lak Corpus Explorer

A publicly accessible, source-aware research corpus of the Lak language (лакку маз, ISO 639-3: lbe). Searchable via translation-first Russian→Lak lookup with concordance examples, quality-tracked records, and a persistent human review system.

## Architecture

- **Backend**: Node.js + Express (`server.js`, port 5000)
- **Database**: Replit PostgreSQL — `reviews` table (record_id, state, correction, note, reviewer_name, timestamps)
- **Corpus data**: `public/data/corpus-data.json` + `public/data/corpus-meta.json` — **generated files, gitignored**. Rebuilt from the canonical `index.html` (project root) with `python3 scripts/extract-corpus.py`. `server.js` auto-runs the script at startup if the files are missing, and aborts with a clear error if regeneration fails.
- **Frontend**: Vanilla JS, multi-page (`public/index.html`, `public/about.html`, `public/queue.html`)

## How to run

```
node server.js
```

Workflow: "Start application" → `node server.js` on port 5000.

## Key features

- **Translation-first search**: Russian query → alias expansion → Lak concordance hits
- **Script normalisation**: NFKC + е/ё merge + palochka variant unification (Ӏ U+04C0 canonical)
- **Filters**: type (text/lexicon), source (PCMLBE, Lak Wikipedia, Digiev phrasebook, IDS, Uslar 1890), variety (standard/arakul/balkhar/shali/historical/unspecified)
- **Quality ladder**: Approved / Flagged / OCR-unreviewed (Uslar 1890) / Unreviewed
- **Inline review panel**: Approve, Flag, Unreviewed — with correction text, note, reviewer name
- **Review queue page**: all reviews, filter by state, JSON/CSV export
- **About/Research page**: methodology, sources, quality ladder, statistics, collaboration invitation

## Private source-import layer (audited v1.2 and v1.3 research packages)

Third-party research material that is **not part of the public corpus** is staged privately and
never served:

- **Persistent storage, disposable cache.** The package archives live in persistent private
  storage (`lib/private-storage.js`) — Replit Object Storage when a bucket exists, otherwise
  chunked binary blobs in Postgres behind the same interface, reachable only through the
  server-side pool. `private/<id>/` is a rebuildable cache: `lib/private-boot.js` restores any
  missing package on boot, re-hashing the archive before it is extracted.
- **Nothing is ingested from a quoted count.** `lib/source-import.js` (v1.2) and
  `lib/source-import-v13.js` (v1.3) check each package against its own reports: declared totals,
  actual line counts, the SHA-256 of every received source file, fail-closed policy fields on
  every record, and — for v1.3 — that system, administrative and non-Lak material stays an
  inventory or reference record and never feeds a Lak language layer. Any checksum mismatch,
  count disagreement, missing report or tampered file blocks that package with a reason string
  and leaves the rest of the app running.
- **Verification is cached by content, not by name.** A result is keyed by a digest over every
  file the verifier reads, so an unchanged package is not re-parsed on boot and a changed,
  missing or tampered file can never reuse a stale "verified" answer.
- Staged rows default to private research / permission pending / import unreviewed /
  not public-search-eligible / not training-ready. Rights, access, review and training are four
  separate human decisions (`routes/source-import.js`); publishing or enabling training needs a
  verified expert plus cleared rights, an accepted review and settled consent. Nothing is
  promoted automatically, and imports are idempotent.
- Identical spellings across sources are linked as corroboration; records are never merged.
- `/api/source-import/status` is public but content-free (counts and states only) and mentions
  no package file or path. `/api/source-import/packages` reports presence, digest verification,
  declared vs staged counts, restore source and blocked reasons to a trusted validator or above.
  Candidate text requires a trusted validator or above, and the training export fails closed.
- Archives, extracted text and generated candidate output are all gitignored.


## Private workspace: Source Intelligence, Alignment Lab, rights review

Authenticated-only screens (`/intelligence.html`, `/alignment.html`, `/rights.html`) where the
relationships between private sources are proposed by evidence and cleared by people:

- **Deterministic proposals only.** `lib/source-intelligence.js` scores every plausible pair over
  filename/title normalisation, folder families, duplicate and near-duplicate text, language and
  script classification, headings, dates, names, numbers, punctuation profile, paragraph structure,
  length ratios, dictionary anchors and public-corpus overlap. Each proposal stores the signals
  that fired, the measurements behind them, both source references, a confidence value and its
  generator version. The same inputs always produce the same proposals, and a scan is skipped
  when the inputs have not changed. Operating-system artefacts (`.DS_Store` and friends) stay
  listed as received files but are not paired.
- **The War family is the reference example**: War-1 as the Lak text, War-1a as an alternate
  near-duplicate Lak version, War-2 as the Russian parallel/translation candidate.
- **Alignment is a draft to correct, not to regenerate.** `lib/alignment-engine.js` aligns a pair
  section → paragraph → sentence with 1:1, 1:many, many:1 and explicitly unmatched units;
  regeneration is refused once a reviewer has decided anything.
- **Nothing here is a validated translation.** Every relationship, unit and response carries
  `validated: false`; acceptance clears a candidate for further work, it does not certify it.
- **Server-side gates** (`routes/source-intelligence.js`): every `/api/private/...` route needs a
  trusted validator or above and returns 401 with no content otherwise; accepting candidates or
  units, regenerating an alignment and raising exposure need a verified expert, and public access
  or training use is refused (409) until rights are cleared and the review is accepted. Rights,
  access, review and training remain four separate decisions, each logged immutably with its note.

## Reviewed translation memory and evaluation isolation

`lib/lab-memory.js` is the single place where three rules live; the retriever, the provider and
every lab route delegate to it, so no caller can drift:

- **Gold evidence.** A pair counts as reviewed translation memory only when it is expert-approved,
  non-private, public access, openly licensed (public domain / CC BY / CC BY-SA), human-authored
  and in the train/dev split. `permission_granted`, `unknown` and `restricted` rights fail closed.
  Pending, private, unreviewed rows and the private v1.2/v1.3 research candidates stay candidates
  and can never be gold. `GET /api/lab/memory` serves the gold layer and its policy.
- **Evidence typing and abstention.** Every answer reports its evidence class — `approved_parallel_pair`
  (gold), `direct_dictionary`, `attested_public_example`, or `usage_support_only` — plus review state,
  provenance and a `certainty` of reviewed / candidate / usage_only / none. **Monolingual examples can
  support usage but never prove a translation**: an example carrying only one side is downgraded to
  usage support and the lab abstains explicitly with a reason instead of guessing. Answers carry a
  claim object that is always `model_learning: false`, `fine_tuned: false`.
- **Benchmark isolation.** Held-out benchmark answers are removed from retrieval, from the memory
  layer and from every export in one shared guard — including a stored pair that happens to duplicate
  a held-out item. The private benchmark (target 500–1,000 expert pairs, test split forced private)
  has its own expert-only import and `no-store` export routes, kept apart from the public export
  surfaces. Evaluation runs are logged as `retrieval_only` or `model_plus_retrieval` with gold and
  abstain counts; nothing is trained or fine-tuned, and a model+retrieval run is refused while no
  model is configured rather than faked.

## Data structure

Each `CORPUS_DATA` row: `[type, lak_text, meaning, source, variety, record_id, url]`

`CORPUS_STATS`: document/segment/token/lexicon counts, per-variety lexicon breakdown  
`CORPUS_ALIASES`: Russian → Lak[] translation map (from IDS + Digiev phrasebook)

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/reviews` | List reviews (optional `?state=&limit=&offset=`) |
| GET | `/api/reviews/:recordId` | Single record review |
| POST | `/api/reviews` | Upsert review |
| POST | `/api/reviews/bulk` | Bulk fetch by record IDs |
| GET | `/api/stats/reviews` | Counts by state |
| GET | `/api/export.json` | Download all reviews as JSON |
| GET | `/api/export.csv` | Download all reviews as CSV |

## User preferences

- Do not publish until the user reviews the working preview.
- Keep Uslar 1890 OCR text verbatim — no silent modernisation.
- Commit completed work to the connected GitHub repository.
