'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeQuery, tokenize, recordMatchTier, QUERY_FIELDS, NO_MATCH } = require('../lib/search');

const root = path.join(__dirname, '..');
const corpus = JSON.parse(fs.readFileSync(path.join(root, 'public/data/corpus-data.json'), 'utf8'));
const parallels = JSON.parse(fs.readFileSync(path.join(root, 'public/data/pcmlbe-parallel.json'), 'utf8'));
const byId = new Map(corpus.map(row => [row[5], row]));

assert.equal(parallels.length, 25, 'expected 25 PCMLBE Lak-English pairs');
assert.equal(parallels.filter(item => item.lak_cyrillic).length, 21,
  'expected 21 PCMLBE Cyrillic parallels');
assert.ok(parallels.every(item => item.license === 'CC BY-SA 4.0'));
assert.ok(parallels.every(item => item.persistent_id ===
  'http://hdl.handle.net/21.11114/COLL-0000-0021-959C-3'));

const enriched = parallels.map(item => {
  const base = byId.get(item.record_id);
  assert.ok(base, `missing public corpus record ${item.record_id}`);
  return [...base.slice(0, 7), item.lak_cyrillic, item.translation_en,
    item.license, item.persistent_id];
});

for (const query of ['becoming old', 'Утти на хъунмагу', "bura Utti bivk'un"]) {
  const phrase = normalizeQuery(query);
  const tokens = tokenize(phrase);
  assert.ok(enriched.some(row => recordMatchTier(row, phrase, tokens, QUERY_FIELDS) !== NO_MATCH),
    `query did not match the enriched public record: ${query}`);
}

const about = fs.readFileSync(path.join(root, 'public/about.html'), 'utf8');
assert.match(about, /Erwin R\. Komen/);
assert.match(about, /CC BY-SA 4\.0/);
assert.match(about, /21\.11114\/COLL-0000-0021-959C-3/);

console.log('PASS: 25 English pairs; 21 Cyrillic parallels; search and attribution verified');
