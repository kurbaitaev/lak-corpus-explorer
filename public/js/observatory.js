(function () {
  'use strict';
  const state = { resources: [], view: 'all', query: '', category: '', status: '', priority: '' };
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? '—' : value).replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const list = (value) => Array.isArray(value) ? value : (value && typeof value === 'object' ? Object.keys(value) : []);
  const countBy = (key, value) => state.resources.filter((r) => r[key] === value).length;

  function stat(label, value) { return '<div class="obs-stat"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>'; }
  function fillSelect(id, values) {
    const select = $(id);
    values.forEach((value) => { const option = document.createElement('option'); option.value = value; option.textContent = value; select.appendChild(option); });
  }
  function isHttp(url) { return /^https?:\/\//i.test(String(url || '')); }
  function card(r, index) {
    const link = isHttp(r.public_url || r.url)
      ? '<a href="' + esc(r.public_url || r.url) + '" target="_blank" rel="noopener noreferrer">Open public source</a>'
      : '<span class="obs-local">Local provenance · not a public link</span>';
    const sensitive = r.permission_sensitive ? '<span class="obs-tag rights">Permission-sensitive</span>' : '';
    return '<article class="obs-card" style="animation-delay:' + Math.min(index * 24, 240) + 'ms">' +
      '<div class="obs-card-head"><div><h2>' + esc(r.title) + '</h2><div class="obs-id">' + esc(r.id) + '</div></div><span class="obs-priority ' + esc(String(r.priority || '').toLowerCase()) + '">' + esc(r.priority) + '</span></div>' +
      '<div class="obs-byline">' + esc(r.creator) + ' · ' + esc(r.year) + '</div>' +
      '<div class="obs-tags"><span class="obs-tag">' + esc(r.category) + '</span><span class="obs-tag status">' + esc(r.status) + '</span><span class="obs-tag">' + esc(r.access) + '</span>' + sensitive + '</div>' +
      '<dl class="obs-facts"><div class="obs-fact"><dt>Language</dt><dd>' + esc(r.language) + '</dd></div><div class="obs-fact"><dt>Rights boundary</dt><dd>' + esc(r.rights) + '</dd></div><div class="obs-fact"><dt>Scale</dt><dd>' + esc(r.scale) + '</dd></div><div class="obs-fact"><dt>Evidence group</dt><dd>' + esc(r.evidence_group) + '</dd></div><div class="obs-fact"><dt>Research value</dt><dd>' + esc(r.value) + ' / 5</dd></div><div class="obs-fact"><dt>Record access</dt><dd>' + esc(r.access) + '</dd></div></dl>' +
      '<div class="obs-action"><strong>Next concrete action</strong>' + esc(r.action) + '</div>' +
      (r.notes ? '<p class="obs-notes"><strong>Notes:</strong> ' + esc(r.notes) + '</p>' : '') +
      '<div class="obs-source">' + link + '<span>' + esc(r.url && !isHttp(r.public_url || r.url) ? 'Evidence held locally' : '') + '</span></div></article>';
  }
  function matches(r) {
    const hay = Object.values(r).join(' ').toLowerCase();
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
    $('obs-results').textContent = results.length + ' of ' + state.resources.length + ' resources';
    const content = $('obs-content');
    content.setAttribute('aria-busy', 'false');
    content.innerHTML = results.length ? '<div class="obs-grid">' + results.map(card).join('') + '</div>' :
      '<div class="obs-empty"><h2>No resources match these filters</h2><p>Try a broader search or clear one of the filters.</p></div>';
  }
  function setup(data) {
    state.resources = Array.isArray(data.resources) ? data.resources : [];
    const counts = data.counts || {};
    $('obs-stats').innerHTML = stat('Registry records', counts.total) +
      stat('P0 priorities', counts.p0) +
      stat('Held or processed', counts.held_or_processed) +
      stat('Permission-sensitive', counts.permission_sensitive);
    fillSelect('category-filter', list(data.options && data.options.categories));
    fillSelect('status-filter', list(data.options && data.options.statuses));
    render();
  }
  function showError() {
    $('obs-content').setAttribute('aria-busy', 'false');
    $('obs-content').innerHTML = '<div class="obs-error"><h2>The register is temporarily unavailable</h2><p>We could not load the resource register. Please try again.</p><button class="btn btn-primary" id="obs-retry" type="button">Try again</button></div>';
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
  load();
}());