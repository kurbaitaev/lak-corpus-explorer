'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const crypto = require('crypto');
const { pool } = require('../lib/db');
const { migrateFiles } = require('./migrate');
const { NORMALIZATION_VERSION, wordformId, lemmaKeyId } = require('../lib/corpus-v2');

const IMPORTER_VERSION = 'import-lexicon-synthesis.js/1';
const DEFAULT_BUNDLE = path.join(__dirname, '..', 'imports', 'lak-lexicon-v1');

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function canonicalHash(row) {
  const clean = {};
  for (const key of Object.keys(row).sort()) if (key !== 'content_hash') clean[key] = row[key];
  return digest(JSON.stringify(clean) + '\n');
}
function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(filename).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}
async function readArtifact(filename) {
  const rows = [];
  const input = readline.createInterface({ input: fs.createReadStream(filename).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let line = 0;
  for await (const value of input) {
    line++;
    if (!value.trim()) continue;
    const row = JSON.parse(value);
    if (row.content_hash && canonicalHash(row) !== row.content_hash) throw new Error(`${path.basename(filename)}:${line}: content hash mismatch`);
    rows.push(row);
  }
  return rows;
}
async function verifyBundle(bundleDir = DEFAULT_BUNDLE) {
  const manifestBytes = fs.readFileSync(path.join(bundleDir, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schema_version !== 'lexicon-synthesis-v1') throw new Error(`Unsupported lexicon schema ${manifest.schema_version}`);
  if (manifest.normalization_version !== NORMALIZATION_VERSION) throw new Error('Lexicon normalization version mismatch');
  const data = {};
  for (const [filename, spec] of Object.entries(manifest.artifacts)) {
    if (await sha256File(path.join(bundleDir, filename)) !== spec.sha256) throw new Error(`${filename}: SHA-256 mismatch`);
    data[filename] = await readArtifact(path.join(bundleDir, filename));
    if (data[filename].length !== spec.records) throw new Error(`${filename}: record count mismatch`);
  }
  return { manifest, manifestHash: digest(manifestBytes), data };
}
function chunks(rows, size = 400) { const out = []; for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size)); return out; }
async function insertRows(client, table, columns, rows, conflict = 'id') {
  let inserted = 0;
  for (const group of chunks(rows)) {
    const values = [];
    const tuples = group.map((row, ri) => `(${columns.map((column, ci) => {
      let value = row[column];
      if (value && typeof value === 'object' && !Array.isArray(value)) value = JSON.stringify(value);
      values.push(value === undefined ? null : value);
      return `$${ri * columns.length + ci + 1}`;
    }).join(',')})`);
    inserted += (await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES ${tuples.join(',')} ON CONFLICT (${conflict}) DO NOTHING`, values)).rowCount;
  }
  return inserted;
}
async function verifyHashes(client, table, rows) {
  for (const group of chunks(rows, 1000)) {
    const found = new Map((await client.query(`SELECT id,content_hash FROM ${table} WHERE id=ANY($1)`, [group.map(row => row.id)])).rows.map(row => [row.id, row.content_hash]));
    for (const row of group) if (found.get(row.id) !== row.content_hash) throw new Error(`${table}: stable-ID conflict for ${row.id}`);
  }
}
async function reconcile(client, expected) {
  const queries = {
    sources: `SELECT COUNT(*)::int n FROM corpus_sources WHERE id IN ('gadzhiev-1958','khaydakov-1962','lexcauc-lak','komen-lakdict','ids-lak','uslar-1890','digiev-2004')`,
    entries: 'SELECT COUNT(*)::int n FROM lexicon_entries', senses: 'SELECT COUNT(*)::int n FROM lexicon_senses',
    forms: 'SELECT COUNT(*)::int n FROM lexicon_forms', relations: 'SELECT COUNT(*)::int n FROM lexicon_entry_lemmas',
    search_terms: 'SELECT COUNT(*)::int n FROM lexicon_search_terms',
  };
  const observed = {};
  for (const [key, sql] of Object.entries(queries)) observed[key] = (await client.query(sql)).rows[0].n;
  for (const key of Object.keys(queries)) if (observed[key] !== expected[key]) throw new Error(`Lexicon reconciliation failed for ${key}: expected ${expected[key]}, observed ${observed[key]}`);
  const word = (await client.query(`SELECT COUNT(*)::int n FROM corpus_wordform_lemma_relations r JOIN corpus_wordforms w ON w.id=r.wordform_id JOIN corpus_lemma_keys l ON l.id=r.lemma_key_id WHERE w.normalized_form='махъру' AND l.normalized_form='махъ' AND r.basis='source_generalization'`)).rows[0].n;
  if (!word) throw new Error('Lexicon reconciliation failed for source-backed махъру to махъ relation');
  observed.source_wordform_relations = (await client.query(`SELECT COUNT(*)::int n FROM corpus_wordform_lemma_relations WHERE basis='source_generalization'`)).rows[0].n;
  return observed;
}

async function importLexiconBundle(bundleDir = DEFAULT_BUNDLE, options = {}) {
  if (options.migrate !== false) await migrateFiles();
  const { manifest, manifestHash, data } = await verifyBundle(bundleDir);
  const sources = data['sources.jsonl.gz'], entries = data['entries.jsonl.gz'], senses = data['senses.jsonl.gz'];
  const forms = data['forms.jsonl.gz'], relations = data['relations.jsonl.gz'], terms = data['search-terms.jsonl.gz'];
  const batchId = `lexicon-v1-${manifestHash.slice(0, 20)}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('lak-lexicon-v1'))`);
    const prior = (await client.query(`SELECT status FROM lexicon_import_batches WHERE id=$1`, [batchId])).rows[0];
    if (prior?.status === 'imported') {
      const counts = await reconcile(client, manifest.counts);
      await client.query('COMMIT');
      return { batchId, idempotent: true, counts };
    }
    await client.query(`INSERT INTO lexicon_import_batches (id,schema_version,importer_version,bundle_sha256,expected_counts,status) VALUES ($1,$2,$3,$4,$5,'preparing') ON CONFLICT (id) DO UPDATE SET status='preparing'`, [batchId, manifest.schema_version, IMPORTER_VERSION, manifestHash, JSON.stringify(manifest.counts)]);
    for (const source of sources) await client.query(`INSERT INTO corpus_sources (id,title,creator_credit,canonical_url,spdx_license,license_url,rights_status,access_status,review_status,attribution_text,public_search_allowed,training_allowed) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,creator_credit=EXCLUDED.creator_credit,canonical_url=COALESCE(EXCLUDED.canonical_url,corpus_sources.canonical_url),spdx_license=COALESCE(EXCLUDED.spdx_license,corpus_sources.spdx_license),license_url=COALESCE(EXCLUDED.license_url,corpus_sources.license_url),rights_status=EXCLUDED.rights_status,access_status=EXCLUDED.access_status,review_status=EXCLUDED.review_status,attribution_text=EXCLUDED.attribution_text,public_search_allowed=EXCLUDED.public_search_allowed,training_allowed=EXCLUDED.training_allowed,updated_at=now()`, [source.id,source.title,source.creator_credit,source.canonical_url||null,source.spdx_license||null,source.license_url||null,source.rights_status,source.access_status,source.review_status,source.attribution_text,source.public_search_allowed,source.training_allowed]);
    const preparedEntries = entries.map(row => ({ ...row, import_batch_id: batchId }));
    await insertRows(client, 'lexicon_entries', ['id','source_id','source_entry_ref','direction','headword_language','headword_original','headword_normalized','homonym_number','part_of_speech','noun_class','source_locator','source_url','raw_entry','review_status','content_hash','import_batch_id'], preparedEntries);
    await verifyHashes(client, 'lexicon_entries', preparedEntries);
    await insertRows(client, 'lexicon_senses', ['id','entry_id','ordinal','gloss_ru','gloss_en','definition','usage_label','raw_sense','content_hash'], senses); await verifyHashes(client,'lexicon_senses',senses);
    await insertRows(client, 'lexicon_forms', ['id','entry_id','language_code','form_original','form_normalized','form_role','feature_atoms','source_explicit','raw_note','content_hash'], forms); await verifyHashes(client,'lexicon_forms',forms);
    const lemmaMap = new Map();
    for (const row of relations) lemmaMap.set(lemmaKeyId(row.lemma_normalized), { id: lemmaKeyId(row.lemma_normalized), language_code:'lbe', normalized_form:row.lemma_normalized, normalization_version:NORMALIZATION_VERSION, display_form:row.lemma_display });
    await insertRows(client, 'corpus_lemma_keys', ['id','language_code','normalized_form','normalization_version','display_form'], [...lemmaMap.values()]);
    const relationRows = relations.map(row => ({ entry_id:row.entry_id, lemma_key_id:lemmaKeyId(row.lemma_normalized), relation_type:row.relation_type, source_form_normalized:row.source_form_normalized, source_explicit:row.source_explicit }));
    await insertRows(client, 'lexicon_entry_lemmas', ['entry_id','lemma_key_id','relation_type','source_form_normalized','source_explicit'], relationRows, 'entry_id,lemma_key_id,relation_type');
    await insertRows(client, 'lexicon_search_terms', ['id','entry_id','sense_id','language_code','term_original','term_normalized','stem_key','term_type','weight','content_hash'], terms); await verifyHashes(client,'lexicon_search_terms',terms);
    const formsByEntry = new Map();
    for (const form of forms) if (form.language_code === 'lbe' && !/\s/.test(form.form_normalized)) { if (!formsByEntry.has(form.entry_id)) formsByEntry.set(form.entry_id, []); formsByEntry.get(form.entry_id).push(form); }
    const wordforms = new Map(), wordRelations = [];
    const entryById = new Map(entries.map(row => [row.id,row]));
    for (const relation of relations) {
      const expandParadigm = relation.relation_type === 'headword' && entryById.get(relation.entry_id)?.source_id === 'khaydakov-1962';
      const linked = (formsByEntry.get(relation.entry_id) || []).filter(form => expandParadigm || form.form_normalized === relation.source_form_normalized);
      for (const form of linked) {
        const wid = wordformId(form.form_normalized); wordforms.set(wid, { id:wid,language_code:'lbe',normalized_form:form.form_normalized,normalization_version:NORMALIZATION_VERSION,display_form:form.form_original });
        wordRelations.push({ wordform_id:wid,lemma_key_id:lemmaKeyId(relation.lemma_normalized),basis:'source_generalization',review_status:'source_verified',source_entry_id:relation.entry_id,feature_atoms:form.feature_atoms||[] });
      }
    }
    await insertRows(client,'corpus_wordforms',['id','language_code','normalized_form','normalization_version','display_form'],[...wordforms.values()]);
    const uniqueWordRelations = new Map();
    for (const row of wordRelations) {
      const key = `${row.wordform_id}\0${row.lemma_key_id}\0${row.basis}`;
      const prior = uniqueWordRelations.get(key);
      if (!prior || (!prior.feature_atoms.length && row.feature_atoms.length)) uniqueWordRelations.set(key,row);
    }
    await insertRows(client,'corpus_wordform_lemma_relations',['wordform_id','lemma_key_id','basis','review_status','source_entry_id','feature_atoms'],[...uniqueWordRelations.values()],'wordform_id,lemma_key_id,basis');
    const counts = await reconcile(client, manifest.counts);
    await client.query(`UPDATE lexicon_import_batches SET status='imported',observed_counts=$2,finished_at=now() WHERE id=$1`, [batchId,JSON.stringify(counts)]);
    await client.query('COMMIT');
    return { batchId, idempotent:false, counts };
  } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
  finally { client.release(); }
}

if (require.main === module) importLexiconBundle(process.argv[2] && path.resolve(process.argv[2])).then(result => { console.log(JSON.stringify(result,null,2)); return pool.end(); }).catch(async error => { console.error(error.stack||error.message); await pool.end().catch(()=>{}); process.exit(1); });
module.exports = { IMPORTER_VERSION, verifyBundle, importLexiconBundle, reconcile, canonicalHash };
