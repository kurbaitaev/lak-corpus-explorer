'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

function runtime(language) {
  const document = {
    readyState: 'complete', documentElement: { setAttribute() {} },
    querySelectorAll() { return []; }, querySelector() { return null; },
  };
  const sandbox = {
    window: { dispatchEvent() {} }, document, location: { hostname: 'production.example' },
    navigator: { language: `${language}-${language.toUpperCase()}` }, Intl,
    localStorage: { getItem: key => key === 'lang' ? language : null, setItem() {} },
    CustomEvent: function CustomEvent(type, detail) { return { type, detail }; }, console,
  };
  vm.runInNewContext(fs.readFileSync('public/js/i18n.js', 'utf8'), sandbox);
  return sandbox.window.I18n;
}

const en = runtime('en');
const ru = runtime('ru');
for (const key of [
  'search.mode.general','search.mode.wordform','search.mode.lemma','search.mode.grammar',
  'search.smart.kicker','search.smart.title','search.smart.body','search.smart.tokens',
  'search.smart.analyses','search.smart.lemmas','search.smart.tags','search.smart.trust',
  'search.grammarFeature','search.badge.sourceAnnotation','search.badge.noSourceAnalysis',
  'search.morph.noMatchesTitle','search.morph.exactPromptTitle',
  'search.lemma.browseAll','search.lemma.placeholder','search.lemma.loading',
  'search.lemma.empty','search.lemma.summary',
  'nav.lemmas','search.morph.openOccurrence',
  'lemmas.meta.title','lemmas.h1','lemmas.intro','lemmas.searchLabel',
  'lemmas.total','lemmas.forms','lemmas.occurrences','lemmas.sourceEvidence',
  'lemmas.attestedForms','lemmas.sentenceOccurrences','lemmas.openOccurrence',
  'occ.meta.title','occ.h1','occ.intro','occ.sentence','occ.analysis',
  'occ.source','occ.form','occ.lemma','occ.tag','occ.definition','occ.evidenceNote',
  'validate.kind.lemma_analysis','validate.question.lemma_analysis',
  'validate.morph.option.accept','validate.morph.option.reject',
  'validate.morph.option.uncertain','validate.morph.option.correct',
  'research.v2.h2','research.v2.body','research.v2.cta','research.v2.trust',
]) {
  assert(en._dict[key]?.en, `${key} missing English`);
  assert(en._dict[key]?.ru, `${key} missing Russian`);
  assert.notStrictEqual(en.t(key), key);
  assert.notStrictEqual(ru.t(key), key);
}
assert(en._dict['search.lemma.count']?.en && en._dict['search.lemma.count']?.ru, 'lemma count plural forms missing');
assert.strictEqual(en.plural('search.lemma.count', 2, { count: 2 }), '2 lemmas');
assert.strictEqual(ru.plural('search.lemma.count', 5, { count: 5 }), '5 лемм');
console.log('corpus v2 EN/RU localization keys passed');
