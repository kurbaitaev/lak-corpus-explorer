'use strict';

// Derives the public Source Library and the public Lak word-form index from
// the privately staged v1.3 batch.
//
// Nothing in here reads a restricted document back out to a visitor. Two kinds
// of public fact are produced:
//
//   1. A catalogue row per substantive source — what kind of material it is,
//      what language and script it is in, what role it plays here, what rights
//      state it is in, how much of it there is. Every value passes the
//      allowlist in lib/public-projection.js before it is written.
//
//   2. An index of normalised word forms attested across the batch, published
//      only where at least two distinct sources agree on a form. A form unique
//      to one restricted document is a fact about that document; enough such
//      facts would reconstruct it, so they are never published.
//
// The derivation runs in four resumable stages, for the same reason the
// private staging does: the process is suspended between requests, so a stage
// that cannot survive interruption is a stage that never finishes. Each chunk
// commits its rows and its own progress marker in one transaction.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const v13 = require('./source-import-v13');
const { ChunkWriter } = require('./chunk-writer');
const P = require('./public-projection');

// Bump when the projection logic changes in a way that would produce
// different public rows. A new version is a new input key, which discards the
// previous derivation and rebuilds rather than leaving stale rows behind.
const DERIVATION_VERSION = 'pub-5';

// Layers whose text may be tokenised into the public form index.
// `private_reference_index` is deliberately absent: it holds bibliographic
// metadata, so tokenising it would publish author surnames and title words as
// if they were Lak vocabulary.
const FORM_SOURCE_LAYERS = ['private_lexicon_lines', 'private_grammar_examples', 'private_text_segments'];

// Sources processed per committed chunk of the tally stage. One is enough:
// the largest single source yields ~140,000 tokens in well under a second, so
// a chunk is small in time as well as in rows.
const TALLY_CHUNK_SOURCES = 1;

// Forms folded per committed chunk of the index stage.
const FOLD_CHUNK_FORMS = 5000;

const SUBSTANTIVE_EXCLUDED = 'system_metadata';

/* ── Stage bookkeeping ───────────────────────────────────────────────── */

async function stageRow(pool, stage, inputKey) {
  const found = await pool.query(
    `SELECT id, status, resume_offset, resume_cursor, produced_count
       FROM public_projection_stages WHERE stage = $1 AND input_key = $2`,
    [stage, inputKey]);
  if (found.rows[0]) return found.rows[0];
  const id = 'pps_' + crypto.randomUUID();
  await pool.query(
    `INSERT INTO public_projection_stages (id, stage, input_key) VALUES ($1,$2,$3)
       ON CONFLICT (stage, input_key) DO NOTHING`,
    [id, stage, inputKey]);
  const again = await pool.query(
    `SELECT id, status, resume_offset, resume_cursor, produced_count
       FROM public_projection_stages WHERE stage = $1 AND input_key = $2`,
    [stage, inputKey]);
  return again.rows[0];
}

function progressWriter(id) {
  return (client, offset, cursor, produced, final) => client.query(
    `UPDATE public_projection_stages
        SET resume_offset = $2, resume_cursor = $3, produced_count = $4,
            status = $5, updated_at = now()
      WHERE id = $1`,
    [id, offset, cursor, produced, final ? 'complete' : 'in_progress']);
}

// A derivation from different inputs — a new package, or new projection logic
// — must not be mixed with the rows the previous one left behind. Discarding
// them is safe: every row here is derived, and can be rebuilt from the staged
// private batch at any time.
async function discardStaleDerivations(pool, inputKey) {
  const stale = await pool.query(
    `SELECT 1 FROM public_projection_stages WHERE input_key <> $1 LIMIT 1`, [inputKey]);
  if (!stale.rows.length) return false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM public_projection_stages WHERE input_key <> $1', [inputKey]);
    await client.query('TRUNCATE public_word_forms, public_word_form_tallies');
    await client.query('DELETE FROM public_sources');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return true;
}

/* ── Stage 1: the source catalogue ───────────────────────────────────── */

function opaqueGroupId(duplicateGroup) {
  if (!duplicateGroup) return null;
  return 'g' + crypto.createHash('sha256').update('v13-dup:' + duplicateGroup)
    .digest('hex').slice(0, 12);
}

// The one text field a visitor can search against. It is built only from
// strings that are already being published on the same card, so searching can
// never reach something the card itself withholds.
function searchTextFor({ title, attributedTo, familyId, materialType, languageScope, corpusRole, ref }) {
  return [
    ref, title, attributedTo,
    familyId ? P.FAMILY_TITLES[familyId] : null,
    materialType, languageScope, corpusRole,
  ].filter(Boolean).join(' ').toLowerCase();
}

// Turn one manifest record plus its staged routing into a public catalogue
// row, or null when the record is not a substantive source.
function projectSource(record, routing) {
  const materialType = record.material_type;
  if (!materialType || materialType === SUBSTANTIVE_EXCLUDED) return null;

  const ref = 's' + record.sequence;
  const consentWithheld = P.isConsentSensitive(materialType);

  // Consent-sensitive material is catalogued by its canonical facets only.
  // Filenames and document metadata in fieldwork material can name the people
  // who were recorded, and nothing in the audit establishes that they agreed
  // to be listed by name in a public catalogue.
  const title = consentWithheld ? null : P.publishableTitle(record.title);
  const attributedTo = consentWithheld ? null : P.publishableAuthor(record.author);
  const documentYear = consentWithheld ? null : P.documentYear(record.creationdate);
  const urls = consentWithheld ? [] : P.publishableUrls(record.source_urls);
  const familyId = consentWithheld ? null : P.familyIdForPath(record.relative_path);

  const nameSource = title ? 'document_title' : (familyId ? 'source_family' : 'material_type');

  // The public projection carries its own rights vocabulary rather than
  // echoing the private manifest's token. `private_research_pending_permission`
  // is a string that exists only because the private package exists, and the
  // release gate probes for it as a provenance marker; publishing it verbatim
  // would both weaken that probe and say nothing extra to a visitor.
  const rightsState = record.rights_status === 'public_domain_candidate_review'
    ? 'public_domain_candidate_review'
    : 'pending_permission';

  const pages = Number.isInteger(record.pages) && record.pages >= 0 && record.pages < 100000
    ? record.pages : null;

  const row = {
    ref,
    title,
    attributed_to: attributedTo,
    document_year: documentYear,
    name_source: nameSource,
    family_id: familyId,
    group_id: opaqueGroupId(record.duplicate_group),
    material_type: materialType,
    language_scope: record.language_scope,
    corpus_role: record.corpus_role || null,
    recommended_use: record.recommended_use || null,
    extraction_status: record.extraction_status || null,
    extraction_quality: record.extraction_quality || null,
    rights_state: rightsState,
    priority: record.priority || null,
    file_format: P.fileFormatOf(record.extension),
    script_profile: P.scriptProfileOf(record.cyrillic_chars, record.latin_chars),
    urls,
    pages,
    word_count: toCount(record.word_count),
    text_chars: toCount(record.text_chars),
    bytes: toCount(record.bytes),
    candidate_rows: routing.candidateRows,
    // Filled in by the finalize stage, once the index exists.
    word_form_count: 0,
    is_duplicate: !!record.duplicate_group,
    is_canonical_copy: !!record.canonical_duplicate &&
      record.canonical_duplicate === record.relative_path,
    consent_withheld: consentWithheld,
    // Nothing from this batch has cleared rights review, so no source text is
    // published. The flag exists so that when something does clear, the change
    // is a data change rather than a code change.
    text_published: false,
    contribution: 'reference_only',
  };

  row.contribution = P.contributionOf({
    materialType,
    derivedRoute: routing.derivedRoute,
    rightsState,
    consentWithheld,
    wordFormCount: 0,
  });

  // The catalogue row is validated as a public payload before it is written,
  // not when it is served. A value that could not be published has no business
  // being stored in a public table in the first place.
  P.assertPublicSafe(row, `source ${ref}`);

  return {
    row,
    sequence: record.sequence,
    searchText: searchTextFor({
      title, attributedTo, familyId, materialType,
      languageScope: record.language_scope, corpusRole: record.corpus_role, ref,
    }),
  };
}

function toCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n);
}

async function deriveSources(pool, { packageDir, inputKey, onStage }) {
  const stage = await stageRow(pool, 'sources', inputKey);
  if (stage.status === 'complete') {
    return { stage: 'sources', produced: Number(stage.produced_count), resumed: false, skipped: true };
  }

  // Routing and candidate volume come from the staged private tables; the
  // bibliographic detail comes from the manifest, which is the only place it
  // exists. Both are read before the write loop starts so a chunk never waits
  // on a query.
  const routes = new Map();
  const routeRows = await pool.query(
    `SELECT source_sequence, derived_route FROM v13_sources`);
  for (const r of routeRows.rows) routes.set(r.source_sequence, r.derived_route);

  const counts = new Map();
  const countRows = await pool.query(
    `SELECT source_sequence, count(*)::int AS n FROM v13_candidates GROUP BY 1`);
  for (const r of countRows.rows) counts.set(r.source_sequence, r.n);

  const writer = new ChunkWriter(pool, {
    sql: `INSERT INTO public_sources
      (ref, source_sequence, title, attributed_to, document_year, name_source, family_id,
       group_id, material_type, language_scope, corpus_role, recommended_use,
       extraction_status, extraction_quality, rights_state, priority, file_format,
       script_profile, contribution, urls, pages, word_count, text_chars, bytes,
       candidate_rows, word_form_count, is_duplicate, is_canonical_copy,
       consent_withheld, text_published, search_text)
      VALUES __VALUES__
      ON CONFLICT (ref) DO NOTHING`,
    columns: 31,
    resumeFrom: Number(stage.resume_offset),
    recordProgress: (client, index, final) =>
      progressWriter(stage.id)(client, index, '', index, final),
  });

  let produced = 0;
  try {
    await v13.forEachRecord(path.join(packageDir, v13.REGISTRY_FILES.manifest), async record => {
      // Every manifest line advances the cursor, including the system-metadata
      // receipts that produce no public row: the resume offset counts records
      // read, so it has to be incremented for records that are skipped too.
      if (!writer.next()) return;
      const projected = projectSource(record, {
        derivedRoute: routes.get(record.sequence) || null,
        candidateRows: counts.get(record.sequence) || 0,
      });
      if (!projected) return;
      produced += 1;
      const r = projected.row;
      await writer.push([
        r.ref, projected.sequence, r.title, r.attributed_to, r.document_year, r.name_source,
        r.family_id, r.group_id, r.material_type, r.language_scope, r.corpus_role,
        r.recommended_use, r.extraction_status, r.extraction_quality, r.rights_state,
        r.priority, r.file_format, r.script_profile, r.contribution, JSON.stringify(r.urls),
        r.pages, r.word_count, r.text_chars, r.bytes, r.candidate_rows, r.word_form_count,
        r.is_duplicate, r.is_canonical_copy, r.consent_withheld, r.text_published,
        projected.searchText,
      ]);
    });
    await writer.commit(true);
  } catch (err) {
    await writer.abort();
    throw err;
  }
  if (onStage) onStage({ stage: 'sources', produced });
  return { stage: 'sources', produced, resumed: Number(stage.resume_offset) > 0, skipped: false };
}

/* ── Stage 2: word-form tallies, one source at a time ────────────────── */

// The tokeniser runs in the database, splitting on everything that is not a
// letter or a palochka. Doing it here rather than in Node keeps a quarter of a
// million rows of restricted text out of the application process entirely.
const TOKENISE_SQL = `
  INSERT INTO public_word_form_tallies (form, source_sequence, occurrences)
  SELECT f.form, c.source_sequence, count(*)::int
    FROM v13_candidates c
    CROSS JOIN LATERAL regexp_split_to_table(lower(c.text), '[^[:alpha:]\u04c0\u04cf]+') AS f(form)
   WHERE c.layer = ANY($1::text[])
     AND c.text IS NOT NULL
     AND c.source_sequence > $2 AND c.source_sequence <= $3
     AND NOT (c.source_sequence = ANY($4::int[]))
     AND length(f.form) BETWEEN $5 AND $6
   GROUP BY 1, 2
      ON CONFLICT (form, source_sequence)
      DO UPDATE SET occurrences = EXCLUDED.occurrences`;

async function deriveTallies(pool, { inputKey, onStage }) {
  const stage = await stageRow(pool, 'tallies', inputKey);
  if (stage.status === 'complete') {
    return { stage: 'tallies', produced: Number(stage.produced_count), skipped: true };
  }

  // Consent-sensitive sources contribute no word forms at all. The
  // two-source rule already prevents a form from being traceable to one
  // document, but fieldwork recordings of named people are held to the
  // stricter line: they are described in the catalogue and used for nothing.
  const withheld = await pool.query(
    `SELECT source_sequence FROM v13_sources WHERE material_type = ANY($1::text[])`,
    [P.CONSENT_SENSITIVE_TYPES]);
  const withheldSequences = withheld.rows.map(r => r.source_sequence);

  const bounds = await pool.query(
    `SELECT COALESCE(max(source_sequence), 0)::int AS hi FROM v13_candidates`);
  const highest = bounds.rows[0].hi;

  let cursor = Number(stage.resume_offset);
  let produced = Number(stage.produced_count);
  const record = progressWriter(stage.id);

  while (cursor < highest) {
    const upper = Math.min(cursor + TALLY_CHUNK_SOURCES, highest);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(TOKENISE_SQL, [
        FORM_SOURCE_LAYERS, cursor, upper, withheldSequences, P.MIN_FORM, P.MAX_FORM,
      ]);
      produced += result.rowCount || 0;
      // The rows and the marker that says how far we got land together, so an
      // interruption can never leave a cursor claiming more than was written.
      await record(client, upper, '', produced, upper >= highest);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw err;
    }
    client.release();
    cursor = upper;
    if (onStage) onStage({ stage: 'tallies', cursor, highest, produced });
  }
  return { stage: 'tallies', produced, skipped: false };
}

/* ── Stage 3: fold tallies into the published index ──────────────────── */

async function deriveForms(pool, { inputKey, onStage }) {
  const stage = await stageRow(pool, 'forms', inputKey);
  if (stage.status === 'complete') {
    return { stage: 'forms', produced: Number(stage.produced_count), skipped: true };
  }

  let cursor = stage.resume_cursor || '';
  let produced = Number(stage.produced_count);
  const record = progressWriter(stage.id);

  for (;;) {
    // The HAVING clause is the re-identification guard: a form attested by a
    // single source never leaves the tally table.
    const chunk = await pool.query(
      `SELECT form, sum(occurrences)::bigint AS occurrences, count(*)::int AS sources
         FROM public_word_form_tallies
        WHERE form > $1
        GROUP BY form
       HAVING count(*) >= $2
        ORDER BY form
        LIMIT $3`,
      [cursor, P.MIN_ATTESTING_SOURCES, FOLD_CHUNK_FORMS]);

    // An empty chunk can still mean there is more to walk: every form in it
    // may have failed the HAVING clause. The cursor has to advance past the
    // forms that were examined, not just the ones that were kept, so the walk
    // is driven by a separate bound.
    const bound = await pool.query(
      `SELECT max(form) AS last FROM (
         SELECT DISTINCT form FROM public_word_form_tallies
          WHERE form > $1 ORDER BY form LIMIT $2) t`,
      [cursor, FOLD_CHUNK_FORMS]);
    const lastExamined = bound.rows[0].last;
    if (!lastExamined) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await record(client, 0, cursor, produced, true);
        await client.query('COMMIT');
      } finally { client.release(); }
      break;
    }

    const rows = [];
    for (const item of chunk.rows) {
      if (item.form > lastExamined) continue;
      // The SQL tokeniser and the projection rule are checked independently.
      // If they ever disagree, the projection rule wins and the form is
      // dropped: the boundary is defined in one place.
      if (!P.isPublishableForm(item.form)) continue;
      const sources = Number(item.sources);
      rows.push([
        item.form, Number(item.occurrences), sources,
        P.scriptOfForm(item.form), P.hasLakMarker(item.form), P.confidenceForForm(sources),
      ]);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (rows.length) {
        const values = [];
        const placeholders = rows.map((row, i) => {
          values.push(...row);
          const base = i * 6;
          return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`;
        });
        await client.query(
          `INSERT INTO public_word_forms
             (form, occurrences, sources, script_profile, lak_marker, confidence)
           VALUES ${placeholders.join(',')}
           ON CONFLICT (form) DO UPDATE SET
             occurrences = EXCLUDED.occurrences, sources = EXCLUDED.sources,
             script_profile = EXCLUDED.script_profile, lak_marker = EXCLUDED.lak_marker,
             confidence = EXCLUDED.confidence`,
          values);
        produced += rows.length;
      }
      await record(client, 0, lastExamined, produced, false);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw err;
    }
    client.release();
    cursor = lastExamined;
    if (onStage) onStage({ stage: 'forms', produced });
  }

  return { stage: 'forms', produced, skipped: false };
}

/* ── Stage 4: attach the index back to the catalogue ─────────────────── */

async function finalize(pool, { inputKey }) {
  const stage = await stageRow(pool, 'finalize', inputKey);
  if (stage.status === 'complete') {
    return { stage: 'finalize', produced: Number(stage.produced_count), skipped: true };
  }
  const record = progressWriter(stage.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // How many *published* forms each source attests. Forms that failed the
    // two-source guard are not counted, because they were not published.
    await client.query(`
      UPDATE public_sources s
         SET word_form_count = COALESCE(t.n, 0)
        FROM (SELECT tl.source_sequence, count(*)::int AS n
                FROM public_word_form_tallies tl
                JOIN public_word_forms w ON w.form = tl.form
               GROUP BY 1) t
       WHERE s.source_sequence = t.source_sequence`);
    await client.query(
      `UPDATE public_sources SET word_form_count = 0
        WHERE source_sequence NOT IN (
          SELECT tl.source_sequence FROM public_word_form_tallies tl
            JOIN public_word_forms w ON w.form = tl.form GROUP BY 1)`);
    // A source that turned out to contribute forms says so, rather than
    // claiming to be reference-only.
    // Consent is the only thing that overrides this. A pending *rights*
    // decision does not: it is about republishing the text, and no text is
    // republished here. See contributionOf() for the same reasoning.
    await client.query(
      `UPDATE public_sources SET contribution = 'word_forms'
        WHERE word_form_count > 0
          AND consent_withheld = FALSE`);
    const total = await client.query('SELECT count(*)::int AS n FROM public_sources');
    await record(client, 0, '', total.rows[0].n, true);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw err;
  }
  client.release();
  return { stage: 'finalize', produced: 0, skipped: false };
}

/* ── Orchestration ───────────────────────────────────────────────────── */

function inputKeyFor(packageDir) {
  const manifest = path.join(packageDir, v13.REGISTRY_FILES.manifest);
  const digest = crypto.createHash('sha256')
    .update(fs.readFileSync(manifest))
    .digest('hex');
  return crypto.createHash('sha256')
    .update(`${DERIVATION_VERSION}\u0000${digest}`)
    .digest('hex')
    .slice(0, 32);
}

/* ── One deriver at a time ───────────────────────────────────────────────
 *
 * The deployment is autoscale, so several instances can boot at once and each
 * one runs this on the way up. The stage table makes the work resumable, but
 * resumability is not mutual exclusion: two instances interleaving would let
 * one truncate the published tables while the other has already recorded a
 * stage as complete, leaving an empty catalogue that reports itself ready.
 *
 * A Postgres session advisory lock is the right shape for this. It is held on
 * one connection for the whole cycle — stale discard included — and Postgres
 * drops it if the instance is suspended or killed, so a half-finished run
 * never wedges the next boot. An instance that cannot take the lock does not
 * queue behind the holder: the holder is doing exactly the same work, so the
 * honest answer is to step aside and let the readiness check speak.
 */
const LOCK_KEYS = [0x4c414b, 0x7075626c];   // "LAK" / "publ" — this derivation only

async function withDerivationLock(pool, run) {
  const client = await pool.connect();
  let held = false;
  try {
    const got = await client.query('SELECT pg_try_advisory_lock($1, $2) AS ok', LOCK_KEYS);
    held = got.rows[0].ok === true;
    if (!held) return { locked: false, result: null };
    return { locked: true, result: await run() };
  } finally {
    if (held) await client.query('SELECT pg_advisory_unlock($1, $2)', LOCK_KEYS).catch(() => {});
    client.release();
  }
}

// Run the whole derivation, resuming whatever an earlier boot left unfinished.
// Never throws for a missing or unverified package: it reports that the public
// library is not ready and the surfaces say so, which is the honest answer.
async function derivePublicLibrary(pool, { packageDir, onStage } = {}) {
  if (!packageDir || !fs.existsSync(path.join(packageDir, v13.REGISTRY_FILES.manifest))) {
    return { ready: false, reason: 'v1.3 package is not available in this instance', stages: [] };
  }
  const inputKey = inputKeyFor(packageDir);

  const { locked, result } = await withDerivationLock(pool, async () => {
    const discarded = await discardStaleDerivations(pool, inputKey);
    const stages = [];
    stages.push(await deriveSources(pool, { packageDir, inputKey, onStage }));
    stages.push(await deriveTallies(pool, { inputKey, onStage }));
    stages.push(await deriveForms(pool, { inputKey, onStage }));
    stages.push(await finalize(pool, { inputKey }));
    return { ready: true, input_key: inputKey, discarded_stale: discarded, stages };
  });

  if (!locked) {
    return {
      ready: false,
      reason: 'another instance is deriving the public library',
      input_key: inputKey,
      stages: [],
    };
  }
  return result;
}

// Whether every stage for the current inputs has finished. The public
// surfaces use this to distinguish "nothing to show" from "not built yet",
// which are very different answers to give a visitor.
async function derivationStatus(pool, packageDir) {
  let inputKey = null;
  try {
    if (packageDir && fs.existsSync(path.join(packageDir, v13.REGISTRY_FILES.manifest))) {
      inputKey = inputKeyFor(packageDir);
    }
  } catch { inputKey = null; }

  const rows = await pool.query(
    `SELECT stage, status, produced_count FROM public_projection_stages
      ${inputKey ? 'WHERE input_key = $1' : ''}`,
    inputKey ? [inputKey] : []);
  const byStage = Object.fromEntries(rows.rows.map(r => [r.stage, r]));
  const required = ['sources', 'tallies', 'forms', 'finalize'];
  const complete = required.every(s => byStage[s] && byStage[s].status === 'complete');
  return {
    ready: complete,
    stages_complete: required.filter(s => byStage[s] && byStage[s].status === 'complete').length,
    stages_total: required.length,
  };
}

module.exports = {
  DERIVATION_VERSION,
  FORM_SOURCE_LAYERS,
  derivePublicLibrary,
  withDerivationLock,
  derivationStatus,
  projectSource,
  inputKeyFor,
};
