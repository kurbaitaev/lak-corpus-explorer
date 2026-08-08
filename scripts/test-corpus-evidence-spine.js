'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = file => fs.readFileSync(file, 'utf8');
const migration = read('migrations/20260808_002_evidence_spine.sql');
for (const table of [
  'corpus_assets', 'corpus_canvases', 'corpus_regions', 'corpus_assertions',
  'corpus_assertion_decisions', 'corpus_translation_units', 'corpus_alignments',
  'corpus_media', 'corpus_media_spans', 'corpus_dataset_snapshots',
  'corpus_dataset_members', 'corpus_pipeline_runs',
]) {
  assert(migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `missing canonical table ${table}`);
}
assert(migration.includes("'model_prediction','generated_hypothesis'"), 'assertion evidence classes are incomplete');
assert(migration.includes("split IN ('train','dev','test')"), 'dataset split constraint missing');
assert(migration.includes('leakage_check JSONB NOT NULL'), 'dataset leakage record missing');

const routes = read('routes/corpus-v2.js');
assert(routes.includes("router.get('/api/corpus/v2/segments/:id'"), 'addressable occurrence endpoint missing');
assert(routes.includes('occurrences, total, page'), 'lemma detail must return paginated occurrences');
assert(routes.includes('g.text_original AS context'), 'occurrence context missing from lemma detail');
assert(routes.includes('a.evidence_class, a.review_status'), 'source evidence labels missing from occurrence APIs');
const occurrenceRoute = routes.slice(
  routes.indexOf("router.get('/api/corpus/v2/segments/:id'"),
  routes.indexOf("router.get('/api/morphology/proposals'"));
assert(!occurrenceRoute.includes('morphology_proposals'),
  'public occurrence endpoint must not read review-only predictions');

for (const file of ['public/js/lemmas.js', 'public/js/occurrence.js']) {
  new vm.Script(read(file), { filename: file });
}
const lemmas = read('public/lemmas.html');
const occurrence = read('public/occurrence.html');
assert(lemmas.includes('id="lemma-grid"') && lemmas.includes('/js/lemmas.js'), 'lemma dictionary UI incomplete');
assert(occurrence.includes('id="occurrence-content"') && occurrence.includes('/js/occurrence.js'), 'occurrence UI incomplete');
const search = read('public/js/search.js');
assert(search.includes('/lemmas.html?id=') && search.includes('/occurrence.html?id='),
  'search results must open lemma and occurrence evidence');
const server = read('server.js');
assert(server.includes("'occurrence.html'") && server.includes("'lemmas.html'"), 'new evidence pages are not served');
assert(server.includes("rights_status: SOURCE_RIGHTS[source] || 'unknown'"),
  'legacy public source index must not label unknown rights as public domain');
assert(server.includes("PCMLBE: 'open_license'") && server.includes("'Uslar 1890': 'public_domain'"),
  'verified legacy rights mappings missing');

console.log('canonical evidence spine, lemma dictionary, and occurrence navigation checks passed');
