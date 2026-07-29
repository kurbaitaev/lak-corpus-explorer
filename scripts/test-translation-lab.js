'use strict';

const { spawn } = require('child_process');
const { Pool } = require('pg');
const BASE = 'http://127.0.0.1:5056';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false });
let passed = 0, failed = 0;
const check = (name, condition, detail) => {
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${JSON.stringify(detail).slice(0, 240)}` : ''}`); }
};
const group = title => console.log(`\n[${title}]`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function client() {
  let cookie = '';
  return {
    async request(method, path, body) {
      const response = await fetch(BASE + path, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const text = await response.text();
      let data; try { data = JSON.parse(text); } catch { data = text; }
      return { status: response.status, data, text, headers: response.headers };
    },
    get(path) { return this.request('GET', path); },
    post(path, body) { return this.request('POST', path, body); },
    put(path, body) { return this.request('PUT', path, body); },
  };
}

const testIds = [];
const testEmails = [];
async function cleanup() {
  for (const id of testIds) {
    await pool.query('DELETE FROM pair_adjudications WHERE pair_id=$1', [id]);
    await pool.query('DELETE FROM pair_reviews WHERE pair_id=$1', [id]);
    await pool.query('DELETE FROM parallel_pair_versions WHERE pair_id=$1', [id]);
    await pool.query('DELETE FROM points_ledger WHERE task_id=$1', [id]);
    await pool.query("DELETE FROM audit_events WHERE target_id=$1", [id]);
    await pool.query('DELETE FROM parallel_pairs WHERE id=$1', [id]);
  }
  await pool.query("DELETE FROM proposal_evidence WHERE proposal_id IN (SELECT id FROM translation_proposals WHERE request_id IN (SELECT id FROM translation_requests WHERE source_text LIKE 'test-lab:%'))");
  await pool.query("DELETE FROM translation_proposals WHERE request_id IN (SELECT id FROM translation_requests WHERE source_text LIKE 'test-lab:%')");
  await pool.query("DELETE FROM translation_requests WHERE source_text LIKE 'test-lab:%'");
  await pool.query("DELETE FROM benchmark_items WHERE notes='test-lab'");
  for (const email of testEmails) {
    const row = await pool.query('SELECT id FROM contributors WHERE email=$1', [email]);
    if (!row.rows[0]) continue;
    const id = row.rows[0].id;
    await pool.query('DELETE FROM points_ledger WHERE contributor_id=$1', [id]);
    await pool.query('DELETE FROM contribution_days WHERE contributor_id=$1', [id]);
    await pool.query('DELETE FROM quests WHERE contributor_id=$1', [id]);
    await pool.query('DELETE FROM achievements WHERE contributor_id=$1', [id]);
    await pool.query('DELETE FROM reliability_events WHERE contributor_id=$1', [id]);
    await pool.query('DELETE FROM suspicion_flags WHERE contributor_id=$1', [id]);
    await pool.query('DELETE FROM audit_events WHERE actor_id=$1', [id]);
    await pool.query('DELETE FROM expert_grants WHERE contributor_id=$1', [id]);
    await pool.query('DELETE FROM contributors WHERE id=$1', [id]);
  }
}

(async () => {
  await cleanup();
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: '5056', LAB_PROPOSE_RATE_MAX: '200', LAB_WRITE_RATE_MAX: '200' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', d => { logs += d; });
  child.stderr.on('data', d => { logs += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/lab/provider')).ok) break; } catch {}
    await sleep(100);
  }

  const anon = client();
  group('provider and evidence-only isolation');
  const provider = await anon.get('/api/lab/provider');
  check('provider is evidence-only and unconfigured', provider.status === 200 && provider.data.provider === 'evidence-only' && provider.data.configured === false, provider.data);
  check('provider response contains no secret values or secret names', !/API_KEY|SESSION_SECRET|PASSPHRASE/i.test(provider.text));
  check('unverified banner is exact', provider.data.banner === 'Model proposal — not verified.');

  group('retrieval and abstention');
  const start = Date.now();
  const thanks = await anon.post('/api/lab/propose', { direction: 'ru_to_lak', source_text: 'спасибо' });
  check('спасибо → барчаллагь exactly', thanks.status === 200 && thanks.data.literal_target === 'барчаллагь', thanks.data.literal_target);
  check('proposal remains explicitly unverified', thanks.data.banner === 'Model proposal — not verified.' && thanks.data.mode === 'evidence-only');
  check('proposal carries source evidence IDs', (thanks.data.evidence || []).every(e => e.evidence_id));
  check('warm proposal completes under 500ms', Date.now() - start < 500, Date.now() - start);
  const sun = await anon.post('/api/lab/propose', { direction: 'ru2lak', source_text: 'солнце' });
  check('солнце → баргь exactly', sun.data.literal_target === 'баргь', sun.data.literal_target);
  const unknown = await anon.post('/api/lab/propose', { direction: 'ru2lak', source_text: 'test-lab:zxqwkjфыва' });
  check('unknown text abstains and invents nothing', unknown.data.abstained === true && unknown.data.literal_target === null && unknown.data.natural_target === null, unknown.data);
  const corpusOnly = await anon.post('/api/lab/propose', { direction: 'lak2ru', source_text: 'барчаллагь' });
  check('monolingual usage is not presented as parallel translation', corpusOnly.data.abstained === true || (corpusOnly.data.evidence || []).some(e => e.evidence_type === 'dictionary_sense'));
  const moon = await anon.post('/api/lab/propose', { direction: 'ru2lak', source_text: 'луна' });
  check('луна has exact parenthetical sense', moon.data.literal_target === 'барз (ссавнийсса)', moon.data.literal_target);
  const month = await anon.post('/api/lab/propose', { direction: 'ru2lak', source_text: 'месяц' });
  check('месяц has exact parenthetical sense', month.data.literal_target === 'барз (шинал)', month.data.literal_target);

  group('authentication and submission');
  check('anonymous save blocked', (await anon.post('/api/lab/pairs', { direction:'ru2lak', ru_text:'x', lak_text:'y' })).status === 401);
  const owner = client(), peer = client(), expert = client();
  for (const [c, suffix] of [[owner,'owner'],[peer,'peer'],[expert,'expert']]) {
    const email = `test-lab-${suffix}-${Date.now()}@example.com`; testEmails.push(email);
    const reg = await c.post('/api/auth/register', { email, password:'test-pass-123', display_name:`Lab ${suffix}` });
    check(`${suffix} account registered`, reg.status === 200, reg.data);
  }
  const expertId = (await pool.query('SELECT id FROM contributors WHERE email=$1', [testEmails[2]])).rows[0].id;
  await pool.query("UPDATE contributors SET role='verified_expert' WHERE id=$1", [expertId]);

  const abstainBad = await owner.post('/api/lab/pairs', {
    direction:'ru2lak', source_text:'test-lab:unknown', abstained:true,
  });
  check('abstention requires category', abstainBad.status === 400, abstainBad.data);
  const saved = await owner.post('/api/lab/pairs', {
    direction:'ru_to_lak', source_text:'test-lab:hello', target_literal:'лак', target_natural:'лак',
    variety:'standard', orthography:'cyrillic', source_type:'human',
    source_provenance:'test suite', rights_status:'cc_by', access_status:'public',
    evidence_ids:['test:1'], abstained:false,
  });
  check('authenticated pair saves with metadata', saved.status === 200 && saved.data.pair.target_natural === 'лак' && saved.data.pair.metadata.rights_status === 'cc_by', saved.data);
  const pairId = saved.data.pair.id; testIds.push(pairId);
  const provisional = await pool.query("SELECT status FROM points_ledger WHERE task_id=$1 AND kind='lab_pair'", [pairId]);
  check('submission points are provisional', provisional.rows[0]?.status === 'provisional', provisional.rows);

  group('independent review and immutable lineage');
  check('self-review blocked', (await owner.post(`/api/lab/pairs/${pairId}/reviews`, { verdict:'accept' })).status === 403);
  check('independent review accepted', (await peer.post(`/api/lab/pairs/${pairId}/reviews`, { verdict:'accept', comment:'independent' })).status === 200);
  check('duplicate review blocked', (await peer.post(`/api/lab/pairs/${pairId}/reviews`, { verdict:'accept' })).status === 409);
  const edit = await owner.put(`/api/lab/pairs/${pairId}`, {
    target_literal:'лак literal', target_natural:'лак natural', orthography:'cyrillic', edit_summary:'substantive correction',
  });
  check('edit creates version 2', edit.status === 200 && edit.data.version === 2, edit.data);
  const history = await owner.get(`/api/lab/pairs/${pairId}/history`);
  check('history preserves both immutable versions', history.status === 200 && history.data.versions.length === 2 && history.data.versions[0].version === 1, history.data);

  group('expert adjudication and idempotent points');
  const adjudicated = await expert.post(`/api/lab/pairs/${pairId}/adjudicate`, { decision:'approve', split:'train', note:'test' });
  check('verified expert approves', adjudicated.status === 200 && adjudicated.data.pair.status === 'approved', adjudicated.data);
  const repeated = await expert.post(`/api/lab/pairs/${pairId}/adjudicate`, { decision:'approve', split:'train', note:'repeat' });
  check('repeated adjudication is idempotent', repeated.status === 200 && repeated.data.applied === false, repeated.data);
  const conflicting = await expert.post(`/api/lab/pairs/${pairId}/adjudicate`, { decision:'reject', note:'must not apply' });
  const afterConflict = await owner.get(`/api/lab/pairs/${pairId}`);
  check('conflicting repeated adjudication cannot flip status', conflicting.data.applied === false && afterConflict.data.pair.status === 'approved', { conflicting:conflicting.data, status:afterConflict.data.pair.status });
  const adjCount = await pool.query("SELECT COUNT(*) n FROM points_ledger WHERE task_id=$1 AND kind='lab_adjudication'", [pairId]);
  check('expert points awarded once', Number(adjCount.rows[0].n) === 1, adjCount.rows[0]);

  group('benchmark and export leakage prevention');
  check('anonymous benchmark template blocked', (await anon.get('/api/lab/benchmark/template.tsv')).status === 401);
  const template = await expert.get('/api/lab/benchmark/template.tsv');
  check('expert template has header plus 500 blank rows', template.status === 200 && template.text.trimEnd().split('\n').length === 501);
  const bench = await expert.post('/api/lab/benchmark/import', { items:[{
    direction:'ru2lak', source_text:'test-lab:heldout', reference_text:'SECRET_TEST_REFERENCE',
    split:'test', notes:'test-lab', is_private:true,
  }]});
  check('expert can import held-out benchmark', bench.status === 200 && bench.data.created === 1, bench.data);
  const jsonl = await anon.get('/api/lab/export.jsonl');
  check('approved public licensed train row is exportable', jsonl.status === 200 && jsonl.text.includes(pairId));
  check('test benchmark reference never leaks into export', !jsonl.text.includes('SECRET_TEST_REFERENCE'));
  const dataset = await anon.get('/api/lab/dataset-card');
  check('dataset card states protected export policy', dataset.status === 200 && /train\/dev|train and dev/i.test(JSON.stringify(dataset.data)) && !JSON.stringify(dataset.data).includes('SECRET_TEST_REFERENCE'), dataset.data);

  group('private access');
  const privatePair = await owner.post('/api/lab/pairs', {
    direction:'ru2lak', source_text:'test-lab:private', target_literal:'секрет', target_natural:'секрет',
    rights_status:'copyrighted', access_status:'permission_pending', source_type:'human',
  });
  testIds.push(privatePair.data.pair.id);
  check('private pair hidden from anonymous readers', (await anon.get(`/api/lab/pairs/${privatePair.data.pair.id}`)).status === 403);
  check('ordinary account cannot review a private pair by ID', (await peer.post(`/api/lab/pairs/${privatePair.data.pair.id}/reviews`, { verdict:'accept' })).status === 403);
  check('private pair owner can read it', (await owner.get(`/api/lab/pairs/${privatePair.data.pair.id}`)).status === 200);
  const privateExport = await anon.get('/api/lab/export.jsonl');
  check('permission-pending pair excluded from export', !privateExport.text.includes('test-lab:private'));

  group('UI and old regressions');
  const page = await anon.get('/lab.html');
  check('lab page serves responsive viewport and unverified banner', page.status === 200 && page.text.includes('width=device-width') && page.text.includes('Model proposal — not verified.'));
  check('lab page does not expose secret names', !/SESSION_SECRET|REVIEWER_PASSPHRASE|API_KEY/.test(page.text));
  const uiCategories = [...page.text.matchAll(/<option value="(no_reliable_target|ambiguous_source|dialectal_gap|ocr_unreliable|insufficient_evidence|out_of_scope|other)">/g)].map(m => m[1]);
  check('every UI abstention category is accepted by the API', uiCategories.length === 7 && new Set(uiCategories).size === 7, uiCategories);

  child.kill('SIGTERM');
  await cleanup();
  await pool.end();
  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  if (failed) process.exit(1);
})().catch(async error => {
  console.error(error);
  try { await cleanup(); await pool.end(); } catch {}
  process.exit(1);
});