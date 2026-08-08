'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { normalizeLak, normalizeLakVariants, parsePagination, FEATURE_ENABLED } = require('../lib/corpus-v2');

assert.strictEqual(FEATURE_ENABLED, false, 'CORPUS_V2_ENABLED must default off');
assert.strictEqual(normalizeLak(' ХАНИЧА '), 'ханича');
assert.strictEqual(normalizeLak('дакI'), 'дакӀ');
assert(normalizeLakVariants('дакӀ').includes('дакӀ') && normalizeLakVariants('дакӀ').includes('дакӏ'));
assert(normalizeLakVariants('ёл').includes('ел'));
assert.deepStrictEqual(parsePagination({ page: '-2', limit: '500' }), { page: 1, limit: 100, offset: 0 });

const routeSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'corpus-v2.js'), 'utf8');
assert(routeSource.includes("['wordform','lemma','grammar']"), 'all morphology modes must be explicit');
assert(routeSource.includes("evidence_badge"), 'public results must label source evidence');
assert(!routeSource.includes('morphology_proposals p JOIN corpus_tokens'), 'public search must not join proposals into token results');
assert(routeSource.includes('public_search_allowed = TRUE'), 'public queries must enforce source rights');
assert(routeSource.includes("p.access_status='authenticated'"), 'proposal queue must require authenticated records');

for (const file of ['public/js/search.js', 'public/js/i18n.js']) {
  const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  new vm.Script(source, { filename: file });
}
const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
for (const mode of ['general','wordform','lemma','grammar']) assert(ui.includes(`data-mode="${mode}"`), `missing ${mode} UI mode`);
const searchUi = fs.readFileSync(path.join(__dirname, '..', 'public/js/search.js'), 'utf8');
assert(searchUi.includes('searchAbort?.abort()') && searchUi.includes('seq !== searchSeq'),
  'newest-request-wins cancellation and stale-response guard missing');
console.log('corpus v2 search semantics, fail-closed rights, UI modes, and newest-request-wins checks passed');
