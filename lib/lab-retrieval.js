'use strict';

// Evidence-only retrieval for the Translation Lab.
//
// Corpus rows are the flat tuples produced by scripts/extract-corpus.py:
//   r[0] kind      'text' | 'lexicon'
//   r[1] lak_text  Lak sentence / headword
//   r[2] gloss     translation / sense (may be empty for plain text rows)
//   r[3] source    'PCMLBE' | 'Lak Wikipedia' | 'IDS' | 'Uslar 1890' | ...
//   r[4] variety   'standard' | 'arakul' | ... | 'historical' | 'unspecified'
//   r[5] record_ref
//   r[6] record_url
//
// The retriever NEVER produces novel target text. It only surfaces, ranks and
// classifies existing corpus evidence. A caller (the provider) turns the top
// evidence into a *suggested* target, always attributed to a real record, and
// flags when there is no evidence rather than inventing anything.

const OCR_SOURCE = 'Uslar 1890';
const ALIAS_SOURCE = 'Corpus alias dictionary';

// Sources we treat as modern/validated (ranked above historical OCR).
const VALIDATED_SOURCES = new Set(['IDS', 'PCMLBE', 'Lak Wikipedia', 'Digiev phrasebook']);

// Evidence classes emitted here:
//   dictionary_sense   — a lexicon headword↔gloss pair, or a materialized
//                        alias-dictionary entry (verbatim existing metadata).
//   alias              — a curated/extracted RU→Lak alias-dictionary entry.
//   corpus_example     — attested monolingual usage. NEVER a translation.
// Whether a class may propose a translation is decided in ONE place —
// lib/lab-memory.js — so retrieval, the provider and the routes cannot drift.
const labMemory = require('./lab-memory');

const TRANSLATION_EVIDENCE = new Set(
  Object.keys(labMemory.TYPE_TO_CLASS).filter(
    t => labMemory.EVIDENCE_CLASSES[labMemory.TYPE_TO_CLASS[t]].can_propose));

function isTranslationEvidence(type) {
  return TRANSLATION_EVIDENCE.has(type);
}

function isOcr(source) {
  return source === OCR_SOURCE;
}

// Bounded score so ranking is transparent and stable.
// Alias-dictionary entries and modern validated dictionary senses rank highest;
// attested corpus usage ranks below any translation evidence; OCR lowest.
function scoreRow(r, { exactHeadword, exactAlias, corpusHit }) {
  let s = 0;
  if (r[0] === 'lexicon') s += 4;          // dictionary evidence is strongest
  if (exactHeadword) s += 3;               // exact headword / phrase match
  if (exactAlias) s += 2;                  // matched via curated alias dictionary
  if (corpusHit) s += 1;                   // token appears in a corpus sentence
  if (VALIDATED_SOURCES.has(r[3])) s += 2; // modern, validated source
  if (isOcr(r[3])) s -= 3;                 // historical OCR sinks to the bottom
  return s;
}

// Build a comparable evidence object from a corpus row.
function toEvidence(r, evidenceType, score) {
  return {
    evidence_type: evidenceType,
    lak_text: r[1] || '',
    gloss: r[2] || '',
    source: r[3] || '',
    variety: r[4] || '',
    record_ref: r[5] || '',
    record_url: r[6] || '',
    is_ocr: isOcr(r[3]),
    validated: VALIDATED_SOURCES.has(r[3]),
    score,
  };
}

// Stable evidence id for a materialized alias entry, so the same query yields
// the same identifier across requests (a citation, not a random row).
function aliasEvidenceRef(normQuery, aliasOriginal) {
  const key = `${normQuery}=>${aliasOriginal}`;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 'alias:' + h.toString(36);
}

// Materialize a RU→Lak alias-dictionary entry as verbatim dictionary metadata.
// lak_text holds the ORIGINAL alias string (parenthetical senses preserved
// exactly); this is existing dictionary data, never generated text.
function aliasEvidence(normQuery, aliasOriginal) {
  return {
    evidence_type: 'alias',
    lak_text: aliasOriginal,          // verbatim, un-normalized
    gloss: '',
    source: ALIAS_SOURCE,
    variety: 'standard',
    record_ref: aliasEvidenceRef(normQuery, aliasOriginal),
    record_url: '',
    is_ocr: false,
    validated: true,                  // curated dictionary metadata
    // Strong score: above corpus examples, on par with an exact dictionary hit.
    score: 9,
  };
}

// Factory: bind the loaded corpus + normalisation helpers once.
//   deps: { corpusData, corpusAliases, curatedAliases, norm, tokenHas }
function createRetriever(deps) {
  const {
    corpusData,
    corpusAliases = {},
    curatedAliases = {},
    norm,
    tokenHas,
  } = deps;

  // Original (un-normalized) alias strings for a normalized RU query.
  function aliasesFor(normQuery) {
    return curatedAliases[normQuery] || corpusAliases[normQuery] || [];
  }

  // ── RU → LAK ──────────────────────────────────────────────
  // Given a Russian query, produce translation evidence FIRST:
  //   1. Each exact alias-dictionary entry, materialized verbatim (type 'alias').
  //   2. Exact lexicon dictionary senses (RU gloss equals the query).
  // then attested corpus usage (type 'corpus_example') for context only —
  // corpus sentences are NEVER treated as a translation.
  function retrieveRu2Lak(query, { limit = 25 } = {}) {
    const q = norm(String(query || '').trim());
    if (!q) return { evidence: [], senses: [], ocrSenses: [], aliases: [] };

    const aliasOriginals = aliasesFor(q).filter(a => a && String(a).trim());
    const aliasNorms = aliasOriginals.map(a => norm(a)).filter(Boolean);
    const seen = new Set();
    const out = [];

    // 1. Materialize each alias-dictionary entry verbatim (strong translation
    //    evidence). Parenthetical senses are preserved exactly.
    for (const original of aliasOriginals) {
      const key = 'alias|' + original;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(aliasEvidence(q, original));
    }

    const push = (r, type, extra) => {
      const key = `${r[0]}|${r[5]}|${r[1]}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(toEvidence(r, type, scoreRow(r, extra)));
    };

    // 2/3. Scan corpus for lexicon senses and attested usage.
    for (const r of corpusData) {
      if (r[0] === 'lexicon') {
        const gloss = norm(r[2] || '');
        if (!gloss) continue;
        // Exact dictionary sense: the RU gloss equals the query.
        const exactGloss = gloss === q || tokenHas(r[2], q);
        // Alias-linked lexicon headword (also a real dictionary sense).
        const aliasHit = aliasNorms.length && aliasNorms.some(a => tokenHas(r[1], a));
        if (exactGloss || aliasHit) {
          push(r, 'dictionary_sense', { exactHeadword: exactGloss, exactAlias: aliasHit, corpusHit: false });
        }
      } else if (aliasNorms.length) {
        // Corpus sentence containing an alias form of the query: attested
        // monolingual usage only. It supports context; it is not a translation.
        if (aliasNorms.some(a => tokenHas(r[1], a))) {
          push(r, 'corpus_example', { exactHeadword: false, exactAlias: false, corpusHit: true });
        }
      }
    }

    // Stable sort: translation evidence first, then by score, keeping alias/
    // dictionary rows above corpus examples regardless of raw score.
    out.sort(compareEvidence);

    // Senses split modern vs OCR for card display — only translation evidence.
    const senses = [];
    const ocrSenses = [];
    for (const e of out) {
      if (!isTranslationEvidence(e.evidence_type) || !e.lak_text) continue;
      (e.is_ocr ? ocrSenses : senses).push(e.lak_text);
    }
    return {
      evidence: out.slice(0, limit),
      senses: dedupe(senses).slice(0, 8),
      ocrSenses: dedupe(ocrSenses).slice(0, 8),
      aliases: aliasNorms,
    };
  }

  // ── LAK → RU ──────────────────────────────────────────────
  // Given a Lak query, produce translation evidence FIRST: exact lexicon
  // dictionary senses (headword equals/contains the query → its Russian gloss).
  // Text rows that merely contain the Lak form are attested monolingual usage
  // (type 'corpus_example'); their r[2] field is a TITLE / monolingual content,
  // NOT a translation, so it is never used as a Russian target.
  function retrieveLak2Ru(query, { limit = 25 } = {}) {
    const q = norm(String(query || '').trim());
    if (!q) return { evidence: [], senses: [], ocrSenses: [], aliases: [] };

    const seen = new Set();
    const out = [];
    const push = (r, type, extra) => {
      const key = `${r[0]}|${r[5]}|${r[1]}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(toEvidence(r, type, scoreRow(r, extra)));
    };

    for (const r of corpusData) {
      const lak = r[1] || '';
      if (!lak) continue;
      const exact = norm(lak) === q;
      const tokenHit = tokenHas(lak, q);
      if (!exact && !tokenHit) continue;
      if (r[0] === 'lexicon') {
        if (!r[2]) continue; // need a Russian gloss to be translation evidence
        push(r, 'dictionary_sense', { exactHeadword: exact, exactAlias: false, corpusHit: tokenHit });
      } else {
        // Attested monolingual Lak usage. r[2] is a title/metadata, not a gloss,
        // so corpus_example rows carry no Russian target.
        push(r, 'corpus_example', { exactHeadword: false, exactAlias: false, corpusHit: true });
      }
    }

    out.sort(compareEvidence);

    // Only dictionary senses contribute Russian senses to the card.
    const senses = [];
    const ocrSenses = [];
    for (const e of out) {
      if (e.evidence_type !== 'dictionary_sense' || !e.gloss) continue;
      (e.is_ocr ? ocrSenses : senses).push(e.gloss);
    }
    return {
      evidence: out.slice(0, limit),
      senses: dedupe(senses).slice(0, 8),
      ocrSenses: dedupe(ocrSenses).slice(0, 8),
      aliases: [],
    };
  }

  function retrieve(direction, query, opts) {
    return direction === 'lak2ru'
      ? retrieveLak2Ru(query, opts)
      : retrieveRu2Lak(query, opts);
  }

  return { retrieve, retrieveRu2Lak, retrieveLak2Ru, aliasesFor };
}

// Rank: translation evidence (alias/dictionary/validated_parallel) always
// above attested corpus usage, then by raw score, then by source stability.
function evidenceTier(e) {
  return isTranslationEvidence(e.evidence_type) ? 1 : 0;
}
function compareEvidence(a, b) {
  const t = evidenceTier(b) - evidenceTier(a);
  if (t !== 0) return t;
  return (b.score - a.score);
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

module.exports = {
  createRetriever,
  VALIDATED_SOURCES,
  OCR_SOURCE,
  ALIAS_SOURCE,
  TRANSLATION_EVIDENCE,
  isTranslationEvidence,
  isOcr,
};
