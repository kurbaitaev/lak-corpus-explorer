'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { verifyBundle, reconcileInTransaction } = require('./import-pcmlbe-v14');
const { normalizeLak } = require('../lib/corpus-v2');
const { pool } = require('../lib/db');

const EXPECTED = Object.freeze({
  documents: 41, segments: 8788, tokens: 87266, source_analyses: 20606,
  x_tokens: 66660, annotated_lemma_keys: 1234, wordforms: 20821,
  raw_tags: 71, proposals: 3193, proposal_occurrences: 21716,
  proposal_methods: { exact_dictionary_headword: 1878, learned_suffix_transformation: 1315 },
  legacy_segment_ids: 8788,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function exactObject(actual, expected, label) {
  const sortObject = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sortObject(value[key])])) : value;
  assert(JSON.stringify(sortObject(actual)) === JSON.stringify(sortObject(expected)), `${label}: expected ${JSON.stringify(expected)}, observed ${JSON.stringify(actual)}`);
}

async function reconcileBundle(bundleDir) {
  const { manifest, data } = await verifyBundle(bundleDir);
  exactObject(manifest.counts, EXPECTED, 'manifest counts');
  const documents = data['documents.jsonl.gz'];
  const segments = data['segments.jsonl.gz'];
  const tokens = data['tokens.jsonl.gz'];
  const analyses = data['source-analyses.jsonl.gz'];
  const proposals = data['lemma-proposals.jsonl.gz'];
  assert(new Set(documents.map(row => row.id)).size === EXPECTED.documents, 'document IDs are not unique');
  assert(new Set(segments.map(row => row.id)).size === EXPECTED.segments, 'segment IDs are not unique');
  assert(new Set(segments.map(row => row.legacy_record_id)).size === EXPECTED.legacy_segment_ids, 'legacy IDs are missing or duplicated');
  assert(new Set(tokens.map(row => row.id)).size === EXPECTED.tokens, 'token IDs are not unique');
  assert(new Set(tokens.map(row => row.surface_normalized)).size === EXPECTED.wordforms, 'wordform count mismatch');
  assert(new Set(tokens.map(row => row.raw_tag)).size === EXPECTED.raw_tags, 'raw-tag count mismatch');
  assert(tokens.filter(row => row.raw_tag === 'X').length === EXPECTED.x_tokens, 'X-token count mismatch');
  assert(new Set(analyses.map(row => row.lemma_normalized)).size === EXPECTED.annotated_lemma_keys, 'annotated lemma-key count mismatch');
  assert(analyses.every(row => row.evidence_class === 'source_annotation'), 'non-source evidence found in analyses');
  assert(proposals.every(row => row.evidence_class === 'deterministic_prediction' && !row.public_search_eligible && !row.training_eligible), 'unsafe prediction flags');

  const tokenById = new Map(tokens.map(row => [row.id, row]));
  for (const proposal of proposals) {
    assert(proposal.occurrence_token_ids.length === proposal.frequency, `proposal ${proposal.id}: frequency mismatch`);
    for (const tokenId of proposal.occurrence_token_ids) {
      const token = tokenById.get(tokenId);
      assert(token && token.raw_tag === 'X', `proposal ${proposal.id}: occurrence is not an X token`);
    }
  }

  const dataPath = path.join(__dirname, '..', 'data', 'corpus-data.json');
  if (!fs.existsSync(dataPath)) {
    const extraction = spawnSync('python3', [path.join(__dirname, 'extract-corpus.py')], { stdio: 'inherit' });
    assert(extraction.status === 0, 'legacy corpus extraction failed');
  }
  const legacyRows = JSON.parse(fs.readFileSync(dataPath, 'utf8')).filter(row => row[3] === 'PCMLBE');
  assert(legacyRows.length === EXPECTED.segments, 'legacy PCMLBE count changed');
  const legacyById = new Map(legacyRows.map(row => [row[5], row]));
  for (const segment of segments) {
    const legacy = legacyById.get(segment.legacy_record_id);
    assert(legacy, `missing legacy row ${segment.legacy_record_id}`);
    assert(normalizeLak(legacy[1]) === normalizeLak(segment.text_original), `legacy text mismatch ${segment.legacy_record_id}`);
  }

  function matchingTokens(form) { return tokens.filter(row => row.surface_normalized === normalizeLak(form)); }
  const yaru = matchingTokens('яру');
  assert(yaru.length === 57, 'fixture яру occurrence count changed');
  const analysisByToken = new Map(analyses.map(row => [row.token_id, row]));
  assert(yaru.every(row => analysisByToken.get(row.id)?.lemma_normalized === 'яру' && analysisByToken.get(row.id)?.raw_tag === 'N' && analysisByToken.get(row.id)?.definition === 'очи'), 'fixture яру analysis changed');
  const khanicha = matchingTokens('ХАНИЧА');
  assert(khanicha.length === 18 && khanicha.every(row => analysisByToken.get(row.id)?.lemma_normalized === 'ханича' && analysisByToken.get(row.id)?.raw_tag === 'NPR'), 'fixture ХАНИЧА changed');
  const dak = analyses.filter(row => row.lemma_normalized === 'дакӀ');
  assert(dak.length === 136 && new Set(dak.map(row => tokenById.get(row.token_id).surface_normalized)).size === 8, 'fixture дакӀ changed');
  assert(analyses.filter(row => row.raw_tag === 'N-GEN').length === 500, 'fixture N-GEN changed');
  const bur = proposals.find(row => row.surface_normalized === 'бур');
  assert(bur && bur.frequency === 997, 'fixture бур proposal changed');
  assert(!analyses.some(row => tokenById.get(row.token_id).surface_normalized === 'бур'), 'бур prediction leaked into source analyses');
  return { manifest: manifest.counts, legacy_pcmlbe_rows: legacyRows.length, fixtures: { yaru: 57, khanicha: 18, dak_occurrences: 136, dak_forms: 8, n_gen: 500, bur_proposal_occurrences: 997 } };
}

async function main() {
  const args = process.argv.slice(2);
  const bundleArg = args.find(arg => !arg.startsWith('--'));
  const bundleDir = path.resolve(bundleArg || path.join(__dirname, '..', 'imports', 'lak-corpus-v1.4'));
  const bundle = await reconcileBundle(bundleDir);
  const output = { bundle };
  if (args.includes('--database')) {
    const client = await pool.connect();
    try { output.database = await reconcileInTransaction(client, EXPECTED); }
    finally { client.release(); await pool.end(); }
  }
  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) main().catch(async error => {
  console.error(error.stack || error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

module.exports = { EXPECTED, reconcileBundle };
