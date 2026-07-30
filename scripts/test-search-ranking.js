'use strict';

/*
 * Natural-search regression suite.
 *
 * Part 1 exercises lib/search.js directly (field scoping, phrase/token tiers,
 * token boundaries, highlight spans). Part 2 spawns an isolated server on
 * port 5062 and proves the /api/corpus/search contract: word-order tolerance,
 * phrase-first ranking, no any-word matches, and that filters, pagination,
 * provenance, alias expansion and highlighting still behave.
 *
 * Usage: node scripts/test-search-ranking.js
 */

const { spawn } = require('child_process');
const path = require('path');
const search = require('../lib/search');

const BASE = 'http://127.0.0.1:5062';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}
function group(title) { console.log(`\n[${title}]`); }

const get = async p => {
  const res = await fetch(BASE + p, { headers: { Accept: 'application/json' } });
  return { status: res.status, data: await res.json() };
};
const q = s => encodeURIComponent(s);
const ids = rows => rows.map(r => r[5]);

function unitTests() {
  const { MATCH_PHRASE, MATCH_TOKENS, NO_MATCH } = search;

  group('normalisation and tokenisation');
  check('query whitespace collapses', search.normalizeQuery('  где   ты  ') === 'где ты');
  check('ё folds to е', search.normalizeQuery('ЁЖ') === 'еж');
  check('tokenizer splits on punctuation', JSON.stringify(search.tokenize('Где ты живешь? (ж.)')) ===
    JSON.stringify(['где', 'ты', 'живешь', 'ж']));

  group('field-scoped match tiers');
  check('exact phrase → phrase tier',
    search.fieldMatchTier('Где ты живешь?', 'где ты', ['где', 'ты']) === MATCH_PHRASE);
  check('reordered tokens → token tier',
    search.fieldMatchTier('Где ты живешь?', 'ты где', ['ты', 'где']) === MATCH_TOKENS);
  check('one token missing → no match',
    search.fieldMatchTier('Где он живет?', 'ты где', ['ты', 'где']) === NO_MATCH);
  check('token fallback respects word boundaries',
    search.fieldMatchTier('Тыква где-то там', 'ты где', ['ты', 'где']) === NO_MATCH);
  check('single-token query keeps substring behaviour',
    search.fieldMatchTier('Тыква', 'ты', ['ты']) === MATCH_PHRASE);

  group('record-level scoping');
  const record = ['text', 'Ттун ххирару ина', 'Где ты живешь?', 'Digiev phrasebook', 'Standard', 'digiev-2004:815', ''];
  check('tokens inside one field match',
    search.recordMatchTier(record, 'ты где', ['ты', 'где']) === MATCH_TOKENS);
  check('tokens split across two fields do NOT match',
    search.recordMatchTier(record, 'ттун живешь', ['ттун', 'живешь']) === NO_MATCH);
  const recordIdQuery = search.normalizeQuery('digiev-2004:815');
  check('record id remains searchable',
    search.recordMatchTier(record, recordIdQuery, search.tokenize(recordIdQuery)) === MATCH_PHRASE);
  check('url field is not searchable',
    search.recordMatchTier(['text', 'a', 'b', 'c', 'd', 'e', 'http://example.org/secret'],
      'secret', ['secret']) === NO_MATCH);

  group('highlight spans');
  const phraseSpans = search.highlightSpansFor('Где ты живешь?', { phrase: 'где ты', queryTokens: ['где', 'ты'] });
  check('phrase span covers the phrase', JSON.stringify(phraseSpans) === JSON.stringify([[0, 6]]), phraseSpans);
  const tokenSpans = search.highlightSpansFor('Где ты живешь?', { phrase: 'ты где', queryTokens: ['ты', 'где'] });
  check('reordered query highlights both tokens', tokenSpans.length === 2, tokenSpans);
  check('alias forms still highlight whole tokens',
    JSON.stringify(search.highlightSpansFor('барз бур', { phrase: 'луна', queryTokens: ['луна'], aliasForms: ['барз'] }))
      === JSON.stringify([[0, 4]]));
}

async function apiTests() {
  group('word-order tolerance');
  const forward = await get(`/api/corpus/search?q=${q('где ты')}&limit=50`);
  const reversed = await get(`/api/corpus/search?q=${q('ты где')}&limit=50`);
  check('“где ты” returns Digiev phrase candidates', forward.data.total >= 4, forward.data.total);
  check('“ты где” returns the same total', forward.data.total === reversed.data.total,
    { forward: forward.data.total, reversed: reversed.data.total });
  check('“ты где” returns the same records',
    JSON.stringify(ids(forward.data.rows).sort()) === JSON.stringify(ids(reversed.data.rows).sort()),
    { forward: ids(forward.data.rows), reversed: ids(reversed.data.rows) });
  check('every returned row contains both tokens in one field',
    forward.data.rows.every(r => search.recordMatchTier(r, 'где ты', ['где', 'ты']) !== search.NO_MATCH));

  group('phrase-first ranking');
  const mixed = await get(`/api/corpus/search?q=${q('я тебя')}&limit=50`);
  const tiers = mixed.data.rows.map(r => search.recordMatchTier(r, 'я тебя', ['я', 'тебя']));
  const firstFallback = tiers.indexOf(search.MATCH_TOKENS);
  const lastExact = tiers.lastIndexOf(search.MATCH_PHRASE);
  check('both tiers are present for “я тебя”',
    tiers.includes(search.MATCH_PHRASE) && tiers.includes(search.MATCH_TOKENS), tiers);
  check('exact word-order rows rank above any-order rows',
    firstFallback === -1 || lastExact < firstFallback, { firstFallback, lastExact });
  check('no row matches only part of the query',
    tiers.every(tier => tier !== search.NO_MATCH));

  group('no any-word matches');
  const single = await get(`/api/corpus/search?q=${q('тебя')}&limit=1`);
  check('multiword search is narrower than its widest single word',
    mixed.data.total < single.data.total, { multi: mixed.data.total, single: single.data.total });
  const nonsense = await get(`/api/corpus/search?q=${q('тебя ототкудасюда')}&limit=5`);
  check('unmatched extra token yields nothing', nonsense.data.total === 0, nonsense.data.total);

  group('filters, pagination, provenance');
  const filtered = await get(`/api/corpus/search?q=${q('ты где')}&source=${q('Digiev phrasebook')}&limit=50`);
  check('source filter still applies', filtered.data.rows.every(r => r[3] === 'Digiev phrasebook'));
  check('filtered total ≤ unfiltered total', filtered.data.total <= reversed.data.total);
  const kindFiltered = await get(`/api/corpus/search?q=${q('барз')}&kind=lexicon&limit=5`);
  check('kind filter still applies', kindFiltered.data.rows.every(r => r[0] === 'lexicon'));
  const page1 = await get(`/api/corpus/search?q=${q('ты где')}&limit=2&page=1`);
  const page2 = await get(`/api/corpus/search?q=${q('ты где')}&limit=2&page=2`);
  check('pagination reports consistent totals', page1.data.total === reversed.data.total);
  check('pages do not overlap',
    !ids(page1.data.rows).some(id => ids(page2.data.rows).includes(id)),
    { page1: ids(page1.data.rows), page2: ids(page2.data.rows) });
  check('paged rows equal the unpaged prefix',
    JSON.stringify(ids(page1.data.rows).concat(ids(page2.data.rows))) ===
    JSON.stringify(ids(reversed.data.rows).slice(0, 4)));
  check('provenance fields are preserved',
    forward.data.rows.every(r => r[3] && r[5]));

  group('alias expansion and highlighting');
  const alias = await get(`/api/corpus/search?q=${q('луна')}&limit=20`);
  check('Russian query still expands to Lak aliases', alias.data.expanded.includes('барз'), alias.data.expanded);
  check('alias senses still returned', Array.isArray(alias.data.senses) && alias.data.senses.length > 0);
  check('alias matches are highlighted in the Lak text',
    alias.data.matches.some(spans => spans.length > 0));
  check('historical OCR is ranked last',
    (() => {
      const flags = alias.data.rows.map(r => r[3] === 'Uslar 1890');
      return flags.indexOf(true) === -1 || !flags.slice(flags.indexOf(true)).includes(false);
    })(), alias.data.rows.map(r => r[3]));
  const reordered = await get(`/api/corpus/search?q=${q('ты где')}&limit=5`);
  check('token-fallback rows report highlight spans where the tokens appear',
    reordered.data.matches.length === reordered.data.rows.length);

  group('existing phrase behaviour');
  const birthday = await get(`/api/corpus/search?q=${q('с днем рождения')}&limit=10`);
  check('“с днем рождения” still matches', birthday.data.total >= 1, birthday.data.total);
  const empty = await get('/api/corpus/search?q=&limit=5');
  check('empty query still returns the corpus', empty.data.total > 1000, empty.data.total);
}

async function main() {
  unitTests();

  console.log('\nStarting isolated test server on :5062 …');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: '5062' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const deadline = Date.now() + 40000;
  while (!log.includes('running on port 5062')) {
    if (Date.now() > deadline) { child.kill('SIGKILL'); throw new Error('Server did not start:\n' + log); }
    await sleep(200);
  }

  try {
    await apiTests();
  } finally {
    child.kill('SIGKILL');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
