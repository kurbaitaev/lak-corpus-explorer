'use strict';

/**
 * Coverage self-check for the Russian display localization of curated
 * Observatory metadata.
 *
 * Run:  node scripts/check-observatory-i18n.js
 *
 * Proves, against the live registry loaded through lib/observatory.js, that
 * public/js/i18n.js provides a Russian translation for:
 *   - every unique category value            (obs.category.<slug>)
 *   - every unique evidence-status value      (obs.status.<slug>)
 *   - every unique rights-boundary value      (obs.rights.<slug>)
 *   - each resource's scale and action        (obs.resource.<id>.scale|action)
 *   - each present notes field                (obs.resource.<id>.notes)
 *
 * A key "resolves in RU with no English fallback" when it exists in DICT with a
 * non-empty ru string that is a genuine Russian rendering — either differing
 * from the English, or (for language-neutral values like "CC BY 4.0" / "N/A")
 * explicitly whitelisted as intentionally identical.
 */

const fs = require('fs');
const path = require('path');
const { loadObservatory } = require('../lib/observatory');

const I18N_PATH = path.join(__dirname, '..', 'public', 'js', 'i18n.js');

// Values whose Russian rendering may legitimately equal the English string
// (license identifiers and other language-neutral tokens).
const RU_MAY_EQUAL_EN = new Set([
  'obs.rights.cc_by_4_0',
  'obs.rights.cc_by_sa_gfdl',
  'obs.rights.apache_2_0_model_terms_to_confirm',
]);

function slug(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

// Extract the DICT object literal from the browser IIFE and evaluate it in an
// isolated scope so we can inspect { en, ru } pairs directly.
function loadDict() {
  const src = fs.readFileSync(I18N_PATH, 'utf8');
  const start = src.indexOf('var DICT = {');
  if (start === -1) throw new Error('DICT declaration not found in i18n.js');
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) throw new Error('Could not find end of DICT literal');
  const literal = src.slice(braceStart, end + 1);
  // eslint-disable-next-line no-new-func
  return Function('"use strict"; return (' + literal + ');')();
}

let passed = 0;
let failed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; } else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); }
}

function requireRu(dict, key) {
  const entry = dict[key];
  if (!entry || typeof entry !== 'object') {
    check(key, false, 'key missing');
    return;
  }
  const { en, ru } = entry;
  if (typeof ru !== 'string' || ru.trim() === '') {
    check(key, false, 'ru empty/missing');
    return;
  }
  if (ru === en && !RU_MAY_EQUAL_EN.has(key)) {
    check(key, false, 'ru identical to en (English fallback): ' + JSON.stringify(ru));
    return;
  }
  check(key, true);
}

const dict = loadDict();
const data = loadObservatory();

const categories = [...new Set(data.resources.map(r => r.category))];
const statuses = [...new Set(data.resources.map(r => r.status))];
const rights = [...new Set(data.resources.map(r => r.rights))];

console.log('\n[category values]  (' + categories.length + ')');
categories.forEach(c => requireRu(dict, 'obs.category.' + slug(c)));

console.log('[status values]    (' + statuses.length + ')');
statuses.forEach(s => requireRu(dict, 'obs.status.' + slug(s)));

console.log('[rights values]    (' + rights.length + ')');
rights.forEach(r => requireRu(dict, 'obs.rights.' + slug(r)));

console.log('[resource fields]  (' + data.resources.length + ' resources)');
let notesCount = 0;
data.resources.forEach(r => {
  const id = slug(r.id);
  requireRu(dict, 'obs.resource.' + id + '.scale');
  requireRu(dict, 'obs.resource.' + id + '.action');
  if (r.notes) { notesCount++; requireRu(dict, 'obs.resource.' + id + '.notes'); }
});

// Explicit headline coverage assertions matching the task requirements.
check('30 categories present', categories.length === 30, String(categories.length));
check('11 statuses present', statuses.length === 11, String(statuses.length));
check('51 rights present', rights.length === 51, String(rights.length));
check('68 resources present', data.resources.length === 68, String(data.resources.length));
check('all 68 notes present', notesCount === 68, String(notesCount));

console.log('\n──────────────────────────────');
console.log('checks passed: ' + passed + ', failed: ' + failed);
if (failed) {
  console.log('\nFAILURES:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('All curated Observatory metadata resolves in Russian with no English fallback. ✓');
