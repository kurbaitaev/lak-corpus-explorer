'use strict';

// Public evidence for one search result.
//
// A search hit on its own says "this record contains your query". It does not
// say what the record means, or what backs that meaning. This module answers
// the second question for the public site, using the SAME evidence contract as
// the Translation Lab (lib/lab-memory.js):
//
//   approved_parallel_pair  — a reviewed pair from translation memory
//   attested_public_example — a public corpus record carrying both sides
//   direct_dictionary       — a published dictionary sense
//   usage_support_only      — a public corpus occurrence: context, not proof
//
// Rules that must not drift:
//   * Only PUBLIC corpus records and gold (approved, public, rights-eligible)
//     pairs are ever read. No private candidate, no unapproved pair.
//   * Everything is filtered through benchmark isolation, so a held-out answer
//     can never surface on a result card.
//   * When nothing qualifies, the answer is an explicit "not enough evidence"
//     — never a guess and never silence.

const labMemory = require('./lab-memory');

const OCR_SOURCE = 'Uslar 1890';
const MAX_TEXT = 240;
const MAX_RECORDS = 60;

// Ranking weights. Reviewed memory outranks published sources, which outrank
// bare usage; unreviewed OCR is always pushed below its reviewed equivalents.
const SCORES = {
  approved_parallel_pair: 12,
  attested_public_example: 8,
  direct_dictionary: 6,
  usage_support_only: 3,
};

const clip = value => {
  const text = String(value == null ? '' : value).trim();
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT - 1) + '…' : text;
};

function createPublicEvidence({ corpusData, norm, tokenize, gate }) {
  const key = text => norm(String(text == null ? '' : text)).replace(/\s+/g, ' ').trim();

  // ── Indexes (built once, on first use) ───────────────────────
  // Linear scans per result row would be ~1M string normalisations per page.
  let index = null;
  function build() {
    if (index) return index;
    const byId = new Map();
    const lexiconByForm = new Map();
    const textByToken = new Map();
    const EXAMPLES_PER_TOKEN = 12;

    corpusData.forEach((row, position) => {
      const recordId = row[5];
      if (recordId && !byId.has(recordId)) byId.set(recordId, { row, position });

      if (row[0] === 'lexicon') {
        if (!row[2]) return;
        const form = key(row[1]);
        if (!form) return;
        const bucket = lexiconByForm.get(form);
        if (bucket) { if (bucket.length < 6) bucket.push(row); }
        else lexiconByForm.set(form, [row]);
        return;
      }
      for (const token of new Set(tokenize(row[1]))) {
        const bucket = textByToken.get(token);
        if (bucket) { if (bucket.length < EXAMPLES_PER_TOKEN) bucket.push(row); }
        else textByToken.set(token, [row]);
      }
    });

    index = { byId, lexiconByForm, textByToken };
    return index;
  }

  // A corpus record that carries both sides is an attested phrase pair when its
  // Lak side is a phrase, and a dictionary sense when it is a single headword.
  const pairType = lak => (/\s/.test(String(lak).trim()) ? 'attested_public_example' : 'dictionary_sense');

  function fromCorpus(row, evidenceType, overrides = {}) {
    return {
      evidence_type: evidenceType,
      lak_text: overrides.lak_text || row[1] || '',
      gloss: overrides.gloss || row[2] || '',
      source: row[3] || '',
      variety: row[4] || '',
      record_ref: row[5] || '',
      record_url: row[6] || '',
      is_ocr: row[3] === OCR_SOURCE,
    };
  }

  // Public projection: exactly the fields a card may show.
  function project(evidence) {
    return {
      evidence_class: evidence.evidence_class,
      review_state: evidence.review_state,
      can_propose: evidence.can_propose === true,
      gold: labMemory.isGoldEvidence(evidence),
      is_ocr: evidence.is_ocr === true,
      source: clip(evidence.source),
      variety: evidence.variety ? String(evidence.variety) : '',
      lak_text: clip(evidence.lak_text),
      gloss: clip(evidence.gloss),
      record_ref: evidence.record_ref == null ? '' : String(evidence.record_ref),
      record_url: evidence.record_url ? String(evidence.record_url) : '',
    };
  }

  // ── One record's evidence bundle ─────────────────────────────
  async function bundleFor(entry, { aliasForms, snap }) {
    const { row } = entry;
    const { lexiconByForm, textByToken } = build();
    const lak = row[1] || '';
    const raw = [];
    const seen = new Set();
    const push = evidence => {
      const id = evidence.evidence_type + '\u0000' + key(evidence.lak_text) + '\u0000' + key(evidence.gloss);
      if (seen.has(id)) return;
      seen.add(id);
      raw.push(evidence);
    };

    // 1. Reviewed translation memory (gold) for this exact Lak text.
    let gold = [];
    try { gold = await gate.memory.lookup('lak2ru', lak, { limit: 2, snap }); }
    catch { gold = []; }
    for (const pair of gold) push(pair);

    // 2. The record's own published translation, when it carries one.
    if (row[0] === 'lexicon' && row[2]) push(fromCorpus(row, pairType(lak)));
    if (row[8]) push(fromCorpus(row, 'attested_public_example', {
      lak_text: row[7] || row[1],
      gloss: row[8],
    }));

    // 3. Published entries elsewhere in the corpus for the same form, and for
    //    the query's Lak forms when the query was alias-expanded.
    const forms = new Set([key(lak), ...(aliasForms || [])]);
    for (const form of forms) {
      if (!form) continue;
      for (const other of lexiconByForm.get(form) || []) {
        if (other[5] === row[5]) continue;
        push(fromCorpus(other, pairType(other[1])));
      }
    }

    // 4. Related public corpus occurrences (context only, never proof).
    const exampleForms = row[0] === 'lexicon' ? [key(lak), ...(aliasForms || [])] : (aliasForms || []);
    let examples = 0;
    for (const form of exampleForms) {
      if (!form || examples >= 2) break;
      for (const other of textByToken.get(form) || []) {
        if (other[5] === row[5] || examples >= 2) continue;
        push(fromCorpus(other, 'corpus_example'));
        examples += 1;
      }
    }

    // Class the rows, then apply benchmark isolation once.
    const annotated = raw.map(labMemory.annotate);
    const { kept } = gate.isolation.filterEvidence(snap, annotated);

    kept.sort((a, b) => {
      const g = (labMemory.isGoldEvidence(b) ? 1 : 0) - (labMemory.isGoldEvidence(a) ? 1 : 0);
      if (g !== 0) return g;
      const p = (b.can_propose ? 1 : 0) - (a.can_propose ? 1 : 0);
      if (p !== 0) return p;
      const ocr = (a.is_ocr ? 1 : 0) - (b.is_ocr ? 1 : 0);
      if (ocr !== 0) return ocr;
      return (SCORES[b.evidence_class] || 0) - (SCORES[a.evidence_class] || 0);
    });

    const evidence = kept.slice(0, 4).map(project);
    const best = evidence[0] || null;
    const confidence = !best ? 'none'
      : best.gold ? 'high'
      : best.can_propose && !best.is_ocr ? 'medium'
      : 'low';

    return {
      status: evidence.length ? 'ok' : 'not_enough_evidence',
      confidence,
      review_state: best ? best.review_state : 'no_public_evidence',
      evidence,
    };
  }

  // ── Bulk lookup for one page of results ──────────────────────
  // `aliasForms` are the Lak forms the query expanded to, so a Russian query
  // can be explained through the dictionary entry that produced the hit.
  async function forRecords(recordIds, { aliasForms = [] } = {}) {
    const { byId } = build();
    const ids = [...new Set((recordIds || []).map(String))].slice(0, MAX_RECORDS);
    const forms = [...new Set(aliasForms.map(form => key(form)).filter(Boolean))];
    const snap = await gate.isolation.snapshot();
    const out = {};
    for (const id of ids) {
      const entry = byId.get(id);
      if (!entry) {
        out[id] = { status: 'not_enough_evidence', confidence: 'none', review_state: 'no_public_evidence', evidence: [] };
        continue;
      }
      out[id] = await bundleFor(entry, { aliasForms: forms, snap });
    }
    return out;
  }

  return { forRecords, MAX_RECORDS };
}

module.exports = { createPublicEvidence, MAX_RECORDS };
