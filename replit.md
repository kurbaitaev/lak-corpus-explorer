# Lak Corpus Explorer

A publicly accessible, source-aware research corpus of the Lak language (лакку маз, ISO 639-3: lbe). Searchable via translation-first Russian→Lak lookup with concordance examples, quality-tracked records, and a persistent human review system.

## Architecture

- **Backend**: Node.js + Express (`server.js`, port 5000)
- **Database**: Replit PostgreSQL — `reviews` table (record_id, state, correction, note, reviewer_name, timestamps)
- **Corpus data**: `data/corpus-data.json` + `data/corpus-meta.json` — **generated files, gitignored**. Rebuilt from the canonical `index.html` (project root) with `python3 scripts/extract-corpus.py`. `server.js` auto-runs the script at startup if the files are missing, and aborts with a clear error if regeneration fails. `public/data/` holds a static copy for download; keep the two in sync when regenerating. The meta file carries a `licenses` block: **PCMLBE is confirmed CC BY-SA 4.0** (credit Erwin Komen, Radboud University; ShareAlike applies), displayed consistently in the Observatory, About page, search results and research page — the release gate checks all four surfaces.
- **Frontend**: Vanilla JS, multi-page (`public/index.html`, `public/about.html`, `public/queue.html`)
- **Structured corpus v2**: additive PostgreSQL tables populated only by the
  explicit checksummed PCMLBE importer. Disabled unless
  `CORPUS_V2_ENABLED=true`; enabled deployments apply additive versioned
  migrations before listening but never auto-import corpus rows unless the
  separate exact `CORPUS_V2_AUTO_IMPORT=true` opt-in is present.

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
- **Optional structured modes**: exact Wordform, Lemma, and Grammar searches;
  source annotations remain separate from authenticated review-only proposals
- **Public lemma dictionary and occurrence evidence**: `/lemmas.html` lists every
  imported source lemma and opens its attested forms and sentence contexts;
  `/occurrence.html` shows the addressable sentence, token analyses, source
  record and license. The additive evidence-spine migration also prepares
  page regions, assertion history, aligned media, versioned datasets and model
  runs without changing existing corpus IDs.

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


## Public Source Library and derived Lak word-form index

The v1.3 batch — the Lak Materials research collection shared by **Professor Victor
Friedman**, credited publicly on the research page — is restricted material, but *knowing
what is in it* is not. Two public, anonymous surfaces (`/source-library.html`,
`/word-forms.html`) publish description and aggregate derived data while the source text
stays private:

- **The public record reconciles to the audit: 320 items.** 293 substantive sources are
  catalogued one by one; the 27 system-metadata receipts (macOS folder files, no content)
  are listed separately with canonical facets only, so the public account of what was
  received matches the audited inventory exactly. `scripts/test-source-library.js` proves
  the staged audit, `public_sources` and `public_receipts` cover the same 320 sequences
  exactly once each.

- **The catalogue describes, it never quotes.** All 293 substantive sources are published with
  their material type, language scope, script mix, size, file format, extraction status, rights
  state, corpus role and recommended use — plus the original public URL where one is recorded.
  `lib/public-projection.js` is the boundary: an allowlist of fields with a rule per field, a
  recursive `assertPublicSafe` that every response passes through, and a withheld list that
  never reaches a visitor (absolute and relative paths, checksums, extracted-text pointers, who
  supplied a source, and prose describing what a source *says*).
- **Names are earned, not invented.** A title is published only when the file's own metadata
  carries something that survives `publishableTitle` (no tool banners, paths, extensions, hex
  runs, mojibake, catalogue numbers); 40 of 64 do. Otherwise the entry is named by its material
  type or by one of the seven curated source families, and says so. The PDF author slot holds
  usernames as often as people, so it is published as *attributed to* only when it looks like a
  real multi-word name, with an on-page caveat. Dates are file dates, labelled as such.
- **Consent outranks completeness.** Fieldwork transcripts and elicitation questionnaires can
  identify the people recorded, so they publish no name, title, date, link or family — and
  contribute no word forms at all.
- **The word-form index is protected by attestation, not by obscurity.** A normalised form is
  published only when **at least two independent sources** attest it; a form found in a single
  restricted document is a fact about that document. The index carries forms, counts, source
  counts, script and a confidence label — no sentences, no context, no line references.
  Bibliographic metadata (`private_reference_index`) is excluded from tokenisation, so author
  surnames and title words are never published as if they were Lak vocabulary.
- **Rights are visible while unresolved.** Three sources look like they may be out of copyright.
  "Looks like" is not a clearance, so they sit in a public review queue with their text
  unpublished.
- **Derivation is resumable and additive.** `lib/public-derivation.js` runs four stages
  (`sources`, `tallies`, `forms`, `finalize`) keyed by the manifest digest plus a derivation
  version, committing progress as it goes so an autoscale instance that is suspended mid-run
  continues instead of restarting. Changing the input or the version discards and rebuilds.
- **Both surfaces are wired into search.** `/api/corpus/search` returns matching sources and
  word forms alongside the corpus rows, so one query reaches everything the project holds.

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
| GET | `/api/source-library` | Public source catalogue (faceted, paginated) |
| GET | `/api/source-library/facets` | Counted filter options |
| GET | `/api/source-library/review-queue` | Sources awaiting a rights decision |
| GET | `/api/source-library/:ref` | One source with its duplicate siblings |
| GET | `/api/word-forms` | Derived Lak word-form index (2+ sources per form) |

When v2 is explicitly enabled after a reconciled import:

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/corpus/v2/status` | Import readiness and public source policy |
| GET | `/api/corpus/v2/facets` | Source tag, POS, and feature facets |
| GET | `/api/corpus/v2/search?mode=wordform\|lemma\|grammar&q=` | Exact morphology search |
| GET | `/api/corpus/v2/lemmas/:id` | Lemma and attested forms |
| GET | `/api/corpus/v2/wordforms/:id` | Wordform occurrence summary |
| GET | `/api/morphology/proposals` | Authenticated proposal queue |
| GET | `/api/morphology/proposals/:id` | Authenticated evidence and contexts |
| POST | `/api/morphology/proposals/:id/adjudicate` | Expert-only structured decision |

## User preferences

- Do not publish until the user reviews the working preview.
- Keep Uslar 1890 OCR text verbatim — no silent modernisation.
- Do not run the production importer or publish until the user reviews the
  working preview and the production database is backed up.
