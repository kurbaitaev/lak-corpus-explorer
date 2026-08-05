'use strict';

// Private Alignment Lab & Source Intelligence API.
//
// Boundaries this router enforces:
//   * Every route here is authenticated. There is no public variant: an
//     unauthenticated request gets 401 with no body content, and a request
//     from too low a role gets 403. Private source text, relationship
//     evidence and alignment segments only ever travel over these routes.
//   * Nothing served here is a validated translation. Relationships and
//     alignment units are candidates produced from deterministic evidence;
//     they carry `validated: false` until a human with the right role accepts
//     them, and accepting is an expert-only decision.
//   * Rights, access, review and training are four independent decisions,
//     enforced server-side. Raising exposure (public access or training) is
//     refused with 409 unless rights are cleared, the review is accepted and
//     the caller is an expert — the UI gating is a convenience, not the gate.
//   * Every decision is written to the immutable private_review_decisions log
//     and to audit_events inside the same transaction as the state change.
//   * Nothing is merged and nothing is promoted into the public corpus.

const express = require('express');
const auth = require('../lib/auth');
const intel = require('../lib/source-intelligence');
const alignment = require('../lib/alignment-engine');

const ACCESS_STATUSES = ['private_research', 'restricted', 'public'];
const RIGHTS_STATUSES = ['permission_pending', 'permission_granted', 'public_domain', 'restricted'];
const REVIEW_STATES = ['source_import_unreviewed', 'in_review', 'accepted_candidate', 'rejected'];
const CLEARED_RIGHTS = ['permission_granted', 'public_domain'];
const CARDINALITIES = ['one_to_one', 'one_to_many', 'many_to_one', 'unmatched_left', 'unmatched_right'];

const clean = (value, max) => (value == null || value === '' ? null : String(value).slice(0, max));
const pageLimit = (value, fallback, max) => Math.min(Math.max(parseInt(value, 10) || fallback, 1), max);

// Tiny filter builder: every `$?` in a fragment binds the one value passed
// with it, so a fragment can mention the same parameter more than once and
// still be parameterised.
function filterBuilder() {
  const where = ['TRUE'];
  const values = [];
  return {
    values,
    add(fragment, value) {
      values.push(value);
      where.push(fragment.replace(/\$\?/g, '$' + values.length));
    },
    clause() { return where.join(' AND '); },
  };
}

// `publicSources` and `publicForms` are read through getters: the corpus is
// loaded at boot and the scan runs asynchronously, so the router must always
// read current state rather than a snapshot taken at mount time.
module.exports = function createSourceIntelligenceRouter(options) {
  const { pool } = options;
  const router = express.Router();
  const { requireRole } = auth.makeMiddleware(pool);
  const requireReviewer = requireRole(auth.TRUSTED_PLUS);
  const requireExpert = requireRole(auth.EXPERT_PLUS);

  const resolve = value => (typeof value === 'function' ? value() : value);
  const publicSources = () => resolve(options.publicSources) || [];
  const publicForms = () => resolve(options.publicForms) || new Set();
  const scanState = () => resolve(options.scanState) || null;

  const audit = (req, eventType, targetType, targetId, payload, executor = pool) => executor.query(
    `INSERT INTO audit_events (actor_type, actor_id, actor_name, event_type, target_type, target_id, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [req.identity.type, req.identity.id || null, req.identity.name || null,
     eventType, targetType, targetId, payload ? JSON.stringify(payload) : null]);

  const fail = (res, err, where) => {
    console.error(where + ':', err.message);
    res.status(500).json({ error: 'Server error' });
  };

  // A relationship row as the client sees it. `validated` is derived, never
  // stored as a claim: only a human acceptance can make it true.
  const shapeRelationship = row => ({
    id: row.id,
    pair_key: row.pair_key,
    family_key: row.family_key,
    relationship_type: row.relationship_type,
    method: row.method,
    generator_version: row.generator_version,
    origin: row.origin,
    left: {
      kind: row.left_source_kind, ref: row.left_source_ref,
      label: row.left_source_label, language: row.left_language, role: row.left_role,
    },
    right: {
      kind: row.right_source_kind, ref: row.right_source_ref,
      label: row.right_source_label, language: row.right_language, role: row.right_role,
    },
    role_note: row.role_note,
    signals: row.signals || [],
    evidence: row.evidence || {},
    confidence: Number(row.confidence),
    rights_status: row.rights_status,
    access_status: row.access_status,
    review_state: row.review_state,
    training_ready: row.training_ready,
    decided_by_name: row.decided_by_name,
    decided_at: row.decided_at,
    candidate: row.review_state !== 'accepted_candidate',
    validated: false,
    human_accepted: row.review_state === 'accepted_candidate',
    alignment_units: row.alignment_units == null ? undefined : Number(row.alignment_units),
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

  const shapeUnit = row => ({
    id: row.id,
    relationship_id: row.relationship_id,
    level: row.level,
    parent_id: row.parent_id,
    ordinal: row.ordinal,
    cardinality: row.cardinality,
    left_refs: row.left_refs || [],
    right_refs: row.right_refs || [],
    left_text: row.left_text,
    right_text: row.right_text,
    method: row.method,
    signals: row.signals || [],
    confidence: Number(row.confidence),
    review_state: row.review_state,
    adjusted: row.adjusted,
    reviewer_note: row.reviewer_note,
    decided_by_name: row.decided_by_name,
    decided_by_role: row.decided_by_role,
    decided_at: row.decided_at,
    candidate: row.review_state !== 'accepted_candidate',
    validated: false,
    children: [],
  });

  // ── Status ─────────────────────────────────────────────────
  router.get('/api/private/intel/status', requireReviewer, async (req, res) => {
    try {
      const [sources, relationships, families, units, run] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS total,
                           COUNT(*) FILTER (WHERE review_state = 'source_import_unreviewed')::int AS unreviewed,
                           COUNT(*) FILTER (WHERE rights_status IN ('permission_granted','public_domain'))::int AS rights_cleared
                      FROM v13_sources`),
        pool.query(`SELECT relationship_type, review_state, COUNT(*)::int AS total
                      FROM private_source_relationships
                     GROUP BY relationship_type, review_state
                     ORDER BY relationship_type, review_state`),
        pool.query(`SELECT COUNT(DISTINCT family_key)::int AS families FROM v13_sources WHERE family_key IS NOT NULL`),
        pool.query(`SELECT COUNT(*)::int AS total,
                           COUNT(*) FILTER (WHERE review_state <> 'source_import_unreviewed')::int AS reviewed
                      FROM private_alignment_units`),
        pool.query(`SELECT generator_version, input_key, sources_scanned, pairs_examined, proposed, created_at
                      FROM private_relationship_runs ORDER BY created_at DESC LIMIT 1`),
      ]);
      const rightsQueue = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE review_state = 'source_import_unreviewed')::int AS open
           FROM v13_rights_reviews`);
      res.json({
        generator_version: intel.GENERATOR_VERSION,
        engine_version: alignment.ENGINE_VERSION,
        scan: scanState(),
        last_run: run.rows[0] || null,
        private_sources: sources.rows[0],
        public_sources: publicSources().length,
        families: families.rows[0].families,
        relationships: relationships.rows,
        relationship_total: relationships.rows.reduce((sum, row) => sum + row.total, 0),
        alignment_units: units.rows[0],
        rights_queue: rightsQueue.rows[0],
      });
    } catch (err) { fail(res, err, 'intel/status'); }
  });

  // ── Source browser ─────────────────────────────────────────
  // Private v1.3 sources, the audited v1.2 sources and the public corpus
  // sources in one list, so a reviewer can filter across all of them.
  router.get('/api/private/intel/sources', requireReviewer, async (req, res) => {
    try {
      const scope = ['all', 'private_v13', 'private_v12', 'public_corpus'].includes(req.query.scope)
        ? req.query.scope : 'all';
      const limit = pageLimit(req.query.limit, 50, 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const query = clean(req.query.q, 200);
      const filters = {
        material_type: clean(req.query.material_type, 120),
        language: clean(req.query.language, 60),
        family_key: clean(req.query.family_key, 200),
        extraction_quality: clean(req.query.extraction_quality, 120),
        rights_status: clean(req.query.rights_status, 60),
        review_state: clean(req.query.review_state, 60),
        access_status: clean(req.query.access_status, 60),
      };

      const rows = [];

      if (scope === 'all' || scope === 'private_v13') {
        const filter = filterBuilder();
        const add = filter.add;
        if (query) add('(s.source_path ILIKE $? OR s.material_type ILIKE $?)', '%' + query + '%');
        if (filters.material_type) add('s.material_type = $?', filters.material_type);
        if (filters.family_key) add('s.family_key = $?', filters.family_key);
        if (filters.extraction_quality) add('s.extraction_quality = $?', filters.extraction_quality);
        if (filters.rights_status) add('s.rights_status = $?', filters.rights_status);
        if (filters.review_state) add('s.review_state = $?', filters.review_state);
        if (filters.access_status) add('s.access_status = $?', filters.access_status);
        if (filters.language) add('s.language_scope ILIKE $?', '%' + filters.language + '%');
        const clause = filter.clause();
        const values = filter.values;
        const sql =
          `SELECT s.source_sequence, s.source_path, s.source_sha256, s.material_type, s.language_scope,
                  s.extraction_quality, s.extraction_status, s.family_key, s.rights_status, s.review_state,
                  s.access_status, s.training_ready, s.text_chars, s.word_count, s.priority, s.extension,
                  s.duplicate_group, s.canonical_duplicate,
                  (SELECT COUNT(*)::int FROM private_source_relationships r
                    WHERE (r.left_source_kind = 'v13_source' AND r.left_source_ref = s.source_sequence::text)
                       OR (r.right_source_kind = 'v13_source' AND r.right_source_ref = s.source_sequence::text)
                  ) AS relationship_count
             FROM v13_sources s
            WHERE ${clause}
            ORDER BY s.source_sequence`;
        const result = await pool.query(sql, values);
        for (const row of result.rows) {
          const parts = intel.pathParts(row.source_path);
          rows.push({
            kind: 'v13_source',
            ref: String(row.source_sequence),
            label: parts.file,
            folder: parts.folder,
            scope: 'private_v13',
            material_type: row.material_type,
            language_scope: row.language_scope,
            family_key: row.family_key,
            extraction_quality: row.extraction_quality,
            extraction_status: row.extraction_status,
            rights_status: row.rights_status,
            review_state: row.review_state,
            access_status: row.access_status,
            training_ready: row.training_ready,
            text_chars: row.text_chars == null ? null : Number(row.text_chars),
            word_count: row.word_count == null ? null : Number(row.word_count),
            priority: row.priority,
            extension: row.extension,
            duplicate_group: row.duplicate_group,
            relationship_count: row.relationship_count,
          });
        }
      }

      if (scope === 'all' || scope === 'private_v12') {
        const result = await pool.query(
          `SELECT source_id,
                  COUNT(*)::int AS candidates,
                  COUNT(*) FILTER (WHERE review_state <> 'source_import_unreviewed')::int AS reviewed,
                  MIN(rights_status) AS rights_status,
                  MIN(access_status) AS access_status
             FROM source_import_candidates GROUP BY source_id ORDER BY source_id`);
        for (const row of result.rows) {
          rows.push({
            kind: 'v12_source',
            ref: row.source_id,
            label: row.source_id,
            folder: null,
            scope: 'private_v12',
            material_type: 'audited_lexical_candidates',
            language_scope: 'Lak-Russian pairs',
            family_key: 'v12:' + intel.slug(row.source_id),
            extraction_quality: 'audited_v12_import',
            extraction_status: 'staged',
            rights_status: row.rights_status,
            review_state: row.reviewed === row.candidates ? 'accepted_candidate' : 'source_import_unreviewed',
            access_status: row.access_status,
            training_ready: false,
            text_chars: null,
            word_count: null,
            priority: null,
            extension: null,
            duplicate_group: null,
            candidates: row.candidates,
            relationship_count: 0,
          });
        }
      }

      if (scope === 'all' || scope === 'public_corpus') {
        for (const source of publicSources()) rows.push({ ...source, relationship_count: 0 });
      }

      const filtered = rows.filter(row => {
        if (query && scope !== 'private_v13') {
          const haystack = [row.label, row.material_type, row.family_key].join(' ').toLowerCase();
          if (!haystack.includes(query.toLowerCase())) return false;
        }
        if (filters.material_type && row.material_type !== filters.material_type) return false;
        if (filters.family_key && row.family_key !== filters.family_key) return false;
        if (filters.extraction_quality && row.extraction_quality !== filters.extraction_quality) return false;
        if (filters.rights_status && row.rights_status !== filters.rights_status) return false;
        if (filters.review_state && row.review_state !== filters.review_state) return false;
        if (filters.access_status && row.access_status !== filters.access_status) return false;
        if (filters.language && !String(row.language_scope || '').toLowerCase()
          .includes(filters.language.toLowerCase())) return false;
        return true;
      });

      // Every received file stays listed — nothing is hidden from a reviewer —
      // but the ones with text to work on come first and the operating-system
      // artefacts the sender's disk contributed (.DS_Store and friends) sink
      // to the bottom. The order is a pure function of the row, so paging is
      // stable across requests.
      const rank = row => {
        const label = String(row.label || '');
        if (label.startsWith('.') || /^(thumbs\.db|desktop\.ini)$/i.test(label)) return 3;
        if (!row.text_chars) return 2;
        if (!row.relationship_count) return 1;
        return 0;
      };
      filtered.sort((a, b) => (rank(a) - rank(b)) ||
        ((b.relationship_count || 0) - (a.relationship_count || 0)) ||
        String(a.folder || '').localeCompare(String(b.folder || '')) ||
        String(a.label || '').localeCompare(String(b.label || '')) ||
        String(a.ref).localeCompare(String(b.ref)));

      res.json({
        total: filtered.length,
        limit,
        offset,
        scope,
        sources: filtered.slice(offset, offset + limit),
      });
    } catch (err) { fail(res, err, 'intel/sources'); }
  });

  router.get('/api/private/intel/facets', requireReviewer, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT material_type, extraction_quality, language_scope, family_key,
                rights_status, review_state, access_status
           FROM v13_sources`);
      const collect = key => Array.from(new Set(result.rows.map(row => row[key]).filter(Boolean))).sort();
      res.json({
        material_type: collect('material_type').concat(['audited_lexical_candidates', 'public_corpus_layer'])
          .filter((value, index, list) => list.indexOf(value) === index).sort(),
        extraction_quality: collect('extraction_quality'),
        language_scope: collect('language_scope'),
        family_key: collect('family_key'),
        rights_status: RIGHTS_STATUSES,
        review_state: REVIEW_STATES,
        access_status: ACCESS_STATUSES,
        relationship_type: intel.RELATIONSHIP_TYPES,
      });
    } catch (err) { fail(res, err, 'intel/facets'); }
  });

  // Family view: sources grouped by the family key derived from their path.
  router.get('/api/private/intel/families', requireReviewer, async (req, res) => {
    try {
      const sources = await pool.query(
        `SELECT family_key, source_sequence, source_path, material_type, language_scope,
                rights_status, review_state, text_chars
           FROM v13_sources
          WHERE family_key IS NOT NULL
          ORDER BY family_key, source_sequence`);
      const relationships = await pool.query(
        `SELECT family_key, relationship_type, COUNT(*)::int AS total
           FROM private_source_relationships
          WHERE family_key IS NOT NULL
          GROUP BY family_key, relationship_type`);
      const byFamily = new Map();
      for (const row of sources.rows) {
        let entry = byFamily.get(row.family_key);
        if (!entry) {
          entry = { family_key: row.family_key, members: [], relationships: {}, relationship_total: 0 };
          byFamily.set(row.family_key, entry);
        }
        entry.members.push({
          kind: 'v13_source',
          ref: String(row.source_sequence),
          label: intel.pathParts(row.source_path).file,
          material_type: row.material_type,
          language_scope: row.language_scope,
          rights_status: row.rights_status,
          review_state: row.review_state,
          text_chars: row.text_chars == null ? null : Number(row.text_chars),
        });
      }
      for (const row of relationships.rows) {
        const entry = byFamily.get(row.family_key);
        if (!entry) continue;
        entry.relationships[row.relationship_type] = row.total;
        entry.relationship_total += row.total;
      }
      const onlyRelated = req.query.related === '1';
      const families = Array.from(byFamily.values())
        .filter(entry => (onlyRelated ? entry.relationship_total > 0 : entry.members.length > 1 || entry.relationship_total > 0))
        .sort((a, b) => (b.relationship_total - a.relationship_total) ||
          (b.members.length - a.members.length) || a.family_key.localeCompare(b.family_key));
      res.json({ total: families.length, families });
    } catch (err) { fail(res, err, 'intel/families'); }
  });

  // Source detail: immutable provenance, relationships and corroborating
  // spellings. Text bodies stay out of this response.
  async function sendSourceDetail(req, res) {
      const sequence = parseInt(req.params.sequence, 10);
      if (!Number.isInteger(sequence)) return res.status(400).json({ error: 'Invalid source reference' });
      const source = await pool.query(
        `SELECT * FROM v13_sources WHERE source_sequence = $1`, [sequence]);
      if (!source.rows[0]) return res.status(404).json({ error: 'Source not found' });
      const row = source.rows[0];
      const [relationships, rights, extent, decisions] = await Promise.all([
        pool.query(
          `SELECT * FROM private_source_relationships
            WHERE (left_source_kind = 'v13_source' AND left_source_ref = $1)
               OR (right_source_kind = 'v13_source' AND right_source_ref = $1)
            ORDER BY confidence DESC, pair_key`, [String(sequence)]),
        pool.query(`SELECT * FROM v13_rights_reviews WHERE source_sequence = $1`, [sequence]),
        pool.query(
          `SELECT COUNT(*)::int AS candidates,
                  MIN(source_unit) AS first_unit, MAX(source_unit) AS last_unit,
                  MIN(source_line) AS first_line, MAX(source_line) AS last_line
             FROM v13_candidates WHERE source_sequence = $1`, [sequence]),
        pool.query(
          `SELECT decision_type, from_value, to_value, note, decided_by_name, decided_by_role, created_at
             FROM private_review_decisions
            WHERE subject_kind = 'v13_source' AND subject_id = $1
            ORDER BY created_at DESC LIMIT 50`, [String(sequence)]),
      ]);
      const spellings = await intel.corroboratingSpellings(pool, sequence, { publicForms: publicForms() });
      res.json({
        source: {
          kind: 'v13_source',
          ref: String(row.source_sequence),
          label: intel.pathParts(row.source_path).file,
          material_type: row.material_type,
          language_scope: row.language_scope,
          extraction_quality: row.extraction_quality,
          extraction_status: row.extraction_status,
          family_key: row.family_key,
          derived_route: row.derived_route,
          corpus_role: row.corpus_role,
          recommended_use: row.recommended_use,
          priority: row.priority,
          rights_status: row.rights_status,
          review_state: row.review_state,
          access_status: row.access_status,
          training_ready: row.training_ready,
          public_search_eligible: row.public_search_eligible,
        },
        // Provenance is copied verbatim from the received package and is
        // never edited by a reviewer decision.
        provenance: {
          source_path: row.source_path,
          file_digest: row.source_sha256,
          source_sequence: row.source_sequence,
          declared_rights_status: row.declared_rights_status,
          source_urls: row.source_urls || [],
          extracted_text_relpath: row.extracted_text_relpath,
          bytes: row.bytes == null ? null : Number(row.bytes),
          text_chars: row.text_chars == null ? null : Number(row.text_chars),
          word_count: row.word_count == null ? null : Number(row.word_count),
          duplicate_group: row.duplicate_group,
          canonical_duplicate: row.canonical_duplicate,
          candidate_count: extent.rows[0].candidates,
          unit_range: [extent.rows[0].first_unit, extent.rows[0].last_unit],
          line_range: [extent.rows[0].first_line, extent.rows[0].last_line],
        },
        rights_review: rights.rows[0] || null,
        relationships: relationships.rows.map(shapeRelationship),
        corroborating_spellings: spellings,
        decisions: decisions.rows,
      });
  }

  router.get('/api/private/intel/sources/:sequence', requireReviewer, async (req, res) => {
    try { await sendSourceDetail(req, res); } catch (err) { fail(res, err, 'intel/source-detail'); }
  });

  // ── The four independent decisions on a private source ─────
  // Server-side gates, not UI gates:
  //   * accepting a review is expert-only
  //   * public access requires expert + cleared rights + accepted review
  //   * training readiness requires the same, independently asserted
  async function applySourceDecisions(req, res) {
    const sequence = parseInt(req.params.sequence, 10);
    if (!Number.isInteger(sequence)) return res.status(400).json({ error: 'Invalid source reference' });
    const body = req.body || {};
    const note = clean(body.note, 2000);

    const current = await pool.query('SELECT * FROM v13_sources WHERE source_sequence = $1', [sequence]);
    if (!current.rows[0]) return res.status(404).json({ error: 'Source not found' });
    const row = current.rows[0];

    const wanted = {
      rights: body.rights_status === undefined ? null : String(body.rights_status),
      access: body.access_status === undefined ? null : String(body.access_status),
      review: body.review_state === undefined ? null : String(body.review_state),
      training: body.training_ready === undefined ? null : Boolean(body.training_ready),
    };
    if (wanted.rights && !RIGHTS_STATUSES.includes(wanted.rights)) {
      return res.status(400).json({ error: 'Unknown rights status' });
    }
    if (wanted.access && !ACCESS_STATUSES.includes(wanted.access)) {
      return res.status(400).json({ error: 'Unknown access status' });
    }
    if (wanted.review && !REVIEW_STATES.includes(wanted.review)) {
      return res.status(400).json({ error: 'Unknown review state' });
    }
    if (wanted.rights == null && wanted.access == null && wanted.review == null && wanted.training == null) {
      return res.status(400).json({ error: 'No decision was supplied' });
    }

    const isExpert = auth.EXPERT_PLUS.includes(req.identity.role);
    const nextRights = wanted.rights || row.rights_status;
    const nextReview = wanted.review || row.review_state;
    const nextAccess = wanted.access || row.access_status;
    const nextTraining = wanted.training == null ? row.training_ready : wanted.training;

    if (wanted.review === 'accepted_candidate' && !isExpert) {
      return res.status(403).json({
        error: 'Accepting a private source is a verified-expert decision.',
        required_role: 'verified_expert',
      });
    }
    const raisesExposure = (wanted.access === 'public' && row.access_status !== 'public') ||
      (wanted.training === true && !row.training_ready);
    if (raisesExposure) {
      if (!isExpert) {
        return res.status(403).json({
          error: 'Raising the exposure of a private source is a verified-expert decision.',
          required_role: 'verified_expert',
        });
      }
      const blockers = [];
      if (!CLEARED_RIGHTS.includes(nextRights)) blockers.push('rights_not_cleared');
      if (nextReview !== 'accepted_candidate') blockers.push('review_not_accepted');
      if (blockers.length) {
        return res.status(409).json({
          error: 'Rights must be cleared and the review accepted before exposure can be raised.',
          blockers,
        });
      }
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE v13_sources
            SET rights_status = $2, review_state = $3, access_status = $4,
                training_ready = $5, updated_at = now()
          WHERE source_sequence = $1
          RETURNING source_sequence, rights_status, review_state, access_status, training_ready`,
        [sequence, nextRights, nextReview, nextAccess, nextTraining]);
      await client.query(
        `UPDATE v13_rights_reviews
            SET rights_status = $2, review_state = $3, updated_at = now()
          WHERE source_sequence = $1`,
        [sequence, nextRights, nextReview]);

      const logged = [];
      const log = async (type, from, to) => {
        if (String(from) === String(to)) return;
        await client.query(
          `INSERT INTO private_review_decisions
             (subject_kind, subject_id, decision_type, from_value, to_value, note,
              decided_by, decided_by_name, decided_by_role)
           VALUES ('v13_source',$1,$2,$3,$4,$5,$6,$7,$8)`,
          [String(sequence), type, String(from), String(to), note,
           req.identity.id || null, req.identity.name || 'unknown', req.identity.role]);
        logged.push({ decision_type: type, from_value: String(from), to_value: String(to) });
      };
      if (wanted.rights != null) await log('rights', row.rights_status, nextRights);
      if (wanted.access != null) await log('access', row.access_status, nextAccess);
      if (wanted.review != null) await log('review', row.review_state, nextReview);
      if (wanted.training != null) await log('training', row.training_ready, nextTraining);

      await audit(req, 'private_source_decision', 'v13_source', String(sequence),
        { decisions: logged, note }, client);
      await client.query('COMMIT');
      res.json({ source: updated.rows[0], decisions: logged, merged: false });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  router.post('/api/private/intel/sources/:sequence/decisions', requireReviewer, async (req, res) => {
    try { await applySourceDecisions(req, res); } catch (err) { fail(res, err, 'intel/source-decisions'); }
  });

  // ── Relationship candidates ────────────────────────────────
  router.get('/api/private/relationships', requireReviewer, async (req, res) => {
    try {
      const limit = pageLimit(req.query.limit, 50, 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const filter = filterBuilder();
      const add = filter.add;
      if (req.query.relationship_type) add('r.relationship_type = $?', clean(req.query.relationship_type, 60));
      if (req.query.review_state) add('r.review_state = $?', clean(req.query.review_state, 60));
      if (req.query.family_key) add('r.family_key = $?', clean(req.query.family_key, 200));
      if (req.query.origin) add('r.origin = $?', clean(req.query.origin, 60));
      if (req.query.source_ref) {
        add('(r.left_source_ref = $? OR r.right_source_ref = $?)', clean(req.query.source_ref, 60));
      }
      if (req.query.q) {
        add('(r.left_source_label ILIKE $? OR r.right_source_label ILIKE $? OR r.family_key ILIKE $?)',
          '%' + clean(req.query.q, 120) + '%');
      }
      const clause = filter.clause();
      const values = filter.values;
      const total = await pool.query(
        `SELECT COUNT(*)::int AS total FROM private_source_relationships r WHERE ${clause}`, values);
      const rows = await pool.query(
        `SELECT r.*, (SELECT COUNT(*)::int FROM private_alignment_units u
                       WHERE u.relationship_id = r.id) AS alignment_units
           FROM private_source_relationships r
          WHERE ${clause}
          ORDER BY r.confidence DESC, r.pair_key
          LIMIT ${limit} OFFSET ${offset}`, values);
      res.json({
        total: total.rows[0].total,
        limit,
        offset,
        relationships: rows.rows.map(shapeRelationship),
        // Nothing in this list is a validated translation, whatever a
        // reviewer has accepted: acceptance clears a candidate for further
        // work, it does not certify the pair.
        validated: false,
        candidate: true,
      });
    } catch (err) { fail(res, err, 'intel/relationships'); }
  });

  async function loadRelationship(id) {
    const result = await pool.query('SELECT * FROM private_source_relationships WHERE id = $1', [id]);
    return result.rows[0] || null;
  }

  router.get('/api/private/relationships/:id', requireReviewer, async (req, res) => {
    try {
      const row = await loadRelationship(clean(req.params.id, 64));
      if (!row) return res.status(404).json({ error: 'Relationship not found' });
      const refs = [row.left_source_ref, row.right_source_ref]
        .filter(ref => /^\d+$/.test(ref)).map(ref => parseInt(ref, 10));
      const [sources, units, decisions] = await Promise.all([
        refs.length ? pool.query(
          `SELECT source_sequence, source_path, source_sha256, material_type, language_scope,
                  extraction_quality, rights_status, review_state, access_status, text_chars, word_count
             FROM v13_sources WHERE source_sequence = ANY($1::int[]) ORDER BY source_sequence`, [refs])
          : { rows: [] },
        pool.query(
          `SELECT level, cardinality, COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE review_state = 'accepted_candidate')::int AS accepted,
                  COUNT(*) FILTER (WHERE review_state = 'rejected')::int AS rejected
             FROM private_alignment_units WHERE relationship_id = $1
            GROUP BY level, cardinality ORDER BY level, cardinality`, [row.id]),
        pool.query(
          `SELECT decision_type, from_value, to_value, note, decided_by_name, decided_by_role, created_at
             FROM private_review_decisions
            WHERE subject_kind = 'relationship' AND subject_id = $1
            ORDER BY created_at DESC LIMIT 50`, [row.id]),
      ]);
      res.json({
        relationship: shapeRelationship(row),
        sources: sources.rows.map(source => ({
          ref: String(source.source_sequence),
          label: intel.pathParts(source.source_path).file,
          source_path: source.source_path,
          file_digest: source.source_sha256,
          material_type: source.material_type,
          language_scope: source.language_scope,
          extraction_quality: source.extraction_quality,
          rights_status: source.rights_status,
          review_state: source.review_state,
          access_status: source.access_status,
          text_chars: source.text_chars == null ? null : Number(source.text_chars),
          word_count: source.word_count == null ? null : Number(source.word_count),
        })),
        alignment_summary: units.rows,
        decisions: decisions.rows,
      });
    } catch (err) { fail(res, err, 'intel/relationship-detail'); }
  });

  // Accepting a relationship candidate is expert-only; a trusted validator
  // can move it into review or reject it.
  router.post('/api/private/relationships/:id/review', requireReviewer, async (req, res) => {
    try {
      const row = await loadRelationship(clean(req.params.id, 64));
      if (!row) return res.status(404).json({ error: 'Relationship not found' });
      const body = req.body || {};
      const next = String(body.review_state || '');
      if (!REVIEW_STATES.includes(next)) return res.status(400).json({ error: 'Unknown review state' });
      const isExpert = auth.EXPERT_PLUS.includes(req.identity.role);
      if (next === 'accepted_candidate' && !isExpert) {
        return res.status(403).json({
          error: 'Accepting a relationship candidate is a verified-expert decision.',
          required_role: 'verified_expert',
        });
      }
      const note = clean(body.note, 2000);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(
          `UPDATE private_source_relationships
              SET review_state = $2, decided_by_name = $3, decided_at = now(), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [row.id, next, req.identity.name || 'unknown']);
        await client.query(
          `INSERT INTO private_review_decisions
             (subject_kind, subject_id, decision_type, from_value, to_value, note,
              decided_by, decided_by_name, decided_by_role)
           VALUES ('relationship',$1,'review',$2,$3,$4,$5,$6,$7)`,
          [row.id, row.review_state, next, note,
           req.identity.id || null, req.identity.name || 'unknown', req.identity.role]);
        await audit(req, 'private_relationship_review', 'private_source_relationship', row.id,
          { from: row.review_state, to: next, note }, client);
        await client.query('COMMIT');
        res.json({ relationship: shapeRelationship(updated.rows[0]), validated: false, candidate: true });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally { client.release(); }
    } catch (err) { fail(res, err, 'intel/relationship-review'); }
  });

  // ── Alignment ──────────────────────────────────────────────
  router.post('/api/private/relationships/:id/alignment', requireReviewer, async (req, res) => {
    try {
      const row = await loadRelationship(clean(req.params.id, 64));
      if (!row) return res.status(404).json({ error: 'Relationship not found' });
      const regenerate = Boolean((req.body || {}).regenerate);
      if (regenerate && !auth.EXPERT_PLUS.includes(req.identity.role)) {
        return res.status(403).json({
          error: 'Regenerating a stored alignment is a verified-expert decision.',
          required_role: 'verified_expert',
        });
      }
      let result;
      try {
        result = await alignment.generateForRelationship(pool, row, { regenerate });
      } catch (err) {
        if (err.code === 'ALIGNMENT_HAS_DECISIONS') return res.status(409).json({ error: err.message });
        throw err;
      }
      if (result.generated) {
        await audit(req, 'private_alignment_generated', 'private_source_relationship', row.id,
          { units: result.units, counts: result.counts });
      }
      res.json({ ...result, validated: false, candidate: true });
    } catch (err) { fail(res, err, 'intel/alignment-generate'); }
  });

  router.get('/api/private/relationships/:id/alignment', requireReviewer, async (req, res) => {
    try {
      const row = await loadRelationship(clean(req.params.id, 64));
      if (!row) return res.status(404).json({ error: 'Relationship not found' });
      const units = await pool.query(
        `SELECT * FROM private_alignment_units
          WHERE relationship_id = $1
          ORDER BY CASE level WHEN 'section' THEN 0 WHEN 'paragraph' THEN 1 ELSE 2 END, ordinal`,
        [row.id]);
      const byId = new Map();
      const roots = [];
      for (const unit of units.rows) byId.set(unit.id, shapeUnit(unit));
      for (const unit of units.rows) {
        const shaped = byId.get(unit.id);
        if (unit.parent_id && byId.has(unit.parent_id)) byId.get(unit.parent_id).children.push(shaped);
        else roots.push(shaped);
      }
      const cardinalities = {};
      for (const unit of units.rows) {
        cardinalities[unit.cardinality] = (cardinalities[unit.cardinality] || 0) + 1;
      }
      res.json({
        relationship: shapeRelationship(row),
        engine_version: alignment.ENGINE_VERSION,
        total_units: units.rows.length,
        cardinalities,
        sections: roots,
        validated: false,
        candidate: true,
      });
    } catch (err) { fail(res, err, 'intel/alignment-read'); }
  });

  // Per-unit accept / reject / adjust. Accepting is expert-only; adjusting
  // and rejecting are open to trusted validators and are recorded as human
  // corrections so the engine never overwrites them.
  router.post('/api/private/alignment-units/:id/review', requireReviewer, async (req, res) => {
    try {
      const id = clean(req.params.id, 64);
      const existing = await pool.query('SELECT * FROM private_alignment_units WHERE id = $1', [id]);
      if (!existing.rows[0]) return res.status(404).json({ error: 'Alignment unit not found' });
      const unit = existing.rows[0];
      const body = req.body || {};
      const action = String(body.action || '');
      if (!['accept', 'reject', 'adjust', 'in_review'].includes(action)) {
        return res.status(400).json({ error: 'Unknown action' });
      }
      const isExpert = auth.EXPERT_PLUS.includes(req.identity.role);
      if (action === 'accept' && !isExpert) {
        return res.status(403).json({
          error: 'Accepting an alignment unit is a verified-expert decision.',
          required_role: 'verified_expert',
        });
      }
      let cardinality = unit.cardinality;
      if (action === 'adjust') {
        if (body.cardinality !== undefined) {
          if (!CARDINALITIES.includes(String(body.cardinality))) {
            return res.status(400).json({ error: 'Unknown cardinality' });
          }
          cardinality = String(body.cardinality);
        }
      }
      const nextState = action === 'accept' ? 'accepted_candidate'
        : action === 'reject' ? 'rejected'
          : action === 'in_review' ? 'in_review' : 'in_review';
      const note = clean(body.note, 2000);

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(
          `UPDATE private_alignment_units
              SET review_state = $2, cardinality = $3, adjusted = $4, reviewer_note = COALESCE($5, reviewer_note),
                  decided_by = $6, decided_by_name = $7, decided_by_role = $8,
                  decided_at = now(), updated_at = now()
            WHERE id = $1 RETURNING *`,
          [id, nextState, cardinality, action === 'adjust' ? true : unit.adjusted, note,
           req.identity.id || null, req.identity.name || 'unknown', req.identity.role]);
        await client.query(
          `INSERT INTO private_review_decisions
             (subject_kind, subject_id, decision_type, from_value, to_value, note,
              decided_by, decided_by_name, decided_by_role)
           VALUES ('alignment_unit',$1,'review',$2,$3,$4,$5,$6,$7)`,
          [id, unit.review_state + (unit.cardinality === cardinality ? '' : '/' + unit.cardinality),
           nextState + (unit.cardinality === cardinality ? '' : '/' + cardinality), note,
           req.identity.id || null, req.identity.name || 'unknown', req.identity.role]);
        await audit(req, 'private_alignment_unit_review', 'private_alignment_unit', id,
          { action, from: unit.review_state, to: nextState, cardinality, note }, client);
        await client.query('COMMIT');
        res.json({ unit: shapeUnit(updated.rows[0]) });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally { client.release(); }
    } catch (err) { fail(res, err, 'intel/alignment-unit-review'); }
  });

  // ── Rights queue ───────────────────────────────────────────
  router.get('/api/private/rights-queue', requireReviewer, async (req, res) => {
    try {
      const limit = pageLimit(req.query.limit, 25, 100);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const filter = filterBuilder();
      const add = filter.add;
      if (req.query.review_state) add('q.review_state = $?', clean(req.query.review_state, 60));
      if (req.query.rights_status) add('q.rights_status = $?', clean(req.query.rights_status, 60));
      if (req.query.material_type) add('q.material_type = $?', clean(req.query.material_type, 120));
      if (req.query.required_action) add('q.required_action = $?', clean(req.query.required_action, 200));
      if (req.query.q) {
        add('(q.source_path ILIKE $? OR q.material_type ILIKE $?)', '%' + clean(req.query.q, 120) + '%');
      }
      const clause = filter.clause();
      const values = filter.values;
      const total = await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE q.review_state = 'source_import_unreviewed')::int AS open
           FROM v13_rights_reviews q WHERE ${clause}`, values);
      const rows = await pool.query(
        `SELECT q.source_sequence, q.source_path, q.source_sha256, q.material_type, q.required_action,
                q.declared_rights_status, q.rights_status, q.review_state, q.canonical_duplicate,
                s.access_status, s.training_ready, s.family_key, s.extraction_quality, s.language_scope,
                s.text_chars, s.priority
           FROM v13_rights_reviews q
           LEFT JOIN v13_sources s ON s.source_sequence = q.source_sequence
          WHERE ${clause}
          ORDER BY q.source_sequence
          LIMIT ${limit} OFFSET ${offset}`, values);
      res.json({
        total: total.rows[0].total,
        open: total.rows[0].open,
        limit,
        offset,
        items: rows.rows.map(row => ({
          ref: String(row.source_sequence),
          label: intel.pathParts(row.source_path).file,
          folder: intel.pathParts(row.source_path).folder,
          material_type: row.material_type,
          required_action: row.required_action,
          declared_rights_status: row.declared_rights_status,
          rights_status: row.rights_status,
          review_state: row.review_state,
          access_status: row.access_status,
          training_ready: row.training_ready,
          family_key: row.family_key,
          extraction_quality: row.extraction_quality,
          language_scope: row.language_scope,
          text_chars: row.text_chars == null ? null : Number(row.text_chars),
          priority: row.priority,
          canonical_duplicate: row.canonical_duplicate,
          file_digest: row.source_sha256,
        })),
      });
    } catch (err) { fail(res, err, 'intel/rights-queue'); }
  });

  router.get('/api/private/rights-queue/facets', requireReviewer, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT DISTINCT material_type, required_action FROM v13_rights_reviews`);
      res.json({
        material_type: Array.from(new Set(result.rows.map(row => row.material_type).filter(Boolean))).sort(),
        required_action: Array.from(new Set(result.rows.map(row => row.required_action).filter(Boolean))).sort(),
        rights_status: RIGHTS_STATUSES,
        review_state: REVIEW_STATES,
        access_status: ACCESS_STATUSES,
      });
    } catch (err) { fail(res, err, 'intel/rights-facets'); }
  });

  // The queue item shares the source-detail shape so the reviewer sees the
  // same immutable provenance and corroborating spellings in both screens.
  router.get('/api/private/rights-queue/:sequence', requireReviewer, async (req, res) => {
    try { await sendSourceDetail(req, res); } catch (err) { fail(res, err, 'intel/rights-queue-item'); }
  });

  router.post('/api/private/rights-queue/:sequence/decisions', requireReviewer, async (req, res) => {
    try { await applySourceDecisions(req, res); } catch (err) { fail(res, err, 'intel/rights-decisions'); }
  });

  // ── Re-run the deterministic scan ──────────────────────────
  router.post('/api/private/intel/scan', requireExpert, async (req, res) => {
    try {
      const force = Boolean((req.body || {}).force);
      const result = await intel.scan(pool, { publicForms: publicForms(), force });
      await audit(req, 'private_intel_scan', 'private_source_relationship', 'scan',
        { force, proposals: result.proposals, sources: result.sources_scanned });
      res.json(result);
    } catch (err) { fail(res, err, 'intel/scan'); }
  });

  return router;
};
