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
  'search.grammarFeature','search.badge.sourceAnnotation','search.badge.noSourceAnalysis',
  'search.morph.noMatchesTitle','search.morph.exactPromptTitle',
  'validate.kind.lemma_analysis','validate.question.lemma_analysis',
  'validate.morph.option.accept','validate.morph.option.reject',
  'validate.morph.option.uncertain','validate.morph.option.correct',
]) {
  assert(en._dict[key]?.en, `${key} missing English`);
  assert(en._dict[key]?.ru, `${key} missing Russian`);
  assert.notStrictEqual(en.t(key), key);
  assert.notStrictEqual(ru.t(key), key);
}
console.log('corpus v2 EN/RU localization keys passed');
