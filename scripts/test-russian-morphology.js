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
assert(snippets[0].snippet.includes('любовь, и мольба, и обида'));
assert(snippets[0].snippet.length <= 360);

const dirtyOcr = concordanceSnippets(
  'прбсьба, мольба; — тПун просйть,', 'мольба', 4,
  { dictionary: true, knownRussian: true });
assert.deepStrictEqual(dirtyOcr, [], 'mixed and damaged OCR must not be shown as readable evidence');

const cleanDictionary = concordanceSnippets(
  'просьба, мольба; обращение с просьбой', 'мольба', 4,
  { dictionary: true, knownRussian: true });
assert.strictEqual(cleanDictionary.length, 1);
assert(cleanDictionary[0].snippet.includes('просьба, мольба'));

const russianStops = new Set(['наклон', 'невод']);
const concatenatedDictionary = concordanceSnippets(
  'мольба миннат наклон кьус ритаву невод', 'мольба', 4,
  { dictionary: true, knownRussian: true, stopTerms: russianStops });
assert.strictEqual(concatenatedDictionary.length, 1);
assert.strictEqual(concatenatedDictionary[0].snippet, 'мольба миннат…');

const cleanProse = concordanceSnippets(
  'Там было все: и скорбь, и любовь, и мольба, и обида, и надежда.', 'мольба', 4,
  { knownRussian: true });
assert.strictEqual(cleanProse.length, 1, 'valid Russian prose with consonant-heavy words must remain');

const wordFormsHtml = fs.readFileSync(require.resolve('../public/word-forms.html'), 'utf8');
const wordFormsJs = fs.readFileSync(require.resolve('../public/js/word-forms.js'), 'utf8');
const appCss = fs.readFileSync(require.resolve('../public/css/app.css'), 'utf8');
assert(!wordFormsHtml.includes('wf-confidence'), 'misleading attestation control must stay removed');
assert(!wordFormsHtml.includes('wf-stats'), 'raw mixed-token total must not be promoted as a lexicon count');
assert(wordFormsJs.includes("if (!document.getElementById('wf-search').value.trim())"),
  'occurrence explorer must wait for an explicit search');
assert(/\.wf-contexts mark\s*\{[^}]*color:\s*#201707/i.test(appCss),
  'highlight text needs an explicit readable color in dark mode');

console.log('Russian inflection lookup and concordance tests passed.');
