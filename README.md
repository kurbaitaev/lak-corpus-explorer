# Lak Corpus Explorer

Public deployment of the searchable, source-aware Lak research corpus.

## Setup

The corpus data files (`public/data/corpus-data.json`, `public/data/corpus-meta.json`) are generated and not committed to git. After cloning, build them once from the canonical `index.html` at the project root:

```
python3 scripts/extract-corpus.py
```

The server (`node server.js`) also runs this automatically at startup if the files are missing, and exits with a clear error if they cannot be regenerated.
