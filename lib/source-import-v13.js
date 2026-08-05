'use strict';

// Private source-import layer for the audited v1.3 package
// (lak-corpus-v1.3-private-data-and-findings).
//
// Same rule as v1.2: a quoted count is not data. The package is staged only
// when it is physically present AND every check below passes.
//
//   * the archive digest matches the digest recorded on receipt
//     (checked in lib/private-packages.js before extraction)
//   * every required report is present and declares fail-closed processing
//   * the package's two declarations — reports/stats.json and
//     reports/candidate_stats.json — agree with each other, with the audited
//     numbers, and with the actual line counts of the JSONL layers
//   * every record parses, carries a 64-hex SHA-256 of the received file, a
//     source path and a source sequence that exists in the source registry
//   * every record declares the fail-closed policy: unreviewed, not
//     public-search-eligible, not training-eligible
//   * system / administrative / non-Lak material stays inventory, reference
//     or control material and never reaches a Lak language layer
//   * every extracted-text body a record points at exists in the package
//
// Any failure blocks ingestion for the whole package and is reported as a
// reason string. The extracted text bodies stay in the package archive in
// persistent storage; the database keeps the pointer, not a second copy.
//
// Files are read line by line, so no whole layer is ever held in memory.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

const PACKAGE_ID = 'v1.3';
const PACKAGE_LABEL = 'lak-corpus-v1.3-private-data-and-findings';
const ARCHIVE_SHA256 = '3152d173fb722c9295f13c7ca955d6b36910917a1b349ee9ca08a616e2fcfef9';

const SHA256_RE = /^[0-9a-f]{64}$/;

// The audited numbers. These are expectations to check the package against,
// never a substitute for it.
const AUDITED = {
  source_routes: 320,
  rights_review_items: 293,
  usable_private_extractions: 290,
  system_metadata_files: 27,
  private_lexicon_lines: 249229,
  private_text_segments: 21151,
  private_grammar_examples: 7658,
  private_reference_index: 84,
};

// Reports the package must ship. A missing report blocks ingestion: without
// it there is nothing to check the layers against.
const REQUIRED_REPORTS = [
  'reports/stats.json',
  'reports/candidate_stats.json',
  'reports/FINDINGS.md',
  'SOURCE_LEDGER.md',
  'DATA_CARD.md',
  'processed/archive_reconciliation.json',
];

const REGISTRY_FILES = {
  manifest: 'processed/source_manifest.jsonl',
  routes: 'processed/source_routes.jsonl',
  rights: 'processed/rights_review_queue.jsonl',
};

// The four candidate layers, smallest first so a package that is going to be
// refused is refused before the largest layer is streamed.
const CANDIDATE_LAYERS = [
  { layer: 'private_reference_index', file: 'processed/private_reference_index.jsonl',
    audited_key: 'private_reference_index', text_field: null, kind: 'reference_record', lak_layer: false },
  { layer: 'private_grammar_examples', file: 'processed/private_grammar_examples.jsonl',
    audited_key: 'private_grammar_examples', text_field: 'text', kind: 'grammar_example_line', lak_layer: true },
  { layer: 'private_text_segments', file: 'processed/private_text_segments.jsonl',
    audited_key: 'private_text_segments', text_field: 'text', kind: 'text_block', lak_layer: true },
  { layer: 'private_lexicon_lines', file: 'processed/private_lexicon_lines.jsonl',
    audited_key: 'private_lexicon_lines', text_field: 'text', kind: 'lexicon_line', lak_layer: true },
];

// Every file whose bytes the verifier depends on. The verification cache is
// keyed by a digest over exactly this list (see lib/private-packages.js), so
// editing any of them invalidates a cached result.
const VERIFIED_FILES = [
  ...REQUIRED_REPORTS,
  ...Object.values(REGISTRY_FILES),
  ...CANDIDATE_LAYERS.map(l => l.file),
  'processed/full_ocr_status.jsonl',
  'processed/legacy_recovery_status.jsonl',
  'processed/extracted_text',
  'processed/full_ocr',
];

// Material that documents the collection rather than the language. These
// stay inventory / reference / control records: they may be indexed as
// reference material, but they must never enter a Lak language layer, and
// they are never public-search-eligible.
const NON_LANGUAGE_MATERIAL = new Set([
  'system_metadata', 'research_administration', 'non_lak_comparative', 'archive_container',
]);

// Rights values the package itself may declare. Whatever it says, staged rows
// are written with the fail-closed default — a "public domain candidate" is a
// review lead, not a clearance.
const PACKAGE_RIGHTS_STATUSES = [
  'private_research_pending_permission', 'not_applicable', 'public_domain_candidate_review',
];
const PACKAGE_REVIEW_STATUS = 'source_import_unreviewed';

// Fail-closed staging defaults applied to every v1.3 row.
const REQUIRED_POLICY = {
  access_status: 'private_research',
  rights_status: 'permission_pending',
  review_state: 'source_import_unreviewed',
  public_search_eligible: false,
  training_ready: false,
};

class PackageError extends Error {}
function fail(message) { throw new PackageError(message); }

const clean = v => (v == null || v === '' ? null : String(v));

function readJsonFile(dir, rel) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); }
  catch { return null; }
}

// Stream a JSONL file one record at a time. Never materialises the file.
async function forEachRecord(filePath, handler) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim() === '') continue;
      let record;
      try { record = JSON.parse(line); }
      catch (err) { fail(`${path.basename(filePath)} line ${lineNumber} is not valid JSON: ${err.message}`); }
      await handler(record, lineNumber);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return lineNumber;
}

function checkFailClosed(record, ref, file) {
  if (record.public_search_eligible !== false)
    fail(`${file}: record "${ref}" must declare public_search_eligible:false`);
  if (record.training_eligible !== false)
    fail(`${file}: record "${ref}" must declare training_eligible:false`);
  if ('review_status' in record && record.review_status !== PACKAGE_REVIEW_STATUS)
    fail(`${file}: record "${ref}" declares review_status ${JSON.stringify(record.review_status)}; only ${PACKAGE_REVIEW_STATUS} may be imported`);
  if ('rights_status' in record && !PACKAGE_RIGHTS_STATUSES.includes(record.rights_status))
    fail(`${file}: record "${ref}" declares an unknown rights_status ${JSON.stringify(record.rights_status)}`);
  if (!SHA256_RE.test(String(record.source_sha256 || record.sha256 || '')))
    fail(`${file}: record "${ref}" has no SHA-256 of the received source file`);
}

// ── Verification ───────────────────────────────────────────────
// Never throws: a broken package is reported and contributes nothing.
async function verifyPackage(options = {}) {
  const dir = options.packageDir;
  const observed = {};
  const declared = {};
  try {
    for (const rel of REQUIRED_REPORTS) {
      if (!fs.existsSync(path.join(dir, rel))) fail(`the package is missing the required report ${rel}`);
    }
    for (const rel of Object.values(REGISTRY_FILES).concat(CANDIDATE_LAYERS.map(l => l.file))) {
      if (!fs.existsSync(path.join(dir, rel))) fail(`the package is missing ${rel}`);
    }

    const stats = readJsonFile(dir, 'reports/stats.json');
    const candidateStats = readJsonFile(dir, 'reports/candidate_stats.json');
    if (!stats) fail('reports/stats.json is missing or unreadable, so no audited count can be checked against the package itself');
    if (!candidateStats) fail('reports/candidate_stats.json is missing or unreadable, so no candidate count can be checked against the package itself');
    Object.assign(declared, {
      source_files_total: stats.source_files_total,
      substantive_files: stats.substantive_files,
      system_metadata_files: stats.system_metadata_files,
      usable_private_extractions: (stats.extraction_quality || {}).usable_private_extraction,
      private_lexicon_lines: candidateStats.private_lexicon_lines,
      private_text_segments: candidateStats.private_text_segments,
      private_grammar_examples: candidateStats.private_grammar_examples,
      private_reference_index: candidateStats.private_reference_index,
      source_routes: candidateStats.source_routes,
      rights_review_queue: candidateStats.rights_review_queue,
    });

    if (stats.fail_closed !== true) fail('reports/stats.json does not declare fail_closed processing');
    if (candidateStats.fail_closed !== true) fail('reports/candidate_stats.json does not declare fail_closed processing');
    if (stats.public_search_eligible !== 0)
      fail(`the package declares ${stats.public_search_eligible} public-search-eligible files; it must declare 0`);
    if (stats.training_eligible !== 0)
      fail(`the package declares ${stats.training_eligible} training-eligible files; it must declare 0`);

    // Declarations must agree with the audited numbers before a single line
    // is read: a package that disagrees with the audit is a different package.
    const declaredChecks = [
      ['reports/stats.json source_files_total', stats.source_files_total, AUDITED.source_routes],
      ['reports/candidate_stats.json source_routes', candidateStats.source_routes, AUDITED.source_routes],
      ['reports/stats.json substantive_files', stats.substantive_files, AUDITED.rights_review_items],
      ['reports/candidate_stats.json rights_review_queue', candidateStats.rights_review_queue, AUDITED.rights_review_items],
      ['reports/stats.json system_metadata_files', stats.system_metadata_files, AUDITED.system_metadata_files],
      ['reports/stats.json extraction_quality.usable_private_extraction',
        (stats.extraction_quality || {}).usable_private_extraction, AUDITED.usable_private_extractions],
      ['reports/candidate_stats.json private_lexicon_lines', candidateStats.private_lexicon_lines, AUDITED.private_lexicon_lines],
      ['reports/candidate_stats.json private_text_segments', candidateStats.private_text_segments, AUDITED.private_text_segments],
      ['reports/candidate_stats.json private_grammar_examples', candidateStats.private_grammar_examples, AUDITED.private_grammar_examples],
      ['reports/candidate_stats.json private_reference_index', candidateStats.private_reference_index, AUDITED.private_reference_index],
    ];
    for (const [what, value, expected] of declaredChecks) {
      if (value !== expected) fail(`${what} is ${JSON.stringify(value)}, not the audited ${expected}`);
    }
    if (stats.substantive_files + stats.system_metadata_files !== stats.source_files_total) {
      fail(`the package declares ${stats.substantive_files} substantive plus ${stats.system_metadata_files} system files, which is not the declared total of ${stats.source_files_total}`);
    }

    // ── Source registry: one disposition row per received file ──
    const sources = new Map();
    let qualityUsable = 0;
    let systemMetadata = 0;
    const manifestLines = await forEachRecord(path.join(dir, REGISTRY_FILES.manifest), record => {
      const ref = record.relative_path || `sequence ${record.sequence}`;
      if (!Number.isInteger(record.sequence)) fail(`source_manifest.jsonl: record "${ref}" has no sequence`);
      if (sources.has(record.sequence)) fail(`source_manifest.jsonl: duplicate sequence ${record.sequence}`);
      if (!record.relative_path) fail(`source_manifest.jsonl: record ${record.sequence} has no relative_path`);
      if (!SHA256_RE.test(String(record.sha256 || '')))
        fail(`source_manifest.jsonl: record "${ref}" has no SHA-256 of the received file`);
      checkFailClosed(record, ref, 'source_manifest.jsonl');
      if (record.extracted_text_relpath &&
          !fs.existsSync(path.join(dir, record.extracted_text_relpath))) {
        fail(`source_manifest.jsonl: record "${ref}" points at ${record.extracted_text_relpath}, which is not in the package`);
      }
      if (record.extraction_quality === 'usable_private_extraction') qualityUsable += 1;
      if (record.material_type === 'system_metadata') systemMetadata += 1;
      sources.set(record.sequence, {
        sequence: record.sequence,
        relative_path: record.relative_path,
        sha256: record.sha256,
        material_type: record.material_type,
        language_scope: record.language_scope,
        extraction_quality: record.extraction_quality,
        extraction_status: record.extraction_status,
        rights_status: record.rights_status,
        review_status: record.review_status,
        corpus_role: record.corpus_role,
        recommended_use: record.recommended_use,
        extension: record.extension,
        bytes: record.bytes,
        priority: record.priority,
        text_chars: record.text_chars,
        word_count: record.word_count,
        duplicate_group: record.duplicate_group,
        canonical_duplicate: record.canonical_duplicate,
        extracted_text_relpath: record.extracted_text_relpath,
        source_urls: Array.isArray(record.source_urls) ? record.source_urls : [],
        received_from: record.received_from,
        received_date: record.received_date,
      });
    });
    observed.source_manifest = manifestLines;
    if (sources.size !== AUDITED.source_routes)
      fail(`source_manifest.jsonl holds ${sources.size} files but the audit recorded ${AUDITED.source_routes}`);
    if (qualityUsable !== AUDITED.usable_private_extractions)
      fail(`the package holds ${qualityUsable} usable private extractions, not the audited ${AUDITED.usable_private_extractions}`);
    if (systemMetadata !== AUDITED.system_metadata_files)
      fail(`the package holds ${systemMetadata} system-metadata records, not the audited ${AUDITED.system_metadata_files}`);
    observed.usable_private_extractions = qualityUsable;
    observed.system_metadata_files = systemMetadata;

    // ── Routes: exactly one corpus disposition per received file ──
    const routes = new Map();
    await forEachRecord(path.join(dir, REGISTRY_FILES.routes), record => {
      const ref = record.source_relative_path || `sequence ${record.source_sequence}`;
      if (!sources.has(record.source_sequence))
        fail(`source_routes.jsonl: record "${ref}" routes sequence ${record.source_sequence}, which is not in the source manifest`);
      if (routes.has(record.source_sequence))
        fail(`source_routes.jsonl: duplicate route for sequence ${record.source_sequence}`);
      const source = sources.get(record.source_sequence);
      if (record.source_sha256 !== source.sha256)
        fail(`source_routes.jsonl: record "${ref}" carries a different file digest than the source manifest`);
      if (!record.derived_route) fail(`source_routes.jsonl: record "${ref}" has no derived_route`);
      if (!record.disposition) fail(`source_routes.jsonl: record "${ref}" has no disposition`);
      checkFailClosed(record, ref, 'source_routes.jsonl');
      // Inventory / reference / control material may only be routed to the
      // reference index — never into a Lak language layer.
      if (NON_LANGUAGE_MATERIAL.has(record.material_type) && record.derived_route !== 'private_reference_index') {
        fail(`source_routes.jsonl: ${record.material_type} record "${ref}" is routed to ${record.derived_route}; non-language material stays an inventory or reference record`);
      }
      routes.set(record.source_sequence, {
        derived_route: record.derived_route,
        disposition: record.disposition,
        corpus_role: record.corpus_role,
        recommended_use: record.recommended_use,
      });
    });
    observed.source_routes = routes.size;
    if (routes.size !== AUDITED.source_routes)
      fail(`source_routes.jsonl holds ${routes.size} dispositions but the audit recorded ${AUDITED.source_routes}`);
    for (const sequence of sources.keys()) {
      if (!routes.has(sequence))
        fail(`source_routes.jsonl has no disposition for received file ${sources.get(sequence).relative_path}`);
    }

    // ── Rights-review queue: one action per substantive source ──
    const rights = new Map();
    await forEachRecord(path.join(dir, REGISTRY_FILES.rights), record => {
      const ref = record.source_relative_path || `sequence ${record.source_sequence}`;
      if (!sources.has(record.source_sequence))
        fail(`rights_review_queue.jsonl: record "${ref}" is not in the source manifest`);
      if (rights.has(record.source_sequence))
        fail(`rights_review_queue.jsonl: duplicate entry for sequence ${record.source_sequence}`);
      if (!record.required_action) fail(`rights_review_queue.jsonl: record "${ref}" states no required action`);
      checkFailClosed(record, ref, 'rights_review_queue.jsonl');
      if (sources.get(record.source_sequence).material_type === 'system_metadata')
        fail(`rights_review_queue.jsonl: record "${ref}" queues a system-metadata file for rights review`);
      rights.set(record.source_sequence, {
        required_action: record.required_action,
        rights_status: record.rights_status,
        material_type: record.material_type,
        source_urls: Array.isArray(record.source_urls) ? record.source_urls : [],
        canonical_duplicate: record.canonical_duplicate,
      });
    });
    observed.rights_review_items = rights.size;
    if (rights.size !== AUDITED.rights_review_items)
      fail(`rights_review_queue.jsonl holds ${rights.size} items but the audit recorded ${AUDITED.rights_review_items}`);

    // ── Candidate layers ───────────────────────────────────────
    const layerCounts = {};
    for (const layer of CANDIDATE_LAYERS) {
      const seen = new Set();
      let count = 0;
      await forEachRecord(path.join(dir, layer.file), (record, lineNumber) => {
        const ref = record.candidate_id || `${layer.layer} line ${lineNumber}`;
        const source = sources.get(record.source_sequence);
        if (!source)
          fail(`${layer.file}: record "${ref}" cites source sequence ${record.source_sequence}, which is not in the source manifest`);
        if (record.source_sha256 !== source.sha256)
          fail(`${layer.file}: record "${ref}" carries a different file digest than the source manifest`);
        if (record.source_relative_path !== source.relative_path)
          fail(`${layer.file}: record "${ref}" carries a different source path than the source manifest`);
        checkFailClosed(record, ref, layer.file);
        if (layer.text_field) {
          if (typeof record.candidate_id !== 'string' || !record.candidate_id.trim())
            fail(`${layer.file}: record on line ${lineNumber} has no candidate_id`);
          if (seen.has(record.candidate_id)) fail(`${layer.file}: duplicate candidate_id "${record.candidate_id}"`);
          seen.add(record.candidate_id);
          // Whitespace is not text: a blank candidate has nothing to review.
          if (!String(record[layer.text_field] ?? '').trim())
            fail(`${layer.file}: record "${ref}" carries no candidate text`);
          // A Lak language layer must never be fed by inventory,
          // administrative or non-Lak comparative material.
          if (layer.lak_layer && NON_LANGUAGE_MATERIAL.has(source.material_type)) {
            fail(`${layer.file}: record "${ref}" comes from ${source.material_type} material, which must stay an inventory or reference record`);
          }
        } else if (record.extracted_text_relpath &&
                   !fs.existsSync(path.join(dir, record.extracted_text_relpath))) {
          fail(`${layer.file}: record "${ref}" points at ${record.extracted_text_relpath}, which is not in the package`);
        }
        count += 1;
      });
      if (count !== AUDITED[layer.audited_key])
        fail(`${layer.file} holds ${count} records but the audit recorded ${AUDITED[layer.audited_key]}`);
      layerCounts[layer.layer] = count;
    }
    Object.assign(observed, layerCounts);

    return {
      status: 'verified',
      blocked_reason: null,
      declared,
      observed,
      sources_total: sources.size,
    };
  } catch (err) {
    if (err instanceof PackageError) return { status: 'blocked', blocked_reason: err.message, declared, observed };
    return { status: 'blocked', blocked_reason: `verification failed: ${err.message}`, declared, observed };
  }
}

// ── Import ─────────────────────────────────────────────────────
// Idempotent: every layer is keyed by (layer, file digest), and every row by
// its own stable key, so re-running the import stages nothing new. Rows are
// written in batches while the file is streamed; no layer is held in memory.
//
// Resumable, too. The lexicon layer alone is a quarter of a million records,
// and on a host that suspends the process between requests an all-or-nothing
// transaction that size is rolled back on every interruption — the layer never
// lands, and because the verification cache is only written once every layer
// succeeds, the whole package restarts from scratch on the next boot. So each
// layer commits in chunks and records how far it got, in the same transaction
// as the rows that progress describes. An interrupted import therefore keeps
// everything it committed and the next boot resumes from there.

const BATCH_ROWS = 500;

// Records staged per committed chunk. Large enough that the progress writes
// are negligible, small enough that an interruption costs little work.
const COMMIT_ROWS = 2000;

// ...and a wall-clock ceiling on top of it. Row count alone is the wrong unit
// when the host decides when the process runs: a slow chunk can leave an open
// transaction for a long time and lose all of it. Committing at least this
// often bounds what an interruption can cost, in time rather than in rows.
const COMMIT_INTERVAL_MS = 2000;

function digestOf(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

async function insertBatch(client, sql, columns, rows) {
  if (!rows.length) return;
  const values = [];
  const placeholders = rows.map((row, i) => {
    values.push(...row);
    const base = i * columns;
    return '(' + Array.from({ length: columns }, (_, k) => '$' + (base + k + 1)).join(',') + ')';
  });
  await client.query(sql.replace('__VALUES__', placeholders.join(',')), values);
}

// A stable, content-free row key: the same package always produces the same
// key, so a repeated import collides and inserts nothing.
function rowKey(...parts) {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

// Streams one layer into the database in committed chunks, skipping whatever
// an earlier, interrupted run already staged.
class LayerWriter {
  constructor(pool, { batchId, sql, columns, resumeFrom }) {
    this.pool = pool;
    this.batchId = batchId;
    this.sql = sql;
    this.columns = columns;
    this.resumeFrom = resumeFrom;
    this.index = 0;        // records seen in this file, counting earlier runs
    this.pending = [];     // rows buffered for the next INSERT
    this.sinceCommit = 0;  // rows written since the last COMMIT
    this.lastCommit = Date.now();
    this.client = null;
  }

  // Call once per record. False means an earlier run already committed it, so
  // the caller can skip rebuilding a row it would only discard.
  next() {
    this.index += 1;
    return this.index > this.resumeFrom;
  }

  async open() {
    if (this.client) return;
    this.client = await this.pool.connect();
    await this.client.query('BEGIN');
  }

  async push(row) {
    this.pending.push(row);
    if (this.pending.length >= BATCH_ROWS) await this.flush();
    const due = this.sinceCommit >= COMMIT_ROWS ||
      (this.sinceCommit > 0 && Date.now() - this.lastCommit >= COMMIT_INTERVAL_MS);
    if (due) await this.commit(false);
  }

  async flush() {
    if (!this.pending.length) return;
    await this.open();
    await insertBatch(this.client, this.sql, this.columns, this.pending);
    this.sinceCommit += this.pending.length;
    this.pending = [];
  }

  // The progress marker is written in the same transaction as the rows it
  // describes, so a boot that dies mid-chunk can never leave an offset that
  // claims more than was actually staged.
  async commit(final) {
    await this.flush();
    await this.open();
    await this.client.query(
      `UPDATE v13_import_batches
          SET resume_offset = $2, imported_count = $2, status = $3, updated_at = now()
        WHERE id = $1`,
      [this.batchId, this.index, final ? 'complete' : 'in_progress']);
    await this.client.query('COMMIT');
    this.client.release();
    this.client = null;
    this.sinceCommit = 0;
    this.lastCommit = Date.now();
  }

  async abort() {
    if (!this.client) return;
    await this.client.query('ROLLBACK').catch(() => {});
    this.client.release();
    this.client = null;
  }
}

async function importLayer(pool, { packageDir, layerId, file, declaredCount, sql, columns, run }) {
  const filePath = path.join(packageDir, file);
  const fileDigest = digestOf(filePath);
  const existing = await pool.query(
    `SELECT id, imported_count, status, resume_offset
       FROM v13_import_batches WHERE layer = $1 AND file_sha256 = $2`,
    [layerId, fileDigest]);

  let batchId;
  let resumeFrom = 0;
  const row = existing.rows[0];
  if (row && row.status === 'complete') {
    return { layer: layerId, imported_count: row.imported_count, already_present: true, resumed: false };
  }
  if (row) {
    // An earlier boot was interrupted part-way through this layer.
    batchId = row.id;
    resumeFrom = row.resume_offset;
  } else {
    // The batch row is committed on its own, before any data: it is the anchor
    // that makes the chunks that follow resumable.
    batchId = 'v13b_' + crypto.randomUUID();
    await pool.query(
      `INSERT INTO v13_import_batches
         (id, package_id, layer, file_name, file_sha256, declared_count, imported_count,
          status, resume_offset)
       VALUES ($1,$2,$3,$4,$5,$6,0,'in_progress',0)`,
      [batchId, PACKAGE_ID, layerId, file, fileDigest, declaredCount]);
  }

  const writer = new LayerWriter(pool, { batchId, sql, columns, resumeFrom });
  try {
    await run(writer, filePath);
    await writer.commit(true);
  } catch (err) {
    await writer.abort();
    throw err;
  }
  return {
    layer: layerId,
    imported_count: writer.index,
    already_present: false,
    resumed: resumeFrom > 0,
  };
}

// The source registry: one disposition row per received file, including the
// 27 system-metadata records. Absolute filesystem paths from the sender's
// machine are deliberately dropped; only the relative path is kept.
async function importSources(pool, packageDir) {
  return importLayer(pool, {
    packageDir, layerId: 'source_registry', file: REGISTRY_FILES.manifest,
    declaredCount: AUDITED.source_routes,
    sql: `INSERT INTO v13_sources
        (id, batch_id, source_sequence, source_path, source_sha256, material_type, language_scope,
         extraction_quality, extraction_status, derived_route, disposition, corpus_role,
         recommended_use, declared_rights_status, extracted_text_relpath, source_urls,
         bytes, text_chars, word_count, priority, duplicate_group, canonical_duplicate, extension)
        VALUES __VALUES__ ON CONFLICT (source_sequence) DO NOTHING`,
    columns: 23,
    run: async (writer, filePath) => {
      const routes = new Map();
      await forEachRecord(path.join(packageDir, REGISTRY_FILES.routes), record => {
        routes.set(record.source_sequence, record);
      });
      await forEachRecord(filePath, async record => {
        if (!writer.next()) return;
        const route = routes.get(record.sequence) || {};
        await writer.push([
          'v13s_' + rowKey(PACKAGE_ID, 'source', String(record.sequence)),
          writer.batchId, record.sequence, record.relative_path, record.sha256,
          clean(record.material_type), clean(record.language_scope),
          clean(record.extraction_quality), clean(record.extraction_status),
          clean(route.derived_route), clean(route.disposition),
          clean(record.corpus_role), clean(record.recommended_use),
          clean(record.rights_status), clean(record.extracted_text_relpath),
          JSON.stringify(Array.isArray(record.source_urls) ? record.source_urls : []),
          record.bytes ?? null, record.text_chars ?? null, record.word_count ?? null,
          clean(record.priority), clean(record.duplicate_group), clean(record.canonical_duplicate),
          clean(record.extension),
        ]);
      });
    },
  });
}

async function importRightsReviews(pool, packageDir) {
  return importLayer(pool, {
    packageDir, layerId: 'rights_review_queue', file: REGISTRY_FILES.rights,
    declaredCount: AUDITED.rights_review_items,
    sql: `INSERT INTO v13_rights_reviews
        (id, batch_id, source_sequence, source_path, source_sha256, material_type,
         required_action, declared_rights_status, source_urls, canonical_duplicate)
        VALUES __VALUES__ ON CONFLICT (source_sequence) DO NOTHING`,
    columns: 10,
    run: async (writer, filePath) => {
      await forEachRecord(filePath, async record => {
        if (!writer.next()) return;
        await writer.push([
          'v13r_' + rowKey(PACKAGE_ID, 'rights', String(record.source_sequence)),
          writer.batchId, record.source_sequence, record.source_relative_path, record.source_sha256,
          clean(record.material_type), clean(record.required_action), clean(record.rights_status),
          JSON.stringify(Array.isArray(record.source_urls) ? record.source_urls : []),
          clean(record.canonical_duplicate),
        ]);
      });
    },
  });
}

async function importCandidateLayer(pool, packageDir, layer) {
  return importLayer(pool, {
    packageDir, layerId: layer.layer, file: layer.file,
    declaredCount: AUDITED[layer.audited_key],
    sql: `INSERT INTO v13_candidates
        (id, batch_id, layer, candidate_ref, candidate_kind, intended_layer, text, word_count,
         source_sequence, source_path, source_sha256, source_unit, source_line,
         extraction_quality, material_type, language_scope, declared_rights_status,
         extracted_text_relpath, text_chars, content_sha256)
        VALUES __VALUES__ ON CONFLICT (layer, candidate_ref) DO NOTHING`,
    columns: 20,
    run: async (writer, filePath) => {
      const sources = new Map();
      await forEachRecord(path.join(packageDir, REGISTRY_FILES.manifest), record => {
        sources.set(record.sequence, {
          extraction_quality: record.extraction_quality,
          material_type: record.material_type,
          language_scope: record.language_scope,
        });
      });
      await forEachRecord(filePath, async (record, lineNumber) => {
        // Skipping before the row is built keeps a resumed run from rehashing
        // text it already staged.
        if (!writer.next()) return;
        const source = sources.get(record.source_sequence) || {};
        const candidateRef = record.candidate_id ||
          rowKey(layer.layer, record.source_sha256, String(record.source_sequence), String(lineNumber));
        const text = layer.text_field ? clean(record[layer.text_field]) : null;
        await writer.push([
          'v13c_' + rowKey(PACKAGE_ID, layer.layer, candidateRef),
          writer.batchId, layer.layer, candidateRef,
          clean(record.candidate_kind) || layer.kind,
          clean(record.intended_layer), text, record.word_count ?? null,
          record.source_sequence, record.source_relative_path, record.source_sha256,
          record.source_unit ?? null, record.source_line ?? null,
          clean(record.source_extraction_quality) || clean(source.extraction_quality),
          clean(record.material_type) || clean(source.material_type),
          clean(record.source_language_scope) || clean(record.language_scope) || clean(source.language_scope),
          clean(record.rights_status),
          clean(record.extracted_text_relpath), record.text_chars ?? null,
          crypto.createHash('sha256').update(text ?? (record.extracted_text_relpath || candidateRef)).digest('hex'),
        ]);
      });
    },
  });
}

// Stage the whole verified package. Nothing is imported unless verification
// passed: a blocked package contributes no rows at all.
// `onLayer` is called as each layer finishes, so a caller can publish real
// progress while the long layers are still landing.
async function importPackage(pool, packageDir, verification, options = {}) {
  if (!verification || verification.status !== 'verified') {
    return { imported: [], skipped: true, reason: verification ? verification.blocked_reason : 'not verified' };
  }
  const onLayer = typeof options.onLayer === 'function' ? options.onLayer : null;
  const imported = [];
  const record = async result => {
    imported.push(result);
    if (onLayer) await onLayer(result).catch(() => {});
  };
  await record(await importSources(pool, packageDir));
  await record(await importRightsReviews(pool, packageDir));
  for (const layer of CANDIDATE_LAYERS) {
    await record(await importCandidateLayer(pool, packageDir, layer));
  }
  return { imported, skipped: false, reason: null };
}

// Staged counts straight from the database, for the authenticated status view.
async function stagedCounts(pool) {
  const [sources, rights, candidates] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE extraction_quality = 'usable_private_extraction')::int AS usable,
                       COUNT(*) FILTER (WHERE material_type = 'system_metadata')::int AS system_metadata,
                       COUNT(*) FILTER (WHERE public_search_eligible)::int AS searchable,
                       COUNT(*) FILTER (WHERE training_ready)::int AS training_ready
                  FROM v13_sources`),
    pool.query('SELECT COUNT(*)::int AS total FROM v13_rights_reviews'),
    pool.query(`SELECT layer, COUNT(*)::int AS n,
                       COUNT(*) FILTER (WHERE public_search_eligible)::int AS searchable,
                       COUNT(*) FILTER (WHERE training_ready)::int AS training_ready,
                       COUNT(*) FILTER (WHERE review_state <> 'source_import_unreviewed')::int AS reviewed
                  FROM v13_candidates GROUP BY layer`),
    ]);
  const layers = Object.fromEntries(candidates.rows.map(r => [r.layer, r.n]));
  return {
    source_routes: sources.rows[0].total,
    usable_private_extractions: sources.rows[0].usable,
    system_metadata_files: sources.rows[0].system_metadata,
    rights_review_items: rights.rows[0].total,
    private_lexicon_lines: layers.private_lexicon_lines || 0,
    private_text_segments: layers.private_text_segments || 0,
    private_grammar_examples: layers.private_grammar_examples || 0,
    private_reference_index: layers.private_reference_index || 0,
    public_search_eligible: sources.rows[0].searchable +
      candidates.rows.reduce((sum, r) => sum + r.searchable, 0),
    training_ready: sources.rows[0].training_ready +
      candidates.rows.reduce((sum, r) => sum + r.training_ready, 0),
    reviewed: candidates.rows.reduce((sum, r) => sum + r.reviewed, 0),
  };
}

// Every layer the import stages, in the order importPackage writes them,
// with the audited figure each one is measured against.
const LAYER_PLAN = [
  { layer: 'source_registry', audited_key: 'source_routes' },
  { layer: 'rights_review_queue', audited_key: 'rights_review_items' },
  ...CANDIDATE_LAYERS.map(l => ({ layer: l.layer, audited_key: l.audited_key })),
];

const DECLARED_TOTAL = LAYER_PLAN.reduce((sum, l) => sum + AUDITED[l.audited_key], 0);

// How far staging has actually got, read from the database rather than from a
// boot-time variable. This is what lets the status stay honest across a
// process that is suspended and resumed: progress is durable, memory is not.
async function importProgress(pool) {
  // One row per layer: the current one. A layer can hold batches from more
  // than one package digest, and a superseded batch must not be counted as
  // this package's progress.
  const rows = await pool.query(
    `SELECT DISTINCT ON (layer) layer, status, imported_count
       FROM v13_import_batches
      WHERE package_id = $1
      ORDER BY layer, updated_at DESC, created_at DESC`, [PACKAGE_ID]);
  const byLayer = new Map(rows.rows.map(r => [r.layer, r]));
  let complete = 0;
  let staged = 0;
  for (const planned of LAYER_PLAN) {
    const row = byLayer.get(planned.layer);
    if (!row) continue;
    staged += Number(row.imported_count) || 0;
    if (row.status === 'complete') complete += 1;
  }
  return {
    layers_complete: complete,
    layers_total: LAYER_PLAN.length,
    records_staged: staged,
    records_declared: DECLARED_TOTAL,
    complete: complete === LAYER_PLAN.length,
  };
}

module.exports = {
  PACKAGE_ID, PACKAGE_LABEL, ARCHIVE_SHA256, AUDITED, REQUIRED_POLICY,
  REQUIRED_REPORTS, REGISTRY_FILES, CANDIDATE_LAYERS, VERIFIED_FILES,
  NON_LANGUAGE_MATERIAL, PACKAGE_RIGHTS_STATUSES, LAYER_PLAN, DECLARED_TOTAL,
  verifyPackage, importPackage, stagedCounts, importProgress, forEachRecord,
};
