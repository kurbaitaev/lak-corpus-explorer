'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { loadObservatory, containsBibleReference } = require('../lib/observatory');

const BASE = 'http://127.0.0.1:5057';
let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const registry = loadObservatory();
  console.log('\n[data integrity and rights boundaries]');
  check('registry contains exactly 68 unique records',
    registry.resources.length === 68 && new Set(registry.resources.map(r => r.id)).size === 68);
  check('headline count is 68 total', registry.counts.total === 68);
  check('headline count is 21 P0', registry.counts.p0 === 21);
  check('headline count is 11 held or processed', registry.counts.held_or_processed === 11);
  check('headline count is 25 permission-sensitive', registry.counts.permission_sensitive === 25);
  check('every canonical field is retained', registry.resources.every(r =>
    ['id','title','creator','year','category','language','access','rights','status','priority',
      'value','scale','url','action','notes'].every(field => Object.hasOwn(r, field))));
  check('no Bible-derived resource is present', registry.resources.every(r => !containsBibleReference(r)));
  check('only HTTP(S) URLs become clickable', registry.resources.every(r =>
    r.public_url === null || /^https?:\/\//.test(r.public_url)));
  check('local provenance references remain non-clickable', registry.resources
    .filter(r => r.url.startsWith('../')).every(r => r.public_url === null));

  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: '5057' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  try {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${BASE}/api/observatory/resources`)).ok) break; } catch {}
      await sleep(100);
    }

    console.log('\n[public route and independent API]');
    const apiResponse = await fetch(`${BASE}/api/observatory/resources`);
    const api = await apiResponse.json();
    check('independent Observatory API serves', apiResponse.status === 200);
    check('API exposes all 68 records and validated counts',
      api.resources.length === 68 && api.counts.permission_sensitive === 25);
    const page = await (await fetch(`${BASE}/observatory.html`)).text();
    check('public Observatory route serves its page',
      page.includes('Lak Resource Observatory') && page.includes('width=device-width'));
    check('page includes required search and filters',
      ['resource-search','category-filter','status-filter','priority-filter'].every(id => page.includes(`id="${id}"`)));
    check('page explains Bible exclusion and rights boundary',
      /Bible/i.test(page) && /public access/i.test(page) && /training permission/i.test(page));
    const nav = await (await fetch(`${BASE}/js/nav.js`)).text();
    check('shared navigation inserts Observatory', nav.includes('/observatory.html'));

    console.log('\n[corpus and Lab isolation]');
    const sample = registry.resources.find(r => r.id === 'ilchi');
    const corpusSearch = await (await fetch(`${BASE}/api/corpus/search?q=${encodeURIComponent(sample.title)}&limit=5`)).json();
    check('Observatory title is absent from corpus search', corpusSearch.total === 0, `total=${corpusSearch.total}`);
    const reviewAttempt = await fetch(`${BASE}/api/reviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_id: sample.id, state: 'flagged', note: 'must be rejected' }),
    });
    check('Observatory ID is rejected by corpus review validation', reviewAttempt.status === 400);
    const exportJson = await (await fetch(`${BASE}/api/export.json`)).text();
    check('Observatory records are absent from review export', !exportJson.includes(sample.id));
    const exportCsv = await (await fetch(`${BASE}/api/export.csv`)).text();
    check('Observatory records are absent from CSV review export', !exportCsv.includes(sample.id));
    const labExport = await (await fetch(`${BASE}/api/lab/export.jsonl`)).text();
    check('Observatory records are absent from Lab export', !labExport.includes(sample.id));

    console.log('\n[responsive implementation]');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public/css/app.css'), 'utf8');
    check('Observatory has a mobile breakpoint',
      css.includes('@media (max-width: 600px)') && css.includes('.observatory .obs-controls'));
    check('Observatory constrains overflow',
      css.includes('overflow-x: clip') && css.includes('overflow-wrap: anywhere'));
    const js = fs.readFileSync(path.join(__dirname, '..', 'public/js/observatory.js'), 'utf8');
    check('client implements text query filtering', /resource-search/.test(js) && /state\.query/.test(js));
    check('client implements all three select filters',
      ['category-filter','status-filter','priority-filter'].every(id => js.includes(id)));
  } finally {
    child.kill('SIGTERM');
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) process.exit(1);
})().catch(error => {
  console.error('OBSERVATORY TEST ERROR:', error.message);
  process.exit(1);
});