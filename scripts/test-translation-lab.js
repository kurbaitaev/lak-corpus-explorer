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
    await pool.query('DELETE FROM model_runs WHERE run_by=$1', [id]);
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

  group('reviewed translation memory (gold-evidence gate)');
  const memBefore = await anon.get('/api/lab/memory?direction=ru2lak&q=test-lab%3Ahello');
  check('memory policy is served and lists what can never be gold',
    memBefore.status === 200 && Array.isArray(memBefore.data.policy.never_gold) &&
    /monolingual/i.test(JSON.stringify(memBefore.data.policy)), memBefore.data);
  // pairId was approved (cc_by, public, train) above → it is now gold.
  check('approved rights-eligible pair is served as gold', memBefore.data.gold_count === 1 &&
    memBefore.data.entries[0].review_state === 'expert_approved' &&
    memBefore.data.entries[0].gold === true, memBefore.data);
  const goldPropose = await anon.post('/api/lab/propose', { direction:'ru2lak', source_text:'test-lab:hello' });
  check('gold answer is classified as reviewed memory',
    goldPropose.data.classification === 'reviewed_memory' && goldPropose.data.gold === true &&
    goldPropose.data.certainty === 'reviewed', goldPropose.data.classification);
  check('gold answer carries evidence type, review state and provenance',
    goldPropose.data.evidence_type === 'approved_parallel_pair' &&
    goldPropose.data.evidence_class === 'approved_parallel_pair' &&
    goldPropose.data.review_state === 'expert_approved' &&
    goldPropose.data.provenance && goldPropose.data.provenance.record_ref === pairId,
    { t: goldPropose.data.evidence_type, p: goldPropose.data.provenance });
  check('gold answer claims a reviewed translation, never model learning',
    goldPropose.data.claim.claim === 'reviewed_translation' &&
    goldPropose.data.claim.model_learning === false, goldPropose.data.claim);

  // A pending pair, and a pair that is approved but NOT rights-eligible/public,
  // must never be served as gold.
  const pendingPair = await owner.post('/api/lab/pairs', {
    direction:'ru2lak', source_text:'test-lab:pending', target_literal:'ждёт', target_natural:'ждёт',
    rights_status:'cc_by', access_status:'public', source_type:'human',
  });
  testIds.push(pendingPair.data.pair.id);
  const memPending = await anon.get('/api/lab/memory?direction=ru2lak&q=test-lab%3Apending');
  check('pending pair is not gold evidence', memPending.data.gold_count === 0, memPending.data);
  const pendingPropose = await anon.post('/api/lab/propose', { direction:'ru2lak', source_text:'test-lab:pending' });
  check('pending pair does not reach the answer', pendingPropose.data.gold === false &&
    !JSON.stringify(pendingPropose.data).includes('ждёт'), pendingPropose.data.classification);

  const restricted = await owner.post('/api/lab/pairs', {
    direction:'ru2lak', source_text:'test-lab:restricted', target_literal:'закрыто', target_natural:'закрыто',
    rights_status:'restricted', access_status:'restricted', source_type:'human',
  });
  testIds.push(restricted.data.pair.id);
  await expert.post(`/api/lab/pairs/${restricted.data.pair.id}/adjudicate`, { decision:'approve', split:'train' });
  const memRestricted = await anon.get('/api/lab/memory?direction=ru2lak&q=test-lab%3Arestricted');
  check('approved but rights-ineligible/private pair is never gold', memRestricted.data.gold_count === 0, memRestricted.data);
  const restrictedPropose = await anon.post('/api/lab/propose', { direction:'ru2lak', source_text:'test-lab:restricted' });
  check('rights-ineligible pair never reaches a public answer',
    restrictedPropose.data.gold === false && !JSON.stringify(restrictedPropose.data).includes('закрыто'),
    restrictedPropose.data.classification);

  group('evidence typing, abstention and the monolingual rule');
  const labProvider = require('../lib/lab-provider');
  const labMemory = require('../lib/lab-memory');
  const monolingual = labProvider.propose('ru2lak', { evidence: [labMemory.annotate({
    evidence_type: 'corpus_example', lak_text: 'МОНОЛИНГВАЛ', gloss: 'a document title',
    source: 'Lak Wikipedia', variety: 'standard', record_ref: 'x', is_ocr: false,
    validated: true, score: 99,
  })] });
  check('monolingual usage can never propose a translation',
    monolingual.abstained === true && monolingual.suggested_target === null &&
    monolingual.abstain.reason === 'usage_only_no_translation' &&
    monolingual.certainty === 'usage_only', monolingual);
  check('monolingual evidence is typed as usage support only',
    labMemory.classOf({ evidence_type: 'corpus_example' }) === 'usage_support_only' &&
    labMemory.canPropose({ evidence_type: 'corpus_example' }) === false);
  check('a one-sided "attested example" is downgraded to usage support',
    labMemory.classOf({ evidence_type: 'attested_public_example', lak_text: 'x', gloss: '' }) === 'usage_support_only' &&
    labMemory.classOf({ evidence_type: 'attested_public_example', lak_text: 'x', gloss: 'y' }) === 'attested_public_example');
  check('no unreviewed pair passes the gold rule',
    labMemory.isGoldPair({ status:'pending', is_private:false, access_status:'public',
      rights_status:'cc_by', provenance:'human', abstained:false, split:'train' }) === false &&
    labMemory.isGoldPair({ status:'approved', is_private:false, access_status:'public',
      rights_status:'cc_by', provenance:'human', abstained:false, split:'test' }) === false &&
    labMemory.isGoldPair({ status:'approved', is_private:false, access_status:'public',
      rights_status:'cc_by', provenance:'human', abstained:false, split:'train' }) === true);
  const abstain = await anon.post('/api/lab/propose', { direction:'ru2lak', source_text:'test-lab:zxqwkjфыва2' });
  check('abstention is explicit with a reason and no claim',
    abstain.data.abstained === true && abstain.data.abstain.reason === 'no_reliable_target' &&
    abstain.data.certainty === 'none' && abstain.data.claim.claim === 'no_translation', abstain.data.abstain);
  const candidate = await anon.post('/api/lab/propose', { direction:'ru2lak', source_text:'спасибо' });
  check('unreviewed dictionary evidence is a candidate match, not validated',
    candidate.data.gold === false && candidate.data.certainty === 'candidate' &&
    candidate.data.claim.claim === 'candidate_match' && candidate.data.claim.validated === false,
    candidate.data.claim);
  check('every returned evidence row is typed and states its review state',
    (candidate.data.evidence || []).every(e => e.evidence_class && e.review_state &&
      typeof e.can_propose === 'boolean'), (candidate.data.evidence || [])[0]);
  check('no answer is ever built from usage-support-only evidence',
    candidate.data.evidence_class !== 'usage_support_only' &&
    goldPropose.data.evidence_class !== 'usage_support_only');
  check('no answer claims model learning or fine-tuning',
    candidate.data.fine_tuned === false && candidate.data.claim.model_learning === false &&
    !/(?<!\bno )model (learned|was trained|is trained|fine-?tuned)/i.test(candidate.text), candidate.data.claim);

  group('benchmark isolation leak probe');
  const benchProbe = await anon.post('/api/lab/propose', { direction:'ru2lak', source_text:'test-lab:heldout' });
  check('a held-out item cannot be answered from the benchmark',
    !benchProbe.text.includes('SECRET_TEST_REFERENCE'), benchProbe.data.suggested_target);
  check('the answer reports that isolation was enforced',
    benchProbe.data.isolation && benchProbe.data.isolation.enforced === true, benchProbe.data.isolation);
  const publicSearch = await anon.get('/api/corpus/search?q=SECRET_TEST_REFERENCE');
  check('held-out reference is absent from public corpus search',
    publicSearch.status === 200 && publicSearch.data.total === 0 &&
    !publicSearch.text.includes('SECRET_TEST_REFERENCE'.toLowerCase()), publicSearch.data.total);
  const memLeak = await anon.get('/api/lab/memory?direction=ru2lak&q=test-lab%3Aheldout');
  check('translation memory serves no held-out item', memLeak.data.gold_count === 0 &&
    !memLeak.text.includes('SECRET_TEST_REFERENCE'), memLeak.data);

  // Contamination: an otherwise perfectly exportable pair whose target equals a
  // held-out reference must still be withheld everywhere.
  const contaminated = await owner.post('/api/lab/pairs', {
    direction:'ru2lak', source_text:'test-lab:contaminated', target_literal:'SECRET_TEST_REFERENCE',
    target_natural:'SECRET_TEST_REFERENCE', rights_status:'cc_by', access_status:'public',
    source_type:'human',
  });
  testIds.push(contaminated.data.pair.id);
  await expert.post(`/api/lab/pairs/${contaminated.data.pair.id}/adjudicate`, { decision:'approve', split:'train' });
  const afterContam = await anon.get('/api/lab/export.jsonl');
  check('a pair duplicating a held-out answer is withheld from export',
    !afterContam.text.includes('SECRET_TEST_REFERENCE') && !afterContam.text.includes('test-lab:contaminated'),
    afterContam.text.slice(0, 200));
  const contamMemory = await anon.get('/api/lab/memory?direction=ru2lak&q=test-lab%3Acontaminated');
  check('a contaminated pair is not served as gold', contamMemory.data.gold_count === 0, contamMemory.data);
  const contamPropose = await anon.post('/api/lab/propose', { direction:'ru2lak', source_text:'test-lab:contaminated' });
  check('a contaminated pair cannot reach a public answer',
    !contamPropose.text.includes('SECRET_TEST_REFERENCE'), contamPropose.data.suggested_target);
  for (const path of ['/api/lab/export.tsv', '/api/lab/export.hf.json', '/api/lab/dataset-card']) {
    const r = await anon.get(path);
    check(`no held-out item leaks via ${path}`, !r.text.includes('SECRET_TEST_REFERENCE'), path);
  }
  check('still exportable: the clean approved pair', afterContam.text.includes(pairId));

  group('private benchmark route (import/export kept apart)');
  const benchList = await expert.get('/api/lab/benchmark?split=test');
  check('benchmark capacity targets 500–1000 held-out expert pairs',
    benchList.status === 200 && benchList.data.capacity.target_size.min === 500 &&
    benchList.data.capacity.target_size.max === 1000, benchList.data.capacity);
  check('anonymous benchmark export blocked',
    (await anon.get('/api/lab/benchmark/export.jsonl')).status === 401 &&
    (await anon.get('/api/lab/benchmark/export.tsv')).status === 401);
  check('ordinary account cannot export the benchmark',
    (await peer.get('/api/lab/benchmark/export.jsonl')).status === 403);
  const benchExport = await expert.get('/api/lab/benchmark/export.jsonl');
  check('expert benchmark export returns held-out items privately',
    benchExport.status === 200 && benchExport.text.includes('SECRET_TEST_REFERENCE') &&
    /no-store/.test(benchExport.headers.get('cache-control') || ''), benchExport.status);
  const benchTsv = await expert.get('/api/lab/benchmark/export.tsv');
  check('expert benchmark TSV export works', benchTsv.status === 200 && benchTsv.text.includes('SECRET_TEST_REFERENCE'));
  const forcedPrivate = await expert.post('/api/lab/benchmark/import', { items:[{
    direction:'ru2lak', source_text:'test-lab:forced', reference_text:'test-lab:forced-ref',
    split:'test', notes:'test-lab', is_private:false,
  }]});
  const forcedRow = await pool.query('SELECT is_private FROM benchmark_items WHERE id=$1', [forcedPrivate.data.ids[0]]);
  check('a held-out item cannot be imported as public', forcedRow.rows[0].is_private === true, forcedRow.rows[0]);

  group('evaluation runs (retrieval-only vs model+retrieval)');
  check('anonymous run listing blocked', (await anon.get('/api/lab/runs')).status === 401);
  const run = await expert.post('/api/lab/runs', { split:'test', config:'retrieval_only' });
  check('retrieval-only run is logged with evidence, gold and abstain counts',
    run.status === 200 && run.data.config === 'retrieval_only' &&
    typeof run.data.items_with_gold === 'number' && typeof run.data.items_abstained === 'number' &&
    run.data.items_total >= 1, run.data);
  check('a run states no fine-tuning took place',
    run.data.fine_tuned === false && run.data.summary.fine_tuning === false &&
    /no model was trained or fine-tuned/i.test(run.data.summary.note), run.data.summary);
  check('a run never leaks the held-out reference it evaluated', !run.text.includes('SECRET_TEST_REFERENCE'));
  const modelRun = await expert.post('/api/lab/runs', { split:'test', config:'model_plus_retrieval' });
  check('model+retrieval run refused while no model is configured',
    modelRun.status === 409 && /no generative model is configured/i.test(JSON.stringify(modelRun.data)), modelRun.data);
  const compare = await expert.get('/api/lab/runs/compare?split=test');
  check('runs can be compared by configuration',
    compare.status === 200 && compare.data.retrieval_only && compare.data.retrieval_only.id === run.data.run_id &&
    compare.data.model_plus_retrieval === null && compare.data.fine_tuning === false, compare.data);

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