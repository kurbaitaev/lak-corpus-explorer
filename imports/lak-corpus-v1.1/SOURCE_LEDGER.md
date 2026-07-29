# Source ledger

| Source | Extracted result | Status | Required next action |
|---|---:|---|---|
| Gadzhiyev 1958 Russian–Lak dictionary HTML | 14,373 entries; 14,163 unique Russian headwords | Source import, unreviewed | Confirm bibliographic record and sampling with a Lak expert |
| `Lak_texts_done.rar` | 77 documents; 45,488 candidate sentences | Private research, permission pending | Resolve two metadata mismatches; confirm permission before unrestricted publication |
| Quba free narratives ZIP | 29 archive rows | Audio inventory only | Confirm speaker consent, language labels, metadata, and duplicates |
| Pear Stories Kuba ZIP | 24 archive rows, 12 duplicated pairs | Audio inventory only | Retain one canonical copy per media signature; verify speakers and consent |
| Lak Wikipedia dump | Compared with corpus v0.1 | Audit only | Review 1,590 old-only candidates before any import |
| Tolstoy in Lak (1982) PDF | Five-page OCR pilot | OCR candidate only | Tune Lak OCR and manually correct before indexing |
| Lak folk tales (1989) PDF | Five-page OCR pilot | OCR candidate only | Tune Lak OCR and manually correct before indexing |
| Daniel et al. OCR paper | Preserved and hashed | Research reference | Extract method recommendations for the OCR workstream |

## Known mismatches

- Text exists without metadata: `qusajnajev_aramtural_kuntil`.
- Metadata exists without a matching text file: `aghaev_pad_xaji`.
- The historical Common Voice report claimed 1,011 lines; the inspected file has 1,002.
- Tesseract Russian OCR confuses Lak palochka and similar glyphs. Pilot text is not corpus-ready.
- Audio language labels are filename-derived guesses, not linguistic verification.

## Integrity

`processed/source_manifest.json` records the absolute original path, byte size, and SHA-256
hash for eight preserved source files. `scripts/test_v11.py` recomputes every hash in chunks
and verifies the generated package.

