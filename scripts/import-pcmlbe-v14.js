'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { migrateFiles } = require('./migrate');
const { NORMALIZATION_VERSION, wordformId, lemmaKeyId } = require('../lib/corpus-v2');

const IMPORTER_VERSION = 'import-pcmlbe-v14.js/1';
const DEFAULT_BUNDLE = path.join(__dirname, '..', 'imports', 'lak-corpus-v1.4');

function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filename);
    input.on('data', chunk => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function canonicalHash(record) {
  const clean = {};
  for (const key of Object.keys(record).sort()) {
    if (key !== 'content_hash') clean[key] = record[key];
  }
  return crypto.createHash('sha256').update(JSON.stringify(clean) + '\n').digest('hex');
}

async function readJsonlGzip(filename, validate) {
  const rows = [];
  const lines = readline.createInterface({ input: fs.createReadStream(filename).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber++;
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); }
    catch (error) { throw new Error(`${path.basename(filename)}:${lineNumber}: invalid JSON: ${error.message}`); }
    if (row.content_hash && canonicalHash(row) !== row.content_hash) {
      throw new Error(`${path.basename(filename)}:${lineNumber}: content hash mismatch`);
    }
    validate(row, lineNumber);
    rows.push(row);
  }
  return rows;
}

function required(row, fields, label) {
  for (const field of fields) {
    if (row[field] === undefined || row[field] === null || row[field] === '') {
      throw new Error(`${label}: missing ${field}`);
    }
  }
}

async function verifyBundle(bundleDir) {
  const manifestPath = path.join(bundleDir, 'manifest.json');
  const manifestBytes = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schema_version !== '2.0.0') throw new Error(`Unsupported schema ${manifest.schema_version}`);
  if (manifest.normalization_version !== NORMALIZATION_VERSION) throw new Error('Normalization version mismatch');
  const manifestHash = crypto.createHash('sha256').update(manifestBytes).digest('hex');
  for (const [filename, expected] of Object.entries(manifest.artifacts || {})) {
    const actual = await sha256File(path.join(bundleDir, filename));
    if (actual !== expected.sha256) throw new Error(`${filename}: SHA-256 mismatch`);
  }
  const validators = {
    'documents.jsonl.gz': row => required(row, ['id','source_id','source_document_ref','source_file_sha256','content_hash'], 'document'),
    'segments.jsonl.gz': row => required(row, ['id','document_id','source_segment_ref','legacy_record_id','text_original','content_hash'], 'segment'),
    'tokens.jsonl.gz': row => required(row, ['id','segment_id','ordinal','source_token_ref','surface_original','surface_normalized','raw_tag','content_hash'], 'token'),
    'source-analyses.jsonl.gz': row => {
      required(row, ['id','token_id','lemma_original','lemma_normalized','raw_tag','evidence_class','content_hash'], 'analysis');
      if (row.evidence_class !== 'source_annotation') throw new Error('Prediction found in source analysis artifact');
    },
    'lemma-proposals.jsonl.gz': row => {
      required(row, ['id','surface_normalized','proposed_lemma_normalized','method','frequency','content_hash'], 'proposal');
      if (row.evidence_class !== 'deterministic_prediction' || row.public_search_eligible !== false || row.training_eligible !== false) {
        throw new Error(`proposal ${row.id}: release-1 safety flags are invalid`);
      }
      if (!Array.isArray(row.occurrence_token_ids) || row.occurrence_token_ids.length !== row.frequency) {
        throw new Error(`proposal ${row.id}: occurrence list does not equal frequency`);
      }
    },
  };
  const data = {};
  for (const filename of Object.keys(validators)) {
    data[filename] = await readJsonlGzip(path.join(bundleDir, filename), validators[filename]);
    if (data[filename].length !== manifest.artifacts[filename].records) throw new Error(`${filename}: record count mismatch`);
  }
  return { manifest, manifestHash, data };
}

function chunks(rows, size = 250) {
  const output = [];
  for (let i = 0; i < rows.length; i += size) output.push(rows.slice(i, i + size));
  return output;
}

async function insertRows(client, table, columns, rows, conflict = 'id') {
  let inserted = 0;
  for (const group of chunks(rows)) {
    const values = [];
    const tuples = group.map((row, rowIndex) => {
      const placeholders = columns.map((column, colIndex) => {
        let value = row[column];
        if (value && typeof value === 'object' && !Array.isArray(value)) value = JSON.stringify(value);
        values.push(value === undefined ? null : value);
        return `$${rowIndex * columns.length + colIndex + 1}`;
      });
      return `(${placeholders.join(',')})`;
    });
    const result = await client.query(
      `INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (${conflict}) DO NOTHING`, values);
    inserted += result.rowCount;
  }
  return inserted;
}

async function verifyExistingHashes(client, table, rows) {
  for (const group of chunks(rows, 1000)) {
    const ids = group.map(row => row.id);
    const result = await client.query(`SELECT id, content_hash FROM ${table} WHERE id = ANY($1)`, [ids]);
    const found = new Map(result.rows.map(row => [row.id, row.content_hash]));
    for (const row of group) {
      if (!found.has(row.id)) throw new Error(`${table}: failed to insert ${row.id}`);
      if (found.get(row.id) !== row.content_hash) throw new Error(`${table}: stable-ID content conflict for ${row.id}`);
    }
  }
}

async function reconcileInTransaction(client, expected) {
  const queries = {
    documents: `SELECT COUNT(*)::int n FROM corpus_documents WHERE source_id='pcmlbe'`,
    segments: `SELECT COUNT(*)::int n FROM corpus_segments s JOIN corpus_documents d ON d.id=s.document_id WHERE d.source_id='pcmlbe'`,
    tokens: `SELECT COUNT(*)::int n FROM corpus_tokens t JOIN corpus_segments s ON s.id=t.segment_id JOIN corpus_documents d ON d.id=s.document_id WHERE d.source_id='pcmlbe'`,
    source_analyses: `SELECT COUNT(*)::int n FROM corpus_token_analyses a JOIN corpus_tokens t ON t.id=a.token_id JOIN corpus_segments s ON s.id=t.segment_id JOIN corpus_documents d ON d.id=s.document_id WHERE d.source_id='pcmlbe'`,
    x_tokens: `SELECT COUNT(*)::int n FROM corpus_tokens t JOIN corpus_segments s ON s.id=t.segment_id JOIN corpus_documents d ON d.id=s.document_id WHERE d.source_id='pcmlbe' AND t.raw_tag='X'`,
    annotated_lemma_keys: `SELECT COUNT(DISTINCT a.lemma_key_id)::int n FROM corpus_token_analyses a JOIN corpus_tokens t ON t.id=a.token_id JOIN corpus_segments s ON s.id=t.segment_id JOIN corpus_documents d ON d.id=s.document_id WHERE d.source_id='pcmlbe'`,
    wordforms: `SELECT COUNT(DISTINCT t.wordform_id)::int n FROM corpus_tokens t JOIN corpus_segments s ON s.id=t.segment_id JOIN corpus_documents d ON d.id=s.document_id WHERE d.source_id='pcmlbe'`,
    raw_tags: `SELECT COUNT(DISTINCT t.raw_tag)::int n FROM corpus_tokens t JOIN corpus_segments s ON s.id=t.segment_id JOIN corpus_documents d ON d.id=s.document_id WHERE d.source_id='pcmlbe'`,
    proposals: `SELECT COUNT(*)::int n FROM morphology_proposals`,
    proposal_occurrences: `SELECT COUNT(*)::int n FROM morphology_proposal_occurrences`,
    legacy_segment_ids: `SELECT COUNT(*)::int n FROM corpus_segments s JOIN corpus_documents d ON d.id=s.document_id WHERE d.source_id='pcmlbe' AND s.legacy_record_id IS NOT NULL`,
  };
  const observed = {};
  for (const [name, sql] of Object.entries(queries)) observed[name] = (await client.query(sql)).rows[0].n;
  for (const [name, value] of Object.entries(observed)) {
    if (expected[name] !== value) throw new Error(`Reconciliation failed for ${name}: expected ${expected[name]}, observed ${value}`);
  }
  const methods = await client.query('SELECT method, COUNT(*)::int n FROM morphology_proposals GROUP BY method ORDER BY method');
  observed.proposal_methods = Object.fromEntries(methods.rows.map(row => [row.method, row.n]));
  if (JSON.stringify(observed.proposal_methods) !== JSON.stringify(expected.proposal_methods)) {
    throw new Error(`Reconciliation failed for proposal methods`);
  }
  const mismatches = await client.query(`SELECT COUNT(*)::int n FROM morphology_proposals p LEFT JOIN (SELECT proposal_id, COUNT(*)::int n FROM morphology_proposal_occurrences GROUP BY proposal_id) o ON o.proposal_id=p.id WHERE p.frequency <> COALESCE(o.n,0)`);
  if (mismatches.rows[0].n !== 0) throw new Error('Proposal frequencies do not match occurrence links');
  const nonX = await client.query(`SELECT COUNT(*)::int n FROM morphology_proposal_occurrences o JOIN corpus_tokens t ON t.id=o.token_id WHERE t.raw_tag <> 'X'`);
  if (nonX.rows[0].n !== 0) throw new Error('A proposal occurrence points to a source-annotated token');
  const unsafe = await client.query(`SELECT COUNT(*)::int n FROM morphology_proposals WHERE public_search_eligible OR training_eligible OR evidence_class <> 'deterministic_prediction'`);
  if (unsafe.rows[0].n !== 0) throw new Error('Unsafe proposal flags detected');
  const reviewLinks = await client.query(`SELECT
    (SELECT COUNT(*)::int FROM validation_tasks WHERE subject_type='morphology_proposal') AS tasks,
    (SELECT COUNT(*)::int FROM morphology_validation_links) AS links`);
  if (reviewLinks.rows[0].tasks !== expected.proposals || reviewLinks.rows[0].links !== expected.proposals) {
    throw new Error(`Morphology review queue mismatch: ${JSON.stringify(reviewLinks.rows[0])}`);
  }
  return observed;
}

async function importBundle(bundleDir = DEFAULT_BUNDLE, options = {}) {
  if (options.migrate !== false) await migrateFiles();
  const { manifest, manifestHash, data } = await verifyBundle(bundleDir);
  const documents = data['documents.jsonl.gz'];
  const segments = data['segments.jsonl.gz'];
  const tokens = data['tokens.jsonl.gz'];
  const analyses = data['source-analyses.jsonl.gz'];
  const proposals = data['lemma-proposals.jsonl.gz'];
  const batchId = `pcmlbe-v14-${manifestHash.slice(0, 20)}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('pcmlbe-v1.4'))`);
    await client.query(
      `INSERT INTO corpus_sources
        (id,title,creator_credit,canonical_url,persistent_id,spdx_license,license_url,rights_status,access_status,review_status,attribution_text,share_alike,public_search_allowed,training_allowed)
       VALUES ('pcmlbe',$1,$2,$3,$4,$5,$6,'open_license','public','rights_verified',$7,TRUE,TRUE,FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [manifest.source.title, 'Erwin R. Komen / Nijmegen Parsed Corpus of Modern Lak', manifest.source.persistent_id,
       manifest.source.persistent_id, manifest.source.license, manifest.source.license_url,
       'Parsed Corpus of Modern Lak (PCMLBE), CC BY-SA 4.0']);
    const source = (await client.query(`SELECT * FROM corpus_sources WHERE id='pcmlbe'`)).rows[0];
    if (!source || source.rights_status !== 'open_license' || source.access_status !== 'public' || !source.public_search_allowed || source.training_allowed) {
      throw new Error('PCMLBE source policy is not in the release-1 fail-closed state');
    }

    const prior = (await client.query('SELECT * FROM corpus_import_batches WHERE id=$1', [batchId])).rows[0];
    if (prior && prior.status === 'imported') {
      const observed = await reconcileInTransaction(client, manifest.counts);
      await client.query('COMMIT');
      return { batchId, idempotent: true, inserted: {}, counts: observed };
    }
    await client.query(
      `INSERT INTO corpus_import_batches
        (id,source_id,schema_version,importer_version,input_manifest_sha256,artifact_sha256,expected_counts,status)
       VALUES ($1,'pcmlbe',$2,$3,$4,$5,$6,'validated')
       ON CONFLICT (id) DO UPDATE SET status='validated', error=NULL`,
      [batchId, manifest.schema_version, IMPORTER_VERSION, manifestHash,
       JSON.stringify(Object.fromEntries(Object.entries(manifest.artifacts).map(([key, value]) => [key, value.sha256]))),
       JSON.stringify(manifest.counts)]);

    const preparedDocuments = documents.map(row => ({ ...row, import_batch_id: batchId }));
    const preparedSegments = segments.map(row => ({ ...row, import_batch_id: batchId }));
    const preparedWordforms = new Map();
    for (const row of tokens) {
      const id = wordformId(row.surface_normalized);
      if (!preparedWordforms.has(id)) preparedWordforms.set(id, { id, language_code: 'lbe', normalized_form: row.surface_normalized, normalization_version: NORMALIZATION_VERSION, display_form: row.surface_original });
    }
    const preparedTokens = tokens.map(row => ({ ...row, wordform_id: wordformId(row.surface_normalized), import_batch_id: batchId }));
    const preparedLemmaKeys = new Map();
    const rememberLemma = (normalized, display) => {
      const id = lemmaKeyId(normalized);
      if (!preparedLemmaKeys.has(id)) preparedLemmaKeys.set(id, { id, language_code: 'lbe', normalized_form: normalized, normalization_version: NORMALIZATION_VERSION, display_form: display || normalized });
      return id;
    };
    for (const row of analyses) rememberLemma(row.lemma_normalized, row.lemma_original);
    for (const row of proposals) rememberLemma(row.proposed_lemma_normalized, row.proposed_lemma_normalized);
    const preparedAnalyses = analyses.map(row => ({ ...row, lemma_key_id: lemmaKeyId(row.lemma_normalized), import_batch_id: batchId }));
    const preparedProposals = proposals.map(row => ({
      id: row.id,
      wordform_id: wordformId(row.surface_normalized),
      proposed_lemma_key_id: lemmaKeyId(row.proposed_lemma_normalized),
      proposed_raw_tag: row.proposed_tag,
      method: row.method,
      rule: row.rule,
      confidence: row.confidence,
      support_count: row.support_count,
      frequency: row.frequency,
      generator_version: manifest.generator_version,
      evidence_class: row.evidence_class,
      state: 'pending',
      access_status: 'authenticated',
      rights_status: 'mixed_or_unverified',
      public_search_eligible: false,
      training_eligible: false,
      proposal_version: 1,
      content_hash: row.content_hash,
      import_batch_id: batchId,
    }));

    const inserted = {};
    inserted.documents = await insertRows(client, 'corpus_documents',
      ['id','source_id','source_document_ref','title','author','editor','bibliography','year','genre','variety','script','raw_metadata','source_file','source_file_sha256','source_url','content_hash','import_batch_id'], preparedDocuments);
    await verifyExistingHashes(client, 'corpus_documents', preparedDocuments);
    inserted.segments = await insertRows(client, 'corpus_segments',
      ['id','document_id','source_segment_ref','forest_id','legacy_record_id','paragraph','section','ordinal','text_original','text_normalized','text_parallel_cyrillic','translation_en','content_hash','import_batch_id'], preparedSegments);
    await verifyExistingHashes(client, 'corpus_segments', preparedSegments);
    inserted.wordforms = await insertRows(client, 'corpus_wordforms',
      ['id','language_code','normalized_form','normalization_version','display_form'], [...preparedWordforms.values()]);
    inserted.tokens = await insertRows(client, 'corpus_tokens',
      ['id','segment_id','wordform_id','ordinal','source_token_ref','surface_original','source_from','source_to','raw_tag','content_hash','import_batch_id'], preparedTokens);
    await verifyExistingHashes(client, 'corpus_tokens', preparedTokens);
    inserted.lemma_keys = await insertRows(client, 'corpus_lemma_keys',
      ['id','language_code','normalized_form','normalization_version','display_form'], [...preparedLemmaKeys.values()]);
    inserted.source_analyses = await insertRows(client, 'corpus_token_analyses',
      ['id','token_id','lemma_key_id','lemma_original','raw_tag','source_pos','source_feature_atoms','definition','evidence_class','source_reference','review_status','content_hash','import_batch_id'], preparedAnalyses);
    await verifyExistingHashes(client, 'corpus_token_analyses', preparedAnalyses);
    inserted.proposals = await insertRows(client, 'morphology_proposals',
      ['id','wordform_id','proposed_lemma_key_id','proposed_raw_tag','method','rule','confidence','support_count','frequency','generator_version','evidence_class','state','access_status','rights_status','public_search_eligible','training_eligible','proposal_version','content_hash','import_batch_id'], preparedProposals);
    await verifyExistingHashes(client, 'morphology_proposals', preparedProposals);

    const occurrenceRows = [];
    const evidenceRows = [];
    const validationTasks = [];
    const validationLinks = [];
    const segmentById = new Map(segments.map(row => [row.id, row]));
    const tokenById = new Map(tokens.map(row => [row.id, row]));
    for (const row of proposals) {
      for (const tokenId of row.occurrence_token_ids) occurrenceRows.push({ proposal_id: row.id, token_id: tokenId });
      for (const label of row.evidence_source_labels || []) evidenceRows.push({
        proposal_id: row.id, source_id: label === 'PCMLBE' ? 'pcmlbe' : null,
        source_label: label, source_record_ref: '', evidence_type: 'proposal_support_label',
        rights_status: label === 'PCMLBE' || label === 'IDS' ? 'open_license' : 'permission_scope_unverified',
        access_status: 'authenticated', content_visible: false,
      });
      const contextRows = row.occurrence_token_ids.slice(0, 3).map(tokenId => segmentById.get(tokenById.get(tokenId).segment_id));
      const taskId = `morph:${row.id}`;
      validationTasks.push({
        id: taskId, kind: 'lemma_analysis',
        prompt_ru: `Предложенный лемматический разбор: ${row.proposed_lemma_normalized}${row.proposed_tag ? ` · ${row.proposed_tag}` : ''}`,
        lak_text: row.surface_original,
        context: {
          morphology_proposal: true, proposal_id: row.id, proposed_lemma: row.proposed_lemma_normalized,
          proposed_tag: row.proposed_tag, method: row.method, confidence: row.confidence,
          frequency: row.frequency, support_count: row.support_count,
          evidence_source_labels: row.evidence_source_labels,
          examples: contextRows.map(item => ({ legacy_record_id: item.legacy_record_id, text: item.text_original })),
          note: 'This is a deterministic proposal, not a source annotation. Accepting it does not assign the analysis to every occurrence.',
        },
        options: JSON.stringify(['accept','reject','uncertain','correct']),
        is_gold: false, gold_answer: null,
        priority: Math.min(100, Math.max(1, Math.round(row.confidence * 60 + Math.log10(row.frequency + 1) * 10))),
        status: 'pending', subject_type: 'morphology_proposal', subject_id: row.id, created_by: 'pcmlbe-v1.4-import',
      });
      validationLinks.push({ proposal_id: row.id, validation_task_id: taskId, proposal_version: 1 });
    }
    inserted.proposal_occurrences = await insertRows(client, 'morphology_proposal_occurrences', ['proposal_id','token_id'], occurrenceRows, 'proposal_id,token_id');
    inserted.proposal_evidence = evidenceRows.length ? await insertRows(client, 'morphology_proposal_evidence',
      ['proposal_id','source_id','source_label','source_record_ref','evidence_type','rights_status','access_status','content_visible'], evidenceRows, 'proposal_id,source_label,source_record_ref') : 0;
    inserted.validation_tasks = await insertRows(client, 'validation_tasks',
      ['id','kind','prompt_ru','lak_text','context','options','is_gold','gold_answer','priority','status','subject_type','subject_id','created_by'], validationTasks);
    inserted.validation_links = await insertRows(client, 'morphology_validation_links', ['proposal_id','validation_task_id','proposal_version'], validationLinks, 'proposal_id');

    const observed = await reconcileInTransaction(client, manifest.counts);
    await client.query(
      `UPDATE corpus_import_batches SET status='imported', observed_counts=$2, finished_at=now(), error=NULL WHERE id=$1`,
      [batchId, JSON.stringify(observed)]);
    await client.query('COMMIT');
    return { batchId, idempotent: false, inserted, counts: observed };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    await client.query(
      `UPDATE corpus_import_batches SET status='failed', error=$2, finished_at=now() WHERE id=$1`,
      [batchId, String(error.message).slice(0, 4000)]).catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  const bundle = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_BUNDLE;
  importBundle(bundle).then(result => {
    console.log(JSON.stringify(result, null, 2));
    return pool.end();
  }).catch(async error => {
    console.error(error.stack || error.message);
    await pool.end().catch(() => {});
    process.exit(1);
  });
}

module.exports = { IMPORTER_VERSION, verifyBundle, importBundle, reconcileInTransaction, canonicalHash };
