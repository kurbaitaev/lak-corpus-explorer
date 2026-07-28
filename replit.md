# Lak Corpus Explorer

A publicly accessible, source-aware research corpus of the Lak language (лакку маз, ISO 639-3: lbe). Searchable via translation-first Russian→Lak lookup with concordance examples, quality-tracked records, and a persistent human review system.

## Architecture

- **Backend**: Node.js + Express (`server.js`, port 5000)
- **Database**: Replit PostgreSQL — `reviews` table (record_id, state, correction, note, reviewer_name, timestamps)
- **Corpus data**: `public/data/corpus.js` — ~4.5 MB self-contained JS file with `CORPUS_DATA`, `CORPUS_STATS`, `CORPUS_ALIASES` (extracted from original `index.html`)
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
