'use strict';
/**
 * Regression check for the Lak Corpus Explorer research-preview release.
 * Run against a live server:  node scripts/regression-check.js
 * Covers: direct translation, phrase search, empty results, filters,
 * pagination, source labels/ordering, OCR separation, review permissions.
 * Creates only record_ids prefixed 'regression:' and deletes them afterwards.
 */
const BASE = process.env.BASE_URL || 'http://localhost:5000';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
async function search(params) {
  const res = await fetch(`${BASE}/api/corpus/search?${new URLSearchParams(params)}`);
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  return res.json();
}
const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

(async () => {
  console.log('\n[луна → барз: senses + OCR separation + source ordering]');
  const luna = await search({ q: 'луна', limit: 50 });
  check('expanded includes барз', luna.expanded.includes('барз'));
  check('senses include moon', luna.senses.includes('moon'));
  check('senses include month', luna.senses.includes('month'));
  check('corrupt Гьсяць NOT in primary senses', !luna.senses.includes('Гьсяць'));
  check('corrupt олнолуне NOT in primary senses', !luna.senses.includes('олнолуне'));
  check('OCR senses separated (Гьсяць, олнолуне)', Array.isArray(luna.ocrSenses) && luna.ocrSenses.includes('Гьсяць') && luna.ocrSenses.includes('олнолуне'));
  check('results found', luna.total > 0, `total=${luna.total}`);
  const srcs = luna.rows.map(r => r[3]);
  const firstOcr = srcs.indexOf('Uslar 1890');
  const lastModern = srcs.reduce((a, s, i) => (s !== 'Uslar 1890' ? i : a), -1);
  check('modern sources ranked before OCR', firstOcr === -1 || firstOcr > lastModern, `firstOcr=${firstOcr} lastModern=${lastModern}`);
  check('every row carries a source label', luna.rows.every(r => typeof r[3] === 'string' && r[3].length > 0));

  console.log('\n[солнце → баргь: curated translation]');
  const soln = await search({ q: 'солнце', limit: 10 });
  check('expanded includes баргь', soln.expanded.includes('баргь'));

  console.log('\n[земля → аьрщи]');
  const zem = await search({ q: 'земля', limit: 5 });
  check('expanded includes аьрщи', zem.expanded.includes('аьрщи'));

  console.log('\n[спасибо → барчаллагь]');
  const spas = await search({ q: 'спасибо', limit: 5 });
  check('expanded includes барчаллагь', spas.expanded.includes('барчаллагь'));

  console.log('\n[phrase search: с днем рождения]');
  const phr = await search({ q: 'с днем рождения', limit: 10 });
  check('phrase returns results', phr.total >= 1, `total=${phr.total}`);

  console.log('\n[empty results]');
  const empty = await search({ q: 'zxqwkjфыва', limit: 5 });
  check('nonsense query returns 0 records', empty.total === 0, `total=${empty.total}`);

  console.log('\n[filters]');
  const lex = await search({ q: 'луна', kind: 'lexicon', limit: 20 });
  check('kind=lexicon → only lexicon rows', lex.rows.length > 0 && lex.rows.every(r => r[0] === 'lexicon'));
  const usl = await search({ q: '', source: 'Uslar 1890', limit: 20 });
  check('source=Uslar 1890 → only Uslar rows', usl.rows.length > 0 && usl.rows.every(r => r[3] === 'Uslar 1890'));
  const wiki = await search({ q: '', source: 'Lak Wikipedia', limit: 5 });
  check('source=Lak Wikipedia → only Wikipedia rows', wiki.rows.length > 0 && wiki.rows.every(r => r[3] === 'Lak Wikipedia'));

  console.log('\n[pagination]');
  const p1 = await search({ q: '', limit: 5, page: 1 });
  const p2 = await search({ q: '', limit: 5, page: 2 });
  check('page 1 returns requested page size', p1.rows.length === 5);
  check('page 2 returns requested page size', p2.rows.length === 5);
  check('page 2 differs from page 1', JSON.stringify(p1.rows) !== JSON.stringify(p2.rows));
  check('page metadata correct', p1.page === 1 && p2.page === 2 && p1.pages > 2, `pages=${p1.pages}`);

  console.log('\n[review permissions]');
  const rid = `regression:${Date.now()}`;
  const anonApprove = await post('/api/reviews', { record_id: rid, state: 'approved', note: 'regression' });
  check('anonymous approve rejected (403)', anonApprove.status === 403, `got ${anonApprove.status}`);
  const anonFlag = await post('/api/reviews', { record_id: rid, state: 'flagged', note: 'regression' });
  check('anonymous flag allowed', anonFlag.status === 200, `got ${anonFlag.status}`);
  const badLogin = await post('/api/auth/login', { name: 'regression', passphrase: 'wrong-passphrase' });
  check('wrong passphrase rejected (401)', badLogin.status === 401, `got ${badLogin.status}`);

  const pp = process.env.REVIEWER_PASSPHRASE;
  if (pp) {
    const login = await post('/api/auth/login', { name: 'regression-reviewer', passphrase: pp });
    check('reviewer login succeeds', login.status === 200, `got ${login.status}`);
    const cookie = login.headers.get('set-cookie') || '';
    const approve = await post('/api/reviews', { record_id: rid, state: 'approved', note: 'regression approve' }, { cookie });
    check('logged-in reviewer can approve', approve.status === 200, `got ${approve.status}`);
    if (approve.status === 200) {
      const body = await approve.json();
      check('approval carries verified attribution',
        !!body.review && body.review.reviewer_verified === true && body.review.reviewer_name === 'regression-reviewer');
    }
    await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie } });
  } else {
    console.log('  (REVIEWER_PASSPHRASE not set — skipped reviewer login tests)');
  }

  console.log('\n[cleanup]');
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await client.connect();
  const del = await client.query("DELETE FROM reviews WHERE record_id LIKE 'regression:%'");
  await client.end();
  console.log(`  removed ${del.rowCount} regression test row(s); real reviews untouched`);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail) { console.log('FAILED:', failures.join('; ')); process.exit(1); }
})().catch(err => { console.error('REGRESSION ERROR:', err.message); process.exit(1); });
