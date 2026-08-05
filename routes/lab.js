'use strict';

// Translation Lab API.
//
// Pipeline:
//   1. POST /api/lab/propose  — evidence-only retrieval (no model, never
//      invents target text). Persists a request + proposal + ranked evidence.
//   2. POST /api/lab/pairs    — an authenticated human turns evidence into a
//      RU↔LAK parallel pair (pending).
//   3. PUT  /api/lab/pairs/:id — versioned edits (immutable history).
//   4. POST /api/lab/pairs/:id/reviews — INDEPENDENT peer review
//      (self-review blocked, one per contributor).
//   5. POST /api/lab/pairs/:id/adjudicate — expert sets approved/rejected +
//      split; idempotent points via a unique (pair, version) adjudication row.
//   6. Dataset card + safe exports (approved train/dev only, excluding
//      test/private/pending/withdrawn/synthetic).
//   7. Expert benchmark import template + management.
//
// Reuses the auth/gamification/audit patterns from routes/validation.js.

const express = require('express');
const crypto = require('crypto');
const auth = require('../lib/auth');
const gam = require('../lib/gamification');
const { createRetriever } = require('../lib/lab-retrieval');
const provider = require('../lib/lab-provider');
const labMemory = require('../lib/lab-memory');

const DIRECTIONS = ['ru2lak', 'lak2ru'];
const SPLITS = ['train', 'dev', 'test'];

// Provider identity — surfaced verbatim so the UI/consumers can display the
// exact model/prompt lineage. There is NO generative model key configured.
const PROVIDER_META = {
  provider: 'evidence-only',
  configured: false,        // no model API key is present
  model_version: 'none',    // no model produced any output
  prompt_version: 'evidence-only-v1',
  mode: 'evidence-only',
  banner: 'Model proposal — not verified.',
  privacy: 'No text you translate is sent to any third-party model or API. ' +
    'All suggestions are retrieved verbatim from the local corpus. Requests are ' +
    'stored only to link evidence to any pair you later save; nothing is shared ' +
    'externally and no generative model is invoked.',
};

// Accept the frontend/spec direction aliases and normalise to canonical form.
const DIRECTION_ALIASES = {
  ru2lak: 'ru2lak', lak2ru: 'lak2ru',
  ru_to_lak: 'ru2lak', lak_to_ru: 'lak2ru',
  'ru-lk': 'ru2lak', 'lk-ru': 'lak2ru',
  'ru-lak': 'ru2lak', 'lak-ru': 'lak2ru',
};
function normDirection(d) {
  if (d == null) return null;
  return DIRECTION_ALIASES[String(d).trim().toLowerCase()] || null;
}

// Metadata enums for the added parallel-pair schema fields.
const ORTHOGRAPHIES = ['cyrillic', 'latin', 'arabic', 'other'];
const SOURCE_TYPES = ['human', 'human_from_evidence', 'model_assisted', 'imported', 'other'];
const RIGHTS_STATUSES = ['public_domain', 'cc_by', 'cc_by_sa', 'permission_granted', 'unknown', 'restricted'];
const ACCESS_STATUSES = ['public', 'restricted', 'private', 'permission_pending', 'withdrawn'];
const ERROR_CATEGORIES = [
  'no_reliable_target', 'ambiguous_source', 'dialectal_gap', 'ocr_unreliable',
  'insufficient_evidence', 'out_of_scope', 'other',
];

// Points for lab contributions (confirmed only when an expert approves).
const LAB_POINTS = {
  pairSubmit: 4,       // provisional on submit
  pairApproved: 8,     // confirmed when an expert approves the pair
  review: 3,           // confirmed on submitting an independent review
  adjudication: 6,     // confirmed for the adjudicating expert
  benchmarkItem: 5,    // confirmed for authoring a benchmark item
};

module.exports = function createLabRouter(deps) {
  const { pool, corpusData, corpusAliases, norm, tokenHas } = deps;
  const curatedAliases = deps.curatedAliases || {};
  const router = express.Router();
  const { requireAccount, requireRole, makeRateLimiter } = auth.makeMiddleware(pool);

  const retriever = createRetriever({
    corpusData, corpusAliases, curatedAliases, norm, tokenHas,
  });

  // The ONE gate every answer path goes through: corpus retrieval + reviewed
  // translation memory, with held-out benchmark isolation applied once, here.
  // No route may call `retriever` directly.
  // The server may pass a shared gate so the public result cards and the Lab
  // answer from the same evidence rules and the same caches.
  const gate = deps.gate || labMemory.createEvidenceGate({ pool, retriever, norm });

  const audit = (req, eventType, targetType, targetId, payload) => {
    const id = req.identity || auth.getIdentity(req) || { type: 'system', id: null, name: null };
    return pool.query(
      `INSERT INTO audit_events (actor_type, actor_id, actor_name, event_type, target_type, target_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id.type, id.id || null, id.name || null, eventType, targetType, targetId,
       payload ? JSON.stringify(payload) : null]);
  };

  const clean = (v, max) => (v == null ? null : String(v).slice(0, max));
  const cleanReq = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

  // Rate limits (per-IP, in-memory) mirroring the auth pattern.
  const proposeLimiter = makeRateLimiter(
    parseInt(process.env.LAB_PROPOSE_RATE_MAX || '60', 10), 60 * 1000,
    'Too many translation requests. Please slow down.');
  const writeLimiter = makeRateLimiter(
    parseInt(process.env.LAB_WRITE_RATE_MAX || '40', 10), 60 * 1000,
    'Too many submissions. Please slow down.');

  // ══ Provider metadata ═════════════════════════════════════════
  // Public: lets the UI show the honest "not verified" banner and lineage,
  // and the privacy statement (nothing is sent to any external model).
  router.get('/api/lab/provider', (req, res) => {
    res.json({ ...PROVIDER_META });
  });

  // ══ 1. Evidence-only propose ══════════════════════════════════
  router.post('/api/lab/propose', proposeLimiter, async (req, res) => {
    try {
      const body = req.body || {};
      const direction = normDirection(body.direction);
      if (!direction)
        return res.status(400).json({
          error: `direction must be one of: ${DIRECTIONS.join(', ')} ` +
                 `(aliases ru_to_lak/lak_to_ru, ru-lk/lk-ru accepted)` });
      // Accept both source_text (spec/frontend) and text (legacy).
      const source = cleanReq(body.source_text != null ? body.source_text : body.text, 2000);
      if (!source) return res.status(400).json({ error: 'Text to translate is required.' });

      const identity = auth.getIdentity(req);
      const requestedBy = identity && identity.type === 'account' ? identity.id : null;

      const retrieval = await gate.gather(direction, source, { limit: 25 });
      const p = provider.propose(direction, retrieval);

      const requestId = 'lreq_' + crypto.randomUUID();
      const proposalId = 'lprop_' + crypto.randomUUID();

      await pool.query(
        `INSERT INTO translation_requests (id, direction, source_text, source_norm, requested_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [requestId, direction, source, norm(source), requestedBy]);
      await pool.query(
        `INSERT INTO translation_proposals
           (id, request_id, provider, evidence_only, classification, suggested_target,
            alternatives, unknowns, coverage, model_version, prompt_version, confidence, rationale,
            evidence_type, evidence_class, review_state, gold_used, abstained, abstain_reason, certainty)
         VALUES ($1,$2,$3,TRUE,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [proposalId, requestId, p.provider, p.classification, p.suggested_target,
         JSON.stringify(p.alternatives), JSON.stringify(p.unknowns), JSON.stringify(p.coverage),
         p.model_version, p.prompt_version, p.confidence, p.rationale,
         p.evidence_type, p.evidence_class, p.review_state, p.gold,
         p.abstained, p.abstain.reason, p.certainty]);

      // Persist ranked evidence (bounded to what we returned).
      let rank = 0;
      for (const e of p.evidence) {
        rank += 1;
        await pool.query(
          `INSERT INTO proposal_evidence
             (proposal_id, rank, evidence_type, lak_text, gloss, source, variety,
              record_ref, record_url, is_ocr, validated, score,
              evidence_class, review_state, gold_eligible)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [proposalId, rank, e.evidence_type, e.lak_text || null, e.gloss || null,
           e.source || null, e.variety || null, e.record_ref || null,
           e.record_url || null, e.is_ocr, e.validated, e.score,
           e.evidence_class || labMemory.classOf(e), e.review_state || null,
           e.gold_eligible === true]);
      }

      // Attach evidence ids so a saved pair can cite exactly what it drew from.
      const evRows = await pool.query(
        `SELECT id, rank FROM proposal_evidence WHERE proposal_id=$1 ORDER BY rank`, [proposalId]);

      res.json({
        request_id: requestId,
        proposal_id: proposalId,
        direction,
        mode: p.mode,
        evidence_only: true,
        provider: p.provider,
        configured: PROVIDER_META.configured,
        banner: PROVIDER_META.banner,
        model_version: p.model_version,
        prompt_version: p.prompt_version,
        classification: p.classification,
        confidence: p.confidence,
        abstained: p.abstained,
        abstain: p.abstain,
        certainty: p.certainty,
        evidence_type: p.evidence_type,
        evidence_class: p.evidence_class,
        review_state: p.review_state,
        gold: p.gold,
        provenance: p.provenance,
        claim: p.claim,
        isolation: p.isolation,
        fine_tuned: false,
        suggested_target: p.suggested_target,
        literal_target: p.literal_target,
        natural_target: p.natural_target,
        alternatives: p.alternatives,
        unknowns: p.unknowns,
        coverage: p.coverage,
        rationale: p.rationale,
        disclaimer: p.disclaimer,
        senses: p.senses,
        ocrSenses: p.ocrSenses,
        aliases: p.aliases,
        evidence: p.evidence.map((e, i) => ({ ...e, evidence_id: evRows.rows[i] ? evRows.rows[i].id : null })),
      });
    } catch (err) {
      console.error('lab/propose:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Fetch a stored proposal + its evidence (for review/edit UIs).
  router.get('/api/lab/proposals/:id', async (req, res) => {
    const pr = await pool.query(
      `SELECT p.*, r.direction, r.source_text
         FROM translation_proposals p JOIN translation_requests r ON r.id = p.request_id
        WHERE p.id = $1`, [req.params.id]);
    if (!pr.rows[0]) return res.status(404).json({ error: 'Proposal not found.' });
    const ev = await pool.query(
      `SELECT rank, evidence_type, evidence_class, review_state, gold_eligible,
              lak_text, gloss, source, variety,
              record_ref, record_url, is_ocr, validated, score
         FROM proposal_evidence WHERE proposal_id = $1 ORDER BY rank`, [req.params.id]);
    res.json({ proposal: pr.rows[0], evidence: ev.rows });
  });

  // ══ Reviewed translation memory ═══════════════════════════════
  // Read-only view of the gold layer. Only expert-approved, rights-eligible,
  // public, non-held-out pairs can appear here — nothing pending, private or
  // unreviewed, and never a private v1.2/v1.3 research candidate.
  router.get('/api/lab/memory', async (req, res) => {
    try {
      const direction = normDirection(req.query.direction);
      const q = cleanReq(req.query.q, 2000);
      const policy = {
        ...labMemory.GOLD_POLICY,
        monolingual_rule: 'Monolingual examples may support usage but can never ' +
          'be presented as proof of a translation.',
      };
      if (!q) {
        const all = await gate.memory.snapshot();
        return res.json({
          policy,
          query: null,
          entries: [],
          gold_total: all.length,
        });
      }
      if (!direction)
        return res.status(400).json({ error: `direction must be one of: ${DIRECTIONS.join(', ')}` });
      const entries = await gate.memory.lookup(direction, q, { limit: 20 });
      res.json({
        policy,
        query: q,
        direction,
        gold_count: entries.length,
        entries: entries.map(e => ({
          record_ref: e.record_ref,
          record_url: e.record_url,
          direction,
          source_text: direction === 'ru2lak' ? e.gloss : e.lak_text,
          target_text: direction === 'ru2lak' ? e.lak_text : e.gloss,
          evidence_type: e.evidence_type,
          evidence_class: e.evidence_class,
          review_state: e.review_state,
          gold: true,
          rights_status: e.rights_status,
          access_status: e.access_status,
          provenance: e.provenance,
          variety: e.variety,
          approved_by: e.approved_by,
          approved_at: e.approved_at,
        })),
      });
    } catch (err) {
      console.error('lab/memory:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ══ 2. Submit a parallel pair ═════════════════════════════════
  // Map a pair row to the frontend shape. The stored source/target depend on
  // direction: for ru2lak the source is Russian and the target is Lak; for
  // lak2ru the source is Lak and the target is Russian. ru_text/lak_text are
  // preserved for backward compatibility alongside source_text/target_*.
  const pairPublic = (row) => {
    const sourceIsRu = row.direction === 'ru2lak';
    const source_text = sourceIsRu ? row.ru_text : row.lak_text;
    const target = sourceIsRu ? row.lak_text : row.ru_text;
    return {
      id: row.id, direction: row.direction,
      // frontend field names
      source_text,
      target_literal: row.literal_target != null ? row.literal_target : target,
      target_natural: row.natural_target != null ? row.natural_target : target,
      current_version: row.head_version,
      contributor_name: row.owner_name,
      // backward-compatible field names
      ru_text: row.ru_text, lak_text: row.lak_text,
      variety: row.variety, notes: row.notes, provenance: row.provenance,
      status: row.status, split: row.split, is_private: row.is_private,
      head_version: row.head_version, owner_id: row.owner_id, owner_name: row.owner_name,
      approved_by: row.approved_by, approved_at: row.approved_at,
      // added metadata
      metadata: {
        orthography: row.orthography,
        source_type: row.source_type,
        source_provenance: row.source_provenance,
        rights_status: row.rights_status,
        access_status: row.access_status,
        evidence_ids: row.evidence_ids || [],
        abstained: row.abstained,
        error_category: row.error_category,
      },
      created_at: row.created_at, updated_at: row.updated_at,
    };
  };

  router.post('/api/lab/pairs', requireAccount, writeLimiter, async (req, res) => {
    try {
      const body = req.body || {};
      const direction = normDirection(body.direction);
      if (!direction)
        return res.status(400).json({ error: `direction must be one of: ${DIRECTIONS.join(', ')}` });

      // Frontend supplies source_text + target_literal / target_natural, plus
      // metadata. Legacy callers may still send ru_text/lak_text directly.
      const sourceIsRu = direction === 'ru2lak';
      const source = cleanReq(body.source_text, 2000);
      const targetLiteral = cleanReq(body.target_literal, 2000);
      const targetNatural = cleanReq(body.target_natural, 2000);
      const abstained = body.abstained === true || body.abstained === 'true';
      const errorCategory = clean(body.error_category, 60);

      // Abstention: no target text required, but a category MUST justify why.
      if (abstained) {
        if (!errorCategory)
          return res.status(400).json({ error: 'When abstaining, an error_category is required to explain why no target was produced.' });
        if (!ERROR_CATEGORIES.includes(errorCategory))
          return res.status(400).json({ error: `error_category must be one of: ${ERROR_CATEGORIES.join(', ')}` });
      }

      // Resolve ru/lak from direction + provided fields. Prefer explicit legacy
      // ru_text/lak_text if given; otherwise derive from source/target.
      const legacyRu = body.ru_text != null ? cleanReq(body.ru_text, 2000) : null;
      const legacyLak = body.lak_text != null ? cleanReq(body.lak_text, 2000) : null;
      // The "primary" target used for ru/lak columns: natural if present, else literal.
      const primaryTarget = targetNatural || targetLiteral;

      let ru, lak;
      if (legacyRu != null || legacyLak != null) {
        ru = legacyRu || (sourceIsRu ? source : primaryTarget);
        lak = legacyLak || (sourceIsRu ? primaryTarget : source);
      } else {
        ru = sourceIsRu ? source : primaryTarget;
        lak = sourceIsRu ? primaryTarget : source;
      }

      if (!abstained && (!ru || !lak))
        return res.status(400).json({ error: 'Both source and target text are required (or set abstained with an error_category).' });
      if (abstained) {
        // Keep NOT NULL columns satisfied while marking the pair as abstained.
        ru = ru || (sourceIsRu ? source : '');
        lak = lak || (sourceIsRu ? '' : source);
        if (!ru && !lak) ru = source || '(abstained)';
      }

      // Validate optional links exist.
      if (body.request_id) {
        const q = await pool.query('SELECT 1 FROM translation_requests WHERE id=$1', [String(body.request_id)]);
        if (!q.rows[0]) return res.status(400).json({ error: 'Unknown request_id.' });
      }
      if (body.proposal_id) {
        const q = await pool.query('SELECT 1 FROM translation_proposals WHERE id=$1', [String(body.proposal_id)]);
        if (!q.rows[0]) return res.status(400).json({ error: 'Unknown proposal_id.' });
      }

      // Metadata with validated enums (invalid values fall back to safe defaults).
      const orthography = ORTHOGRAPHIES.includes(body.orthography) ? body.orthography : 'cyrillic';
      const sourceType = SOURCE_TYPES.includes(body.source_type) ? body.source_type : 'human';
      const rightsStatus = RIGHTS_STATUSES.includes(body.rights_status) ? body.rights_status : 'unknown';
      // Fail closed: omitted/invalid access metadata must never become public.
      const accessStatus = ACCESS_STATUSES.includes(body.access_status) ? body.access_status : 'private';
      // Anything not explicitly public is stored private (kept out of exports).
      const isPrivate = accessStatus !== 'public';
      const evidenceIds = Array.isArray(body.evidence_ids)
        ? body.evidence_ids.slice(0, 100).map(x => String(x).slice(0, 100)) : [];
      const provenance = (body.provenance === 'synthetic') ? 'synthetic'
        : (body.from_evidence || sourceType === 'human_from_evidence' || evidenceIds.length)
          ? 'human_from_evidence' : 'human';
      const sourceProvenance = clean(body.source_provenance, 500);

      const id = 'lpair_' + crypto.randomUUID();
      const cleanVariety = cleanReq(body.variety, 40) || 'standard';
      const cleanNotes = clean(body.notes, 1000);
      const litCol = targetLiteral || null;
      const natCol = targetNatural || null;

      const r = await pool.query(
        `INSERT INTO parallel_pairs
           (id, request_id, proposal_id, direction, ru_text, lak_text,
            literal_target, natural_target, variety, orthography, source_type,
            source_provenance, rights_status, access_status, evidence_ids,
            abstained, error_category, notes, provenance, status, head_version,
            is_private, owner_id, owner_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'pending',1,$20,$21,$22)
         RETURNING *`,
        [id, body.request_id || null, body.proposal_id || null, direction, ru, lak,
         litCol, natCol, cleanVariety, orthography, sourceType,
         sourceProvenance, rightsStatus, accessStatus, JSON.stringify(evidenceIds),
         abstained, errorCategory, cleanNotes, provenance,
         isPrivate, req.identity.id, req.identity.name]);

      await pool.query(
        `INSERT INTO parallel_pair_versions
           (pair_id, version, ru_text, lak_text, literal_target, natural_target,
            variety, orthography, notes, edited_by, edited_by_name, edit_summary)
         VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Initial submission')`,
        [id, ru, lak, litCol, natCol, cleanVariety, orthography, cleanNotes,
         req.identity.id, req.identity.name]);

      const provisional = await gam.awardPoints(pool, {
        contributorId: req.identity.id, taskId: id, kind: 'lab_pair',
        points: LAB_POINTS.pairSubmit,
        reason: 'Submitted a parallel pair (provisional until expert approval)' });
      await gam.bumpContributionDay(pool, req.identity.id, true);
      await audit(req, 'lab_pair_submit', 'parallel_pair', id,
        { direction, provenance, abstained, access_status: accessStatus, rights_status: rightsStatus });

      res.json({ pair: pairPublic(r.rows[0]), points: { provisional: provisional ? provisional.points : 0 } });
    } catch (err) {
      console.error('lab/pairs:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ══ 3. Versioned edit ═════════════════════════════════════════
  router.put('/api/lab/pairs/:id', requireAccount, writeLimiter, async (req, res) => {
    try {
      const pr = await pool.query('SELECT * FROM parallel_pairs WHERE id=$1', [req.params.id]);
      const pair = pr.rows[0];
      if (!pair) return res.status(404).json({ error: 'Pair not found.' });

      const isOwner = pair.owner_id === req.identity.id;
      const isTrusted = auth.TRUSTED_PLUS.includes(req.identity.role);
      if (!isOwner && !isTrusted)
        return res.status(403).json({ error: 'Only the owner or a trusted reviewer can edit this pair.' });
      if (['approved', 'rejected', 'withdrawn'].includes(pair.status))
        return res.status(409).json({ error: `A ${pair.status} pair cannot be edited.` });

      const body = req.body || {};
      const sourceIsRu = pair.direction === 'ru2lak';

      // Accept either the frontend shape (source_text/target_literal/target_natural)
      // or legacy ru_text/lak_text. Fields omitted keep their current values.
      const litCol = body.target_literal != null ? (cleanReq(body.target_literal, 2000) || null) : pair.literal_target;
      const natCol = body.target_natural != null ? (cleanReq(body.target_natural, 2000) || null) : pair.natural_target;
      const orthography = body.orthography != null
        ? (ORTHOGRAPHIES.includes(body.orthography) ? body.orthography : pair.orthography)
        : pair.orthography;

      let ru, lak;
      if (body.ru_text != null || body.lak_text != null) {
        ru = body.ru_text != null ? cleanReq(body.ru_text, 2000) : pair.ru_text;
        lak = body.lak_text != null ? cleanReq(body.lak_text, 2000) : pair.lak_text;
      } else if (body.source_text != null || body.target_literal != null || body.target_natural != null) {
        const source = body.source_text != null
          ? cleanReq(body.source_text, 2000)
          : (sourceIsRu ? pair.ru_text : pair.lak_text);
        const primaryTarget = (natCol || litCol) ||
          (sourceIsRu ? pair.lak_text : pair.ru_text);
        ru = sourceIsRu ? source : primaryTarget;
        lak = sourceIsRu ? primaryTarget : source;
      } else {
        ru = pair.ru_text; lak = pair.lak_text;
      }
      if (!ru || !lak)
        return res.status(400).json({ error: 'Both source and target text are required.' });

      const cleanVariety = body.variety != null ? (cleanReq(body.variety, 40) || 'standard') : pair.variety;
      const cleanNotes = body.notes != null ? clean(body.notes, 1000) : pair.notes;

      const nextVersion = pair.head_version + 1;
      await pool.query(
        `INSERT INTO parallel_pair_versions
           (pair_id, version, ru_text, lak_text, literal_target, natural_target,
            variety, orthography, notes, edited_by, edited_by_name, edit_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [pair.id, nextVersion, ru, lak, litCol, natCol, cleanVariety, orthography, cleanNotes,
         req.identity.id, req.identity.name, clean(body.edit_summary, 300) || 'Edit']);
      const r = await pool.query(
        `UPDATE parallel_pairs SET ru_text=$2, lak_text=$3, literal_target=$4,
           natural_target=$5, variety=$6, orthography=$7, notes=$8,
           head_version=$9, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [pair.id, ru, lak, litCol, natCol, cleanVariety, orthography, cleanNotes, nextVersion]);
      gate.invalidate();
      await audit(req, 'lab_pair_edit', 'parallel_pair', pair.id, { version: nextVersion });
      res.json({ pair: pairPublic(r.rows[0]), version: nextVersion });
    } catch (err) {
      console.error('lab/pairs/edit:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Can the caller see a pair that is private/restricted?
  // Public pairs are visible to anyone; non-public pairs only to the owner,
  // trusted validators, verified experts and administrators.
  function canViewPair(req, pair) {
    if (!pair.is_private) return true;
    const identity = req.identity || auth.getIdentity(req);
    if (!identity || identity.type !== 'account') return false;
    if (identity.id === pair.owner_id) return true;
    return auth.TRUSTED_PLUS.includes(identity.role);
  }

  // ══ History ═══════════════════════════════════════════════════
  router.get('/api/lab/pairs/:id/history', async (req, res) => {
    const pr = await pool.query('SELECT * FROM parallel_pairs WHERE id=$1', [req.params.id]);
    if (!pr.rows[0]) return res.status(404).json({ error: 'Pair not found.' });
    if (!canViewPair(req, pr.rows[0]))
      return res.status(403).json({ error: 'This pair is private or restricted.' });
    const v = await pool.query(
      `SELECT version, ru_text, lak_text, literal_target, natural_target,
              variety, orthography, notes, edited_by_name, edit_summary, created_at
         FROM parallel_pair_versions WHERE pair_id=$1 ORDER BY version`, [req.params.id]);
    res.json({ versions: v.rows });
  });

  // ══ My pairs ══════════════════════════════════════════════════
  router.get('/api/lab/my-pairs', requireAccount, async (req, res) => {
    const validStatus = ['pending', 'under_review', 'approved', 'rejected', 'withdrawn'];
    const filterStatus = validStatus.includes(req.query.status) ? req.query.status : null;
    const r = await pool.query(
      `SELECT * FROM parallel_pairs
        WHERE owner_id = $1 AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC LIMIT 200`,
      [req.identity.id, filterStatus]);
    res.json({ pairs: r.rows.map(pairPublic) });
  });

  // Single pair. Private/restricted pairs are only visible to the owner or a
  // trusted validator / verified expert / administrator.
  router.get('/api/lab/pairs/:id', async (req, res) => {
    const pr = await pool.query('SELECT * FROM parallel_pairs WHERE id=$1', [req.params.id]);
    if (!pr.rows[0]) return res.status(404).json({ error: 'Pair not found.' });
    if (!canViewPair(req, pr.rows[0]))
      return res.status(403).json({ error: 'This pair is private or restricted.' });
    const reviews = await pool.query(
      `SELECT reviewer_name, pair_version, verdict, comment, created_at
         FROM pair_reviews WHERE pair_id=$1 ORDER BY created_at`, [req.params.id]);
    res.json({ pair: pairPublic(pr.rows[0]), reviews: reviews.rows });
  });

  // ══ 4. Independent peer review (self-review blocked) ══════════
  router.post('/api/lab/pairs/:id/reviews', requireAccount, writeLimiter, async (req, res) => {
    try {
      const { verdict, suggested_lak, comment } = req.body || {};
      const VERDICTS = ['accept', 'revise', 'reject'];
      if (!VERDICTS.includes(verdict))
        return res.status(400).json({ error: `verdict must be one of: ${VERDICTS.join(', ')}` });

      const pr = await pool.query('SELECT * FROM parallel_pairs WHERE id=$1', [req.params.id]);
      const pair = pr.rows[0];
      if (!pair) return res.status(404).json({ error: 'Pair not found.' });
      if (!canViewPair(req, pair))
        return res.status(403).json({ error: 'This pair is private or restricted.' });

      // Independent review: the owner cannot review their own pair.
      if (pair.owner_id === req.identity.id)
        return res.status(403).json({ error: 'You cannot review your own pair — reviews must be independent.' });
      if (['approved', 'rejected', 'withdrawn'].includes(pair.status))
        return res.status(409).json({ error: 'This pair is closed to new reviews.' });

      let row;
      try {
        const rr = await pool.query(
          `INSERT INTO pair_reviews
             (pair_id, pair_version, reviewer_id, reviewer_name, verdict, suggested_lak, comment)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
          [pair.id, pair.head_version, req.identity.id, req.identity.name,
           verdict, clean(suggested_lak, 2000), clean(comment, 1000)]);
        row = rr.rows[0];
      } catch (e) {
        if (e.code === '23505')
          return res.status(409).json({ error: 'You have already reviewed this pair.' });
        throw e;
      }

      // Move to under_review on first review (never auto-approve).
      if (pair.status === 'pending') {
        await pool.query(
          `UPDATE parallel_pairs SET status='under_review', updated_at=now() WHERE id=$1 AND status='pending'`,
          [pair.id]);
      }

      await gam.awardPoints(pool, {
        contributorId: req.identity.id, taskId: pair.id, kind: 'lab_review',
        points: LAB_POINTS.review, status: 'confirmed', reason: 'Independent pair review' });
      await gam.bumpContributionDay(pool, req.identity.id, true);
      await audit(req, 'lab_pair_review', 'parallel_pair', pair.id, { verdict });

      res.json({ review: { id: row.id, verdict, created_at: row.created_at } });
    } catch (err) {
      console.error('lab/pairs/reviews:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ══ 5. Expert adjudication (idempotent points) ════════════════
  router.post('/api/lab/pairs/:id/adjudicate', requireRole(auth.EXPERT_PLUS), writeLimiter, async (req, res) => {
    try {
      const { decision, split, note } = req.body || {};
      const DECISIONS = ['approve', 'reject', 'withdraw'];
      if (!DECISIONS.includes(decision))
        return res.status(400).json({ error: `decision must be one of: ${DECISIONS.join(', ')}` });
      let finalSplit = null;
      if (decision === 'approve') {
        finalSplit = SPLITS.includes(split) ? split : 'train';
      } else if (split != null && !SPLITS.includes(split)) {
        return res.status(400).json({ error: `split must be one of: ${SPLITS.join(', ')}` });
      }

      const pr = await pool.query('SELECT * FROM parallel_pairs WHERE id=$1', [req.params.id]);
      const pair = pr.rows[0];
      if (!pair) return res.status(404).json({ error: 'Pair not found.' });

      const resultingStatus =
        decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'withdrawn';

      // Idempotency: a unique (pair_id, pair_version) row means the expert's
      // points are awarded at most once per adjudicated version.
      let adjRow, firstTime = true;
      try {
        const ar = await pool.query(
          `INSERT INTO pair_adjudications
             (pair_id, pair_version, adjudicator_id, adjudicator_name, adjudicator_role,
              decision, split, note, resulting_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [pair.id, pair.head_version, req.identity.id, req.identity.name, req.identity.role,
           decision, finalSplit, clean(note, 1000), resultingStatus]);
        adjRow = ar.rows[0];
      } catch (e) {
        if (e.code === '23505') {
          // This version has already been adjudicated. Return its persisted
          // state without allowing a second request to mutate lifecycle state.
          const current = await pool.query('SELECT * FROM parallel_pairs WHERE id=$1', [pair.id]);
          return res.json({ pair: pairPublic(current.rows[0]), applied: false });
        }
        else throw e;
      }

      const upd = await pool.query(
        `UPDATE parallel_pairs SET status=$2, split=$3,
           approved_by = CASE WHEN $2='approved' THEN $4 ELSE approved_by END,
           approved_at = CASE WHEN $2='approved' THEN now() ELSE approved_at END,
           updated_at = now()
         WHERE id=$1 RETURNING *`,
        [pair.id, resultingStatus, decision === 'approve' ? finalSplit : null, req.identity.name]);

      // Owner points: confirm on approve, revoke otherwise (idempotent resolve).
      if (pair.owner_id) {
        if (decision === 'approve') {
          await gam.resolvePoints(pool, pair.owner_id, pair.id, 'confirmed', 'Pair approved by expert');
          if (firstTime) {
            await gam.awardPoints(pool, {
              contributorId: pair.owner_id, taskId: pair.id, kind: 'lab_pair_approved',
              points: LAB_POINTS.pairApproved, status: 'confirmed', reason: 'Parallel pair approved' });
          }
          await gam.checkAchievements(pool, pair.owner_id);
        } else {
          await gam.resolvePoints(pool, pair.owner_id, pair.id, 'revoked', `Pair ${resultingStatus} by expert`);
        }
      }

      // Adjudicator points once per new adjudication.
      if (firstTime && req.identity.type === 'account') {
        await gam.awardPoints(pool, {
          contributorId: req.identity.id, taskId: pair.id, kind: 'lab_adjudication',
          points: LAB_POINTS.adjudication, status: 'confirmed',
          reason: `Adjudicated a pair as ${req.identity.role}` });
      }
      // Gold membership just changed: reviewed translation memory must reflect
      // this decision on the very next request.
      gate.invalidate();
      await audit(req, 'lab_pair_adjudicate', 'parallel_pair', pair.id,
        { decision, split: finalSplit, resulting_status: resultingStatus, idempotent_skip: !firstTime });

      res.json({ pair: pairPublic(upd.rows[0]), applied: firstTime });
    } catch (err) {
      console.error('lab/pairs/adjudicate:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ══ Review queue for experts/trusted ══════════════════════════
  router.get('/api/lab/review-queue', requireRole(auth.TRUSTED_PLUS), async (req, res) => {
    const r = await pool.query(
      `SELECT p.*, COUNT(rv.id) AS review_count,
              COUNT(*) FILTER (WHERE rv.verdict='accept') AS accepts,
              COUNT(*) FILTER (WHERE rv.verdict='reject') AS rejects
         FROM parallel_pairs p
         LEFT JOIN pair_reviews rv ON rv.pair_id = p.id
        WHERE p.status IN ('pending','under_review')
        GROUP BY p.id
        ORDER BY review_count DESC, p.created_at LIMIT 100`);
    res.json({ pairs: r.rows.map(p => ({
      ...pairPublic(p),
      review_count: Number(p.review_count),
      accepts: Number(p.accepts),
      rejects: Number(p.rejects),
    })) });
  });

  // ══ 6. Dataset card ═══════════════════════════════════════════
  // Transparent counts describing exactly what is (and is not) exportable.
  router.get('/api/lab/dataset-card', async (req, res) => {
    try {
      const [statusRows, provRows, reviewedRows, bench, rows, goldRows] = await Promise.all([
        pool.query(`SELECT status, COUNT(*) n FROM parallel_pairs GROUP BY status`),
        pool.query(`SELECT provenance, COUNT(*) n FROM parallel_pairs GROUP BY provenance`),
        pool.query(`SELECT COUNT(DISTINCT pair_id) n FROM pair_reviews`),
        pool.query(`SELECT split, COUNT(*) n FROM benchmark_items GROUP BY split`),
        // Already filtered through the benchmark isolation guard.
        exportableRows(),
        gate.memory.snapshot(),
      ]);
      const tally = (list, keyFn) => {
        const out = {};
        for (const item of list) {
          const k = keyFn(item);
          out[k] = (out[k] || 0) + 1;
        }
        return out;
      };
      const byStatus = Object.fromEntries(statusRows.rows.map(r => [r.status, Number(r.n)]));
      const bySplit = tally(rows, r => r.split);
      const exportable = rows.length;
      res.json({
        card: {
          name: 'Lak ↔ Russian parallel corpus (Translation Lab)',
          description: 'Human-verified RU↔LAK sentence pairs derived from ' +
            'corpus evidence. No machine-generated target text — every pair was ' +
            'confirmed by a contributor and approved by a verified expert.',
          license: 'Only openly-licensed rows (public_domain or cc_by) are exported; ' +
            'individual corpus sources retain their own terms.',
          exportPolicy: 'Exports include ONLY approved train/dev pairs that are ' +
            'public (access_status=public), openly licensed (public_domain or cc_by) ' +
            'and human-authored. Excluded: the held-out test split, private/restricted ' +
            'pairs, pending/under-review/rejected/withdrawn pairs, any ' +
            'synthetic-provenance rows, and any pair that duplicates a held-out ' +
            'benchmark item.',
          goldEvidencePolicy: labMemory.GOLD_POLICY,
          benchmarkIsolation: 'Held-out benchmark items live in a private, expert-only ' +
            'store. They never enter retrieval, a public answer, or any export, and ' +
            'the rule is enforced in one place for every caller.',
          modelLineage: { provider: 'evidence-only', model_version: 'none', prompt_version: 'evidence-only-v1' },
          evidenceOnlyProvider: true,
          fineTuning: 'No model is trained or fine-tuned. Evaluation runs are ' +
            'retrieval-only unless a model provider is configured.',
          counts: {
            byStatus,
            byProvenance: Object.fromEntries(provRows.rows.map(r => [r.provenance, Number(r.n)])),
            exportableBySplit: bySplit,
            exportableByDirection: tally(rows, r => r.direction),
            exportableByVariety: tally(rows, r => r.variety),
            exportableByLicense: tally(rows, r => r.rights_status),
            exportableTotal: exportable,
            goldMemoryPairs: goldRows.length,
            pairsWithReviews: Number(reviewedRows.rows[0].n),
            benchmarkBySplit: Object.fromEntries(bench.rows.map(r => [r.split, Number(r.n)])),
          },
        },
      });
    } catch (err) {
      console.error('lab/dataset-card:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // The single source of truth for what may leave the system. Approved,
  // public access, openly-licensed (public_domain or cc_by), human-authored,
  // train/dev only — never test/private/restricted/pending/withdrawn/synthetic.
  const EXPORT_FILTER = `status='approved' AND NOT is_private
      AND access_status='public'
      AND rights_status IN ('public_domain','cc_by')
      AND provenance IN ('human','human_from_evidence')
      AND split IN ('train','dev')`;

  // Every export surface reads through the same benchmark isolation guard, so
  // a pair that duplicates a held-out item can never leave the system even if
  // it otherwise satisfies the export filter.
  async function exportableRows() {
    const r = await pool.query(
      `SELECT id, direction, ru_text, lak_text, literal_target, natural_target,
              variety, orthography, split, provenance, source_type, source_provenance,
              rights_status, access_status, status, approved_by, approved_at,
              proposal_id
         FROM parallel_pairs
        WHERE ${EXPORT_FILTER}
        ORDER BY split, id`);
    const safe = await gate.safePairs(r.rows);
    return safe.kept;
  }

  // JSONL — one JSON object per line.
  router.get('/api/lab/export.jsonl', async (req, res) => {
    try {
      const rows = await exportableRows();
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="lak-ru-parallel.jsonl"');
      res.send(rows.map(r => JSON.stringify({
        id: r.id, direction: r.direction, ru: r.ru_text, lak: r.lak_text,
        target_literal: r.literal_target, target_natural: r.natural_target,
        variety: r.variety, orthography: r.orthography, split: r.split,
        provenance: r.provenance, source_type: r.source_type,
        source_provenance: r.source_provenance,
        license: r.rights_status, access_status: r.access_status,
        status: r.status, approved_by: r.approved_by, approved_at: r.approved_at,
        model_lineage: { provider: 'evidence-only', model_version: 'none', prompt_version: 'evidence-only-v1' },
      })).join('\n') + (rows.length ? '\n' : ''));
    } catch (err) {
      console.error('lab/export.jsonl:', err.message);
      res.status(500).json({ error: 'Export failed' });
    }
  });

  // TSV — Russian<TAB>Lak plus metadata columns.
  router.get('/api/lab/export.tsv', async (req, res) => {
    try {
      const rows = await exportableRows();
      const esc = v => String(v == null ? '' : v).replace(/[\t\r\n]/g, ' ');
      const cols = ['id', 'direction', 'ru', 'lak', 'target_literal', 'target_natural',
        'variety', 'orthography', 'split', 'provenance', 'source_type', 'license',
        'access_status', 'status', 'approved_by', 'model_version', 'prompt_version'];
      const header = cols.join('\t');
      const body = rows.map(r =>
        [r.id, r.direction, r.ru_text, r.lak_text, r.literal_target, r.natural_target,
         r.variety, r.orthography, r.split, r.provenance, r.source_type, r.rights_status,
         r.access_status, r.status, r.approved_by, 'none', 'evidence-only-v1'].map(esc).join('\t')).join('\n');
      res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="lak-ru-parallel.tsv"');
      res.send(header + '\n' + body + (rows.length ? '\n' : ''));
    } catch (err) {
      console.error('lab/export.tsv:', err.message);
      res.status(500).json({ error: 'Export failed' });
    }
  });

  // Hugging Face-style export: dataset dict keyed by split with a card.
  router.get('/api/lab/export.hf.json', async (req, res) => {
    try {
      const rows = await exportableRows();
      const splits = { train: [], dev: [] };
      for (const r of rows) {
        (splits[r.split] || (splits[r.split] = [])).push({
          id: r.id, direction: r.direction,
          translation: { ru: r.ru_text, lak: r.lak_text },
          target_literal: r.literal_target, target_natural: r.natural_target,
          variety: r.variety, orthography: r.orthography, provenance: r.provenance,
          source_type: r.source_type, source_provenance: r.source_provenance,
          license: r.rights_status, access_status: r.access_status, status: r.status,
        });
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="lak-ru-parallel.hf.json"');
      res.json({
        dataset_name: 'lak_ru_parallel',
        features: { id: 'string', direction: 'string',
          translation: { ru: 'string', lak: 'string' },
          target_literal: 'string', target_natural: 'string',
          variety: 'string', orthography: 'string', provenance: 'string',
          license: 'string', access_status: 'string', status: 'string' },
        exported_at: new Date().toISOString(),
        model_lineage: { provider: 'evidence-only', model_version: 'none', prompt_version: 'evidence-only-v1' },
        license_policy: 'Only public_domain or cc_by rows are exported.',
        note: 'Approved, public, openly-licensed (public_domain/cc_by), human-authored ' +
              'train/dev pairs only. Test split and private/restricted/pending/' +
              'withdrawn/synthetic rows are intentionally excluded.',
        splits: {
          train: splits.train || [],
          validation: splits.dev || [],
        },
      });
    } catch (err) {
      console.error('lab/export.hf.json:', err.message);
      res.status(500).json({ error: 'Export failed' });
    }
  });

  // ══ 7. Private benchmark: import template, management, export ═
  // Expert-only throughout. Held-out items are sized for a 500–1,000 item
  // expert benchmark and are kept entirely apart from the public export
  // surfaces: they have their own import and their own export route, and the
  // isolation guard keeps them out of every retrieval and public answer.
  const BENCH_TSV_COLUMNS = ['row', 'direction', 'source_text', 'reference_text',
    'split', 'variety', 'category', 'difficulty', 'notes', 'is_private'];
  const BENCH_TARGET_SIZE = { min: 500, max: 1000 };

  router.get('/api/lab/benchmark/template.tsv', requireRole(auth.EXPERT_PLUS), (req, res) => {
    const header = BENCH_TSV_COLUMNS.join('\t');
    const blank = new Array(BENCH_TSV_COLUMNS.length - 1).fill('');
    const rows = [];
    for (let i = 1; i <= 500; i++) rows.push([i, ...blank].join('\t'));
    res.setHeader('Content-Type', 'text/tab-separated-values; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="benchmark-template.tsv"');
    res.send('\uFEFF' + header + '\n' + rows.join('\n') + '\n');
  });

  // JSON metadata template describing the schema/enums (no fake example rows).
  router.get('/api/lab/benchmark/template', requireRole(auth.EXPERT_PLUS), (req, res) => {
    res.json({
      format: 'jsonl',
      tsv_template_url: '/api/lab/benchmark/template.tsv',
      columns: BENCH_TSV_COLUMNS,
      required: ['direction', 'source_text', 'reference_text'],
      optional: ['split', 'variety', 'category', 'difficulty', 'notes', 'is_private'],
      allowed: { direction: DIRECTIONS, split: SPLITS, difficulty: ['easy', 'medium', 'hard'] },
      defaults: { split: 'test', variety: 'standard', is_private: true },
      note: 'The test split is held out and is never exported in the public dataset. ' +
            'Download the blank TSV template, fill your own items (no sample data is ' +
            'provided), then import.',
    });
  });

  // Bulk import benchmark items (JSONL body: { items: [...] }).
  router.post('/api/lab/benchmark/import', requireRole(auth.EXPERT_PLUS), writeLimiter, async (req, res) => {
    try {
      const items = (req.body && req.body.items) || [];
      if (!Array.isArray(items) || !items.length)
        return res.status(400).json({ error: 'items must be a non-empty array.' });
      if (items.length > 1000)
        return res.status(400).json({ error: 'Import at most 1000 items at a time.' });

      const created = [];
      const errors = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const direction = normDirection(it.direction);
        const source = cleanReq(it.source_text, 2000);
        const reference = cleanReq(it.reference_text, 2000);
        if (!direction || !source || !reference) {
          errors.push({ index: i, error: 'direction, source_text and reference_text are required.' });
          continue;
        }
        const split = SPLITS.includes(it.split) ? it.split : 'test';
        const difficulty = ['easy', 'medium', 'hard'].includes(it.difficulty) ? it.difficulty : null;
        // Held-out items are private by construction: the test split can never
        // be marked public, whatever the import file says.
        const isPrivate = split === 'test' ? true : it.is_private !== false;
        const id = 'bench_' + crypto.randomUUID();
        await pool.query(
          `INSERT INTO benchmark_items
             (id, split, direction, source_text, reference_text, variety, category, difficulty, notes,
              is_private, created_by, created_by_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [id, split, direction, source, reference,
           cleanReq(it.variety, 40) || 'standard', clean(it.category, 80), difficulty,
           clean(it.notes, 1000),
           isPrivate,
           req.identity.id, req.identity.name]);
        created.push(id);
        if (req.identity.type === 'account') {
          await gam.awardPoints(pool, {
            contributorId: req.identity.id, taskId: id, kind: 'lab_benchmark',
            points: LAB_POINTS.benchmarkItem, status: 'confirmed', reason: 'Authored a benchmark item' });
        }
      }
      // The isolation guard must see the new held-out items immediately.
      gate.invalidate();
      await audit(req, 'lab_benchmark_import', 'benchmark', null,
        { created: created.length, errors: errors.length });
      const total = await pool.query(`SELECT COUNT(*) n FROM benchmark_items WHERE split='test'`);
      res.json({
        created: created.length, ids: created, errors,
        held_out_total: Number(total.rows[0].n),
        target_size: BENCH_TARGET_SIZE,
        isolation: 'Imported items are held out: they never enter retrieval, a ' +
          'public answer, or any public export.',
      });
    } catch (err) {
      console.error('lab/benchmark/import:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // List / manage benchmark items (experts only — the test split is private).
  router.get('/api/lab/benchmark', requireRole(auth.EXPERT_PLUS), async (req, res) => {
    const split = SPLITS.includes(req.query.split) ? req.query.split : null;
    const direction = normDirection(req.query.direction);
    const [r, counts] = await Promise.all([
      pool.query(
        `SELECT id, split, direction, source_text, reference_text, variety, category,
                difficulty, notes, is_private, created_by_name, created_at
           FROM benchmark_items
          WHERE ($1::text IS NULL OR split=$1) AND ($2::text IS NULL OR direction=$2)
          ORDER BY created_at DESC LIMIT 1000`, [split, direction]),
      pool.query(`SELECT split, COUNT(*) n FROM benchmark_items GROUP BY split`),
    ]);
    const bySplit = Object.fromEntries(counts.rows.map(row => [row.split, Number(row.n)]));
    const heldOut = bySplit.test || 0;
    res.json({
      items: r.rows,
      counts: { bySplit, held_out: heldOut },
      capacity: {
        target_size: BENCH_TARGET_SIZE,
        held_out: heldOut,
        remaining_to_minimum: Math.max(0, BENCH_TARGET_SIZE.min - heldOut),
        at_capacity: heldOut >= BENCH_TARGET_SIZE.max,
      },
      isolation: {
        enforced: true,
        note: 'Held-out items are expert-only. They are excluded from retrieval, ' +
          'public answers and every public export by a single shared guard.',
      },
    });
  });

  // Private benchmark export — expert-only and deliberately separate from the
  // public /api/lab/export.* surfaces. Never linked from a public page and
  // never cached by an intermediary.
  function benchmarkExportRows(split, direction) {
    return pool.query(
      `SELECT id, split, direction, source_text, reference_text, variety, category,
              difficulty, notes, is_private, created_by_name, created_at
         FROM benchmark_items
        WHERE ($1::text IS NULL OR split=$1) AND ($2::text IS NULL OR direction=$2)
        ORDER BY created_at`, [split, direction]);
  }

  const privateHeaders = (res, filename, contentType) => {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  };

  router.get('/api/lab/benchmark/export.jsonl', requireRole(auth.EXPERT_PLUS), async (req, res) => {
    try {
      const split = SPLITS.includes(req.query.split) ? req.query.split : null;
      const direction = normDirection(req.query.direction);
      const r = await benchmarkExportRows(split, direction);
      await audit(req, 'lab_benchmark_export', 'benchmark', null,
        { format: 'jsonl', split, direction, items: r.rows.length });
      privateHeaders(res, 'benchmark-heldout.jsonl', 'application/x-ndjson; charset=utf-8');
      res.send(r.rows.map(row => JSON.stringify({
        id: row.id, split: row.split, direction: row.direction,
        source_text: row.source_text, reference_text: row.reference_text,
        variety: row.variety, category: row.category, difficulty: row.difficulty,
        notes: row.notes, created_by: row.created_by_name, created_at: row.created_at,
        visibility: 'private_held_out',
      })).join('\n') + (r.rows.length ? '\n' : ''));
    } catch (err) {
      console.error('lab/benchmark/export.jsonl:', err.message);
      res.status(500).json({ error: 'Export failed' });
    }
  });

  router.get('/api/lab/benchmark/export.tsv', requireRole(auth.EXPERT_PLUS), async (req, res) => {
    try {
      const split = SPLITS.includes(req.query.split) ? req.query.split : null;
      const direction = normDirection(req.query.direction);
      const r = await benchmarkExportRows(split, direction);
      const esc = v => String(v == null ? '' : v).replace(/[\t\r\n]/g, ' ');
      const cols = ['id', 'split', 'direction', 'source_text', 'reference_text',
        'variety', 'category', 'difficulty', 'notes', 'created_by', 'created_at'];
      await audit(req, 'lab_benchmark_export', 'benchmark', null,
        { format: 'tsv', split, direction, items: r.rows.length });
      privateHeaders(res, 'benchmark-heldout.tsv', 'text/tab-separated-values; charset=utf-8');
      res.send('\uFEFF' + cols.join('\t') + '\n' + r.rows.map(row => [
        row.id, row.split, row.direction, row.source_text, row.reference_text,
        row.variety, row.category, row.difficulty, row.notes, row.created_by_name,
        row.created_at,
      ].map(esc).join('\t')).join('\n') + (r.rows.length ? '\n' : ''));
    } catch (err) {
      console.error('lab/benchmark/export.tsv:', err.message);
      res.status(500).json({ error: 'Export failed' });
    }
  });

  router.put('/api/lab/benchmark/:id', requireRole(auth.EXPERT_PLUS), async (req, res) => {
    const pr = await pool.query('SELECT * FROM benchmark_items WHERE id=$1', [req.params.id]);
    const item = pr.rows[0];
    if (!item) return res.status(404).json({ error: 'Benchmark item not found.' });
    const { source_text, reference_text, split, variety, category, difficulty, notes, is_private } = req.body || {};
    if (split != null && !SPLITS.includes(split))
      return res.status(400).json({ error: `split must be one of: ${SPLITS.join(', ')}` });
    if (difficulty != null && !['easy', 'medium', 'hard'].includes(difficulty))
      return res.status(400).json({ error: 'difficulty must be easy, medium, or hard.' });
    const r = await pool.query(
      `UPDATE benchmark_items SET
         source_text = COALESCE($2, source_text),
         reference_text = COALESCE($3, reference_text),
         split = COALESCE($4, split),
         variety = COALESCE($5, variety),
         category = COALESCE($6, category),
         difficulty = COALESCE($7, difficulty),
         notes = COALESCE($8, notes),
         is_private = COALESCE($9, is_private),
         updated_at = now()
       WHERE id=$1 RETURNING *`,
      [item.id,
       source_text != null ? cleanReq(source_text, 2000) : null,
       reference_text != null ? cleanReq(reference_text, 2000) : null,
       split || null, variety != null ? cleanReq(variety, 40) : null,
       category != null ? clean(category, 80) : null, difficulty || null,
       notes != null ? clean(notes, 1000) : null,
       typeof is_private === 'boolean' ? is_private : null]);
    gate.invalidate();
    await audit(req, 'lab_benchmark_update', 'benchmark', item.id, null);
    res.json({ item: r.rows[0] });
  });

  router.delete('/api/lab/benchmark/:id', requireRole(auth.EXPERT_PLUS), async (req, res) => {
    const r = await pool.query('DELETE FROM benchmark_items WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Benchmark item not found.' });
    gate.invalidate();
    await audit(req, 'lab_benchmark_delete', 'benchmark', req.params.id, null);
    res.json({ ok: true });
  });

  // ══ 8. Evaluation runs ════════════════════════════════════════
  // A run answers each held-out item through the SAME gate a public request
  // uses, and records what evidence was available and whether the lab
  // abstained. Two configurations can be logged and compared:
  //   retrieval_only       — evidence retrieval + reviewed memory (the only
  //                          configuration possible while no model is configured)
  //   model_plus_retrieval — the same, with a generative model on top
  // No fine-tuning happens in either: nothing is trained on the benchmark or
  // on anything else, and a run can never assert that a model learned.
  const RUN_CONFIGS = ['retrieval_only', 'model_plus_retrieval'];

  router.post('/api/lab/runs', requireRole(auth.EXPERT_PLUS), writeLimiter, async (req, res) => {
    try {
      const body = req.body || {};
      const split = SPLITS.includes(body.split) ? body.split : 'test';
      const direction = normDirection(body.direction);
      const config = RUN_CONFIGS.includes(body.config) ? body.config : 'retrieval_only';
      if (config === 'model_plus_retrieval' && !PROVIDER_META.configured) {
        return res.status(409).json({
          error: 'No generative model is configured, so a model+retrieval run ' +
                 'cannot be recorded. Only retrieval_only runs are possible, and ' +
                 'no model is trained or fine-tuned in any configuration.',
          config_available: ['retrieval_only'],
        });
      }

      const items = await pool.query(
        `SELECT direction, source_text FROM benchmark_items
          WHERE split=$1 AND ($2::text IS NULL OR direction=$2)`, [split, direction]);

      let withEvidence = 0, withGold = 0, abstained = 0;
      const byEvidenceClass = {};
      for (const it of items.rows) {
        // Same gate as a public answer: held-out references cannot come back
        // as evidence even when the item itself is the query.
        const retrieval = await gate.gather(it.direction, it.source_text, { limit: 10 });
        const p = provider.propose(it.direction, retrieval);
        if (retrieval.evidence.length) withEvidence += 1;
        if (p.gold) withGold += 1;
        if (p.abstained) abstained += 1;
        const k = p.evidence_class || 'none';
        byEvidenceClass[k] = (byEvidenceClass[k] || 0) + 1;
      }

      const id = 'run_' + crypto.randomUUID();
      const total = items.rows.length;
      const summary = {
        config,
        note: config === 'retrieval_only'
          ? 'Retrieval-only run: reviewed translation memory plus corpus evidence. ' +
            'No generative model was invoked, no model was trained or fine-tuned, ' +
            'and nothing here demonstrates model learning.'
          : 'Model+retrieval run: the configured model was given retrieved evidence. ' +
            'No fine-tuning took place.',
        evidence_coverage: total ? withEvidence / total : 0,
        gold_coverage: total ? withGold / total : 0,
        abstain_rate: total ? abstained / total : 0,
        evidence_class_breakdown: byEvidenceClass,
        fine_tuning: false,
        benchmark_isolation: 'Held-out references are withheld from retrieval; the ' +
          'run measures coverage over items the system has never been able to see.',
      };
      await pool.query(
        `INSERT INTO model_runs
           (id, provider, config, split, direction, items_total, items_with_evidence,
            items_with_gold, items_abstained, items_scored, evidence_only,
            model_version, fine_tuned, summary, run_by, run_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,FALSE,$13,$14,$15)`,
        [id, PROVIDER_META.provider, config, split, direction, total, withEvidence,
         withGold, abstained, config === 'retrieval_only' ? 0 : total,
         config === 'retrieval_only', PROVIDER_META.model_version,
         JSON.stringify(summary), req.identity.id, req.identity.name]);
      await audit(req, 'lab_run', 'model_run', id,
        { split, direction, config, items: total });
      res.json({
        run_id: id, split, direction, config, provider: PROVIDER_META.provider,
        items_total: total, items_with_evidence: withEvidence,
        items_with_gold: withGold, items_abstained: abstained,
        items_scored: config === 'retrieval_only' ? 0 : total,
        evidence_only: config === 'retrieval_only',
        model_version: PROVIDER_META.model_version, fine_tuned: false, summary,
      });
    } catch (err) {
      console.error('lab/runs:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  const RUN_COLUMNS = `id, provider, config, split, direction, items_total,
              items_with_evidence, items_with_gold, items_abstained, items_scored,
              evidence_only, model_version, fine_tuned, summary, run_by_name, created_at`;

  router.get('/api/lab/runs', requireRole(auth.EXPERT_PLUS), async (req, res) => {
    const config = RUN_CONFIGS.includes(req.query.config) ? req.query.config : null;
    const r = await pool.query(
      `SELECT ${RUN_COLUMNS} FROM model_runs
        WHERE ($1::text IS NULL OR config=$1)
        ORDER BY created_at DESC LIMIT 100`, [config]);
    res.json({ runs: r.rows, configs: RUN_CONFIGS, fine_tuning: false });
  });

  // Side-by-side comparison of the two configurations for one split.
  router.get('/api/lab/runs/compare', requireRole(auth.EXPERT_PLUS), async (req, res) => {
    const split = SPLITS.includes(req.query.split) ? req.query.split : 'test';
    const r = await pool.query(
      `SELECT DISTINCT ON (config) ${RUN_COLUMNS}
         FROM model_runs WHERE split=$1
        ORDER BY config, created_at DESC`, [split]);
    const byConfig = Object.fromEntries(r.rows.map(row => [row.config, row]));
    res.json({
      split,
      retrieval_only: byConfig.retrieval_only || null,
      model_plus_retrieval: byConfig.model_plus_retrieval || null,
      model_configured: PROVIDER_META.configured,
      fine_tuning: false,
      note: PROVIDER_META.configured
        ? 'Both configurations use the same held-out benchmark and the same ' +
          'isolation guard. No model is trained or fine-tuned.'
        : 'No generative model is configured, so only retrieval-only runs exist. ' +
          'No model is trained or fine-tuned, and no claim of model learning is made.',
    });
  });

  return router;
};
