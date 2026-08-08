'use strict';

const assert = require('assert');
const fs = require('fs');
const { stemRussian, stemKey, containsRussianForm, createAliasResolver } = require('../lib/russian-morphology');
const { createRetriever } = require('../lib/lab-retrieval');
const { concordanceSnippets } = require('../routes/source-library');
const { norm, tokenHas } = require('../lib/search');

const forms = ['слово', 'слова', 'слову', 'словом', 'словами', 'словах'];
assert.strictEqual(new Set(forms.map(stemRussian)).size, 1, 'слово inflections must share a stem');
assert.strictEqual(stemKey('простые слова'), stemKey('простое слово'));
assert(containsRussianForm('Значение слова приводится в словаре.', 'слово'));
assert(containsRussianForm('Значение слова приводится в словаре.', 'словами'));

const resolver = createAliasResolver([{ слово: ['махъ'] }], norm);
assert.deepStrictEqual(resolver('слово').aliases, ['махъ']);
assert.deepStrictEqual(resolver('слова').aliases, ['махъ']);
assert.strictEqual(resolver('слова').match, 'inflection');

const corpusData = JSON.parse(fs.readFileSync(require.resolve('../data/corpus-data.json'), 'utf8'));
const corpusAliases = JSON.parse(fs.readFileSync(require.resolve('../data/corpus-meta.json'), 'utf8')).aliases;
const retriever = createRetriever({ corpusData, corpusAliases, curatedAliases: {}, norm, tokenHas });
for (const form of forms) {
  const result = retriever.retrieveRu2Lak(form);
  assert.strictEqual(result.evidence[0].lak_text, 'махъ', `${form} should resolve to махъ`);
  assert.strictEqual(result.evidence[0].evidence_type, 'alias');
}

const snippets = concordanceSnippets(
  '[OCR PAGE 85] Там было все: и скорбь, и любовь, и мольба, и обида, и надежда.', 'мольба');
assert.strictEqual(snippets.length, 1);
assert(snippets[0].includes('любовь, и мольба, и обида'));
assert(snippets[0].length <= 360);

console.log('Russian inflection lookup and concordance tests passed.');
