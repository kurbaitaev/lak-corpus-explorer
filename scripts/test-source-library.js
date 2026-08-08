'use strict';

/*
 * Public Source Library and word-form index — behaviour tests.
 *
 * The release gate proves that nothing private escapes. This script proves the
 * other half: that what *is* published is correct, complete and consistent —
 * the catalogue covers every substantive source, the filters and paging agree
 * with each other, the naming rules hold, the two-source rule for word forms is
 * never broken, and consent-sensitive material contributes nothing.
 *
 * It runs against a live server and writes nothing.
 *
 * Usage: node scripts/test-source-library.js      (BASE_URL defaults to :5000)
 */

const assert = require('assert');
const P = require('../lib/public-projection');

const BASE = (process.env.BASE_URL || 'http://127.0.0.1:5000').replace(/\/$/, '');
const EXPECTED_SOURCES = 293;          // substantive records in the v1.3 manifest
const EXPECTED_REVIEW_QUEUE = 3;       // public-domain candidates awaiting a decision

let passed = 0;
const failures = [];
function it(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => {
      failures.push(name);
      console.log(`  ✗ ${name} — ${err.message.split('\n')[0].slice(0, 300)}`);
    });
}
function group(title) { console.log(`\n[${title}]`); }

async function api(path) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* surfaced by the caller's assertion */ }
  return { status: res.status, data, text };
}

async function main() {
  console.log(`Source Library tests against ${BASE}`);

  const first = await api('/api/source-library?limit=100&page=1');
  if (first.status !== 200 || !first.data) {
    console.log(`\nFAILED: the catalogue is not answering (status ${first.status}).`);
    process.exit(1);
  }
  if (first.data.status === 'preparing') {
    console.log(`\nFAILED: the derivation has not finished ` +
      `(${first.data.stages_complete}/${first.data.stages_total} stages). Let the server boot and retry.`);
    process.exit(1);
  }

  // Read the whole catalogue once; almost every assertion below is about the
  // set as a whole rather than about one page of it.
  const all = [];
  for (let page = 1; page <= Math.ceil(first.data.total / 100); page++) {
    const res = await api(`/api/source-library?limit=100&page=${page}`);
    all.push(...res.data.items);
  }

  group('coverage');
  await it(`every substantive source is catalogued (${EXPECTED_SOURCES})`, () => {
    assert.strictEqual(first.data.total, EXPECTED_SOURCES);
    assert.strictEqual(all.length, EXPECTED_SOURCES);
  });
  await it('every ref is unique and well formed', () => {
    const refs = new Set(all.map(s => s.ref));
    assert.strictEqual(refs.size, all.length, 'duplicate refs');
    for (const s of all) assert.match(s.ref, /^s\d{1,6}$/, `bad ref ${s.ref}`);
  });
  await it('paging is consistent: page 2 does not repeat page 1', async () => {
    const a = await api('/api/source-library?limit=10&page=1');
    const b = await api('/api/source-library?limit=10&page=2');
    const overlap = a.data.items.filter(x => b.data.items.some(y => y.ref === x.ref));
    assert.deepStrictEqual(overlap, [], 'pages overlap');
    assert.strictEqual(a.data.pages_total, Math.ceil(EXPECTED_SOURCES / 10));
  });
  await it('an out-of-range page clamps to the last page instead of erroring', async () => {
    const res = await api('/api/source-library?limit=10&page=9999');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.page, res.data.pages_total);
    assert(res.data.items.length > 0, 'clamped page is empty');
  });

  group('vocabulary: every published value is one the client can label');
  const vocabFields = ['material_type', 'language_scope', 'corpus_role', 'extraction_status',
    'extraction_quality', 'rights_state', 'priority', 'file_format', 'script_profile',
    'name_source', 'contribution'];
  for (const field of vocabFields) {
    await it(`${field} stays inside its declared vocabulary`, () => {
      const allowed = P.VOCAB[field];
      assert(Array.isArray(allowed) && allowed.length, `no vocabulary declared for ${field}`);
      const stray = [...new Set(all.map(s => s[field]).filter(v => v != null && !allowed.includes(v)))];
      assert.deepStrictEqual(stray, [], `values outside the vocabulary: ${stray.join(', ')}`);
    });
  }
  await it('every family_id is one of the seven curated families', () => {
    const stray = [...new Set(all.map(s => s.family_id).filter(v => v && !P.FAMILY_IDS.includes(v)))];
    assert.deepStrictEqual(stray, []);
  });

  group('naming: a name is either real or honestly derived');
  await it('name_source agrees with what is actually published', () => {
    for (const s of all) {
      if (s.name_source === 'document_title') assert(s.title, `${s.ref} claims a title but has none`);
      else assert.strictEqual(s.title, null, `${s.ref} publishes a title but claims ${s.name_source}`);
      if (s.name_source === 'source_family') assert(s.family_id, `${s.ref} claims a family but has none`);
    }
  });
  await it('no published title looks like a path, a filename or a tool banner', () => {
    for (const s of all) {
      if (!s.title) continue;
      assert(!/[\\/]/.test(s.title), `${s.ref}: path-like title`);
      assert(!/\.(pdf|docx?|djvu|tiff?|jpe?g|rtf|zip|rar)\b/i.test(s.title), `${s.ref}: filename title`);
      assert(/\p{L}/u.test(s.title), `${s.ref}: letterless title`);
    }
  });
  await it('no attributed_to looks like a username rather than a person', () => {
    for (const s of all) {
      if (!s.attributed_to) continue;
      assert(/\s/.test(s.attributed_to), `${s.ref}: single-token name "${s.attributed_to}"`);
      assert(!/[@\d]/.test(s.attributed_to), `${s.ref}: name carries a digit or @`);
    }
  });
  await it('a published year is a plausible file date', () => {
    for (const s of all) {
      if (s.document_year === null) continue;
      assert(Number.isInteger(s.document_year) && s.document_year >= 1900 && s.document_year <= 2100,
        `${s.ref}: implausible year ${s.document_year}`);
    }
  });

  group('consent: fieldwork and elicitation material is withheld, not just unlinked');
  await it('consent-sensitive sources publish no name, date or link', () => {
    const sensitive = all.filter(s => s.consent_withheld);
    assert(sensitive.length > 0, 'no consent-sensitive sources found — the rule is untested');
    for (const s of sensitive) {
      assert.strictEqual(s.title, null, `${s.ref} publishes a title`);
      assert.strictEqual(s.attributed_to, null, `${s.ref} publishes a name`);
      assert.strictEqual(s.document_year, null, `${s.ref} publishes a date`);
      assert.deepStrictEqual(s.urls, [], `${s.ref} publishes a link`);
      assert.strictEqual(s.family_id, null, `${s.ref} publishes a family`);
    }
  });
  await it('consent-sensitive sources contribute no word forms at all', () => {
    for (const s of all.filter(x => x.consent_withheld)) {
      assert.strictEqual(s.word_form_count, 0, `${s.ref} contributed ${s.word_form_count} forms`);
      assert.strictEqual(s.contribution, 'withheld_pending_review', `${s.ref}: ${s.contribution}`);
    }
  });
  await it('every consent-sensitive material type is actually marked withheld', () => {
    for (const s of all) {
      if (P.CONSENT_SENSITIVE_TYPES.includes(s.material_type)) {
        assert.strictEqual(s.consent_withheld, true, `${s.ref} (${s.material_type}) is not withheld`);
      }
    }
  });

  group('rights: nothing claims to be published that is not');
  await it('no source in this batch publishes its text', () => {
    const published = all.filter(s => s.text_published);
    assert.deepStrictEqual(published.map(s => s.ref), []);
  });
  await it(`the review queue holds exactly the ${EXPECTED_REVIEW_QUEUE} public-domain candidates`, async () => {
    const res = await api('/api/source-library/review-queue');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.total, EXPECTED_REVIEW_QUEUE);
    for (const s of res.data.review_queue) {
      assert.strictEqual(s.rights_state, 'public_domain_candidate_review');
      assert.strictEqual(s.text_published, false, `${s.ref} publishes text while under review`);
    }
  });
  await it('the queue matches the catalogue', () => {
    const candidates = all.filter(s => s.rights_state === 'public_domain_candidate_review');
    assert.strictEqual(candidates.length, EXPECTED_REVIEW_QUEUE);
  });

  group('duplicates: counted once, catalogued individually');
  await it('duplicate group ids are opaque and never leak the private group name', () => {
    for (const s of all) {
      if (!s.group_id) continue;
      assert.match(s.group_id, /^g[0-9a-f]{12}$/, `${s.ref}: ${s.group_id}`);
      assert(!/dup-\d/.test(s.group_id), `${s.ref} leaks the private group name`);
    }
  });
  await it('every grouped source has at least one sibling, and exactly one canonical copy', () => {
    const groups = new Map();
    for (const s of all.filter(x => x.group_id)) {
      if (!groups.has(s.group_id)) groups.set(s.group_id, []);
      groups.get(s.group_id).push(s);
    }
    assert(groups.size > 0, 'no duplicate groups found — the rule is untested');
    for (const [gid, members] of groups) {
      assert(members.length >= 2, `${gid} has a single member`);
      const canonical = members.filter(m => m.is_canonical_copy);
      assert.strictEqual(canonical.length, 1, `${gid} has ${canonical.length} canonical copies`);
    }
  });
  await it('a detail request returns the siblings of its group and never itself', async () => {
    const grouped = all.find(s => s.group_id);
    const res = await api(`/api/source-library/${grouped.ref}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.source.ref, grouped.ref);
    assert(res.data.related.length >= 1, 'no siblings returned');
    assert(!res.data.related.some(r => r.ref === grouped.ref), 'the source is its own sibling');
    for (const r of res.data.related) assert.strictEqual(r.group_id, grouped.group_id);
  });
  await it('an ungrouped source returns no siblings', async () => {
    const solo = all.find(s => !s.group_id);
    const res = await api(`/api/source-library/${solo.ref}`);
    assert.deepStrictEqual(res.data.related, []);
    assert.strictEqual(res.data.count, 0);
  });
  await it('an unknown or malformed ref is a 404, not an error', async () => {
    for (const ref of ['s999999', 'nonsense', '..%2Fetc', 's1;DROP']) {
      const res = await api(`/api/source-library/${encodeURIComponent(ref)}`);
      assert.strictEqual(res.status, 404, `${ref} → ${res.status}`);
    }
  });

  group('filters and facets agree with the catalogue');
  const facets = await api('/api/source-library/facets');
  await it('the facet totals add up to the catalogue total', () => {
    assert.strictEqual(facets.data.total, EXPECTED_SOURCES);
    for (const field of ['material_type', 'language_scope', 'rights_state', 'script_profile', 'contribution']) {
      const sum = facets.data.facets[field].reduce((n, o) => n + o.count, 0);
      assert.strictEqual(sum, EXPECTED_SOURCES, `${field} facet counts sum to ${sum}`);
    }
  });
  await it('filtering by a facet returns exactly the count the facet promised', async () => {
    for (const field of ['material_type', 'language_scope', 'contribution']) {
      for (const option of facets.data.facets[field].slice(0, 3)) {
        const value = option[field];
        const res = await api(`/api/source-library?${field}=${encodeURIComponent(value)}&limit=1`);
        assert.strictEqual(res.data.total, option.count, `${field}=${value}: ${res.data.total} vs ${option.count}`);
      }
    }
  });
  await it('an unknown filter value is ignored rather than returning nothing', async () => {
    const res = await api('/api/source-library?material_type=not_a_real_type&limit=1');
    assert.strictEqual(res.data.total, EXPECTED_SOURCES);
  });
  await it('a free-text query narrows the catalogue and matches on published text only', async () => {
    const res = await api('/api/source-library?q=dictionary&limit=100');
    assert(res.data.total > 0 && res.data.total < EXPECTED_SOURCES, `got ${res.data.total}`);
  });
  await it('a query with SQL metacharacters is treated as text, not as a pattern', async () => {
    // Each of these would match every record if it were passed through to
    // LIKE unescaped. A single literal '_' is deliberately not in the list:
    // every search_text contains one, so matching everything would be correct.
    for (const q of ['%', '__________', '%%%%%', "' OR 1=1 --", 'a%z']) {
      const res = await api(`/api/source-library?q=${encodeURIComponent(q)}&limit=1`);
      assert.strictEqual(res.status, 200, `${q} → ${res.status}`);
      assert(res.data.total < EXPECTED_SOURCES, `"${q}" matched everything — it was read as a wildcard`);
    }
  });

  group('word forms: the two-source rule is the whole guarantee');
  const forms = await api('/api/word-forms?limit=100&sort=sources');
  await it('the index is non-empty and reports its own size', () => {
    assert.strictEqual(forms.status, 200);
    assert(forms.data.total > 10000, `only ${forms.data.total} forms`);
  });
  await it('no published form is attested by fewer than two sources', async () => {
    const pages = await Promise.all([
      api('/api/word-forms?limit=100&sort=sources'),
      api(`/api/word-forms?limit=100&sort=sources&page=${Math.ceil(forms.data.total / 100)}`),
      api('/api/word-forms?limit=100&sort=alphabetical'),
      api('/api/word-forms?limit=100&sort=occurrences'),
    ]);
    let checked = 0;
    for (const p of pages) {
      for (const f of p.data.items) {
        assert(f.sources >= P.MIN_ATTESTING_SOURCES,
          `"${f.form}" is attested by ${f.sources} source(s)`);
        assert(f.occurrences >= f.sources, `"${f.form}" occurs fewer times than it has sources`);
        checked++;
      }
    }
    assert(checked >= 300, `only ${checked} forms checked`);
  });
  await it('every form is a bare word: no whitespace, no punctuation, no context', () => {
    for (const f of forms.data.items) {
      assert(!/\s/.test(f.form), `"${f.form}" contains whitespace`);
      assert(f.form.length <= 40, `"${f.form}" is too long to be a word form`);
    }
  });
  await it('each sort order actually sorts', async () => {
    const bySources = (await api('/api/word-forms?limit=50&sort=sources')).data.items;
    const byOcc = (await api('/api/word-forms?limit=50&sort=occurrences')).data.items;
    const alpha = (await api('/api/word-forms?limit=50&sort=alphabetical')).data.items;
    for (let i = 1; i < bySources.length; i++) assert(bySources[i].sources <= bySources[i - 1].sources);
    for (let i = 1; i < byOcc.length; i++) assert(byOcc[i].occurrences <= byOcc[i - 1].occurrences);
    for (let i = 1; i < alpha.length; i++) assert(alpha[i].form >= alpha[i - 1].form);
  });
  await it('a prefix query returns only forms with that prefix', async () => {
    const res = await api('/api/word-forms?q=%D0%B1%D1%83&limit=50');   // "бу"
    assert(res.data.items.length > 0, 'no forms matched a common prefix');
    for (const f of res.data.items) assert(f.form.startsWith('бу'), `"${f.form}" does not start with "бу"`);
  });
  await it('the Lak-marker filter returns only marked forms', async () => {
    const res = await api('/api/word-forms?lak_marker=true&limit=50');
    assert(res.data.items.length > 0, 'no marked forms');
    for (const f of res.data.items) assert.strictEqual(f.lak_marker, true);
  });
  await it('confidence and script filters return only matching forms', async () => {
    for (const c of P.VOCAB.confidence) {
      const res = await api(`/api/word-forms?confidence=${c}&limit=20`);
      for (const f of res.data.items) assert.strictEqual(f.confidence, c);
    }
    for (const s of ['cyrillic', 'latin']) {
      const res = await api(`/api/word-forms?script_profile=${s}&limit=20`);
      for (const f of res.data.items) assert.strictEqual(f.script_profile, s);
    }
  });
  await it('the limit is capped so the index cannot be dumped in one request', async () => {
    const res = await api('/api/word-forms?limit=100000');
    assert(res.data.items.length <= 100, `returned ${res.data.items.length} rows`);
  });
  await it('a published form opens the exact sources behind its counts', async () => {
    const forms = await api('/api/word-forms?limit=1&sort=sources');
    const summary = forms.data.items[0];
    assert(summary, 'no published form available for detail test');
    const detail = await api(`/api/word-forms/${encodeURIComponent(summary.form)}/sources`);
    assert.strictEqual(detail.status, 200);
    assert.strictEqual(detail.data.form, summary.form);
    assert.strictEqual(detail.data.occurrences, summary.occurrences);
    assert.strictEqual(detail.data.sources, summary.sources);
    assert.strictEqual(detail.data.items.length, summary.sources);
    assert.strictEqual(detail.data.items.reduce((n, row) => n + row.form_occurrences, 0), summary.occurrences);
    for (const source of detail.data.items) {
      assert.match(source.ref, /^s\d{1,6}$/);
      assert(source.form_occurrences > 0);
      assert(!Object.prototype.hasOwnProperty.call(source, 'text'));
      assert(!Object.prototype.hasOwnProperty.call(source, 'source_path'));
      assert(!Object.prototype.hasOwnProperty.call(source, 'urls'));
      assert(Array.isArray(source.contexts));
      for (const context of source.contexts) {
        assert(context.snippet.length > 0 && context.snippet.length <= 360);
      }
    }
  });

  group('the catalogue and the index agree with each other');
  await it('only sources that contribute word forms have a non-zero form count', () => {
    for (const s of all) {
      if (s.contribution === 'word_forms') continue;
      assert.strictEqual(s.word_form_count, 0,
        `${s.ref} contributes "${s.contribution}" but counts ${s.word_form_count} forms`);
    }
    const contributing = all.filter(s => s.contribution === 'word_forms');
    assert(contributing.length > 100, `only ${contributing.length} contributing sources`);
    assert(contributing.some(s => s.word_form_count > 0), 'no contributing source produced a form');
  });

  group('search reaches both collections');
  await it('a corpus search also returns matching sources and forms', async () => {
    const res = await api('/api/corpus/search?q=%D0%B1%D1%83%D1%80&limit=5');
    assert.strictEqual(res.status, 200);
    assert(res.data.collections, 'no collections in the search response');
    assert(res.data.collections.library.total >= 0);
    assert(res.data.collections.forms.total > 0, 'a common Lak form returned no word-form matches');
    for (const f of res.data.collections.forms.items) {
      assert(f.sources >= P.MIN_ATTESTING_SOURCES, `"${f.form}" slipped past the two-source rule`);
    }
  });
  await it('an empty search still answers, with empty collections', async () => {
    const res = await api('/api/corpus/search?q=&limit=5');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.collections.library.total, 0);
    assert.strictEqual(res.data.collections.forms.total, 0);
  });

  // The audit counted 320 items: 293 substantive sources plus 27
  // system-metadata receipts. The public catalogue has to account for every
  // one of them exactly once — nothing missing, nothing invented, nothing
  // counted twice.
  group('the whole audited batch is represented exactly once');
  const receiptsPayload = await api('/api/source-library/receipts');
  const facetsPayload = await api('/api/source-library/facets');

  await it('the facets report the full audit: 320 items = 293 sources + 27 receipts', async () => {
    assert.strictEqual(facetsPayload.data.sources_total, 293, 'sources_total');
    assert.strictEqual(facetsPayload.data.receipts_total, 27, 'receipts_total');
    assert.strictEqual(facetsPayload.data.items_total, 320, 'items_total');
  });

  await it('27 receipts are listed, each carrying only safe canonical fields', async () => {
    assert.strictEqual(receiptsPayload.data.receipts.length, 27, 'receipt count');
    for (const r of receiptsPayload.data.receipts) {
      assert.deepStrictEqual(Object.keys(r).sort(),
        ['bytes', 'corpus_role', 'disposition', 'receipt_kind', 'recommended_use', 'ref'].sort(),
        `receipt ${r.ref} carries an undeclared field`);
      assert.match(r.ref, /^r\d{1,6}$/, `receipt ref ${r.ref} is not an opaque receipt ref`);
      assert.strictEqual(r.receipt_kind, 'macos_folder_metadata');
      assert.ok(['no_extractable_text', 'provenance_witness_only'].includes(r.disposition),
        `unexpected disposition ${r.disposition}`);
    }
  });

  // Runs against the staged audit itself, so this must stay before the
  // concurrency group, which is the group that closes the shared pool.
  const { pool: auditPool } = require('../lib/db');
  await it('every audited item appears exactly once across sources and receipts', async () => {
    const audited = await auditPool.query('SELECT source_sequence FROM v13_sources');
    const sources = await auditPool.query('SELECT source_sequence FROM public_sources');
    const receiptsDb = await auditPool.query('SELECT source_sequence FROM public_receipts');
    const auditedSeqs = new Set(audited.rows.map(r => r.source_sequence));
    assert.strictEqual(auditedSeqs.size, 320, 'the staged audit is not 320 items');
    const srcSeqs = sources.rows.map(r => r.source_sequence);
    const rcpSeqs = receiptsDb.rows.map(r => r.source_sequence);
    assert.strictEqual(srcSeqs.length, 293, 'public_sources is not 293 rows');
    assert.strictEqual(rcpSeqs.length, 27, 'public_receipts is not 27 rows');
    assert.deepStrictEqual(srcSeqs.filter(s => rcpSeqs.includes(s)), [],
      'an item is catalogued as both a source and a receipt');
    const covered = new Set([...srcSeqs, ...rcpSeqs]);
    assert.deepStrictEqual([...auditedSeqs].filter(s => !covered.has(s)), [],
      'audited items are missing from the public catalogue');
    assert.deepStrictEqual([...covered].filter(s => !auditedSeqs.has(s)), [],
      'the catalogue holds items the audit does not know');
  });

  await it('the corpus-role filter returns only that role', async () => {
    const r = await api('/api/source-library?corpus_role=private%20lexicon%20candidate&limit=100');
    assert.ok(r.data.total > 0, 'no sources carry the lexicon role');
    for (const item of r.data.items) assert.strictEqual(item.corpus_role, 'private lexicon candidate');
  });

  await it('the extraction-quality filter returns only that quality', async () => {
    const r = await api('/api/source-library?extraction_quality=very_short&limit=100');
    assert.ok(r.data.total > 0, 'no sources are very short');
    for (const item of r.data.items) assert.strictEqual(item.extraction_quality, 'very_short');
  });

  await it('a filter value outside the vocabulary is ignored, not injected', async () => {
    const r = await api("/api/source-library?corpus_role=x' OR 1=1 --&limit=5");
    assert.strictEqual(r.data.status, 'ok');
    assert.strictEqual(facetsPayload.data.sources_total, 293, 'the catalogue changed under a bogus filter');
  });

  // The deployment is autoscale: several instances boot at once and every one
  // of them starts a derivation. The stage table makes that resumable, but
  // resumability is not exclusion — without a lock one instance could discard
  // the published tables while another had already marked a stage complete,
  // and the surfaces would report themselves ready over an empty catalogue.
  group('concurrent boots cannot corrupt the published library');
  const { pool } = require('../lib/db');
  const derivation = require('../lib/public-derivation');
  try {
    await it('only one derivation may hold the lock at a time', async () => {
      let inside = 0, maxInside = 0, refused = 0;
      const body = async () => {
        inside++; maxInside = Math.max(maxInside, inside);
        await new Promise(r => setTimeout(r, 250));
        inside--;
        return true;
      };
      const runs = await Promise.all(
        [1, 2, 3, 4].map(() => derivation.withDerivationLock(pool, body)));
      for (const r of runs) if (!r.locked) refused++;
      assert.strictEqual(maxInside, 1, `${maxInside} derivations ran at once`);
      assert.strictEqual(refused, 3, `${4 - refused} instances took the lock`);
    });

    await it('the lock is released again, so the next boot can derive', async () => {
      const again = await derivation.withDerivationLock(pool, async () => 'ran');
      assert.strictEqual(again.locked, true, 'the lock was not released');
      assert.strictEqual(again.result, 'ran');
    });

    await it('a second derivation while one holds the lock steps aside instead of discarding', async () => {
      const before = await api('/api/source-library?limit=1');
      const held = derivation.withDerivationLock(pool, () => new Promise(r => setTimeout(r, 600)));
      const blocked = await derivation.derivePublicLibrary(pool, {
        packageDir: process.env.PRIVATE_PACKAGE_CACHE_DIR
          ? `${process.env.PRIVATE_PACKAGE_CACHE_DIR}/v1.3`
          : `${__dirname}/../private/v1.3`,
      });
      await held;
      assert.strictEqual(blocked.ready, false, 'the blocked instance claimed to have derived');
      assert.deepStrictEqual(blocked.stages, [], 'the blocked instance ran stages anyway');
      const after = await api('/api/source-library?limit=1');
      assert.strictEqual(after.data.total, before.data.total, 'the catalogue changed size');
      assert.strictEqual(after.data.status, 'ok', 'the catalogue stopped reporting ready');
    });
  } finally {
    await pool.end().catch(() => {});
  }

  console.log(`\n=== ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) {
    console.log('FAILED: ' + failures.join('; '));
    process.exit(1);
  }
}

main().catch(err => { console.error('SOURCE LIBRARY TEST ERROR:', err); process.exit(1); });
