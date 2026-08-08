'use strict';

const express = require('express');
const auth = require('../lib/auth');
const { requireFeature, normalizeLak, normalizeLakVariants, parsePagination } = require('../lib/corpus-v2');
const { applyExpertDecision } = require('../lib/morphology-review');
const { stemKey } = require('../lib/russian-morphology');

const PUBLIC_SOURCE = `s.public_search_allowed = TRUE AND s.access_status = 'public'
  AND s.rights_status IN ('open_license','public_domain','permission_recorded')`;
const PUBLIC_SOURCE_SRC = `src.public_search_allowed = TRUE AND src.access_status = 'public'
  AND src.rights_status IN ('open_license','public_domain','permission_recorded')`;

module.exports = function createCorpusV2Router({ pool }) {
  const router = express.Router();
  const { requireAccount, requireRole } = auth.makeMiddleware(pool);
  router.use('/api/corpus/v2', requireFeature);
  router.use('/api/morphology', requireFeature);

  router.get('/api/corpus/v2/status', async (req, res) => {
    try {
      const batch = (await pool.query(
        `SELECT schema_version, importer_version, observed_counts, finished_at
           FROM corpus_import_batches WHERE source_id='pcmlbe' AND status='imported'
          ORDER BY finished_at DESC LIMIT 1`)).rows[0];
      const lexicon = (await pool.query(`SELECT schema_version,observed_counts,finished_at FROM lexicon_import_batches WHERE status='imported' ORDER BY finished_at DESC LIMIT 1`)).rows[0];
      res.json({ enabled: true, ready: !!batch && !!lexicon, source: batch ? {
        id: 'pcmlbe', license: 'CC-BY-SA-4.0', persistent_id: 'http://hdl.handle.net/21.11114/COLL-0000-0021-959C-3',
      } : null, batch: batch || null, lexicon: lexicon || null });
    } catch (error) {
      console.error('corpus v2 status:', error.message);
      res.status(503).json({ enabled: true, ready: false, error: 'Corpus v2 schema or import is not ready.' });
    }
  });

  router.get('/api/corpus/v2/dictionary', async (req, res) => {
    const query = normalizeLak(req.query.q);
    if (!query) return res.status(400).json({ error: 'q is required' });
    const { page, limit, offset } = parsePagination(req.query);
    const russianStem = stemKey(query);
    try {
      const result = await pool.query(
        `WITH matches AS (
           SELECT DISTINCT ON (st.entry_id) st.entry_id,st.term_original,st.term_normalized,st.term_type,
                  CASE WHEN st.term_normalized=$1 THEN 3 WHEN st.language_code='ru' AND st.stem_key=$2 THEN 2 ELSE 1 END match_level,
                  st.weight
             FROM lexicon_search_terms st JOIN lexicon_entries e ON e.id=st.entry_id JOIN corpus_sources src ON src.id=e.source_id
            WHERE ${PUBLIC_SOURCE_SRC} AND (st.term_normalized=$1 OR (NULLIF($2,'') IS NOT NULL AND st.language_code='ru' AND st.stem_key=$2) OR st.term_normalized LIKE $1 || '%')
            ORDER BY st.entry_id,match_level DESC,st.weight DESC
         ), ranked AS (
           SELECT e.*,m.term_original AS matched_term,m.term_type,m.match_level,m.weight,
                  COALESCE(array_agg(DISTINCT l.id) FILTER (WHERE l.id IS NOT NULL),ARRAY[]::text[]) lemma_ids,
                  COALESCE(array_agg(DISTINCT l.display_form) FILTER (WHERE l.id IS NOT NULL),ARRAY[]::text[]) lak_lemmas,
                  COALESCE(array_agg(DISTINCT s.gloss_ru) FILTER (WHERE s.gloss_ru IS NOT NULL),ARRAY[]::text[]) glosses_ru,
                  COALESCE(array_agg(DISTINCT s.gloss_en) FILTER (WHERE s.gloss_en IS NOT NULL),ARRAY[]::text[]) glosses_en,
                  src.title source_title,src.attribution_text,COUNT(*) OVER()::int total
             FROM matches m JOIN lexicon_entries e ON e.id=m.entry_id JOIN corpus_sources src ON src.id=e.source_id
             LEFT JOIN lexicon_entry_lemmas el ON el.entry_id=e.id LEFT JOIN corpus_lemma_keys l ON l.id=el.lemma_key_id
             LEFT JOIN lexicon_senses s ON s.entry_id=e.id
            GROUP BY e.id,m.term_original,m.term_type,m.match_level,m.weight,src.title,src.attribution_text
         ) SELECT * FROM ranked ORDER BY match_level DESC,weight DESC,headword_normalized,homonym_number NULLS FIRST,id LIMIT $3 OFFSET $4`,
        [query, russianStem, limit, offset]);
      const total = result.rows[0]?.total || 0;
      res.set('Cache-Control','no-store');
      res.json({ query:req.query.q, normalized_query:query, russian_stem:russianStem, total,page,pages:Math.max(1,Math.ceil(total/limit)),limit,
        rows:result.rows.map(({total:ignored,...row})=>row) });
    } catch (error) { console.error('dictionary search:',error.message); res.status(500).json({ error:'Dictionary search failed.' }); }
  });

  router.get('/api/corpus/v2/facets', async (req, res) => {
    try {
      const [tags, pos, features] = await Promise.all([
        pool.query(`SELECT a.raw_tag AS value, COUNT(*)::int AS count FROM corpus_token_analyses a JOIN corpus_tokens t ON t.id=a.token_id JOIN corpus_segments g ON g.id=t.segment_id JOIN corpus_documents d ON d.id=g.document_id JOIN corpus_sources s ON s.id=d.source_id WHERE ${PUBLIC_SOURCE} GROUP BY a.raw_tag ORDER BY count DESC, value`),
        pool.query(`SELECT a.source_pos AS value, COUNT(*)::int AS count FROM corpus_token_analyses a JOIN corpus_tokens t ON t.id=a.token_id JOIN corpus_segments g ON g.id=t.segment_id JOIN corpus_documents d ON d.id=g.document_id JOIN corpus_sources s ON s.id=d.source_id WHERE ${PUBLIC_SOURCE} AND a.source_pos IS NOT NULL GROUP BY a.source_pos ORDER BY count DESC, value`),
        pool.query(`SELECT atom AS value, COUNT(*)::int AS count FROM corpus_token_analyses a JOIN corpus_tokens t ON t.id=a.token_id JOIN corpus_segments g ON g.id=t.segment_id JOIN corpus_documents d ON d.id=g.document_id JOIN corpus_sources s ON s.id=d.source_id CROSS JOIN LATERAL unnest(a.source_feature_atoms) atom WHERE ${PUBLIC_SOURCE} GROUP BY atom ORDER BY count DESC, atom`),
      ]);
      res.json({ tags: tags.rows, parts_of_speech: pos.rows, features: features.rows });
    } catch (error) {
      console.error('corpus v2 facets:', error.message);
      res.status(500).json({ error: 'Corpus search failed.' });
    }
  });

  router.get('/api/corpus/v2/search', async (req, res) => {
    const mode = String(req.query.mode || 'wordform');
    if (!['wordform','lemma','grammar'].includes(mode)) return res.status(400).json({ error: 'mode must be wordform, lemma, or grammar' });
    const query = normalizeLak(req.query.q);
    if (!query) return res.status(400).json({ error: 'q is required' });
    const { page, limit, offset } = parsePagination(req.query);
    try {
      const params = [];
      let predicate;
      let joins;
      if (mode === 'wordform') {
        params.push(normalizeLakVariants(req.query.q).map(value => req.query.match === 'prefix' ? `${value}%` : value));
        predicate = req.query.match === 'prefix' ? 'w.normalized_form LIKE ANY($1)' : 'w.normalized_form = ANY($1)';
        joins = `JOIN corpus_wordforms w ON w.id=t.wordform_id LEFT JOIN corpus_token_analyses a ON a.token_id=t.id LEFT JOIN corpus_lemma_keys l ON l.id=a.lemma_key_id`;
      } else if (mode === 'lemma') {
        params.push(normalizeLakVariants(req.query.q).map(value => req.query.match === 'prefix' ? `${value}%` : value));
        predicate = req.query.match === 'prefix' ? 'l.normalized_form LIKE ANY($1)' : 'l.normalized_form = ANY($1)';
        joins = `JOIN corpus_wordforms w ON w.id=t.wordform_id JOIN corpus_token_analyses a ON a.token_id=t.id JOIN corpus_lemma_keys l ON l.id=a.lemma_key_id`;
      } else {
        params.push(String(req.query.q).trim());
        predicate = `(a.raw_tag = $1 OR a.source_pos = $1 OR $1 = ANY(a.source_feature_atoms))`;
        joins = `JOIN corpus_wordforms w ON w.id=t.wordform_id JOIN corpus_token_analyses a ON a.token_id=t.id JOIN corpus_lemma_keys l ON l.id=a.lemma_key_id`;
        if (req.query.definition) {
          params.push(`%${normalizeLak(req.query.definition)}%`);
          predicate += ` AND lower(COALESCE(a.definition,'')) LIKE $2`;
        }
      }
      params.push(limit, offset);
      const result = await pool.query(
        `SELECT t.id AS token_id, t.surface_original AS matched_surface, w.id AS wordform_id,
                w.normalized_form AS wordform, a.id AS analysis_id, l.id AS lemma_id,
                a.lemma_original AS lemma, a.raw_tag, a.source_pos, a.source_feature_atoms,
                a.definition, a.evidence_class, a.review_status,
                g.id AS segment_id, g.legacy_record_id, g.text_original AS context,
                d.id AS document_id, d.title AS document_title, d.author,
                s.id AS source_id, s.title AS source_title, s.spdx_license AS license,
                s.license_url, s.persistent_id, COUNT(*) OVER()::int AS total
           FROM corpus_tokens t ${joins}
           JOIN corpus_segments g ON g.id=t.segment_id
           JOIN corpus_documents d ON d.id=g.document_id
           JOIN corpus_sources s ON s.id=d.source_id
          WHERE ${PUBLIC_SOURCE} AND ${predicate}
          ORDER BY g.id, t.ordinal, a.id NULLS LAST LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params);
      const total = result.rows[0]?.total || 0;
      const rows = result.rows.map(({ total: ignored, ...row }) => ({
        ...row,
        evidence_badge: row.analysis_id ? 'Source annotation' : 'No source analysis',
      }));
      res.json({ mode, query: req.query.q, match: req.query.match === 'prefix' ? 'prefix' : 'exact', total, page, pages: Math.max(1, Math.ceil(total / limit)), limit, rows });
    } catch (error) {
      console.error('corpus v2 search:', error.message);
      res.status(500).json({ error: 'Corpus search failed.' });
    }
  });

  router.get('/api/corpus/v2/lemmas', async (req, res) => {
    const { page, limit, offset } = parsePagination(req.query);
    const query = normalizeLak(req.query.q);
    const params = [];
    let predicate = '';
    if (query) {
      params.push(normalizeLakVariants(req.query.q).map(value => `${value}%`));
      predicate = `AND l.normalized_form LIKE ANY($1)`;
    }
    params.push(limit, offset);
    const limitParam = `$${params.length - 1}`;
    const offsetParam = `$${params.length}`;
    try {
      const result = await pool.query(
        `SELECT l.id AS lemma_id,l.display_form AS lemma,l.normalized_form,
                (SELECT COUNT(DISTINCT t.id)::int FROM corpus_tokens t JOIN corpus_segments g ON g.id=t.segment_id JOIN corpus_documents d ON d.id=g.document_id JOIN corpus_sources s ON s.id=d.source_id LEFT JOIN corpus_token_analyses a ON a.token_id=t.id LEFT JOIN corpus_wordform_lemma_relations r ON r.wordform_id=t.wordform_id WHERE ${PUBLIC_SOURCE} AND (a.lemma_key_id=l.id OR (r.lemma_key_id=l.id AND r.review_status='source_verified'))) annotated_occurrences,
                (SELECT COUNT(DISTINCT w.id)::int FROM corpus_wordforms w LEFT JOIN corpus_token_analyses a ON EXISTS (SELECT 1 FROM corpus_tokens tx WHERE tx.wordform_id=w.id AND tx.id=a.token_id) LEFT JOIN corpus_wordform_lemma_relations r ON r.wordform_id=w.id WHERE a.lemma_key_id=l.id OR (r.lemma_key_id=l.id AND r.review_status='source_verified')) attested_forms,
                COALESCE((SELECT array_agg(DISTINCT e.part_of_speech) FILTER (WHERE e.part_of_speech IS NOT NULL) FROM lexicon_entry_lemmas el JOIN lexicon_entries e ON e.id=el.entry_id WHERE el.lemma_key_id=l.id),ARRAY[]::text[]) parts_of_speech,
                COALESCE((SELECT array_agg(DISTINCT COALESCE(ss.gloss_ru,ss.gloss_en,ss.definition)) FILTER (WHERE COALESCE(ss.gloss_ru,ss.gloss_en,ss.definition) IS NOT NULL) FROM lexicon_entry_lemmas el JOIN lexicon_senses ss ON ss.entry_id=el.entry_id WHERE el.lemma_key_id=l.id),ARRAY[]::text[]) definitions,
                (SELECT COUNT(DISTINCT e.source_id)::int FROM lexicon_entry_lemmas el JOIN lexicon_entries e ON e.id=el.entry_id WHERE el.lemma_key_id=l.id) source_count,
                COUNT(*) OVER()::int total
           FROM corpus_lemma_keys l
          WHERE (EXISTS (SELECT 1 FROM lexicon_entry_lemmas el WHERE el.lemma_key_id=l.id) OR EXISTS (SELECT 1 FROM corpus_token_analyses a WHERE a.lemma_key_id=l.id)) ${predicate}
          ORDER BY source_count DESC,CASE WHEN l.normalized_form ~ '^[А-Яа-яЁёӀӏ]' THEN 0 WHEN l.normalized_form ~ '[А-Яа-яЁёӀӏ]' THEN 1 ELSE 2 END,l.normalized_form,l.id
          LIMIT ${limitParam} OFFSET ${offsetParam}`,
        params);
      const total = result.rows[0]?.total || 0;
      const rows = result.rows.map(({ total: ignored, ...row }) => row);
      res.set('Cache-Control', 'no-store');
      res.json({ mode: 'lemmas', version: 'lemma-index-v2', query: req.query.q || '', total, page, pages: Math.max(1, Math.ceil(total / limit)), limit, rows });
    } catch (error) {
      console.error('corpus v2 lemmas:', error.message);
      res.status(500).json({ error: 'Lemma index failed.' });
    }
  });

  router.get('/api/corpus/v2/lemmas/:id', async (req, res) => {
    const { page, limit, offset } = parsePagination(req.query);
    try {
      const lemma = (await pool.query(`SELECT id,display_form,normalized_form FROM corpus_lemma_keys WHERE id=$1 AND (EXISTS (SELECT 1 FROM lexicon_entry_lemmas WHERE lemma_key_id=$1) OR EXISTS (SELECT 1 FROM corpus_token_analyses WHERE lemma_key_id=$1))`,[req.params.id])).rows[0];
      if (!lemma) return res.status(404).json({ error: 'Lemma not found.' });
      const [forms, occurrenceResult, entryResult, stats] = await Promise.all([
        pool.query(
        `SELECT w.id,w.display_form,w.normalized_form,COALESCE(COUNT(DISTINCT t.id),0)::int occurrences,
                COALESCE(array_agg(DISTINCT atom) FILTER (WHERE atom IS NOT NULL),ARRAY[]::text[]) feature_atoms
           FROM corpus_wordforms w LEFT JOIN corpus_tokens t ON t.wordform_id=w.id
           LEFT JOIN corpus_token_analyses a ON a.token_id=t.id LEFT JOIN corpus_wordform_lemma_relations r ON r.wordform_id=w.id
           LEFT JOIN LATERAL unnest(r.feature_atoms) atom ON TRUE
          WHERE a.lemma_key_id=$1 OR (r.lemma_key_id=$1 AND r.review_status='source_verified') GROUP BY w.id ORDER BY occurrences DESC,w.normalized_form`,[req.params.id]),
        pool.query(
        `SELECT DISTINCT ON (t.id) t.id AS token_id,t.ordinal AS token_ordinal,t.surface_original AS surface,
                a.id AS analysis_id,a.lemma_original AS lemma,a.raw_tag,a.source_pos,
                COALESCE(a.source_feature_atoms,r.feature_atoms) source_feature_atoms,a.definition,
                CASE WHEN a.id IS NOT NULL THEN 'source_annotation' ELSE 'source_dictionary_relation' END evidence_class,
                COALESCE(a.review_status,r.review_status) review_status,
                g.id AS segment_id, g.legacy_record_id, g.text_original AS context,
                g.paragraph, g.section, d.id AS document_id, d.title AS document_title,
                d.author, d.year, d.genre, d.variety, s.id AS source_id,
                s.title AS source_title, s.spdx_license AS license, s.license_url,
                s.persistent_id, COUNT(*) OVER()::int AS total
           FROM corpus_tokens t LEFT JOIN corpus_token_analyses a ON a.token_id=t.id AND a.lemma_key_id=$1
           LEFT JOIN corpus_wordform_lemma_relations r ON r.wordform_id=t.wordform_id AND r.lemma_key_id=$1 AND r.review_status='source_verified'
           JOIN corpus_segments g ON g.id=t.segment_id
           JOIN corpus_documents d ON d.id=g.document_id
           JOIN corpus_sources s ON s.id=d.source_id
          WHERE (a.id IS NOT NULL OR r.id IS NOT NULL) AND ${PUBLIC_SOURCE}
          ORDER BY t.id,a.id NULLS LAST LIMIT $2 OFFSET $3`,
        [req.params.id, limit, offset]),
        pool.query(`SELECT e.id,e.source_entry_ref,e.headword_original,e.homonym_number,e.part_of_speech,e.noun_class,e.source_locator,e.source_url,e.raw_entry,s.title source_title,s.attribution_text,
          COALESCE(json_agg(DISTINCT jsonb_build_object('ordinal',ss.ordinal,'gloss_ru',ss.gloss_ru,'gloss_en',ss.gloss_en,'definition',ss.definition,'raw_sense',ss.raw_sense)) FILTER (WHERE ss.id IS NOT NULL),'[]') senses,
          COALESCE(json_agg(DISTINCT jsonb_build_object('form',f.form_original,'role',f.form_role,'features',f.feature_atoms)) FILTER (WHERE f.id IS NOT NULL),'[]') forms
          FROM lexicon_entry_lemmas el JOIN lexicon_entries e ON e.id=el.entry_id JOIN corpus_sources s ON s.id=e.source_id LEFT JOIN lexicon_senses ss ON ss.entry_id=e.id LEFT JOIN lexicon_forms f ON f.entry_id=e.id WHERE el.lemma_key_id=$1 AND ${PUBLIC_SOURCE} GROUP BY e.id,s.title,s.attribution_text ORDER BY (e.id=$2) DESC,e.headword_normalized,e.homonym_number NULLS FIRST`,[req.params.id,req.query.entry||'']),
        pool.query(`SELECT
          (SELECT COUNT(DISTINCT t.id)::int FROM corpus_tokens t LEFT JOIN corpus_token_analyses a ON a.token_id=t.id LEFT JOIN corpus_wordform_lemma_relations r ON r.wordform_id=t.wordform_id WHERE a.lemma_key_id=$1 OR (r.lemma_key_id=$1 AND r.review_status='source_verified')) occurrences,
          (SELECT COUNT(DISTINCT wordform_id)::int FROM corpus_wordform_lemma_relations WHERE lemma_key_id=$1 AND review_status='source_verified') +
          (SELECT COUNT(DISTINCT t.wordform_id)::int FROM corpus_token_analyses a JOIN corpus_tokens t ON t.id=a.token_id WHERE a.lemma_key_id=$1 AND NOT EXISTS (SELECT 1 FROM corpus_wordform_lemma_relations r WHERE r.wordform_id=t.wordform_id AND r.lemma_key_id=$1 AND r.review_status='source_verified')) forms`,[req.params.id]),
      ]);
      const total = occurrenceResult.rows[0]?.total || 0;
      const occurrences = occurrenceResult.rows.map(({ total: ignored, ...row }) => row);
      res.set('Cache-Control', 'no-store');
      lemma.annotated_occurrences=stats.rows[0].occurrences; lemma.attested_forms=stats.rows[0].forms;
      res.json({ lemma, forms: forms.rows, source_entries:entryResult.rows, occurrences, total, page,
        pages: Math.max(1, Math.ceil(total / limit)), limit });
    } catch (error) { res.status(500).json({ error: 'Corpus lookup failed.' }); }
  });

  router.get('/api/corpus/v2/wordforms/:id', async (req, res) => {
    const { page, limit, offset } = parsePagination(req.query);
    try {
      const wordform = (await pool.query(
        `SELECT w.id, w.display_form, w.normalized_form, COUNT(t.id)::int AS occurrences,
                COUNT(a.id)::int AS source_analyses
           FROM corpus_wordforms w JOIN corpus_tokens t ON t.wordform_id=w.id
           LEFT JOIN corpus_token_analyses a ON a.token_id=t.id JOIN corpus_segments g ON g.id=t.segment_id
           JOIN corpus_documents d ON d.id=g.document_id JOIN corpus_sources s ON s.id=d.source_id
          WHERE w.id=$1 AND ${PUBLIC_SOURCE} GROUP BY w.id`, [req.params.id])).rows[0];
      if (!wordform) return res.status(404).json({ error: 'Wordform not found.' });
      const occurrenceResult = await pool.query(
        `SELECT t.id AS token_id, t.ordinal AS token_ordinal, t.surface_original AS surface,
                a.id AS analysis_id, l.id AS lemma_id, a.lemma_original AS lemma,
                a.raw_tag, a.source_pos, a.source_feature_atoms, a.definition,
                a.evidence_class, a.review_status, g.id AS segment_id,
                g.legacy_record_id, g.text_original AS context, d.id AS document_id,
                d.title AS document_title, d.author, d.year, d.genre, d.variety,
                s.id AS source_id, s.title AS source_title, s.spdx_license AS license,
                s.license_url, s.persistent_id, COUNT(*) OVER()::int AS total
           FROM corpus_tokens t
           LEFT JOIN corpus_token_analyses a ON a.token_id=t.id
           LEFT JOIN corpus_lemma_keys l ON l.id=a.lemma_key_id
           JOIN corpus_segments g ON g.id=t.segment_id
           JOIN corpus_documents d ON d.id=g.document_id
           JOIN corpus_sources s ON s.id=d.source_id
          WHERE t.wordform_id=$1 AND ${PUBLIC_SOURCE}
          ORDER BY d.id, g.ordinal, t.ordinal, a.id NULLS LAST LIMIT $2 OFFSET $3`,
        [req.params.id, limit, offset]);
      const total = occurrenceResult.rows[0]?.total || 0;
      const occurrences = occurrenceResult.rows.map(({ total: ignored, ...row }) => row);
      res.set('Cache-Control', 'no-store');
      res.json({ wordform, occurrences, total, page,
        pages: Math.max(1, Math.ceil(total / limit)), limit });
    } catch (error) { res.status(500).json({ error: 'Corpus lookup failed.' }); }
  });

  router.get('/api/corpus/v2/segments/:id', async (req, res) => {
    try {
      const segment = (await pool.query(
        `SELECT g.id, g.source_segment_ref, g.forest_id, g.legacy_record_id,
                g.paragraph, g.section, g.ordinal, g.text_original,
                g.text_diplomatic, g.text_normalized, g.text_parallel_cyrillic,
                g.translation_en, g.language_code, d.id AS document_id,
                d.title AS document_title, d.author, d.editor, d.bibliography,
                d.year, d.genre, d.variety, d.script, s.id AS source_id,
                s.title AS source_title, s.creator_credit, s.canonical_url,
                s.persistent_id, s.spdx_license AS license, s.license_url,
                s.attribution_text
           FROM corpus_segments g
           JOIN corpus_documents d ON d.id=g.document_id
           JOIN corpus_sources s ON s.id=d.source_id
          WHERE g.id=$1 AND ${PUBLIC_SOURCE}`, [req.params.id])).rows[0];
      if (!segment) return res.status(404).json({ error: 'Corpus occurrence not found.' });
      const tokens = await pool.query(
        `SELECT t.id AS token_id, t.ordinal, t.surface_original AS surface,
                t.raw_tag AS token_source_tag, w.id AS wordform_id,
                w.normalized_form AS wordform, a.id AS analysis_id,
                l.id AS lemma_id, a.lemma_original AS lemma, a.raw_tag,
                a.source_pos, a.source_feature_atoms, a.definition,
                a.evidence_class, a.review_status, a.source_reference
           FROM corpus_tokens t
           JOIN corpus_wordforms w ON w.id=t.wordform_id
           LEFT JOIN corpus_token_analyses a ON a.token_id=t.id
           LEFT JOIN corpus_lemma_keys l ON l.id=a.lemma_key_id
          WHERE t.segment_id=$1 ORDER BY t.ordinal, a.id NULLS LAST`, [req.params.id]);
      res.set('Cache-Control', 'no-store');
      res.json({ segment, tokens: tokens.rows });
    } catch (error) {
      console.error('corpus v2 segment:', error.message);
      res.status(500).json({ error: 'Corpus occurrence lookup failed.' });
    }
  });

  router.get('/api/morphology/proposals', requireAccount, async (req, res) => {
    const { page, limit, offset } = parsePagination(req.query);
    const state = req.query.state ? String(req.query.state) : null;
    try {
      const result = await pool.query(
        `SELECT p.id, w.display_form AS surface, w.normalized_form AS surface_normalized,
                l.display_form AS proposed_lemma, p.proposed_raw_tag, p.method, p.confidence,
                p.support_count, p.frequency, p.state, p.proposal_version,
                COUNT(*) OVER()::int AS total
           FROM morphology_proposals p JOIN corpus_wordforms w ON w.id=p.wordform_id
           JOIN corpus_lemma_keys l ON l.id=p.proposed_lemma_key_id
          WHERE p.access_status='authenticated' AND ($1::text IS NULL OR p.state=$1)
          ORDER BY p.confidence DESC, p.frequency DESC, p.id LIMIT $2 OFFSET $3`, [state, limit, offset]);
      const total = result.rows[0]?.total || 0;
      res.json({ total, page, pages: Math.max(1, Math.ceil(total / limit)), limit,
        proposals: result.rows.map(({ total: ignored, ...row }) => row) });
    } catch (error) { res.status(500).json({ error: 'Proposal queue failed.' }); }
  });

  router.get('/api/morphology/proposals/:id', requireAccount, async (req, res) => {
    try {
      const proposal = (await pool.query(
        `SELECT p.id, w.display_form AS surface, w.normalized_form AS surface_normalized,
                l.display_form AS proposed_lemma, p.proposed_raw_tag, p.method, p.rule,
                p.confidence, p.support_count, p.frequency, p.state, p.proposal_version,
                v.validation_task_id
           FROM morphology_proposals p JOIN corpus_wordforms w ON w.id=p.wordform_id
           JOIN corpus_lemma_keys l ON l.id=p.proposed_lemma_key_id
           LEFT JOIN morphology_validation_links v ON v.proposal_id=p.id
          WHERE p.id=$1 AND p.access_status='authenticated'`, [req.params.id])).rows[0];
      if (!proposal) return res.status(404).json({ error: 'Proposal not found.' });
      const [contexts, evidence, decisions] = await Promise.all([
        pool.query(`SELECT g.legacy_record_id, g.text_original AS text FROM morphology_proposal_occurrences o JOIN corpus_tokens t ON t.id=o.token_id JOIN corpus_segments g ON g.id=t.segment_id WHERE o.proposal_id=$1 ORDER BY g.id,t.ordinal LIMIT 10`, [req.params.id]),
        pool.query(`SELECT source_label, evidence_type, rights_status FROM morphology_proposal_evidence WHERE proposal_id=$1 AND access_status='authenticated' ORDER BY source_label`, [req.params.id]),
        pool.query(`SELECT verdict, corrected_lemma, corrected_tag, contributor_role, evidence_note, created_at FROM morphology_decisions WHERE proposal_id=$1 ORDER BY created_at`, [req.params.id]),
      ]);
      res.json({ proposal, contexts: contexts.rows, evidence: evidence.rows, decisions: decisions.rows,
        warning: 'This is a deterministic proposal, not a source annotation. A type-level decision never assigns every occurrence.' });
    } catch (error) { res.status(500).json({ error: 'Proposal lookup failed.' }); }
  });

  router.post('/api/morphology/proposals/:id/adjudicate', requireRole(auth.EXPERT_PLUS), async (req, res) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const link = (await client.query(`SELECT t.* FROM morphology_validation_links l JOIN validation_tasks t ON t.id=l.validation_task_id WHERE l.proposal_id=$1`, [req.params.id])).rows[0] || null;
      const result = await applyExpertDecision(client, { proposalId: req.params.id, task: link, identity: req.identity, body: req.body || {} });
      if (!result) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Proposal not found.' }); }
      if (link) {
        const taskStatus = result.verdict === 'reject' ? 'rejected' : 'expert_verified';
        await client.query(`UPDATE validation_tasks SET status=$2, consensus_value=$3, consensus_confidence=1, version=version+1, updated_at=now() WHERE id=$1`, [link.id, taskStatus, result.verdict]);
      }
      await client.query('COMMIT');
      res.json({ ok: true, decision: result });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (/verdict|required/.test(error.message)) return res.status(400).json({ error: error.message });
      console.error('morphology adjudication:', error.message);
      res.status(500).json({ error: 'Adjudication failed.' });
    } finally { client.release(); }
  });

  return router;
};
