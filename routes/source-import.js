'use strict';

// Private source-import review API.
//
// Boundaries this router enforces:
//   * Candidate CONTENT is never public. Only authorized reviewers
//     (trusted validator / verified expert / administrator) can read it.
//   * Rights, access, review and training are four separate decisions. A
//     candidate only becomes training-eligible when rights are cleared, the
//     review accepted it, consent is settled and an expert says so.
//   * The training export fails closed: it emits a row only when all four
//     decisions are positive, so an unreviewed import can never leak.
//   * Duplicates are linked as corroboration; nothing is merged into the
//     canonical corpus here.

const express = require('express');
const auth = require('../lib/auth');
const sourceImport = require('../lib/source-import');
const v13 = require('../lib/source-import-v13');

const ACCESS_STATUSES = ['private_research', 'restricted', 'public'];
const RIGHTS_STATUSES = ['permission_pending', 'permission_granted', 'public_domain', 'restricted'];
const REVIEW_STATES = ['source_import_unreviewed', 'in_review', 'accepted_candidate', 'rejected'];
const CONSENT_STATUSES = ['unknown', 'not_applicable', 'documented', 'withheld'];
const RELATIONS = ['corroborates', 'conflicts'];

const CLEARED_RIGHTS = ['permission_granted', 'public_domain'];
const SETTLED_CONSENT = ['documented', 'not_applicable'];

// `verification` and `packages` are read through getters: the private
// packages are restored and verified asynchronously after boot, so the router
// must always read the current state rather than a snapshot taken at mount.
module.exports = function createSourceImportRouter({ pool, verification, packages }) {
  const router = express.Router();
  const { requireRole } = auth.makeMiddleware(pool);
  const requireReviewer = requireRole(auth.TRUSTED_PLUS);
  const requireExpert = requireRole(auth.EXPERT_PLUS);
  const currentVerification = () => (typeof verification === 'function' ? verification() : verification);
  const currentPackages = () => (typeof packages === 'function' ? packages() : packages) || null;

  const clean = (v, max) => (v == null ? null : String(v).slice(0, max));

  const audit = (req, eventType, targetId, payload, executor = pool) => executor.query(
    `INSERT INTO audit_events (actor_type, actor_id, actor_name, event_type, target_type, target_id, payload)
     VALUES ($1,$2,$3,$4,'source_import_candidate',$5,$6)`,
    [req.identity.type, req.identity.id || null, req.identity.name || null,
     eventType, targetId, payload ? JSON.stringify(payload) : null]);

  // ── Public, content-free status ────────────────────────────
  // Counts and states only: what was audited, what was verified, what is
  // still blocked. No candidate text is reachable without authorization.
  router.get('/api/source-import/status', async (req, res) => {
    try {
      const status = sourceImport.publicStatus(currentVerification());
      const batches = await pool.query(
        `SELECT source_id, verification_status, imported_count, expected_count,
                declared_count, metrics, created_at
           FROM source_import_batches ORDER BY source_id`);
      const stored = new Map(batches.rows.map(row => [row.source_id, row]));
      const counts = await pool.query(
        `SELECT source_id,
                COUNT(*)::int AS candidates,
                COUNT(*) FILTER (WHERE review_state <> 'source_import_unreviewed')::int AS reviewed,
                COUNT(*) FILTER (WHERE access_status = 'public')::int AS public_candidates,
                COUNT(*) FILTER (WHERE training_ready)::int AS training_ready
           FROM source_import_candidates GROUP BY source_id`);
      const byCount = new Map(counts.rows.map(row => [row.source_id, row]));
      res.json({
        ...status,
        sources: status.sources.map(source => {
          const batch = stored.get(source.source_id) || null;
          const tally = byCount.get(source.source_id) || null;
          return {
            ...source,
            imported_record_count: tally ? tally.candidates : 0,
            reviewed_record_count: tally ? tally.reviewed : 0,
            public_record_count: tally ? tally.public_candidates : 0,
            training_ready_record_count: tally ? tally.training_ready : 0,
            imported_at: batch ? batch.created_at : null,
          };
        }),
      });
    } catch (err) {
      console.error('source-import/status:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── Authenticated private-package status ───────────────────
  // Operational detail about the private packages: whether each one is
  // present, where it was restored from, whether its archive digest checked
  // out, declared vs staged counts, and the verbatim reason a package is
  // blocked. This names files and reasons, so it needs authorization; the
  // public status endpoint above stays content- and path-free.
  router.get('/api/source-import/packages', requireReviewer, async (req, res) => {
    try {
      const report = currentPackages();
      if (!report) {
        return res.json({
          storage_backend: null, ready: false,
          message: 'The private packages have not finished preparing yet.',
          packages: [],
        });
      }
      const staged = await v13.stagedCounts(pool).catch(() => null);
      const v12Counts = await pool.query(
        `SELECT COUNT(*)::int AS candidates,
                COUNT(*) FILTER (WHERE access_status = 'public')::int AS public_candidates,
                COUNT(*) FILTER (WHERE training_ready)::int AS training_ready
           FROM source_import_candidates`);
      res.json({
        storage_backend: report.backend,
        ready: true,
        policy_defaults: v13.REQUIRED_POLICY,
        packages: report.packages.map(entry => ({
          package_id: entry.package_id,
          package_label: entry.package_label,
          present: entry.present,
          restore_source: entry.restore_source,
          archive_sha256: entry.archive_sha256,
          archive_in_persistent_storage: entry.archive_in_persistent_storage,
          archive_digest_verified: entry.archive_digest_verified,
          archive_uploaded_this_boot: entry.archive_uploaded_this_boot,
          verification_status: entry.verification_status,
          verification_cache_hit: entry.verification_cache_hit,
          content_key: entry.content_key,
          blocked_reason: entry.blocked_reason,
          declared_counts: entry.declared_counts,
          verified_counts: entry.verified_counts,
          staged_counts: entry.package_id === 'v1.3'
            ? staged
            : { staged_private_candidates: v12Counts.rows[0].candidates },
          public_candidates: entry.package_id === 'v1.3'
            ? (staged ? staged.public_search_eligible : null)
            : v12Counts.rows[0].public_candidates,
          training_ready: entry.package_id === 'v1.3'
            ? (staged ? staged.training_ready : null)
            : v12Counts.rows[0].training_ready,
        })),
      });
    } catch (err) {
      console.error('source-import/packages:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // ── Authorized candidate review workflow ───────────────────
  const candidatePublic = row => ({
    id: row.id, source_id: row.source_id, layer: row.layer,
    candidate_ref: row.candidate_ref,
    lak_text: row.lak_text, ru_text: row.ru_text, gloss: row.gloss,
    ocr_text: row.ocr_text, title: row.title,
    row_ref: row.row_ref, page_ref: row.page_ref, collection_ref: row.collection_ref,
    provenance: row.provenance,
    access_status: row.access_status, rights_status: row.rights_status,
    review_state: row.review_state, consent_status: row.consent_status,
    training_ready: row.training_ready,
    created_at: row.created_at, updated_at: row.updated_at,
  });

  router.get('/api/source-import/candidates', requireReviewer, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const sourceId = req.query.source_id ? String(req.query.source_id).slice(0, 100) : null;
      const reviewState = REVIEW_STATES.includes(req.query.review_state) ? req.query.review_state : null;
      const rows = await pool.query(
        `SELECT * FROM source_import_candidates
          WHERE ($1::text IS NULL OR source_id = $1)
            AND ($2::text IS NULL OR review_state = $2)
          ORDER BY source_id, candidate_ref
          LIMIT $3 OFFSET $4`,
        [sourceId, reviewState, limit, offset]);
      const total = await pool.query(
        `SELECT COUNT(*)::int AS n FROM source_import_candidates
          WHERE ($1::text IS NULL OR source_id = $1)
            AND ($2::text IS NULL OR review_state = $2)`,
        [sourceId, reviewState]);
      res.json({ total: total.rows[0].n, limit, offset, candidates: rows.rows.map(candidatePublic) });
    } catch (err) {
      console.error('source-import/candidates:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.get('/api/source-import/candidates/:id', requireReviewer, async (req, res) => {
    try {
      const row = await pool.query('SELECT * FROM source_import_candidates WHERE id = $1', [req.params.id]);
      if (!row.rows[0]) return res.status(404).json({ error: 'Candidate not found.' });
      const [decisions, links] = await Promise.all([
        pool.query(
          `SELECT decision_type, from_value, to_value, note, decided_by_name, decided_by_role, created_at
             FROM source_import_decisions WHERE candidate_id = $1 ORDER BY created_at`, [req.params.id]),
        pool.query(
          `SELECT related_kind, related_candidate_id, related_record_id, relation, note, linked_by_name, created_at
             FROM source_import_corroborations WHERE candidate_id = $1 ORDER BY created_at`, [req.params.id]),
      ]);
      res.json({
        candidate: candidatePublic(row.rows[0]),
        decisions: decisions.rows,
        corroborations: links.rows,
      });
    } catch (err) {
      console.error('source-import/candidate:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Record a review decision. Each request carries one or more of the four
  // independent decisions; every change is logged immutably.
  router.post('/api/source-import/candidates/:id/review', requireReviewer, async (req, res) => {
    try {
      const body = req.body || {};
      const current = await pool.query('SELECT * FROM source_import_candidates WHERE id = $1', [req.params.id]);
      const candidate = current.rows[0];
      if (!candidate) return res.status(404).json({ error: 'Candidate not found.' });

      const changes = [];
      const invalid = (field, allowed) =>
        res.status(400).json({ error: `${field} must be one of: ${allowed.join(', ')}` });

      if (body.rights_status !== undefined) {
        if (!RIGHTS_STATUSES.includes(body.rights_status)) return invalid('rights_status', RIGHTS_STATUSES);
        changes.push(['rights', 'rights_status', body.rights_status]);
      }
      if (body.consent_status !== undefined) {
        if (!CONSENT_STATUSES.includes(body.consent_status)) return invalid('consent_status', CONSENT_STATUSES);
        changes.push(['rights', 'consent_status', body.consent_status]);
      }
      if (body.review_state !== undefined) {
        if (!REVIEW_STATES.includes(body.review_state)) return invalid('review_state', REVIEW_STATES);
        changes.push(['review', 'review_state', body.review_state]);
      }
      if (body.access_status !== undefined) {
        if (!ACCESS_STATUSES.includes(body.access_status)) return invalid('access_status', ACCESS_STATUSES);
        changes.push(['access', 'access_status', body.access_status]);
      }
      if (body.training_ready !== undefined) {
        if (typeof body.training_ready !== 'boolean')
          return res.status(400).json({ error: 'training_ready must be a boolean.' });
        changes.push(['training', 'training_ready', body.training_ready]);
      }
      if (!changes.length)
        return res.status(400).json({ error: 'Provide at least one of rights_status, consent_status, review_state, access_status, training_ready.' });

      // Resulting state after applying the requested changes.
      const next = { ...candidate };
      for (const [, column, value] of changes) next[column] = value;

      // Publishing or training-enabling requires expert authority plus cleared
      // rights, a settled consent record and an accepted review — fail closed.
      const raisesExposure =
        (next.access_status === 'public' && candidate.access_status !== 'public') ||
        (next.training_ready === true && candidate.training_ready !== true);
      if (raisesExposure) {
        if (!auth.EXPERT_PLUS.includes(req.identity.role))
          return res.status(403).json({
            error: 'Publishing a candidate or marking it training-ready requires a verified expert or administrator.' });
        if (!CLEARED_RIGHTS.includes(next.rights_status))
          return res.status(409).json({
            error: 'Rights must be granted or public domain before a candidate may be published or used for training.' });
        if (next.review_state !== 'accepted_candidate')
          return res.status(409).json({
            error: 'The candidate must be accepted in review before it may be published or used for training.' });
        if (!SETTLED_CONSENT.includes(next.consent_status))
          return res.status(409).json({
            error: 'Consent must be documented or explicitly not applicable before publication or training use.' });
      }

      // The state change, its immutable decision log and the audit trail are
      // written together: a candidate must never move without its record of
      // who moved it and why.
      const db = await pool.connect();
      let updated;
      try {
        await db.query('BEGIN');
        updated = await db.query(
          `UPDATE source_import_candidates
              SET rights_status = $2, consent_status = $3, review_state = $4,
                  access_status = $5, training_ready = $6, updated_at = now()
            WHERE id = $1 RETURNING *`,
          [candidate.id, next.rights_status, next.consent_status, next.review_state,
           next.access_status, next.training_ready]);

        for (const [decisionType, column, value] of changes) {
          if (String(candidate[column]) === String(value)) continue;
          await db.query(
            `INSERT INTO source_import_decisions
               (candidate_id, decision_type, from_value, to_value, note,
                decided_by, decided_by_name, decided_by_role)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [candidate.id, decisionType, String(candidate[column]), String(value),
             clean(body.note, 1000), req.identity.id || null,
             req.identity.name || 'unknown', req.identity.role]);
        }
        await audit(req, 'source_import_review', candidate.id,
          { changes: changes.map(([type, column, value]) => ({ type, column, value })) }, db);
        await db.query('COMMIT');
      } catch (err) {
        await db.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        db.release();
      }

      res.json({ candidate: candidatePublic(updated.rows[0]) });
    } catch (err) {
      console.error('source-import/review:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Link a duplicate as corroboration. This never rewrites either record.
  router.post('/api/source-import/candidates/:id/corroborations', requireReviewer, async (req, res) => {
    try {
      const body = req.body || {};
      const relation = RELATIONS.includes(body.relation) ? body.relation : 'corroborates';
      const candidate = await pool.query('SELECT id FROM source_import_candidates WHERE id = $1', [req.params.id]);
      if (!candidate.rows[0]) return res.status(404).json({ error: 'Candidate not found.' });

      const relatedCandidateId = body.related_candidate_id ? String(body.related_candidate_id).slice(0, 100) : null;
      const relatedRecordId = body.related_record_id ? String(body.related_record_id).slice(0, 200) : null;
      if (!relatedCandidateId && !relatedRecordId)
        return res.status(400).json({ error: 'Provide related_candidate_id or related_record_id.' });
      if (relatedCandidateId && relatedRecordId)
        return res.status(400).json({ error: 'Link either another candidate or a corpus record, not both.' });
      if (relatedCandidateId === req.params.id)
        return res.status(400).json({ error: 'A candidate cannot corroborate itself.' });
      if (relatedCandidateId) {
        const related = await pool.query('SELECT id FROM source_import_candidates WHERE id = $1', [relatedCandidateId]);
        if (!related.rows[0]) return res.status(400).json({ error: 'Unknown related_candidate_id.' });
      }

      const relatedKind = relatedCandidateId ? 'candidate' : 'corpus_record';
      const relatedKey = relatedCandidateId || relatedRecordId;
      const inserted = await pool.query(
        `INSERT INTO source_import_corroborations
           (candidate_id, related_kind, related_candidate_id, related_record_id,
            related_key, relation, note, linked_by, linked_by_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (candidate_id, related_kind, related_key, relation) DO NOTHING
         RETURNING id, related_kind, related_candidate_id, related_record_id, relation, note, created_at`,
        [req.params.id, relatedKind, relatedCandidateId, relatedRecordId, relatedKey,
         relation, clean(body.note, 1000), req.identity.id || null, req.identity.name || null]);

      await audit(req, 'source_import_corroboration', req.params.id,
        { related_kind: relatedKind, related_key: relatedKey, relation });

      // Duplicates are linked, never merged: both rows keep their own state.
      res.json({
        corroboration: inserted.rows[0] || null,
        already_linked: inserted.rows.length === 0,
        merged: false,
      });
    } catch (err) {
      console.error('source-import/corroboration:', err.message);
      res.status(500).json({ error: 'Server error' });
    }
  });

  // Training export — fails closed on every dimension.
  router.get('/api/source-import/export.jsonl', requireExpert, async (req, res) => {
    try {
      const rows = await pool.query(
        `SELECT source_id, candidate_ref, lak_text, ru_text, gloss, provenance
           FROM source_import_candidates
          WHERE training_ready = TRUE
            AND access_status = 'public'
            AND review_state = 'accepted_candidate'
            AND rights_status IN ('permission_granted','public_domain')
            AND consent_status IN ('documented','not_applicable')
          ORDER BY source_id, candidate_ref`);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="lak-source-import-training.jsonl"');
      res.send(rows.rows.map(row => JSON.stringify(row)).join('\n'));
    } catch (err) {
      console.error('source-import/export:', err.message);
      res.status(500).json({ error: 'Export failed' });
    }
  });

  return router;
};
