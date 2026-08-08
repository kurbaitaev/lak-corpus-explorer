/* One addressable public corpus occurrence with source annotation evidence. */
(function () {
  'use strict';

  var I18n = window.I18n;
  function t(key, fallback) {
    var value = I18n && I18n.t ? I18n.t(key) : null;
    return value && value !== key ? value : fallback;
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }
  function sourceLink(segment) {
    var url = segment.persistent_id || segment.canonical_url;
    return url ? '<a href="' + esc(url) + '" target="_blank" rel="noreferrer">' + esc(segment.source_title) + '</a>' : esc(segment.source_title);
  }
  function highlightedSentence(text, surface) {
    var source = String(text || '');
    var wanted = String(surface || '');
    if (!wanted) return esc(source);
    var lower = source.toLocaleLowerCase();
    var needle = wanted.toLocaleLowerCase();
    var out = '';
    var from = 0;
    var at;
    while ((at = lower.indexOf(needle, from)) >= 0) {
      out += esc(source.slice(from, at)) + '<mark>' + esc(source.slice(at, at + wanted.length)) + '</mark>';
      from = at + wanted.length;
    }
    return out + esc(source.slice(from));
  }
  function groupTokens(rows) {
    var groups = [];
    var byId = Object.create(null);
    rows.forEach(function (row) {
      if (!byId[row.token_id]) {
        byId[row.token_id] = { token_id: row.token_id, ordinal: row.ordinal, surface: row.surface, analyses: [] };
        groups.push(byId[row.token_id]);
      }
      if (row.analysis_id) byId[row.token_id].analyses.push(row);
    });
    return groups.sort(function (a, b) { return a.ordinal - b.ordinal; });
  }

  var currentPayload = null;
  function render(payload) {
    currentPayload = payload;
    var segment = payload.segment;
    var wantedToken = new URLSearchParams(window.location.search).get('token');
    var tokens = groupTokens(payload.tokens || []);
    var selected = tokens.find(function (token) { return token.token_id === wantedToken; }) || null;
    var tokenRows = tokens.map(function (token) {
      var analysis = token.analyses[0] || null;
      var lemma = analysis && analysis.lemma_id
        ? '<a href="/lemmas.html?id=' + encodeURIComponent(analysis.lemma_id) + '" lang="lbe">' + esc(analysis.lemma) + '</a>'
        : '<span class="occ-no-analysis">' + esc(t('occ.noAnalysis', 'No source analysis')) + '</span>';
      return '<tr' + (token.token_id === wantedToken ? ' class="occ-selected-token"' : '') + '>' +
        '<td data-label="' + esc(t('occ.form', 'Form')) + '" lang="lbe"><a href="/?mode=wordform&amp;q=' + encodeURIComponent(token.surface) + '">' + esc(token.surface) + '</a></td>' +
        '<td data-label="' + esc(t('occ.lemma', 'Lemma')) + '">' + lemma + '</td><td data-label="' + esc(t('occ.tag', 'Source tag')) + '">' + esc(analysis ? analysis.raw_tag : '') + '</td>' +
        '<td data-label="' + esc(t('occ.definition', 'Definition')) + '">' + esc(analysis ? analysis.definition || '' : '') + '</td></tr>';
    }).join('');
    var meta = [segment.document_title, segment.author, segment.year].filter(function (value) {
      return value && String(value).toLocaleLowerCase() !== 'unknown';
    }).join(' · ');
    var license = segment.license_url
      ? '<a href="' + esc(segment.license_url) + '" target="_blank" rel="noreferrer">' + esc(segment.license || '') + '</a>'
      : esc(segment.license || '');
    var host = document.getElementById('occurrence-content');
    host.setAttribute('aria-busy', 'false');
    host.innerHTML = '<a class="lib-back" href="javascript:history.back()">' + esc(t('occ.back', 'Back to search')) + '</a>' +
      '<section class="occurrence-card"><div class="occurrence-card-head"><span class="quality-badge q-approved">' +
      esc(t('lemmas.sourceEvidence', 'PCMLBE source annotation')) + '</span></div><h2>' + esc(t('occ.sentence', 'Attested sentence')) + '</h2>' +
      '<blockquote class="occurrence-sentence" lang="lbe">' + highlightedSentence(segment.text_original, selected && selected.surface) + '</blockquote>' +
      (segment.translation_en ? '<p class="occurrence-translation">' + esc(segment.translation_en) + '</p>' : '') + '</section>' +
      '<section class="occurrence-card"><h2>' + esc(t('occ.analysis', 'Token analysis')) + '</h2>' +
      '<div class="occurrence-table-wrap"><table class="occurrence-table"><thead><tr><th>' + esc(t('occ.form', 'Form')) +
      '</th><th>' + esc(t('occ.lemma', 'Lemma')) + '</th><th>' + esc(t('occ.tag', 'Source tag')) +
      '</th><th>' + esc(t('occ.definition', 'Definition')) + '</th></tr></thead><tbody>' + tokenRows + '</tbody></table></div>' +
      '<p class="occ-evidence-note">' + esc(t('occ.evidenceNote', 'Analyses shown here come from the source annotation. They are preserved separately from machine proposals and expert decisions.')) + '</p></section>' +
      '<section class="occurrence-card"><h2>' + esc(t('occ.source', 'Source citation')) + '</h2><dl class="occ-source-grid">' +
      '<div><dt>' + esc(t('occ.source', 'Source citation')) + '</dt><dd>' + sourceLink(segment) + '</dd></div>' +
      (meta ? '<div><dt>' + esc(t('search.results.sourceDocument', 'Source document')) + '</dt><dd>' + esc(meta) + '</dd></div>' : '') +
      '<div><dt>' + esc(t('occ.record', 'Corpus record')) + '</dt><dd><code>' + esc(segment.legacy_record_id || segment.id) + '</code></dd></div>' +
      (license ? '<div><dt>' + esc(t('occ.license', 'License')) + '</dt><dd>' + license + '</dd></div>' : '') + '</dl></section>';
  }

  function fail() {
    var host = document.getElementById('occurrence-content');
    host.setAttribute('aria-busy', 'false');
    host.innerHTML = '<a class="lib-back" href="/">' + esc(t('occ.back', 'Back to search')) + '</a>' +
      '<div class="obs-error"><h2>' + esc(t('occ.error.title', 'Occurrence not found')) + '</h2><p>' +
      esc(t('occ.error.body', 'The record may be unavailable or the structured corpus may still be preparing.')) + '</p></div>';
  }

  function boot() {
    var id = new URLSearchParams(window.location.search).get('id');
    if (!id) return fail();
    fetch('/api/corpus/v2/segments/' + encodeURIComponent(id), { cache: 'no-store' })
      .then(function (response) { if (!response.ok) throw new Error('failed'); return response.json(); })
      .then(render).catch(fail);
  }

  if (I18n && I18n.onChange) I18n.onChange(function () { if (currentPayload) render(currentPayload); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
