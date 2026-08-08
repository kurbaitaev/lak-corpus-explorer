'use strict';

const assert = require('assert');
const fs = require('fs');

const read = file => fs.readFileSync(file, 'utf8');
const publicPages = [
  'public/index.html',
  'public/about.html',
  'public/how-it-works.html',
  'public/observatory.html',
  'public/research.html',
  'public/source-library.html',
  'public/validate.html',
  'public/word-forms.html',
];
const combined = publicPages.map(read).join('\n') + read('public/js/i18n.js');

for (const phrase of [
  'Professor Victor Friedman',
  'We thank',
  'What should I do here?',
  'How to read these numbers',
  'Invitation for collaboration',
  'Every validation here is an act of preservation',
  'Spot the versions',
  'Route, never merge',
  'Nothing is missing from the corpus',
]) {
  assert(!combined.includes(phrase), `public copy still contains: ${phrase}`);
}

const home = read('public/index.html');
assert(!home.includes('search-guidance'), 'homepage guidance panel should stay removed');
assert(!home.includes('research-update-banner'), 'homepage research banner should stay removed');

const research = read('public/research.html');
assert(!research.includes('id="research-public"'), 'removed research summary should stay removed');
assert(!research.includes('research.permission.credit'), 'personal acknowledgement should not appear in public research copy');

const nav = read('public/js/nav.js');
assert(nav.includes("var primaryOrder = ['/', '/source-library.html', '/research.html', '/lab.html', '/validate.html', '/about.html'];"), 'primary navigation order changed');

const i18n = read('public/js/i18n.js');
assert(i18n.includes("'nav.brand.name': { en: 'Lak Corpus', ru: 'Корпус лакского языка' }"), 'Russian brand label changed');
assert(!i18n.includes("ru: 'Обозреватель'"), 'awkward Russian brand label returned');

console.log('professional public copy and navigation checks passed');
