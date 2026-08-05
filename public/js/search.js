'use strict';

// ── Localization helper ──────────────────────────────────────
// Canonical dictionary lives in i18n.js; this only forwards calls and
// falls back to the supplied English default when a key is missing.
function t(key, def, vars) {
  const I = window.I18n;
  if (I && typeof I.t === 'function') {
    const out = I.t(key, vars);
    if (out != null && out !== key) return out;
  }
  return def;
}
function tp(key, count, def, vars) {
  const I = window.I18n;
  if (I && typeof I.plural === 'function') {
    const out = I.plural(key, count, vars);
    if (out != null && out !== key) return out;
  }
  return def;
}
// Localized display labels for review states. Canonical values stay 'approved'
// / 'flagged' / 'unreviewed'; only the shown text is translated.
function reviewStateLabel(state) {
  if (state === 'approved')   return t('review.state.approved', 'Approved');
  if (state === 'flagged')    return t('review.state.flagged', 'Flagged');
  if (state === 'unreviewed') return t('review.state.unreviewed', 'Unreviewed');
  return state;
}

// ── Utilities ────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

const fmt = n => typeof n === 'number' ? n.toLocaleString(localeTag()) : String(n ?? '');
function localeTag() {
  const I = window.I18n;
  if (I && typeof I.getLanguage === 'function') {
    return I.getLanguage() === 'ru' ? 'ru-RU' : 'en-GB';
  }
  return 'en-GB';
}

function toast(msg, type = 'ok') {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Review cache ─────────────────────────────────────────────
const reviewCache = {};

function qualityBadgeHtml(recordId, source, reviewData) {
  if (reviewData) {
    if (reviewData.state === 'approved')   return `<span class="quality-badge q-approved">${esc(reviewStateLabel('approved'))}</span>`;
    if (reviewData.state === 'flagged')    return `<span class="quality-badge q-flagged">${esc(reviewStateLabel('flagged'))}</span>`;
    if (reviewData.state === 'unreviewed') return `<span class="quality-badge q-unreviewed">${esc(reviewStateLabel('unreviewed'))}</span>`;
  }
  if (source === 'Uslar 1890') return `<span class="quality-badge q-ocr">${esc(t('search.badge.ocrUnreviewed', 'OCR — unreviewed'))}</span>`;
  return `<span class="quality-badge q-unreviewed">${esc(reviewStateLabel('unreviewed'))}</span>`;
}

// ── State ────────────────────────────────────────────────────
let currentPage   = 1;
let currentTotal  = 0;
let currentPages  = 1;
let currentExpanded = [];
let currentSenses   = [];
let currentQuery    = '';
let currentOcrSenses = [];
let currentRows     = [];
let currentMatches  = [];
// Where each row matched, when the Lak text itself shows no highlight.
let currentExplain  = [];
// Sources and word forms matching the same query, from the public Source
// Library. Held so a language switch can re-render them without a refetch.
let currentCollections = null;
// Public evidence per record id, filled in after the rows render.
const evidenceCache = {};
let openReviewId  = null;
let hasSearchIntent = false;
// Monotonic id of the most recently *started* search. Only the request whose id
// still equals this may write page state or the DOM, so a slow earlier request
// can never overwrite the results of a newer query/filter change.
let searchSeq     = 0;
// AbortController of the in-flight search, so a superseded request is dropped at
// the network level as well as ignored on resolution.
let searchAbort   = null;

// ── DOM refs ─────────────────────────────────────────────────
const $q       = document.getElementById('q');
const $kind    = document.getElementById('kind');
const $source  = document.getElementById('source');
const $variety = document.getElementById('variety');
const $concept = document.getElementById('concept-card');
const $tbody   = document.getElementById('tbody');
const $count   = document.getElementById('count-label');
const $page    = document.getElementById('page-label');
const $page2   = document.getElementById('page-label2');
const $prev    = document.getElementById('prev-btn');
const $next    = document.getElementById('next-btn');
const $prev2   = document.getElementById('prev-btn2');
const $next2   = document.getElementById('next-btn2');

// ── Populate stats from server ────────────────────────────────
let lastStats = null;
async function loadStats() {
  try {
    const res  = await fetch('/api/corpus/stats');
    const data = await res.json();
    lastStats  = data.stats;
    renderStats();
  } catch { /* silent */ }
}
function renderStats() {
  const s = lastStats;
  if (!s) return;
  const row = document.getElementById('stats-row');
  row.innerHTML = [
    [t('search.stats.documents', 'Documents'), s.documents],
    [t('search.stats.segments', 'Segments'),   s.sentences],
    [t('search.stats.tokens', 'Tokens'),       fmt(s.tokens)],
    [t('search.stats.lexicon', 'Lexicon'),     fmt(s.lexicon_rows)],
  ].map(([l, v]) =>
    `<div class="stat-chip"><span class="val">${v}</span><span class="lbl">${esc(l)}</span></div>`
  ).join('');
}

// ── Search (calls server API) ─────────────────────────────────
async function search(page = 1) {
  // Supersede any search already in flight: the newest user action always wins.
  const seq = ++searchSeq;
  searchAbort?.abort();
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  searchAbort = controller;

  hasSearchIntent = true;
  document.querySelectorAll('.results-only').forEach(el => el.hidden = false);

  const q       = $q.value.trim();
  const kind    = $kind.value;
  const source  = $source.value;
  const variety = $variety.value;

  const params = new URLSearchParams({ page, limit: 50 });
  if (q)       params.set('q', q);
  if (kind)    params.set('kind', kind);
  if (source)  params.set('source', source);
  if (variety) params.set('variety', variety);

  $tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text3);">${esc(t('search.loading', 'Searching…'))}</td></tr>`;
  [$prev,$prev2,$next,$next2].forEach(b => b.disabled = true);

  try {
    const res  = await fetch(`/api/corpus/search?${params}`, controller ? { signal: controller.signal } : undefined);
    if (!res.ok) throw new Error(t('search.error.failed', 'Search failed'));
    const data = await res.json();
    // A newer search started while this one was resolving — discard it whole.
    if (seq !== searchSeq) return;

    currentTotal    = data.total;
    currentPages    = data.pages;
    currentPage     = data.page;
    currentExpanded = data.expanded || [];
    currentSenses   = data.senses   || [];
    currentQuery    = q;
    currentOcrSenses = data.ocrSenses || [];
    currentRows     = data.rows || [];
    currentMatches  = data.matches || [];
    currentExplain  = data.explain || [];

    currentCollections = data.collections || null;

    renderConceptCard(q, currentExpanded, currentSenses, currentOcrSenses);
    renderCollections(currentQuery, currentCollections);
    renderResults(currentRows, currentMatches, currentExplain);
    renderPagination();
    loadEvidence(seq, currentRows, currentExpanded);

  } catch (err) {
    // Superseded requests (aborted or simply late) must not touch the DOM: the
    // newer request owns the loading state and will resolve it itself.
    if (seq !== searchSeq || err?.name === 'AbortError') return;
    $tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
      <div class="icon">⚠️</div><h3>${esc(t('search.error.title', 'Search error'))}</h3><p>${esc(err.message)}</p>
    </div></td></tr>`;
  } finally {
    if (seq === searchSeq) searchAbort = null;
  }
}

function renderConceptCard(q, expanded, senses, ocrSenses = []) {
  if (!expanded.length) {
    $concept.classList.remove('visible');
    $concept.innerHTML = '';
    return;
  }
  $concept.innerHTML = `
    <div>
      <div class="concept-label">${esc(t('search.concept.russianQuery', 'Russian query'))}</div>
      <div class="concept-val">${esc(q)}</div>
    </div>
    <div class="concept-arrow">→</div>
    <div>
      <div class="concept-label">${esc(t('search.concept.lakTranslation', 'Lak translation'))}</div>
      <div class="concept-val" lang="lbe">${expanded.map(esc).join(' · ')}</div>
      ${senses.length ? `<div class="concept-senses">${esc(t('search.concept.dictionarySenses', 'Dictionary senses:'))} ${senses.map(esc).join(', ')}</div>` : ''}
    </div>
    ${ocrSenses.length ? `
    <div class="concept-ocr">
      <span class="quality-badge q-ocr">${esc(t('search.badge.ocrUnverified', 'OCR — unverified'))}</span>
      <span>${esc(t('search.concept.historicalSenses', 'Historical senses from Uslar 1890 (unreviewed OCR):'))} ${ocrSenses.map(esc).join(', ')}</span>
    </div>` : ''}`;
  $concept.classList.add('visible');
}

function renderPagination() {
  const prefix = currentExpanded.length && $kind.value !== 'lexicon' ? t('search.count.corpusPrefix', 'Corpus occurrences · ') : '';
  $count.innerHTML = tp('search.count.records', currentTotal,
    `${prefix}<b>${currentTotal.toLocaleString(localeTag())}</b> records`,
    { prefix, count: `<b>${currentTotal.toLocaleString(localeTag())}</b>` });
  const text = t('search.page.of', `Page ${currentPage} of ${currentPages}`, { page: currentPage, pages: currentPages });
  $page.textContent = $page2.textContent = text;
  [$prev,$prev2].forEach(b => b.disabled = currentPage <= 1);
  [$next,$next2].forEach(b => b.disabled = currentPage >= currentPages);
}

// Wrap matched spans ([start, end) offsets) in <mark class="hl">
function highlightSpans(text, spans) {
  const s = String(text ?? '');
  if (!spans || !spans.length) return esc(s);
  let out = '', last = 0;
  for (const [a, b] of spans) {
    if (a < last) continue;
    out += esc(s.slice(last, a)) + `<mark class="hl">${esc(s.slice(a, b))}</mark>`;
    last = b;
  }
  return out + esc(s.slice(last));
}

// Localized display for the corpus variety label. The stored value is kept as
// data; only the shown text is localized when a dictionary key exists.
function varietyLabel(variety) {
  if (!variety) return '—';
  const key = 'variety.' + String(variety).toLowerCase();
  const cap = variety.charAt(0).toUpperCase() + variety.slice(1);
  return t(key, cap);
}

// ── Match explanation ─────────────────────────────────────────
// A record can match on its translation, source, variety or identifier rather
// than on its Lak text. Saying so is what makes every result explainable.
function matchChipHtml(explain, isLexicon) {
  if (!explain || !explain.field) return '';
  const field = String(explain.field);
  // Field 2 of a record is a translation for lexicon rows and a translation or
  // document title for text rows, so the label stays honest about both.
  const key = field === 'translation' && !isLexicon ? 'translationOrDocument' : field;
  const label = t('search.match.' + key, '');
  if (!label) return '';
  return `<span class="match-where" data-field="${esc(field)}">${esc(label)}</span>`;
}

// ── Public evidence on a result card ──────────────────────────
// Rendered from /api/corpus/evidence: reviewed pairs, dictionary translations,
// attested phrase pairs and public corpus examples — or an explicit
// "not enough evidence" state. Never a guess.
function evidenceItemHtml(item) {
  const className = t('search.evidence.class.' + item.evidence_class, item.evidence_class);
  const usageOnly = item.can_propose
    ? ''
    : `<span class="ev-caveat">${esc(t('search.evidence.usageOnly', 'context only — not proof of a translation'))}</span>`;
  const ocr = item.is_ocr
    ? `<span class="quality-badge q-ocr">${esc(t('search.badge.ocrUnreviewed', 'OCR — unreviewed'))}</span>`
    : '';
  const gloss = item.gloss ? `<span class="ev-gloss">${esc(item.gloss)}</span>` : '';
  const lak = item.lak_text ? `<span class="ev-lak" lang="lbe">${esc(item.lak_text)}</span>` : '';
  const source = item.source
    ? `<span class="ev-chip ev-source">${esc(item.source)}</span>`
    : '';
  return `<li class="ev-item">
    <span class="ev-chip ev-class ev-${esc(item.evidence_class)}">${esc(className)}</span>
    ${lak}${lak && gloss ? '<span class="ev-arrow" aria-hidden="true">→</span>' : ''}${gloss}
    <span class="ev-meta">${source}${ocr}${usageOnly}</span>
  </li>`;
}

function evidenceCellHtml(recordId) {
  const bundle = evidenceCache[recordId];
  if (bundle === undefined) {
    return `<span class="ev-loading">${esc(t('search.evidence.loading', 'Checking evidence…'))}</span>`;
  }
  if (bundle === null) {
    return `<span class="ev-loading">${esc(t('search.evidence.unavailable', 'Evidence check unavailable'))}</span>`;
  }
  const confidence = bundle.confidence || 'none';
  const head = `<span class="ev-chip ev-confidence ev-conf-${esc(confidence)}">${esc(t('search.evidence.confidence.' + confidence, confidence))}</span>` +
    `<span class="ev-chip ev-review">${esc(t('search.evidence.review.' + (bundle.review_state || 'no_public_evidence'), bundle.review_state || ''))}</span>`;
  if (bundle.status !== 'ok' || !bundle.evidence || !bundle.evidence.length) {
    return `<div class="ev-block ev-empty">${head}
      <p class="ev-none">${esc(t('search.evidence.none.body',
        'No dictionary entry, reviewed pair or public example backs this record yet.'))}</p></div>`;
  }
  return `<div class="ev-block">${head}
    <ul class="ev-list">${bundle.evidence.slice(0, 3).map(evidenceItemHtml).join('')}</ul></div>`;
}

// Fill the evidence cells of the rows that are already on screen. The search
// sequence guard applies here too: a superseded page never paints.
function paintEvidence(rows) {
  for (const r of rows) {
    const recordId = r[5];
    if (!recordId) continue;
    const cell = document.querySelector(`tr[data-record="${CSS.escape(recordId)}"] .td-evidence`);
    if (cell) cell.innerHTML = evidenceCellHtml(recordId);
  }
}

async function loadEvidence(seq, rows, expanded) {
  const ids = rows.map(r => r[5]).filter(Boolean);
  if (!ids.length) return;
  let bundles = null;
  try {
    const res = await fetch('/api/corpus/evidence', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_ids: ids, expanded: expanded || [] }),
    });
    if (res.ok) bundles = (await res.json()).evidence || {};
  } catch { bundles = null; }
  // A newer search owns the table now — its own request will paint it.
  if (seq !== searchSeq) return;
  for (const id of ids) evidenceCache[id] = bundles ? (bundles[id] || null) : null;
  paintEvidence(rows);
}

// ── Source Library and word-form collections ──────────────────
// The corpus table answers "where does this phrase appear in published text?".
// These two panels answer the questions next to it: "which sources hold this?"
// and "is this form actually attested?" — both from the public projection of
// the research batch, so nothing restricted is exposed.
function collectionSourceName(s) {
  if (s.title) return s.title;
  const material = t('lib.materialType.' + s.material_type, s.material_type.replace(/_/g, ' '));
  return `${material} — ${s.ref}`;
}

function renderCollections(query, collections) {
  const host = document.getElementById('search-collections');
  if (!host) return;
  if (!query || !collections) { host.innerHTML = ''; return; }

  const panels = [];
  const lib = collections.library || { total: 0, items: [] };
  const forms = collections.forms || { total: 0, items: [] };

  if (lib.items.length) {
    panels.push(`<section class="search-collection">
      <h3>${esc(t('search.collections.sources', `Sources matching “${query}”`, { q: query }))}</h3>
      <ul>${lib.items.map(s => `<li>
        <a href="/source-library.html?source=${encodeURIComponent(s.ref)}">${esc(collectionSourceName(s))}</a>
        <span class="search-collection-meta">${esc(t('lib.languageScope.' + s.language_scope, s.language_scope))} · ${esc(t('lib.contribution.' + s.contribution, s.contribution.replace(/_/g, ' ')))}</span>
      </li>`).join('')}</ul>
      <a class="search-collection-more" href="/source-library.html?q=${encodeURIComponent(query)}">${esc(t('search.collections.allSources', `All ${lib.total} matching sources →`, { n: lib.total }))}</a>
    </section>`);
  }

  if (forms.items.length) {
    panels.push(`<section class="search-collection">
      <h3>${esc(t('search.collections.forms', `Word forms starting with “${query}”`, { q: query }))}</h3>
      <ul>${forms.items.map(f => `<li>
        <a href="/word-forms.html?q=${encodeURIComponent(f.form)}" lang="lbe">${esc(f.form)}</a>
        <span class="search-collection-meta">${esc(t('search.collections.formSummary', `${f.occurrences} occurrences · ${f.sources} sources`, { occurrences: f.occurrences, sources: f.sources }))}</span>
      </li>`).join('')}</ul>
      <a class="search-collection-more" href="/word-forms.html?q=${encodeURIComponent(query)}">${esc(t('search.collections.allForms', `All ${forms.total} matching forms →`, { n: forms.total }))}</a>
    </section>`);
  }

  host.innerHTML = panels.join('');
}

function renderResults(rows, matches = [], explain = []) {
  if (!rows.length) {
    $tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state">
      <div class="icon">🔍</div><h3>${esc(t('search.empty.title', 'No records match'))}</h3>
      <p>${esc(t('search.empty.body', 'Try a different query, or clear the filters above.'))}</p>
    </div></td></tr>`;
    return;
  }

  $tbody.innerHTML = rows.map((r, i) => {
    const [type, lak, meaning, source, variety, recordId, url] = r;
    const typeTag = type === 'text'
      ? `<span class="tag tag-text">${esc(t('search.type.text', 'Text'))}</span>`
      : `<span class="tag tag-lexicon">${esc(t('search.type.lexicon', 'Lexicon'))}</span>`;

    const sourceCell = url
      ? `<a href="${esc(url)}" class="source-link" target="_blank" rel="noreferrer">${esc(source)}</a>`
      : esc(source);
    const isLexicon = String(type).toLowerCase() === 'lexicon';
    const translation = isLexicon && meaning
      ? meaning
      : t('search.results.translationMissing', 'Translation not added yet');
    const documentId = !isLexicon && meaning ? meaning : recordId;
    const sourceHelp = source === 'PCMLBE'
      ? ` <span class="help-marker" data-help="help.pcmlbe" data-help-fallback="PCMLBE is the Pangloss Collection metadata and archive source used for this record."></span>` +
        ` <a class="license-chip" href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer" title="${esc(t('search.license.pcmlbeTitle', 'PCMLBE by Erwin Komen, Radboud University — CC BY-SA 4.0; reuse requires attribution and ShareAlike'))}">CC BY-SA 4.0</a>`
      : '';

    // Where the match happened, when the Lak text carries no highlight.
    const where = explain[i] || null;
    const whereChip = matchChipHtml(where, isLexicon);
    const translationHtml = where && where.field === 'translation' && where.spans && where.spans.length
      ? highlightSpans(meaning, where.spans)
      : esc(translation);
    const documentHtml = where && where.field === 'translation' && where.spans && where.spans.length && !isLexicon
      ? highlightSpans(documentId, where.spans)
      : esc(documentId);

    return `<tr data-record="${esc(recordId)}">
      <td class="td-type" data-label="${esc(t('search.col.typeQuality', 'Type / quality'))}">${typeTag}</td>
      <td class="td-lak" data-label="${esc(t('search.col.lak', 'Lak'))}"><span class="lak-text" lang="lbe">${highlightSpans(lak, matches[i])}</span>${whereChip}</td>
      <td class="td-meaning" data-label="${esc(t('search.results.translation', 'Translation'))}">${isLexicon ? translationHtml : esc(translation)}</td>
      <td class="td-document" data-label="${esc(t('search.results.sourceDocument', 'Source document'))}">
        <span>${documentHtml}</span>
        <span class="record-meta">${esc(t('search.results.recordId', 'Record ID'))}: ${esc(recordId)}</span>
      </td>
      <td data-label="${esc(t('search.col.source', 'Source'))}">${sourceCell}${sourceHelp}</td>
      <td data-label="${esc(t('search.col.variety', 'Variety'))}">${esc(varietyLabel(variety))}</td>
      <td class="td-evidence" data-label="${esc(t('search.col.evidence', 'Evidence'))}">${evidenceCellHtml(recordId)}</td>
      <td class="td-actions"><a class="btn btn-sm btn-primary" href="/validate.html?record=${encodeURIComponent(recordId)}">${esc(t('search.results.validateAction', 'Check translation'))}</a></td>
    </tr>`;
  }).join('');
}

// ── Review badge refresh after bulk fetch ─────────────────────
async function fetchBulkReviews(ids) {
  try {
    const res = await fetch('/api/reviews/bulk', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_ids: ids }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    Object.assign(reviewCache, data.reviews || {});
    return data.reviews || {};
  } catch { return {}; }
}

function updateBadges(rows, revMap) {
  for (const r of rows) {
    const [,, , source,, recordId] = r;
    const review = revMap[recordId];
    if (!review) continue;
    const dataRow = document.querySelector(`tr[data-record="${CSS.escape(recordId)}"]`);
    if (!dataRow) continue;
    dataRow.querySelectorAll('.quality-badge').forEach(b => b.remove());
    const newBadge = document.createElement('span');
    newBadge.className = review.state === 'approved' ? 'quality-badge q-approved'
                       : review.state === 'flagged'  ? 'quality-badge q-flagged'
                       : 'quality-badge q-unreviewed';
    newBadge.textContent = reviewStateLabel(review.state);
    dataRow.querySelector('.tag')?.insertAdjacentElement('afterend', newBadge);
  }
}

// ── Inline review panel ───────────────────────────────────────
window.toggleReview = function(btn) {
  const recordId = btn.dataset.id;
  const existing = document.querySelector('.review-row');
  if (existing && openReviewId === recordId) { existing.remove(); openReviewId = null; return; }
  existing?.remove();
  openReviewId = recordId;
  const row = btn.closest('tr');
  const review = reviewCache[recordId] || {};

  const panelRow = document.createElement('tr');
  panelRow.className = 'review-row';
  panelRow.innerHTML = `
    <td colspan="8">
      <div style="font-size:13px;font-weight:600;color:var(--text2);margin-bottom:10px;">
        ${esc(t('search.review.heading', 'Review'))} — <span style="font-family:var(--font-mono);font-weight:400;">${esc(recordId)}</span>
      </div>
      <div class="review-panel">
        <div>
          <label style="font-size:11px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;display:block;">${esc(t('search.review.correctionLabel', 'Correction (optional)'))}</label>
          <textarea id="rv-correction" rows="3" placeholder="${esc(t('search.review.correctionPlaceholder', 'Corrected Lak text or translation…'))}">${esc(review.correction || '')}</textarea>
        </div>
        <div>
          <label style="font-size:11px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;display:block;">${esc(t('search.review.noteLabel', 'Note (optional)'))}</label>
          <textarea id="rv-note" rows="3" placeholder="${esc(t('search.review.notePlaceholder', 'Describe the issue or your finding…'))}">${esc(review.note || '')}</textarea>
        </div>
      </div>
      <div>
        <label style="font-size:11px;color:var(--text3);font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;display:block;margin-top:8px;">${esc(window.REVIEWER ? t('search.review.reviewingAs', 'Reviewing as') : t('search.review.yourNameOptional', 'Your name (optional)'))}</label>
        ${window.REVIEWER
          ? `<input type="text" id="rv-name" value="${esc(window.REVIEWER)}" readonly style="width:260px;background:var(--bg2,#f4f4f4);" title="${esc(t('search.review.attributedTooltip', 'Attributed to your reviewer login'))}"> <span class="quality-badge q-approved" style="font-size:10.5px;">${esc(t('search.review.loggedIn', '✓ logged in'))}</span>`
          : `<input type="text" id="rv-name" placeholder="${esc(t('search.review.namePlaceholder', 'Reviewer name or anonymous'))}" value="${esc(review.reviewer_name || '')}" style="width:260px;">`}
      </div>
      <div class="review-actions">
        ${window.REVIEWER
          ? `<button class="btn btn-ok" onclick="submitReview('${esc(recordId)}','approved')">${esc(t('search.review.approve', '✓ Approve'))}</button>`
          : `<span class="review-login-hint">${t('search.review.loginHint', 'You can flag problems or leave suggestions. <a href="/login.html">Log in as a reviewer</a> to approve records.')}</span>`}
        <button class="btn btn-warn" onclick="submitReview('${esc(recordId)}','flagged')">${esc(t('search.review.flag', '⚑ Flag'))}</button>
        <button class="btn" onclick="submitReview('${esc(recordId)}','unreviewed')">${esc(t('search.review.markUnreviewed', '↺ Mark unreviewed'))}</button>
        <button class="btn" onclick="document.querySelector('.review-row')?.remove();openReviewId=null;">${esc(t('search.review.cancel', 'Cancel'))}</button>
        ${review.state ? `<span style="font-size:12px;color:var(--text3);">${esc(t('search.review.current', 'Current:'))} <b>${esc(reviewStateLabel(review.state))}</b> · ${new Date(review.updated_at).toLocaleDateString(localeTag())}</span>` : ''}
      </div>
    </td>`;
  row.insertAdjacentElement('afterend', panelRow);
};

window.submitReview = async function(recordId, state) {
  const correction    = document.getElementById('rv-correction')?.value.trim() || null;
  const note          = document.getElementById('rv-note')?.value.trim() || null;
  const reviewer_name = document.getElementById('rv-name')?.value.trim() || null;
  try {
    const res = await fetch('/api/reviews', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_id: recordId, state, correction, note, reviewer_name }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      throw new Error(errBody.error || t('search.review.serverError', `Server error (${res.status})`, { status: res.status }));
    }
    const data = await res.json();
    reviewCache[recordId] = data.review;
    document.querySelector('.review-row')?.remove();
    openReviewId = null;

    // Update badge in visible row
    const dataRow = document.querySelector(`tr[data-record="${CSS.escape(recordId)}"]`);
    if (dataRow) {
      dataRow.querySelectorAll('.quality-badge').forEach(b => b.remove());
      const nb = document.createElement('span');
      nb.className = state === 'approved' ? 'quality-badge q-approved'
                   : state === 'flagged'  ? 'quality-badge q-flagged' : 'quality-badge q-unreviewed';
      nb.textContent = reviewStateLabel(state);
      dataRow.querySelector('.tag')?.insertAdjacentElement('afterend', nb);
    }
    toast(t('search.review.saved', `Review saved: ${reviewStateLabel(state)}`, { state: reviewStateLabel(state) }), 'ok');
  } catch (err) {
    toast(err.message || t('search.review.saveFailed', 'Failed to save review. Please try again.'), 'err');
  }
};

// ── Pagination ────────────────────────────────────────────────
function prevPage() { if (currentPage > 1) { search(currentPage - 1); scrollTo(0, 0); } }
function nextPage() { if (currentPage < currentPages) { search(currentPage + 1); scrollTo(0, 0); } }
$prev.onclick = $prev2.onclick = prevPage;
$next.onclick = $next2.onclick = nextPage;

// ── Search wiring ─────────────────────────────────────────────
[$kind, $source, $variety].forEach(el => el.addEventListener('change', () => search(1)));

// ── Re-render on language change ──────────────────────────────
function relocalize() {
  renderStats();
    if (hasSearchIntent) {
    renderConceptCard(currentQuery, currentExpanded, currentSenses, currentOcrSenses);
    renderCollections(currentQuery, currentCollections);
    renderResults(currentRows, currentMatches, currentExplain);
    renderPagination();
    const ids = currentRows.map(r => r[5]).filter(Boolean);
    if (ids.length) updateBadges(currentRows, reviewCache);
  }
}
(function () {
  if (window.I18n && typeof window.I18n.onChange === 'function') window.I18n.onChange(relocalize);
  else window.addEventListener('i18n:change', relocalize);
})();

// ── Init ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  document.querySelectorAll('.results-only').forEach(el => el.hidden = true);
  const form = document.getElementById('search-form');
  form?.addEventListener('submit', e => { e.preventDefault(); search(1); });
  document.getElementById('browse-all')?.addEventListener('click', () => { $q.value = ''; search(1); });
});
