'use strict';

// Reviewed translation memory, evidence typing, and benchmark isolation.
//
// This module is the SINGLE place that decides:
//   1. which stored pairs qualify as GOLD evidence (reviewed translation
//      memory: expert-approved AND rights-eligible AND public AND not held out),
//   2. what each evidence row is allowed to do — propose a translation, or
//      only support usage,
//   3. what may never be seen by retrieval, a public answer, or an export
//      (anything that duplicates a held-out benchmark item).
//
// Everything else (retriever, provider, routes) asks this module instead of
// re-implementing the rules, so the guarantees cannot drift per caller.

// ── 1. The gold-evidence rule ────────────────────────────────
//
// A pair is reviewed translation memory only when ALL of these hold. Anything
// pending, under review, rejected, withdrawn, private, restricted, permission-
// pending, unknown-rights, synthetic, abstained, or held out in the test split
// is NOT gold and can never be served as proof of a translation.
const GOLD_STATUS = 'approved';
const GOLD_RIGHTS = ['public_domain', 'cc_by', 'cc_by_sa'];
const GOLD_PROVENANCE = ['human', 'human_from_evidence'];
const GOLD_SPLITS = ['train', 'dev'];

// SQL form of the same rule (used for the memory lookup query).
const GOLD_PAIR_SQL = `
      status = 'approved'
  AND NOT is_private
  AND access_status = 'public'
  AND rights_status IN ('public_domain','cc_by','cc_by_sa')
  AND provenance IN ('human','human_from_evidence')
  AND NOT abstained
  AND split IN ('train','dev')`;

// JS form, so the same rule can be asserted on an in-memory row.
function isGoldPair(row) {
  if (!row) return false;
  return row.status === GOLD_STATUS
    && row.is_private === false
    && row.access_status === 'public'
    && GOLD_RIGHTS.includes(row.rights_status)
    && GOLD_PROVENANCE.includes(row.provenance)
    && row.abstained !== true
    && GOLD_SPLITS.includes(row.split);
}

const GOLD_POLICY = {
  description: 'Reviewed translation memory: only expert-approved, rights-eligible, ' +
    'public pairs may be served as gold evidence.',
  requires: {
    status: GOLD_STATUS,
    access_status: 'public',
    rights_status: GOLD_RIGHTS,
    provenance: GOLD_PROVENANCE,
    split: GOLD_SPLITS,
    abstained: false,
    is_private: false,
  },
  never_gold: [
    'pending / under_review / rejected / withdrawn pairs',
    'private, restricted, permission_pending or withdrawn access',
    'unknown or restricted rights',
    'synthetic provenance',
    'the held-out test split',
    'private v1.2 / v1.3 research candidates (they stay candidates)',
    'monolingual corpus usage',
  ],
};

// ── 2. Evidence typing ───────────────────────────────────────
//
// Four classes. Only the first three may propose a translation; the fourth can
// support usage but is never proof of a translation.
const EVIDENCE_CLASSES = {
  approved_parallel_pair: {
    can_propose: true,
    gold: true,
    review_state: 'expert_approved',
    label: 'Approved parallel pair (reviewed translation memory)',
  },
  direct_dictionary: {
    can_propose: true,
    gold: false,
    review_state: 'published_source',
    label: 'Direct dictionary entry',
  },
  attested_public_example: {
    can_propose: true,
    gold: false,
    review_state: 'published_source',
    label: 'Attested public corpus example carrying both sides',
  },
  usage_support_only: {
    can_propose: false,
    gold: false,
    review_state: 'unreviewed_usage',
    label: 'Monolingual usage — supports context, never proves a translation',
  },
};

// Raw retrieval/memory evidence_type → class.
const TYPE_TO_CLASS = {
  approved_parallel_pair: 'approved_parallel_pair',
  validated_parallel: 'approved_parallel_pair',
  dictionary_sense: 'direct_dictionary',
  alias: 'direct_dictionary',
  attested_public_example: 'attested_public_example',
  corpus_example: 'usage_support_only',
  monolingual_example: 'usage_support_only',
};

// Class of one evidence row. An "attested public example" only keeps that class
// when the record actually carries BOTH sides; a one-sided example is
// monolingual usage and is downgraded, so it can never propose a translation.
function classOf(e) {
  if (!e) return 'usage_support_only';
  const cls = TYPE_TO_CLASS[e.evidence_type] || 'usage_support_only';
  if (cls === 'attested_public_example') {
    const bothSides = !!(e.lak_text && String(e.lak_text).trim()) &&
                      !!(e.gloss && String(e.gloss).trim());
    return bothSides ? cls : 'usage_support_only';
  }
  return cls;
}

function canPropose(e) {
  return EVIDENCE_CLASSES[classOf(e)].can_propose === true;
}

// Gold status is NOT taken from the evidence_type alone: a row only counts as
// gold when it came from the memory layer and was marked there.
function isGoldEvidence(e) {
  return !!(e && e.gold_eligible === true && classOf(e) === 'approved_parallel_pair');
}

// Attach class, review state and gold flag to a raw evidence row.
function annotate(e) {
  const cls = classOf(e);
  const meta = EVIDENCE_CLASSES[cls];
  return {
    ...e,
    evidence_class: cls,
    can_propose: meta.can_propose,
    review_state: e.review_state || meta.review_state,
    gold_eligible: e.gold_eligible === true && meta.gold === true,
  };
}

// ── 3. Benchmark isolation ───────────────────────────────────
//
// Held-out benchmark items live only in `benchmark_items`; they are never part
// of the corpus. This guard is the one enforcement point that also keeps any
// *other* record that duplicates a held-out item out of retrieval, public
// answers and exports, so a contaminated pair cannot leak the answer either.
function createBenchmarkIsolation({ pool, norm, ttlMs = 3000 }) {
  const key = t => norm(String(t == null ? '' : t)).replace(/\s+/g, ' ').trim();
  let cached = null;
  let loadedAt = 0;
  let inflight = null;

  async function load() {
    const r = await pool.query('SELECT source_text, reference_text FROM benchmark_items');
    const sources = new Set();
    const references = new Set();
    const pairs = new Set();
    for (const row of r.rows) {
      const s = key(row.source_text);
      const ref = key(row.reference_text);
      if (s) sources.add(s);
      if (ref) references.add(ref);
      if (s && ref) pairs.add(s + '\u0000' + ref);
    }
    return { sources, references, pairs, item_count: r.rows.length };
  }

  async function snapshot() {
    const now = Date.now();
    if (cached && now - loadedAt < ttlMs) return cached;
    if (!inflight) {
      inflight = load().then(snap => {
        cached = snap; loadedAt = Date.now(); inflight = null; return snap;
      }).catch(err => { inflight = null; throw err; });
    }
    return inflight;
  }

  function invalidate() { cached = null; loadedAt = 0; }

  // Any text that is a held-out reference (the answer) is blocked. A held-out
  // *source* is the query itself, so it is not blocked as text — blocking it
  // would make evaluation impossible without protecting anything.
  function isHeldOutAnswer(snap, text) {
    const k = key(text);
    return !!k && snap.references.has(k);
  }

  // Drop evidence that would reveal a held-out answer.
  function filterEvidence(snap, evidence) {
    const kept = [];
    let dropped = 0;
    for (const e of evidence) {
      if (isHeldOutAnswer(snap, e.lak_text) || isHeldOutAnswer(snap, e.gloss)) { dropped += 1; continue; }
      kept.push(e);
    }
    return { kept, dropped };
  }

  // Drop stored pairs that duplicate a held-out item (either side, or the whole
  // pair). Used for memory lookups AND every export surface.
  function filterPairs(snap, rows) {
    const kept = [];
    let dropped = 0;
    for (const row of rows) {
      const ru = key(row.ru_text);
      const lak = key(row.lak_text);
      const contaminated =
        snap.references.has(ru) || snap.references.has(lak) ||
        snap.pairs.has(ru + '\u0000' + lak) || snap.pairs.has(lak + '\u0000' + ru);
      if (contaminated) { dropped += 1; continue; }
      kept.push(row);
    }
    return { kept, dropped };
  }

  return { snapshot, invalidate, filterEvidence, filterPairs, isHeldOutAnswer, key };
}

// ── 4. The translation-memory layer ──────────────────────────
function createTranslationMemory({ pool, norm, isolation, ttlMs = 3000 }) {
  const key = t => norm(String(t == null ? '' : t)).replace(/\s+/g, ' ').trim();
  let cached = null;
  let loadedAt = 0;
  let inflight = null;

  async function load() {
    const r = await pool.query(
      `SELECT id, direction, ru_text, lak_text, literal_target, natural_target,
              variety, orthography, split, provenance, source_type, source_provenance,
              rights_status, access_status, status, is_private, abstained,
              approved_by, approved_at, owner_name
         FROM parallel_pairs
        WHERE ${GOLD_PAIR_SQL}
        ORDER BY approved_at DESC NULLS LAST
        LIMIT 5000`);
    // Belt and braces: re-assert the rule in JS on every row we loaded.
    return r.rows.filter(isGoldPair);
  }

  async function snapshot() {
    const now = Date.now();
    if (cached && now - loadedAt < ttlMs) return cached;
    if (!inflight) {
      inflight = load().then(rows => {
        cached = rows; loadedAt = Date.now(); inflight = null; return rows;
      }).catch(err => { inflight = null; throw err; });
    }
    return inflight;
  }

  function invalidate() { cached = null; loadedAt = 0; }

  // Turn a gold pair into an evidence row shaped like corpus evidence, so the
  // provider ranks and quotes it the same way — but carrying its review state.
  function toEvidence(pair, direction) {
    const sourceIsRu = direction === 'ru2lak';
    const target = sourceIsRu ? pair.lak_text : pair.ru_text;
    return annotate({
      evidence_type: 'approved_parallel_pair',
      lak_text: pair.lak_text || '',
      gloss: pair.ru_text || '',
      target,
      source: 'Reviewed translation memory',
      variety: pair.variety || 'standard',
      record_ref: pair.id,
      record_url: '/api/lab/pairs/' + pair.id,
      is_ocr: false,
      validated: true,
      // Ranked above every corpus source: this pair was reviewed by an expert.
      score: 12,
      gold_eligible: true,
      review_state: 'expert_approved',
      rights_status: pair.rights_status,
      access_status: pair.access_status,
      provenance: pair.provenance,
      source_provenance: pair.source_provenance || null,
      split: pair.split,
      approved_by: pair.approved_by || null,
      approved_at: pair.approved_at || null,
    });
  }

  // Gold lookup for one query. Matching is exact on the normalized source side
  // of the pair — a reviewed pair answers the request it was reviewed for.
  async function lookup(direction, query, { limit = 10, snap } = {}) {
    const q = key(query);
    if (!q) return [];
    const rows = await snapshot();
    const isoSnap = snap || (isolation ? await isolation.snapshot() : null);
    const sourceIsRu = direction === 'ru2lak';
    const matched = rows.filter(p => {
      if (p.direction !== direction) return false;
      const src = sourceIsRu ? p.ru_text : p.lak_text;
      return key(src) === q;
    });
    const safe = isoSnap ? isolation.filterPairs(isoSnap, matched).kept : matched;
    return safe.slice(0, limit).map(p => toEvidence(p, direction));
  }

  return { lookup, snapshot, invalidate, toEvidence, policy: GOLD_POLICY };
}

// ── 5. The evidence gate ─────────────────────────────────────
//
// Every path that answers a translation request goes through here: corpus
// retrieval and reviewed memory are combined, then isolation is applied ONCE.
// Callers never touch the retriever directly.
function createEvidenceGate({ pool, retriever, norm }) {
  const isolation = createBenchmarkIsolation({ pool, norm });
  const memory = createTranslationMemory({ pool, norm, isolation });

  async function gather(direction, query, { limit = 25 } = {}) {
    const snap = await isolation.snapshot();
    const [gold, corpus] = await Promise.all([
      memory.lookup(direction, query, { limit: 10, snap }),
      Promise.resolve(retriever.retrieve(direction, query, { limit })),
    ]);

    const corpusEvidence = (corpus.evidence || []).map(annotate);
    const combined = [...gold, ...corpusEvidence];
    const { kept, dropped } = isolation.filterEvidence(snap, combined);

    // Reviewed memory first, then corpus evidence in its own ranked order.
    kept.sort((a, b) => {
      const g = (isGoldEvidence(b) ? 1 : 0) - (isGoldEvidence(a) ? 1 : 0);
      if (g !== 0) return g;
      const p = (b.can_propose ? 1 : 0) - (a.can_propose ? 1 : 0);
      if (p !== 0) return p;
      return (b.score || 0) - (a.score || 0);
    });

    // Senses shown on the card: reviewed targets first, then corpus senses,
    // with the corpus split (modern vs OCR) preserved.
    const goldSenses = [];
    for (const e of kept) {
      if (!isGoldEvidence(e)) continue;
      const t = direction === 'lak2ru' ? e.gloss : e.lak_text;
      if (t && !goldSenses.includes(t)) goldSenses.push(t);
    }
    const senses = [...goldSenses];
    for (const s of corpus.senses || []) if (!senses.includes(s)) senses.push(s);

    return {
      evidence: kept.slice(0, limit + gold.length),
      senses: senses.slice(0, 8),
      ocrSenses: corpus.ocrSenses || [],
      aliases: corpus.aliases || [],
      gold_count: kept.filter(isGoldEvidence).length,
      isolation: {
        enforced: true,
        held_out_items: snap.item_count,
        evidence_withheld: dropped,
        note: 'Held-out benchmark items, and any record duplicating one, are ' +
              'removed before any answer, ranking or export is produced.',
      },
    };
  }

  // Filter stored pairs (exports, dataset card) through the same guard.
  async function safePairs(rows) {
    const snap = await isolation.snapshot();
    return isolation.filterPairs(snap, rows);
  }

  function invalidate() { isolation.invalidate(); memory.invalidate(); }

  return { gather, safePairs, invalidate, memory, isolation };
}

module.exports = {
  GOLD_PAIR_SQL, GOLD_POLICY, GOLD_RIGHTS, GOLD_SPLITS, GOLD_PROVENANCE,
  EVIDENCE_CLASSES, TYPE_TO_CLASS,
  isGoldPair, classOf, canPropose, isGoldEvidence, annotate,
  createBenchmarkIsolation, createTranslationMemory, createEvidenceGate,
};
