'use strict';

// Private source-import layer for the audited Diana Forker v1.2 package.
//
// NOTHING is ingested from a description, a screenshot or a quoted count. A
// source only enters the private staging tables when the processed package is
// physically present AND every integrity check below passes:
//
//   * the package's own stats.json agrees with the audited counts
//   * every JSONL line parses, carries a stable id and source provenance
//     (row / page / collection / work level, plus the SHA-256 of the original
//     received file)
//   * every record declares the fail-closed policy the package promises:
//     private research, pending permission, unreviewed, not training-eligible
//     (and, for OCR pages, not search-eligible)
//   * the package declares no Bible material, and no record identifies a
//     Bible-derived source
//   * no record publishes a URL to a protected binary (PDF/DOC/ODS/WAV)
//
// Anything else stops ingestion for that source and is reported verbatim. The
// package itself is never served: it lives outside public/ and is gitignored.
//
// Package directory (override with SOURCE_IMPORT_PACKAGE_DIR):
//   private/v1.2/

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PACKAGE_DIR = process.env.SOURCE_IMPORT_PACKAGE_DIR ||
  path.join(__dirname, '..', 'private', 'v1.2');

// SHA-256 of the transferred archive, recorded when the package was received.
// Checked whenever the archive is still in the workspace; its absence is fine
// (the extracted files carry their own per-source digests), but a different
// archive under the same name blocks everything.
const PACKAGE_ARCHIVE_SHA256 = '6183e591fa8e35cb93c058bcf276f934fe1cbb7080a0cce87300ba5a7ddedd4e';
const PACKAGE_LABEL = 'lak-corpus-v1.2-processed-only';
const PACKAGE_ARCHIVE_DIR = process.env.SOURCE_IMPORT_ARCHIVE_DIR ||
  path.join(__dirname, '..', 'attached_assets');

const LAYERS = ['lexical_candidate', 'ocr_candidate', 'audio_inventory', 'reference_metadata'];
const GRANULARITIES = ['row', 'page', 'collection', 'work'];

// Fail-closed defaults. Every staged candidate is written with exactly these
// values regardless of what a package claims; a package whose own policy
// fields are weaker is rejected rather than quietly downgraded.
const REQUIRED_POLICY = {
  access_status: 'private_research',
  rights_status: 'permission_pending',
  review_state: 'source_import_unreviewed',
  training_ready: false,
  redistribution_permitted: false,
};
const ALLOWED_CONSENT = ['unknown', 'not_applicable', 'documented', 'withheld'];

// Policy values the package must declare on every record.
const PACKAGE_ACCESS_STATUS = 'private_research_pending_permission';
const PACKAGE_REVIEW_STATES = ['source_import_unreviewed', 'ocr_unreviewed'];

const SHA256_RE = /^[0-9a-f]{64}$/;
// Bible exclusion is a statement about the SOURCE, not about vocabulary: a
// dictionary entry for the word "библия" is ordinary lexicography. The check
// therefore runs over source-identifying fields only.
const BIBLE_PATTERN = /\b(bible|biblical|scripture|gospel|new testament|old testament)\b|библи|евангел|псалт|завет/i;
const IDENTIFYING_FIELDS = ['source', 'source_file', 'title', 'author', 'role', 'collection'];
// Protected binaries must never be referenced by a servable URL.
const BINARY_URL_PATTERN = /https?:\/\/\S+\.(wav|mp3|flac|pdf|docx?|ods|xlsx?)\b/i;

const clean = v => (v == null || v === '' ? null : String(v));

// Normalization used for exact-form corroboration, mirroring the package's
// reconciliation method: NFC + casefold + palochka folding + punctuation
// removal. This detects identical spellings, never identical senses.
function normalizeForm(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[iіӏ]/g, 'ӏ')
    .replace(/[^\p{L}\p{N}ӏ]+/gu, '');
}

const EXPECTED_SOURCES = [
  {
    source_id: 'khaydakov-1962',
    observatory_id: 'khaydakov',
    title: 'Хайдаков 1962 — Лакско-русский словарь',
    file: 'khaydakov_1962_lexicon.jsonl',
    layer: 'lexical_candidate',
    provenance_granularity: 'row',
    expected_record_count: 9294,
    stats_key: 'khaydakov_entries',
    id_field: 'entry_id',
    required_fields: ['lak_headword', 'source_line', 'source_sha256'],
    description_key: 'khaydakov_1962',
    map: r => ({
      candidate_ref: r.entry_id,
      lak_text: clean(r.lak_headword),
      ru_text: clean(r.russian_entry_text),
      gloss: null,
      ocr_text: null,
      title: null,
      row_ref: String(r.source_line),
      page_ref: null,
      collection_ref: null,
      normalized_form: normalizeForm(r.lak_headword),
      provenance: {
        source_id: 'khaydakov-1962', source: r.source, source_author: r.source_author,
        source_year: r.source_year, source_file: r.source_file, source_line: r.source_line,
        source_sha256: r.source_sha256, evidence_class: r.evidence_class,
      },
    }),
  },
  {
    source_id: 'lexcauc',
    observatory_id: null,
    title: 'LexCauc Lak — structured lexical records',
    file: 'lexcauc_lak_lexicon.jsonl',
    layer: 'lexical_candidate',
    provenance_granularity: 'row',
    expected_record_count: 2246,
    stats_key: 'lexcauc_records',
    id_field: 'entry_id',
    required_fields: ['source_row', 'source_sha256'],
    description_key: 'lexcauc',
    map: r => ({
      candidate_ref: r.entry_id,
      lak_text: clean(r.orthographic),
      ru_text: clean(r.concept_ru) || clean(r.def_ru),
      gloss: clean(r.phonemic) || clean(r.gloss),
      ocr_text: null,
      title: null,
      row_ref: String(r.source_row),
      page_ref: null,
      collection_ref: null,
      normalized_form: normalizeForm(r.orthographic),
      provenance: {
        source_id: 'lexcauc', source: r.source, source_file: r.source_file,
        source_sheet: r.source_sheet, source_row: r.source_row, source_sha256: r.source_sha256,
        evidence_class: r.evidence_class, lex_id: r.lex_id, concept_en: r.concept_en,
      },
    }),
  },
  {
    source_id: 'dzhidalaev-1993',
    observatory_id: null,
    title: 'Джидалаев 1993 — постраничный OCR (Русско-лакский словарь)',
    file: 'dzhidalaev_1993_ocr_pages.jsonl',
    layer: 'ocr_candidate',
    provenance_granularity: 'page',
    expected_record_count: 926,
    stats_key: 'dzhidalaev_ocr_pages_with_text',
    id_field: 'candidate_id',
    required_fields: ['page', 'ocr_text', 'source_sha256'],
    description_key: 'dzhidalaev_1993',
    map: r => ({
      candidate_ref: r.candidate_id,
      lak_text: null,
      ru_text: null,
      gloss: null,
      ocr_text: clean(r.ocr_text),
      title: null,
      row_ref: null,
      page_ref: String(r.page),
      collection_ref: null,
      normalized_form: null,
      provenance: {
        source_id: 'dzhidalaev-1993', source: r.source, source_file: r.source_file,
        page: r.page, source_sha256: r.source_sha256, evidence_class: r.evidence_class,
        review_status: r.review_status,
      },
    }),
  },
  {
    source_id: 'lexcauc-audio',
    observatory_id: 'forker-audio',
    title: 'LexCauc Lak — опись аудиозаписей',
    file: 'lexcauc_audio_inventory.jsonl',
    layer: 'audio_inventory',
    provenance_granularity: 'collection',
    expected_record_count: 7,
    stats_key: 'lexcauc_audio_files',
    id_field: 'audio_id',
    required_fields: ['source_file', 'duration_seconds', 'source_sha256'],
    expected_metrics: { file_count: 7, total_duration_seconds: 3154.894 },
    description_key: 'lexcauc_audio',
    map: r => ({
      candidate_ref: r.audio_id,
      lak_text: null,
      ru_text: null,
      gloss: null,
      ocr_text: null,
      title: r.source_file,
      row_ref: null,
      page_ref: null,
      collection_ref: 'lexcauc-lak-recordings',
      normalized_form: null,
      // Only what the package documents. Speaker, variety, recording context
      // and row/time alignment stay unknown and are recorded as such.
      provenance: {
        source_id: 'lexcauc-audio', source_file: r.source_file, source_sha256: r.source_sha256,
        bytes: r.bytes, duration_seconds: r.duration_seconds, sample_rate_hz: r.sample_rate_hz,
        channels: r.channels, language_label_from_package: r.language_label_from_package,
        speaker_id: r.speaker_id ?? null, speaker_variety: r.speaker_variety ?? null,
        recording_date: r.recording_date ?? null, recording_location: r.recording_location ?? null,
        row_or_time_alignment: r.row_or_time_alignment ?? null,
        consent_status: r.consent_status,
      },
    }),
  },
  {
    source_id: 'diana-reference-documents',
    observatory_id: 'kazenin-syntax',
    title: 'Reference documents — Anderson 1996, Kazenin 2013 and related',
    file: 'reference_documents.jsonl',
    layer: 'reference_metadata',
    provenance_granularity: 'work',
    expected_record_count: 5,
    stats_key: 'reference_documents',
    id_field: 'document_id',
    required_fields: ['title', 'source_file', 'source_sha256'],
    description_key: 'reference_documents',
    map: r => ({
      candidate_ref: r.document_id,
      lak_text: null,
      ru_text: null,
      gloss: null,
      ocr_text: null,
      title: r.title,
      row_ref: null,
      page_ref: null,
      collection_ref: 'diana-forker-2026-07-30',
      normalized_form: null,
      provenance: {
        source_id: 'diana-reference-documents', title: r.title, author: r.author, year: r.year,
        role: r.role, quality: r.quality, source_file: r.source_file, source_sha256: r.source_sha256,
        bytes: r.bytes, pages: r.pages, received_from: r.received_from, received_date: r.received_date,
        public_text_extraction_allowed: r.public_text_extraction_allowed,
      },
    }),
  },
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Canonical, key-sorted serialization so a checksum is reproducible.
function canonicalize(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(k => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
  }
  return JSON.stringify(value === undefined ? null : value);
}

function nearlyEqual(a, b) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-6;
}

class ManifestError extends Error {}
function fail(message) { throw new ManifestError(message); }

function readJsonl(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(line => line.trim() !== '');
  const records = lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch (err) { fail(`line ${index + 1} is not valid JSON: ${err.message}`); }
  });
  return { records, digest: sha256(raw) };
}

function checkRecordPolicy(expected, record, ref) {
  if (record.access_status !== PACKAGE_ACCESS_STATUS)
    fail(`record "${ref}" declares access_status ${JSON.stringify(record.access_status)}; the package must stage everything as ${PACKAGE_ACCESS_STATUS}`);
  if (!PACKAGE_REVIEW_STATES.includes(record.review_status))
    fail(`record "${ref}" declares review_status ${JSON.stringify(record.review_status)}; only ${PACKAGE_REVIEW_STATES.join(' / ')} may be imported`);
  if (record.training_eligible !== false)
    fail(`record "${ref}" is marked training_eligible; nothing may arrive training-ready`);
  if (expected.layer === 'ocr_candidate' && record.search_eligible !== false)
    fail(`OCR record "${ref}" must declare search_eligible:false`);
  if (expected.layer === 'reference_metadata' && record.public_text_extraction_allowed !== false)
    fail(`reference record "${ref}" must declare public_text_extraction_allowed:false`);

  for (const field of IDENTIFYING_FIELDS) {
    if (record[field] && BIBLE_PATTERN.test(String(record[field])))
      fail(`record "${ref}" identifies a Bible-derived source, which is excluded`);
  }
  if (BINARY_URL_PATTERN.test(JSON.stringify(record)))
    fail(`record "${ref}" publishes a URL to a protected binary`);
  if (!SHA256_RE.test(String(record.source_sha256 || '')))
    fail(`record "${ref}" has no SHA-256 of the received source file`);
}

function verifySource(expected, dir, stats) {
  const filePath = path.join(dir, expected.file);
  let parsed;
  try {
    parsed = readJsonl(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return {
        status: 'awaiting_manifest',
        error: 'The verified processed package is not present in the workspace, so no candidate was ingested.',
      };
    }
    if (err instanceof ManifestError) return { status: 'rejected', error: err.message };
    return { status: 'rejected', error: `source file could not be read: ${err.message}` };
  }

  try {
    const raw = parsed.records;
    if (raw.length !== expected.expected_record_count)
      fail(`file holds ${raw.length} records but the audit recorded ${expected.expected_record_count}`);
    // The package's own declaration must be present and must agree: a count we
    // cannot check against the package is not a verified count.
    if (!(expected.stats_key in stats))
      fail(`package stats does not declare ${expected.stats_key}`);
    if (stats[expected.stats_key] !== expected.expected_record_count)
      fail(`package stats.${expected.stats_key} is ${stats[expected.stats_key]}, not ${expected.expected_record_count}`);

    const refs = new Set();
    const records = raw.map((record, index) => {
      const ref = record[expected.id_field];
      if (typeof ref !== 'string' || !ref.trim())
        fail(`record ${index + 1} has no ${expected.id_field}`);
      if (refs.has(ref)) fail(`duplicate ${expected.id_field} "${ref}"`);
      refs.add(ref);
      for (const field of expected.required_fields) {
        if (record[field] === undefined || record[field] === null || record[field] === '')
          fail(`record "${ref}" is missing ${field}, required for ${expected.provenance_granularity}-level provenance`);
      }
      checkRecordPolicy(expected, record, ref);
      const mapped = expected.map(record);
      mapped.content_sha256 = sha256(canonicalize(record));
      // Audio consent is documented as unknown in the package; everything
      // else has no consent record at all, which is also unknown.
      mapped.consent_status = 'unknown';
      return mapped;
    });

    // Layer-specific integrity.
    const metrics = {};
    if (expected.layer === 'audio_inventory') {
      const totalSeconds = Number(records
        .reduce((sum, r) => sum + Number(r.provenance.duration_seconds || 0), 0).toFixed(3));
      metrics.file_count = records.length;
      metrics.total_duration_seconds = totalSeconds;
      if (!nearlyEqual(totalSeconds, expected.expected_metrics.total_duration_seconds))
        fail(`audio inventory totals ${totalSeconds}s, not the audited ${expected.expected_metrics.total_duration_seconds}s`);
      if (records.length !== expected.expected_metrics.file_count)
        fail(`audio inventory holds ${records.length} files, not ${expected.expected_metrics.file_count}`);
      if (!('lexcauc_audio_seconds' in stats))
        fail('package stats does not declare lexcauc_audio_seconds');
      if (!nearlyEqual(stats.lexcauc_audio_seconds, totalSeconds))
        fail(`package stats.lexcauc_audio_seconds is ${stats.lexcauc_audio_seconds}, not ${totalSeconds}`);
      if (records.some(r => r.provenance.row_or_time_alignment))
        fail('audio inventory claims row/time alignment, which the package does not support');
    }
    if (expected.layer === 'reference_metadata') {
      const has = (author, year) => raw.some(r =>
        String(r.author || '').toLowerCase().includes(author) && Number(r.year) === year);
      if (!has('anderson', 1996)) fail('reference documents do not include Anderson 1996');
      if (!has('казенин', 2013) && !has('kazenin', 2013)) fail('reference documents do not include Kazenin 2013');
      if (raw.some(r => r.ocr_text || r.full_text || r.body))
        fail('reference documents must carry metadata only, not copied content');
    }

    return {
      status: 'verified',
      error: null,
      records,
      file_sha256: parsed.digest,
      records_sha256: sha256(canonicalize(records)),
      metrics,
    };
  } catch (err) {
    if (err instanceof ManifestError) return { status: 'rejected', error: err.message };
    return { status: 'rejected', error: `verification failed: ${err.message}` };
  }
}

// If the received archive is still in the workspace it must be the archive we
// audited. A file of the same name with a different digest is a different
// package and blocks ingestion.
function checkArchive(archiveDir) {
  let names;
  try { names = fs.readdirSync(archiveDir); } catch { return null; }
  const archive = names.find(n => n.startsWith(PACKAGE_LABEL) && n.endsWith('.zip'));
  if (!archive) return null;
  let digest;
  try { digest = sha256(fs.readFileSync(path.join(archiveDir, archive))); }
  catch { return 'The received package archive is present but could not be read for checksumming.'; }
  return digest === PACKAGE_ARCHIVE_SHA256
    ? null
    : 'The package archive in the workspace does not match the checksum recorded when it was received.';
}

function readJsonFile(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

// Exact normalized-form overlap between the two lexical sources. This is what
// the package's reconciliation report describes: identical spellings, never
// an assertion that two entries mean the same thing.
function computeOverlap(sources) {
  const byId = Object.fromEntries(sources.map(s => [s.source_id, s]));
  const left = byId['khaydakov-1962'];
  const right = byId['lexcauc'];
  if (!left || !right || left.status !== 'verified' || right.status !== 'verified') return null;
  const index = new Map();
  for (const record of left.records) {
    if (!record.normalized_form) continue;
    if (!index.has(record.normalized_form)) index.set(record.normalized_form, 0);
    index.set(record.normalized_form, index.get(record.normalized_form) + 1);
  }
  let forms = 0, pairs = 0;
  const seen = new Set();
  for (const record of right.records) {
    const form = record.normalized_form;
    if (!form || !index.has(form)) continue;
    if (!seen.has(form)) { seen.add(form); forms++; }
    pairs += index.get(form);
  }
  return { overlapping_forms: forms, candidate_pairs: pairs };
}

// Verify the whole package. Never throws: a missing or broken source is
// reported and simply contributes nothing.
function verifySources(options = {}) {
  const dir = options.packageDir || options.manifestDir || PACKAGE_DIR;
  const stats = readJsonFile(path.join(dir, 'stats.json'));
  const reconciliation = readJsonFile(path.join(dir, 'reconciliation.json'));

  // The package declaration is mandatory. Without it there is nothing to check
  // the record counts against, so no source can be verified and nothing is
  // ingested — a partially copied package must never look complete.
  // A package that does not declare Bible exclusion also blocks everything.
  const archiveError = checkArchive(options.archiveDir || PACKAGE_ARCHIVE_DIR);
  const packageBlocked = !stats
    ? { status: 'awaiting_manifest', error: 'The package declaration (stats.json) is missing or unreadable, so no audited count can be checked against the package itself.' }
    : archiveError
      ? { status: 'rejected', error: archiveError }
      : stats.bible_included !== false
        ? { status: 'rejected', error: 'The package does not declare Bible exclusion (stats.bible_included must be false).' }
        : null;

  const sources = EXPECTED_SOURCES.map(expected => {
    const result = packageBlocked
      ? { status: packageBlocked.status, error: packageBlocked.error }
      : verifySource(expected, dir, stats);
    return {
      source_id: expected.source_id,
      observatory_id: expected.observatory_id,
      title: expected.title,
      layer: expected.layer,
      provenance_granularity: expected.provenance_granularity,
      expected_record_count: expected.expected_record_count,
      expected_metrics: expected.expected_metrics || null,
      file: expected.file,
      description_key: expected.description_key,
      status: result.status,
      error: result.error || null,
      file_sha256: result.file_sha256 || null,
      records_sha256: result.records_sha256 || null,
      metrics: result.metrics || {},
      records: result.records || [],
    };
  });

  const verified = sources.filter(s => s.status === 'verified');
  const overlap = computeOverlap(sources);
  return {
    package_dir: dir,
    package_label: PACKAGE_LABEL,
    package_present: !!stats,
    stats,
    reconciliation,
    overlap,
    sources,
    counts: {
      sources_total: sources.length,
      verified: verified.length,
      awaiting_manifest: sources.filter(s => s.status === 'awaiting_manifest').length,
      rejected: sources.filter(s => s.status === 'rejected').length,
      expected_records: sources.reduce((sum, s) => sum + s.expected_record_count, 0),
      verified_records: verified.reduce((sum, s) => sum + s.records.length, 0),
    },
    // True whenever an audited source could not be verified: those sources
    // contribute no candidates at all.
    ingestion_blocked: verified.length !== sources.length,
  };
}

// Public reason codes. The detailed verifier message stays server-side (it can
// name files and parse errors); the public surface gets a bounded code only.
const BLOCKED_REASON_CODES = { awaiting_manifest: 'package_not_present', rejected: 'verification_failed' };

// Content-free public view: statuses, counts and rights states only.
function publicStatus(verification) {
  return {
    package_label: verification.package_label,
    package_present: verification.package_present,
    counts: verification.counts,
    ingestion_blocked: verification.ingestion_blocked,
    policy_defaults: { ...REQUIRED_POLICY },
    corroboration: verification.overlap
      ? {
        ...verification.overlap,
        method: verification.reconciliation ? verification.reconciliation.method : null,
        merged: false,
      }
      : null,
    sources: verification.sources.map(s => ({
      source_id: s.source_id,
      observatory_id: s.observatory_id,
      title: s.title,
      layer: s.layer,
      provenance_granularity: s.provenance_granularity,
      expected_record_count: s.expected_record_count,
      expected_metrics: s.expected_metrics,
      description_key: s.description_key,
      status: s.status,
      blocked_reason_code: s.status === 'verified' ? null : (BLOCKED_REASON_CODES[s.status] || 'verification_failed'),
      verified_record_count: s.status === 'verified' ? s.records.length : 0,
      metrics: s.metrics,
      consent_status: 'unknown',
      // Nothing here is public, training-ready or redistributable.
      access_status: REQUIRED_POLICY.access_status,
      rights_status: REQUIRED_POLICY.rights_status,
      review_state: REQUIRED_POLICY.review_state,
      training_ready: false,
    })),
  };
}

// Link identical spellings across the two lexical sources as corroboration.
// Nothing is merged: both candidates keep their own text, provenance and
// review state, and the link is recorded as evidence to compare.
async function linkCorroborations(pool) {
  const result = await pool.query(
    `INSERT INTO source_import_corroborations
       (candidate_id, related_kind, related_candidate_id, related_key, relation, note, linked_by_name)
     SELECT a.id, 'candidate', b.id, b.id, 'corroborates',
            'exact normalized form overlap between source packages (not semantic deduplication)',
            'source-import'
       FROM source_import_candidates a
       JOIN source_import_candidates b
         ON b.normalized_form = a.normalized_form
      WHERE a.source_id = 'khaydakov-1962'
        AND b.source_id = 'lexcauc'
        AND a.normalized_form IS NOT NULL AND a.normalized_form <> ''
     ON CONFLICT (candidate_id, related_kind, related_key, relation) DO NOTHING`);
  return result.rowCount;
}

// Import verified sources into the private staging tables. Idempotent: a
// batch is keyed by (source_id, file_sha256), so re-running with the same
// package imports nothing new. Unverified sources are skipped entirely.
async function importVerified(pool, verification) {
  const imported = [];
  const skipped = [];
  for (const source of verification.sources) {
    if (source.status !== 'verified') {
      skipped.push({ source_id: source.source_id, status: source.status, reason: source.error });
      continue;
    }
    const existing = await pool.query(
      'SELECT id, imported_count FROM source_import_batches WHERE source_id = $1 AND manifest_sha256 = $2',
      [source.source_id, source.file_sha256]);
    if (existing.rows[0]) {
      imported.push({ source_id: source.source_id, batch_id: existing.rows[0].id,
        imported_count: existing.rows[0].imported_count, already_present: true });
      continue;
    }

    const batchId = 'sib_' + crypto.randomUUID();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO source_import_batches
           (id, source_id, layer, provenance_granularity, manifest_file, manifest_sha256,
            records_sha256, declared_count, expected_count, imported_count,
            verification_status, verification_error, metrics)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'verified',NULL,$11)`,
        [batchId, source.source_id, source.layer, source.provenance_granularity,
         source.file, source.file_sha256, source.records_sha256,
         source.records.length, source.expected_record_count, source.records.length,
         JSON.stringify(source.metrics || {})]);

      const COLUMNS = 17;
      const CHUNK = 200;
      for (let start = 0; start < source.records.length; start += CHUNK) {
        const chunk = source.records.slice(start, start + CHUNK);
        const values = [];
        const placeholders = chunk.map((record, i) => {
          values.push('sic_' + crypto.randomUUID(), batchId, source.source_id, source.layer,
            record.candidate_ref, record.lak_text, record.ru_text, record.gloss,
            record.ocr_text, record.title, record.row_ref, record.page_ref,
            record.collection_ref, record.normalized_form, JSON.stringify(record.provenance),
            record.content_sha256, record.consent_status);
          const base = i * COLUMNS;
          return '(' + Array.from({ length: COLUMNS }, (_, k) => '$' + (base + k + 1)).join(',') + ')';
        });
        await client.query(
          `INSERT INTO source_import_candidates
             (id, batch_id, source_id, layer, candidate_ref, lak_text, ru_text, gloss,
              ocr_text, title, row_ref, page_ref, collection_ref, normalized_form,
              provenance, content_sha256, consent_status)
           VALUES ${placeholders.join(',')}
           ON CONFLICT (source_id, candidate_ref) DO NOTHING`,
          values);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      throw err;
    }
    client.release();
    imported.push({ source_id: source.source_id, batch_id: batchId,
      imported_count: source.records.length, already_present: false });
  }

  const corroborations = imported.length ? await linkCorroborations(pool) : 0;
  return { imported, skipped, corroborations };
}

module.exports = {
  PACKAGE_DIR, PACKAGE_LABEL, PACKAGE_ARCHIVE_SHA256, LAYERS, GRANULARITIES,
  REQUIRED_POLICY, ALLOWED_CONSENT, EXPECTED_SOURCES,
  PACKAGE_ACCESS_STATUS, PACKAGE_REVIEW_STATES,
  canonicalize, sha256, normalizeForm, BLOCKED_REASON_CODES,
  verifySources, publicStatus, importVerified, linkCorroborations,
};
