(function () {
  'use strict';
  const state = { resources: [], counts: {}, options: {}, view: 'all', query: '', category: '', status: '', priority: '' };
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? '—' : value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const list = (value) => Array.isArray(value) ? value : (value && typeof value === 'object' ? Object.keys(value) : []);
  const countBy = (key, value) => state.resources.filter((r) => r[key] === value).length;

  // ── Localization helper (canonical dictionary in i18n.js) ──
  function t(key, def, vars) {
    const I = window.I18n;
    if (I && typeof I.t === 'function') {
      const out = I.t(key, vars);
      if (out != null && out !== key) return out;
    }
    return def;
  }
  // Curated display labels for facet values. The stored/select value is kept
  // exact; only the visible text is localized when a dictionary key exists,
  // otherwise the original value is shown unchanged.
  function slug(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
  function labelFor(kind, value) {
    if (value == null || value === '') return t('obs.value.none', '—');
    // ISO/language descriptors and P0/P1/P2 are intentionally language-neutral
    // bibliographic/canonical values, so do not treat them as missing UI keys.
    if (kind === 'language' || kind === 'priority') return String(value);
    return t('obs.' + kind + '.' + slug(value), String(value));
  }
  // Per-resource curated field lookup: try obs.resource.<sanitized-id>.<field>,
  // then fall back to the stored English value shipped in the API payload.
  function fieldFor(r, field) {
    const raw = r && r[field];
    if (raw == null || raw === '') return field === 'notes' ? '' : t('obs.value.none', '—');
    return t('obs.resource.' + slug(r.id) + '.' + field, String(raw));
  }

  function stat(label, value) { return '<div class="obs-stat"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>'; }
  function fillSelect(id, values, kind) {
    const select = $(id);
    values.forEach((value) => { const option = document.createElement('option'); option.value = value; option.textContent = labelFor(kind, value); select.appendChild(option); });
  }
  function isHttp(url) { return /^https?:\/\//i.test(String(url || '')); }
  function card(r, index) {
    const link = isHttp(r.public_url || r.url)
      ? '<a class="obs-source-button" href="' + esc(r.public_url || r.url) + '" target="_blank" rel="noopener noreferrer">' + esc(t('obs.openPublicSource', 'Open public source')) + ' <span class="obs-external-indicator" aria-hidden="true">↗</span><span class="sr-only"> ' + esc(t('obs.opensNewTab', '(opens in a new tab)')) + '</span></a>'
      : '<span class="obs-local">' + esc(t('obs.localProvenance', 'Local provenance — not publicly accessible')) + '</span>';
    const sensitive = r.permission_sensitive ? '<span class="obs-tag rights">' + esc(t('obs.permissionSensitive', 'Permission-sensitive')) + '</span>' : '';
    return '<article class="obs-card" style="animation-delay:' + Math.min(index * 24, 240) + 'ms">' +
      '<div class="obs-card-head"><div><h2>' + esc(r.title) + '</h2><div class="obs-byline">' + esc(r.creator) + (r.year ? ' · ' + esc(r.year) : '') + '</div></div><span class="obs-priority ' + esc(String(r.priority || '').toLowerCase()) + '">' + esc(labelFor('priority', r.priority)) + '</span></div>' +
      '<div class="obs-tags"><span class="obs-tag">' + esc(labelFor('category', r.category)) + '</span><span class="obs-tag status">' + esc(labelFor('status', r.status)) + '</span>' + sensitive + '</div>' +
      '<dl class="obs-facts"><div class="obs-fact"><dt>' + esc(t('obs.fact.language', 'Language')) + '</dt><dd>' + esc(labelFor('language', r.language)) + '</dd></div><div class="obs-fact"><dt>' + esc(t('obs.fact.rightsBoundary', 'Rights boundary')) + '</dt><dd>' + esc(labelFor('rights', r.rights)) + '</dd></div><div class="obs-fact"><dt>' + esc(t('obs.fact.scale', 'Scale')) + '</dt><dd>' + esc(fieldFor(r, 'scale')) + '</dd></div></dl>' +
      '<div class="obs-action"><strong>' + esc(t('obs.nextAction', 'Next concrete action')) + '</strong>' + esc(fieldFor(r, 'action')) + '</div>' +
      (r.notes ? '<p class="obs-notes"><strong>' + esc(t('obs.notes', 'Notes:')) + '</strong> ' + esc(fieldFor(r, 'notes')) + '</p>' : '') +
      '<div class="obs-source">' + link + '</div></article>';
  }
  function matches(r) {
    // Raw canonical values (English, IDs, URLs) always searchable; localized
    // display strings are appended so a Russian query matches what is shown.
    const localized = [
      labelFor('category', r.category), labelFor('status', r.status),
      labelFor('priority', r.priority), labelFor('language', r.language),
      labelFor('rights', r.rights), fieldFor(r, 'scale'),
      fieldFor(r, 'action'), r.notes ? fieldFor(r, 'notes') : ''
    ].join(' ');
    const hay = (Object.values(r).join(' ') + ' ' + localized).toLowerCase();
    if (state.query && !hay.includes(state.query.toLowerCase())) return false;
    if (state.category && r.category !== state.category) return false;
    if (state.status && r.status !== state.status) return false;
    if (state.priority && r.priority !== state.priority) return false;
    if (state.view === 'acquisition' && !['Catalog only', 'Verified lead', 'Discovery portal', 'Gap confirmed', 'Needs verification'].includes(r.status)) return false;
    if (state.view === 'contact' &&
        !(r.permission_sensitive || ['Contact lead', 'Institutional lead', 'Local lead'].includes(r.status))) return false;
    return true;
  }
  function render() {
    const results = state.resources.filter(matches);
    $('obs-results').textContent = t('obs.resultsCount',
      results.length + ' of ' + state.resources.length + ' resources',
      { shown: results.length, total: state.resources.length });
    const content = $('obs-content');
    content.setAttribute('aria-busy', 'false');
    content.innerHTML = results.length ? '<div class="obs-grid">' + results.map(card).join('') + '</div>' :
      '<div class="obs-empty"><h2>' + esc(t('obs.empty.title', 'No resources match these filters')) + '</h2><p>' + esc(t('obs.empty.body', 'Try a broader search or clear one of the filters.')) + '</p></div>';
  }
  function renderStats() {
    const counts = state.counts || {};
    $('obs-stats').innerHTML = stat(t('obs.stat.registryRecords', 'Registry records'), counts.total) +
      stat(t('obs.stat.p0Priorities', 'P0 priorities'), counts.p0) +
      stat(t('obs.stat.heldOrProcessed', 'Held or processed'), counts.held_or_processed) +
      stat(t('obs.stat.permissionSensitive', 'Permission-sensitive'), counts.permission_sensitive);
  }
  function setup(data) {
    state.resources = Array.isArray(data.resources) ? data.resources : [];
    state.counts = data.counts || {};
    state.options = data.options || {};
    renderStats();
    fillSelect('category-filter', list(data.options && data.options.categories), 'category');
    fillSelect('status-filter', list(data.options && data.options.statuses), 'status');
    render();
  }
  // ── Private research layer (audited v1.2 sources) ──────────
  // Counts and states only. Candidate content is never fetched here: it is
  // served exclusively to authorized reviewers by the source-import API.
  function privateCard(source, index) {
    const status = String(source.status || 'awaiting_manifest');
    const verified = status === 'verified';
    const staged = source.imported_record_count || 0;
    const audio = source.layer === 'audio_inventory'
      ? (source.metrics && source.metrics.file_count != null ? source.metrics : source.expected_metrics)
      : null;
    const badges = [
      t('obs.private.badge.privateResearch', 'Private research'),
      t('obs.private.badge.permissionPending', 'Permission pending'),
      t('obs.private.badge.unreviewed', 'Import unreviewed'),
      t('obs.private.badge.notTrainingReady', 'Not training-ready'),
      t('obs.private.badge.excludedFromSearch', 'Excluded from search and exports'),
    ];
    if (source.layer === 'audio_inventory') {
      badges.push(t('obs.private.badge.consentUnknown', 'Consent unknown'));
      badges.push(t('obs.private.badge.noBinaries', 'No binaries served'));
    }
    const facts =
      '<div class="obs-fact"><dt>' + esc(t('obs.private.fact.expected', 'Expected from audit')) + '</dt><dd>' + esc(source.expected_record_count) + '</dd></div>' +
      '<div class="obs-fact"><dt>' + esc(t('obs.private.fact.staged', 'Staged privately')) + '</dt><dd>' + esc(staged) + '</dd></div>' +
      '<div class="obs-fact"><dt>' + esc(t('obs.private.fact.reviewed', 'Human-reviewed')) + '</dt><dd>' + esc(source.reviewed_record_count || 0) + '</dd></div>' +
      (audio ? '<div class="obs-fact"><dt>' + esc(t('obs.private.fact.audio', 'Audio inventory')) + '</dt><dd>' +
        esc(t('obs.private.audioSummary', audio.file_count + ' WAV files · ' + audio.total_duration_seconds + ' seconds total · no file URLs published',
          { files: audio.file_count, seconds: audio.total_duration_seconds })) + '</dd></div>' : '');
    const blocked = verified ? '' :
      '<div class="obs-action"><strong>' + esc(t('obs.private.blockedLabel', 'Why nothing was imported')) + '</strong>' +
      esc(t('obs.private.blocked.' + (source.blocked_reason_code || 'verification_failed'),
        t('obs.private.notImported',
          'The verified processed package for this source is not present or did not pass its integrity checks, so the audited count is shown as an expectation and no candidate was ingested.'))) +
      '</div>';
    return '<article class="obs-card obs-private-card" style="animation-delay:' + Math.min(index * 24, 240) + 'ms">' +
      '<div class="obs-card-head"><div><h3>' +
      esc(t('obs.private.title.' + source.description_key, source.title)) + '</h3>' +
      '<div class="obs-byline">' + esc(t('obs.private.granularity.' + source.provenance_granularity, source.provenance_granularity)) + '</div></div>' +
      '<span class="obs-private-status ' + (verified ? 'ok' : 'pending') + '">' +
      esc(t('obs.private.status.' + status, status)) + '</span></div>' +
      '<div class="obs-tags"><span class="obs-tag">' + esc(t('obs.private.layer.' + source.layer, source.layer)) + '</span>' +
      badges.map((b) => '<span class="obs-tag rights">' + esc(b) + '</span>').join('') + '</div>' +
      '<dl class="obs-facts">' + facts + '</dl>' +
      '<p class="obs-notes">' + esc(t('obs.private.source.' + source.description_key, '')) + '</p>' +
      blocked + '</article>';
  }

  function renderPrivate(data) {
    state.privateLayer = data;
    const sources = Array.isArray(data.sources) ? data.sources : [];
    const counts = data.counts || {};
    const staged = sources.reduce((sum, s) => sum + (s.imported_record_count || 0), 0);
    const exposed = sources.reduce((sum, s) =>
      sum + (s.public_record_count || 0) + (s.training_ready_record_count || 0), 0);
    const corroboration = data.corroboration || null;
    $('obs-private-stats').innerHTML =
      stat(t('obs.private.stat.sources', 'Audited sources'), counts.sources_total || sources.length) +
      stat(t('obs.private.stat.expected', 'Expected records'), counts.expected_records || 0) +
      stat(t('obs.private.stat.staged', 'Staged privately'), staged) +
      stat(t('obs.private.stat.publicOrTraining', 'Public or training-ready'), exposed) +
      (corroboration ? stat(t('obs.private.stat.corroborated', 'Corroborating spellings'),
        corroboration.overlapping_forms || 0) : '');
    const content = $('obs-private-content');
    content.setAttribute('aria-busy', 'false');
    const corroborationNote = corroboration
      ? '<p class="obs-private-corroboration">' + esc(t('obs.private.corroboration',
        corroboration.overlapping_forms + ' spellings occur in both lexical sources; they are linked as corroboration and never merged.',
        { forms: corroboration.overlapping_forms, pairs: corroboration.candidate_pairs })) + '</p>'
      : '';
    content.innerHTML = corroborationNote +
      '<div class="obs-grid">' + sources.map(privateCard).join('') + '</div>';
  }

  function showPrivateError() {
    $('obs-private-content').setAttribute('aria-busy', 'false');
    $('obs-private-content').innerHTML = '<div class="obs-error"><h3>' +
      esc(t('obs.private.error.title', 'The private layer summary is unavailable')) + '</h3><p>' +
      esc(t('obs.private.error.body', 'We could not load the private research summary. The material itself remains private either way.')) + '</p></div>';
  }

  function loadPrivate() {
    fetch('/api/source-import/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((response) => { if (!response.ok) throw new Error('Fetch failed'); return response.json(); })
      .then(renderPrivate).catch(showPrivateError);
  }

  function showError() {
    $('obs-content').setAttribute('aria-busy', 'false');
    $('obs-content').innerHTML = '<div class="obs-error"><h2>' + esc(t('obs.error.title', 'The register is temporarily unavailable')) + '</h2><p>' + esc(t('obs.error.body', 'We could not load the resource register. Please try again.')) + '</p><button class="btn btn-primary" id="obs-retry" type="button">' + esc(t('obs.tryAgain', 'Try again')) + '</button></div>';
    $('obs-retry').addEventListener('click', load);
  }
  function load() {
    $('obs-content').setAttribute('aria-busy', 'true');
    fetch('/api/observatory/resources', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then((response) => { if (!response.ok) throw new Error('Fetch failed'); return response.json(); })
      .then(setup).catch(showError);
  }
  $('resource-search').addEventListener('input', (e) => { state.query = e.target.value.trim(); render(); });
  [['category-filter', 'category'], ['status-filter', 'status'], ['priority-filter', 'priority']].forEach(([id, key]) => $(id).addEventListener('change', (e) => { state[key] = e.target.value; render(); }));
  document.querySelectorAll('.obs-tab').forEach((tab) => tab.addEventListener('click', () => {
    state.view = tab.dataset.view;
    document.querySelectorAll('.obs-tab').forEach((item) => { const active = item === tab; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); });
    render();
  }));

  // ── Re-render on language change ────────────────────────────
  function relocalizeSelect(id, kind) {
    const select = $(id);
    if (!select) return;
    Array.from(select.options).forEach((opt) => {
      if (opt.value === '') return; // leave the "all" placeholder to its HTML text
      opt.textContent = labelFor(kind, opt.value);
    });
  }
  function relocalize() {
    if (state.resources.length || (state.counts && Object.keys(state.counts).length)) {
      renderStats();
      relocalizeSelect('category-filter', 'category');
      relocalizeSelect('status-filter', 'status');
      relocalizeSelect('priority-filter', 'priority');
      render();
    }
    if (state.privateLayer) renderPrivate(state.privateLayer);
  }
  if (window.I18n && typeof window.I18n.onChange === 'function') window.I18n.onChange(relocalize);
  else window.addEventListener('i18n:change', relocalize);

  load();
  loadPrivate();
}());
