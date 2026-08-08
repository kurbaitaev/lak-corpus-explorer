'use strict';

// Public API for the Source Library and the derived Lak word-form index.
//
// Everything served here is derived material that has already passed the
// allowlist in lib/public-projection.js on its way into the database. It is
// validated again on the way out: the tables are the boundary's memory, not
// its judgement, and a row that somehow arrived without passing the rules is
// not going to be handed to a visitor because it happened to be stored.
//
// These routes are anonymous by design. There is no login, no session and no
// reviewer check, because there is nothing here a reviewer may see and the
// public may not.

const express = require('express');
const P = require('../lib/public-projection');
const derivation = require('../lib/public-derivation');

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 24;

// The facets a visitor may filter on, and the vocabulary each one accepts. A
// filter value outside its vocabulary is ignored rather than passed to SQL.
const FILTERS = {
  material_type: 'material_type',
  language_scope: 'language_scope',
  rights_state: 'rights_state',
  script_profile: 'script_profile',
  contribution: 'contribution',
  corpus_role: 'corpus_role',
  extraction_quality: 'extraction_quality',
  file_format: 'file_format',
  priority: 'priority',
};

const SOURCE_COLUMNS = `
  ref, title, attributed_to, document_year, name_source, family_id, group_id,
  material_type, language_scope, corpus_role, recommended_use, extraction_status,
  extraction_quality, rights_state, priority, file_format, script_profile,
  contribution, urls, pages, word_count, text_chars, bytes, candidate_rows,
  word_form_count, is_duplicate, is_canonical_copy, consent_withheld, text_published`;

function toPublicSource(row) {
  return {
    ref: row.ref,
    title: row.title,
    attributed_to: row.attributed_to,
    document_year: row.document_year === null ? null : Number(row.document_year),
    name_source: row.name_source,
    family_id: row.family_id,
    group_id: row.group_id,
    material_type: row.material_type,
    language_scope: row.language_scope,
    corpus_role: row.corpus_role,
    recommended_use: row.recommended_use,
    extraction_status: row.extraction_status,
    extraction_quality: row.extraction_quality,
    rights_state: row.rights_state,
    priority: row.priority,
    file_format: row.file_format,
    script_profile: row.script_profile,
    contribution: row.contribution,
    pages: row.pages === null ? null : Number(row.pages),
    word_count: row.word_count === null ? null : Number(row.word_count),
    text_chars: row.text_chars === null ? null : Number(row.text_chars),
    bytes: row.bytes === null ? null : Number(row.bytes),
    candidate_rows: Number(row.candidate_rows),
    word_form_count: Number(row.word_form_count),
    is_duplicate: !!row.is_duplicate,
    is_canonical_copy: !!row.is_canonical_copy,
    consent_withheld: !!row.consent_withheld,
    text_published: !!row.text_published,
  };
}

function toPublicForm(row) {
  return {
    form: row.form,
    occurrences: Number(row.occurrences),
    sources: Number(row.sources),
    script_profile: row.script_profile,
    lak_marker: !!row.lak_marker,
    confidence: row.confidence,
  };
}

function toPublicReceipt(row) {
  return {
    ref: row.ref,
    receipt_kind: row.receipt_kind,
    disposition: row.disposition,
    corpus_role: row.corpus_role,
    recommended_use: row.recommended_use,
    bytes: row.bytes === null ? null : Number(row.bytes),
  };
}

function intParam(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

// A free-text query is never echoed back and never interpolated. It is bound
// as a parameter and matched against `search_text`, which was itself built
// only from strings that are already published on the card.
function cleanQuery(value) {
  return String(value || '').trim().slice(0, 80);
}

const CYRILLIC_VOWELS = /[аеёиоуыэюя]/gi;
const LATIN_LETTERS = /[A-Za-z]/;
const CYRILLIC_LETTERS = /[А-Яа-яЁё]/;
const INTERNAL_CAPITAL = /[а-яё][А-ЯЁ]/;

function concordanceQuality(snippet, form, knownRussian) {
  let score = 5;
  const text = String(snippet || '');
  const lower = text.toLowerCase();
  const at = lower.indexOf(String(form || '').toLowerCase());
  if (at === 0 || at <= 12) score += 2;
  if (text.length > 250) score -= 2;
  if (/�|\u0000/.test(text)) score -= 10;
  if (INTERNAL_CAPITAL.test(text)) score -= 6;
  if (/-\s*$/.test(text)) score -= 3;
  if (knownRussian && LATIN_LETTERS.test(text) && CYRILLIC_LETTERS.test(text)) score -= 8;
  if (knownRussian) {
    const words = text.match(/[А-Яа-яЁё]+/g) || [];
    for (const word of words) {
      if (word.length < 6 || word.toLowerCase() === String(form).toLowerCase()) continue;
      const vowels = (word.match(CYRILLIC_VOWELS) || []).length;
      if (vowels <= 1) score -= 4;
    }
  }
  const withoutMatch = at >= 0 ? text.slice(0, at) + text.slice(at + String(form).length) : text;
  if ((withoutMatch.match(/[\p{L}\p{N}]/gu) || []).length <= 2) score -= 5;
  return score;
}

function containsKnownRussianContext(text, terms, form) {
  const wanted = String(form || '').toLowerCase().replace(/ё/g, 'е');
  const words = String(text || '').toLowerCase().match(/[а-яё]+/g) || [];
  return words.some(word => {
    const normalized = word.replace(/ё/g, 'е');
    return normalized !== wanted && terms.has(normalized);
  });
}

function concordanceSnippets(text, form, max = 4, options = {}) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  const query = String(form || '').normalize('NFKC').toLowerCase();
  const searchable = source.normalize('NFKC').toLowerCase();
  if (!source || !query) return [];
  const out = [];
  let from = 0;
  while (out.length < max) {
    const at = searchable.indexOf(query, from);
    if (at < 0) break;
    const before = at === 0 ? '' : searchable[at - 1];
    const after = searchable[at + query.length] || '';
    if ((!before || !/[\p{L}\p{N}]/u.test(before)) &&
        (!after || !/[\p{L}\p{N}]/u.test(after) || /[\u0300-\u036f]/u.test(after))) {
      let start = Math.max(0, at - 90);
      let end = Math.min(source.length, at + query.length + 120);
      if (options.dictionary) {
        const leftBreak = Math.max(source.lastIndexOf(';', at - 1), source.lastIndexOf('.', at - 1));
        const rightSemi = source.indexOf(';', at + query.length);
        const rightPeriod = source.indexOf('.', at + query.length);
        const rightCandidates = [rightSemi, rightPeriod].filter(n => n >= 0);
        if (leftBreak >= 0 && at - leftBreak <= 100) start = leftBreak + 1;
        if (rightCandidates.length) {
          const boundary = Math.min(...rightCandidates);
          if (boundary - at <= 130) end = boundary;
        }
        if (options.stopTerms && end > at + query.length) {
          const tail = source.slice(at + query.length, end);
          const words = tail.matchAll(/[А-Яа-яЁё]+/g);
          for (const match of words) {
            const normalized = match[0].toLowerCase().replace(/ё/g, 'е');
            const between = tail.slice(0, match.index);
            if (options.stopTerms.has(normalized) && /[А-Яа-яЁё]/.test(between)) {
              end = at + query.length + match.index;
              break;
            }
          }
        }
      }
      let snippet = source.slice(start, end).trim();
      if (start > 0) snippet = '…' + snippet;
      if (end < source.length) snippet += '…';
      const quality = concordanceQuality(snippet, form, !!options.knownRussian);
      if (quality >= 4 && !out.some(item => item.snippet === snippet)) out.push({ snippet, quality });
    }
    from = at + query.length;
  }
  return out.sort((a, b) => b.quality - a.quality).slice(0, max);
}

function contextPage(text) {
  const match = String(text || '').match(/\[(?:OCR\s+)?PAGE\s+(\d{1,5})\]/i);
  return match ? Number(match[1]) : null;
}

module.exports = ({ pool, packageDir, knownRussianTerms = new Set() }) => {
  const router = express.Router();

  // A shared "is the library built yet" answer. A visitor arriving while the
  // derivation is still running is told that, rather than being shown an empty
  // catalogue that looks like an answer.
  async function readiness() {
    try {
      return await derivation.derivationStatus(pool, packageDir());
    } catch {
      return { ready: false, stages_complete: 0, stages_total: 4 };
    }
  }

  function buildWhere(query) {
    const clauses = [];
    const values = [];
    for (const [param, column] of Object.entries(FILTERS)) {
      const raw = query[param];
      if (!raw) continue;
      const vocabName = column === 'contribution' ? 'contribution' : column;
      const vocab = P.VOCAB[vocabName];
      if (!vocab || !vocab.includes(raw)) continue;
      values.push(raw);
      clauses.push(`${column} = $${values.length}`);
    }
    if (query.family_id && P.FAMILY_IDS.includes(query.family_id)) {
      values.push(query.family_id);
      clauses.push(`family_id = $${values.length}`);
    }
    const q = cleanQuery(query.q);
    if (q) {
      values.push('%' + q.toLowerCase().replace(/[\\%_]/g, ch => '\\' + ch) + '%');
      clauses.push(`search_text LIKE $${values.length}`);
    }
    return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', values };
  }

  // ── The catalogue ───────────────────────────────────────────
  router.get('/api/source-library', async (req, res) => {
    try {
      const status = await readiness();
      const limit = intParam(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
      const page = intParam(req.query.page, 1, 1, 10000);
      const { where, values } = buildWhere(req.query);

      const totalRow = await pool.query(
        `SELECT count(*)::int AS n FROM public_sources ${where}`, values);
      const total = totalRow.rows[0].n;
      const pagesTotal = Math.max(1, Math.ceil(total / limit));
      const safePage = Math.min(page, pagesTotal);

      const rows = await pool.query(
        `SELECT ${SOURCE_COLUMNS} FROM public_sources ${where}
          ORDER BY (title IS NULL), title NULLS LAST, source_sequence
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, (safePage - 1) * limit]);

      res.json(P.assertPublicSafe({
        status: status.ready ? 'ok' : 'preparing',
        stages_complete: status.stages_complete,
        stages_total: status.stages_total,
        total,
        page: safePage,
        pages_total: pagesTotal,
        limit,
        items: rows.rows.map(toPublicSource),
      }, 'source-library'));
    } catch (err) {
      console.error('Source library list failed:', err.message);
      res.status(500).json({ error: 'Source library unavailable' });
    }
  });

  // Counted options for each facet, so the filters can show how much is behind
  // them rather than offering choices that lead nowhere.
  router.get('/api/source-library/facets', async (req, res) => {
    try {
      const status = await readiness();
      const facets = {};
      for (const column of Object.values(FILTERS)) {
        const rows = await pool.query(
          `SELECT ${column} AS value, count(*)::int AS count
             FROM public_sources WHERE ${column} IS NOT NULL
            GROUP BY 1 ORDER BY 2 DESC, 1`);
        facets[column] = rows.rows.map(r => ({ [column]: r.value, count: r.count }));
      }
      const families = await pool.query(
        `SELECT family_id, count(*)::int AS count FROM public_sources
          WHERE family_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1`);
      facets.family_id = families.rows.map(r => ({ family_id: r.family_id, count: r.count }));

      const [sourcesTotal, receiptsTotal] = await Promise.all([
        pool.query('SELECT count(*)::int AS n FROM public_sources'),
        pool.query('SELECT count(*)::int AS n FROM public_receipts'),
      ]);
      // The whole audited batch, accounted for in the open: 293 substantive
      // sources plus 27 system-metadata receipts is the 320 the audit counted.
      // While a rebuild is in flight the totals are partial, so the payload
      // says so — a preparing answer is honest, a half-rebuilt one is not.
      res.json(P.assertPublicSafe({
        status: status.ready ? 'ok' : 'preparing',
        stages_complete: status.stages_complete,
        stages_total: status.stages_total,
        total: sourcesTotal.rows[0].n,
        sources_total: sourcesTotal.rows[0].n,
        receipts_total: receiptsTotal.rows[0].n,
        items_total: sourcesTotal.rows[0].n + receiptsTotal.rows[0].n,
        facets,
      }, 'source-library-facets'));
    } catch (err) {
      console.error('Source library facets failed:', err.message);
      res.status(500).json({ error: 'Source library unavailable' });
    }
  });

  // The rights review queue. Three sources in this batch look like they may
  // already be out of copyright. "Looks like" is not a clearance, so they are
  // listed here with their text unpublished until someone checks.
  router.get('/api/source-library/review-queue', async (req, res) => {
    try {
      const rows = await pool.query(
        `SELECT ${SOURCE_COLUMNS} FROM public_sources
          WHERE rights_state = 'public_domain_candidate_review'
          ORDER BY source_sequence`);
      res.json(P.assertPublicSafe({
        status: 'ok',
        total: rows.rowCount,
        review_queue: rows.rows.map(toPublicSource),
      }, 'source-library-review-queue'));
    } catch (err) {
      console.error('Rights review queue failed:', err.message);
      res.status(500).json({ error: 'Source library unavailable' });
    }
  });

  // The system-metadata receipts. Registered before /:ref so "receipts" is
  // never parsed as a source reference.
  router.get('/api/source-library/receipts', async (req, res) => {
    try {
      const status = await readiness();
      const rows = await pool.query(
        `SELECT ref, receipt_kind, disposition, corpus_role, recommended_use, bytes
           FROM public_receipts ORDER BY source_sequence`);
      res.json(P.assertPublicSafe({
        status: status.ready ? 'ok' : 'preparing',
        stages_complete: status.stages_complete,
        stages_total: status.stages_total,
        total: rows.rowCount,
        receipts: rows.rows.map(toPublicReceipt),
      }, 'source-library-receipts'));
    } catch (err) {
      console.error('Receipts list failed:', err.message);
      res.status(500).json({ error: 'Source library unavailable' });
    }
  });

  // One source, with the other copies of the same file when there are any.
  router.get('/api/source-library/:ref', async (req, res) => {
    try {
      const ref = String(req.params.ref || '');
      if (!/^s\d{1,6}$/.test(ref)) return res.status(404).json({ error: 'Unknown source' });
      const found = await pool.query(
        `SELECT ${SOURCE_COLUMNS} FROM public_sources WHERE ref = $1`, [ref]);
      if (!found.rows.length) return res.status(404).json({ error: 'Unknown source' });
      const source = toPublicSource(found.rows[0]);

      let related = [];
      if (source.group_id) {
        const siblings = await pool.query(
          `SELECT ${SOURCE_COLUMNS} FROM public_sources
            WHERE group_id = $1 AND ref <> $2 ORDER BY source_sequence`,
          [source.group_id, ref]);
        related = siblings.rows.map(toPublicSource);
      }

      res.json(P.assertPublicSafe({
        status: 'ok', source, related, count: related.length,
      }, 'source-library-detail'));
    } catch (err) {
      console.error('Source detail failed:', err.message);
      res.status(500).json({ error: 'Source library unavailable' });
    }
  });

  // ── The word-form index ─────────────────────────────────────
  router.get('/api/word-forms', async (req, res) => {
    try {
      const status = await readiness();
      const limit = intParam(req.query.limit, 50, 1, MAX_LIMIT);
      const page = intParam(req.query.page, 1, 1, 10000);
      const sort = ['sources', 'occurrences', 'alphabetical'].includes(req.query.sort)
        ? req.query.sort : 'sources';

      const clauses = [];
      const values = [];
      const q = cleanQuery(req.query.q).toLowerCase();
      if (q) {
        values.push(q.replace(/[\\%_]/g, ch => '\\' + ch) + '%');
        clauses.push(`form LIKE $${values.length}`);
      }
      if (P.VOCAB.script_profile.includes(req.query.script_profile)) {
        values.push(req.query.script_profile);
        clauses.push(`script_profile = $${values.length}`);
      }
      if (P.VOCAB.confidence.includes(req.query.confidence)) {
        values.push(req.query.confidence);
        clauses.push(`confidence = $${values.length}`);
      }
      if (req.query.lak_marker === 'true') clauses.push('lak_marker = TRUE');
      const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

      const order = sort === 'alphabetical' ? 'form'
        : sort === 'occurrences' ? 'occurrences DESC, sources DESC, form'
        : 'sources DESC, occurrences DESC, form';

      const totalRow = await pool.query(
        `SELECT count(*)::int AS n FROM public_word_forms ${where}`, values);
      const total = totalRow.rows[0].n;
      const pagesTotal = Math.max(1, Math.ceil(total / limit));
      const safePage = Math.min(page, pagesTotal);

      const rows = await pool.query(
        `SELECT form, occurrences, sources, script_profile, lak_marker, confidence
           FROM public_word_forms ${where} ORDER BY ${order}
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, limit, (safePage - 1) * limit]);

      res.json(P.assertPublicSafe({
        status: status.ready ? 'ok' : 'preparing',
        stages_complete: status.stages_complete,
        stages_total: status.stages_total,
        total, page: safePage, pages_total: pagesTotal, limit, sort,
        items: rows.rows.map(toPublicForm),
      }, 'word-forms'));
    } catch (err) {
      console.error('Word form index failed:', err.message);
      res.status(500).json({ error: 'Word form index unavailable' });
    }
  });

  // The drill-down returns bounded concordance windows, not files or complete
  // source rows. This lets a reader verify where a form occurred directly.
  router.get('/api/word-forms/:form/sources', async (req, res) => {
    try {
      const form = cleanQuery(req.params.form).toLowerCase();
      if (!form) return res.status(404).json({ error: 'Word form not found' });

      const published = await pool.query(
        `SELECT form, occurrences, sources, script_profile, lak_marker, confidence
           FROM public_word_forms WHERE form = $1`, [form]);
      if (!published.rows.length) {
        return res.status(404).json({ error: 'Word form not found' });
      }

      const rows = await pool.query(
        `SELECT ${SOURCE_COLUMNS}, s.source_sequence, t.occurrences AS form_occurrences
           FROM public_word_form_tallies t
           JOIN public_sources s ON s.source_sequence = t.source_sequence
          WHERE t.form = $1
          ORDER BY t.occurrences DESC, (s.title IS NULL), s.title NULLS LAST, s.source_sequence`,
        [form]);
      const summary = toPublicForm(published.rows[0]);
      const sequences = rows.rows.map(row => Number(row.source_sequence));
      const candidates = sequences.length ? await pool.query(
        `SELECT source_sequence, layer, text, source_line
           FROM v13_candidates
          WHERE source_sequence = ANY($1::int[])
            AND layer = ANY($2::text[])
            AND text IS NOT NULL
            AND lower(text) LIKE '%' || $3 || '%'
          ORDER BY source_sequence, source_line NULLS LAST, candidate_ref
          LIMIT 750`,
        [sequences, derivation.FORM_SOURCE_LAYERS, form]) : { rows: [] };

      const contextsBySource = new Map();
      const knownRussian = knownRussianTerms.has(form) || candidates.rows.some(candidate =>
        candidate.layer === 'private_lexicon_lines' &&
        containsKnownRussianContext(candidate.text, knownRussianTerms, form));
      for (const candidate of candidates.rows) {
        const seq = Number(candidate.source_sequence);
        if (!contextsBySource.has(seq)) contextsBySource.set(seq, []);
        const contexts = contextsBySource.get(seq);
        const page = contextPage(candidate.text);
        const dictionary = candidate.layer === 'private_lexicon_lines';
        for (const result of concordanceSnippets(candidate.text, form, 5, {
          dictionary,
          // A plain-Cyrillic lookup inside a bilingual dictionary may be a
          // Russian gloss even when the older flat corpus never indexed it.
          // Apply the stricter OCR checks to that local context only. This
          // avoids pretending that every plain-Cyrillic Lak form is Russian.
          knownRussian: knownRussian || (dictionary && !/[Ӏӏ]/u.test(form)),
          stopTerms: knownRussian ? knownRussianTerms : null,
        })) {
          const snippet = result.snippet;
          try {
            P.assertPublicSafe({ snippet }, 'word-form-context');
          } catch {
            continue;
          }
          const context = { snippet, _quality: result.quality };
          if (page !== null) context.page = page;
          else if (candidate.source_line !== null && Number(candidate.source_line) >= 0) {
            context.line = Number(candidate.source_line);
          }
          if (!contexts.some(item => item.snippet === snippet)) contexts.push(context);
        }
      }

      for (const contexts of contextsBySource.values()) {
        contexts.sort((a, b) => b._quality - a._quality);
        contexts.splice(3);
        for (const context of contexts) delete context._quality;
      }

      const items = rows.rows.map(row => ({
        ref: row.ref,
        title: row.title,
        document_year: row.document_year === null ? null : Number(row.document_year),
        material_type: row.material_type,
        form_occurrences: Number(row.form_occurrences),
        contexts: contextsBySource.get(Number(row.source_sequence)) || [],
      }));

      res.set('Cache-Control', 'no-store');
      res.json(P.assertPublicSafe({
        status: 'ok', form: summary.form, occurrences: summary.occurrences,
        sources: summary.sources, items,
      }, 'word-form-sources'));
    } catch (err) {
      console.error('Word form source detail failed:', err.message);
      res.status(500).json({ error: 'Word form sources unavailable' });
    }
  });

  return router;
};

// Exported for the search integration in server.js, which needs the same
// projection without going back out through HTTP.
module.exports.lookup = async function lookup(pool, query, { sourceLimit = 3, formLimit = 3 } = {}) {
  const q = cleanQuery(query).toLowerCase();
  if (!q) return { library: { total: 0, items: [] }, forms: { total: 0, items: [] } };
  const like = '%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
  const prefix = q.replace(/[\\%_]/g, ch => '\\' + ch) + '%';

  const [sources, forms] = await Promise.all([
    pool.query(
      `SELECT ${SOURCE_COLUMNS} FROM public_sources
        WHERE search_text LIKE $1
        ORDER BY (title IS NULL), word_form_count DESC, source_sequence LIMIT $2`,
      [like, sourceLimit]),
    pool.query(
      `SELECT form, occurrences, sources, script_profile, lak_marker, confidence
         FROM public_word_forms WHERE form LIKE $1
         ORDER BY sources DESC, occurrences DESC, form LIMIT $2`,
      [prefix, formLimit]),
  ]);

  const [sourceTotal, formTotal] = await Promise.all([
    pool.query('SELECT count(*)::int AS n FROM public_sources WHERE search_text LIKE $1', [like]),
    pool.query('SELECT count(*)::int AS n FROM public_word_forms WHERE form LIKE $1', [prefix]),
  ]);

  return P.assertPublicSafe({
    library: { total: sourceTotal.rows[0].n, items: sources.rows.map(toPublicSource) },
    forms: { total: formTotal.rows[0].n, items: forms.rows.map(toPublicForm) },
  }, 'search-collections');
};

module.exports.concordanceSnippets = concordanceSnippets;
