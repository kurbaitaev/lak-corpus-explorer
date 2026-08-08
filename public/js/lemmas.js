/* Public lemma dictionary backed only by cleared PCMLBE source annotations. */
(function () {
  'use strict';

  var I18n = window.I18n;
  function t(key, fallback, vars) {
    var value = I18n && I18n.t ? I18n.t(key, vars) : null;
    if (!value || value === key) value = fallback;
    return String(value).replace(/\{(\w+)\}/g, function (match, name) {
      return vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
    });
  }
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (character) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character];
    });
  }
  function number(value) {
    return Number(value || 0).toLocaleString(I18n && I18n.getLanguage ? I18n.getLanguage() : 'en');
  }
  function highlight(text, form) {
    var source = String(text || '');
    var wanted = String(form || '');
    if (!wanted) return esc(source);
    var at = source.toLocaleLowerCase().indexOf(wanted.toLocaleLowerCase());
    if (at < 0) return esc(source);
    return esc(source.slice(0, at)) + '<mark>' + esc(source.slice(at, at + wanted.length)) + '</mark>' + esc(source.slice(at + wanted.length));
  }

  var state = { page: 1, payload: null, detail: null, detailPage: 1, controller: null, sequence: 0 };

  function loading(host) {
    host.setAttribute('aria-busy', 'true');
    host.innerHTML = '<div class="obs-grid" aria-label="' + esc(t('lemmas.loading', 'Loading lemmas')) + '">' +
      '<div class="obs-skeleton"></div><div class="obs-skeleton"></div><div class="obs-skeleton"></div></div>';
  }

  function card(row) {
    var definitions = (row.definitions || []).filter(Boolean).slice(0, 2);
    var parts = (row.parts_of_speech || []).filter(Boolean).slice(0, 3);
    return '<a class="lemma-dictionary-card" href="/lemmas.html?id=' + encodeURIComponent(row.lemma_id) + '">' +
      '<span class="lemma-index-form" lang="lbe">' + esc(row.lemma) + '</span>' +
      (definitions.length ? '<span class="lemma-index-definition">' + esc(definitions.join('; ')) + '</span>' : '') +
      (parts.length ? '<span class="lemma-index-pos">' + parts.map(esc).join(' · ') + '</span>' : '') +
      '<span class="lemma-index-counts">' + esc(t('lemmas.forms', '{count} forms', { count: number(row.attested_forms) })) +
      ' · ' + esc(t('lemmas.occurrences', '{count} occurrences', { count: number(row.annotated_occurrences) })) + '</span>' +
      '<span class="lemma-open">' + esc(t('lemmas.open', 'Open lemma')) + '</span></a>';
  }

  function renderBrowse(payload) {
    state.payload = payload;
    var grid = document.getElementById('lemma-grid');
    grid.setAttribute('aria-busy', 'false');
    document.getElementById('lemma-total').textContent = t('lemmas.total', '{count} annotated lemmas', { count: number(payload.total) });
    grid.innerHTML = payload.rows.length ? payload.rows.map(card).join('') :
      '<div class="obs-empty lemma-empty"><h2>' + esc(t('lemmas.empty.title', 'No lemmas match')) + '</h2><p>' +
      esc(t('lemmas.empty.body', 'Try a shorter beginning or another spelling.')) + '</p></div>';
    var pager = document.getElementById('lemma-pager');
    if (payload.pages > 1) {
      pager.hidden = false;
      pager.innerHTML = '<button type="button" class="lib-page-btn" data-page="' + (payload.page - 1) + '"' + (payload.page <= 1 ? ' disabled' : '') + '>' +
        esc(t('lemmas.previous', 'Previous')) + '</button><span class="lib-page-status">' +
        esc(t('lemmas.page', 'Page {page} of {pages}', { page: number(payload.page), pages: number(payload.pages) })) +
        '</span><button type="button" class="lib-page-btn" data-page="' + (payload.page + 1) + '"' +
        (payload.page >= payload.pages ? ' disabled' : '') + '>' + esc(t('lemmas.next', 'Next')) + '</button>';
    } else {
      pager.hidden = true;
    }
  }

  function loadBrowse() {
    var sequence = ++state.sequence;
    if (state.controller) state.controller.abort();
    state.controller = new AbortController();
    var query = document.getElementById('lemma-search').value.trim();
    var params = new URLSearchParams({ page: String(state.page), limit: '48' });
    if (query) params.set('q', query);
    loading(document.getElementById('lemma-grid'));
    fetch('/api/corpus/v2/lemmas?' + params.toString(), { cache: 'no-store', signal: state.controller.signal })
      .then(function (response) { if (!response.ok) throw new Error('failed'); return response.json(); })
      .then(function (payload) { if (sequence === state.sequence) renderBrowse(payload); })
      .catch(function (error) {
        if (error && error.name === 'AbortError') return;
        if (sequence !== state.sequence) return;
        document.getElementById('lemma-grid').innerHTML = '<div class="obs-error"><h2>' +
          esc(t('lemmas.error.title', 'Lemma data could not be loaded')) + '</h2><p>' +
          esc(t('lemmas.error.body', 'Reload the page and try again.')) + '</p></div>';
      });
  }

  function occurrenceCard(row) {
    var meta = [row.document_title, row.year, row.source_title].filter(Boolean).join(' · ');
    return '<article class="lemma-occurrence-card"><p class="lemma-occurrence-context" lang="lbe">' +
      highlight(row.context, row.surface) + '</p><div class="morph-details">' +
      (row.raw_tag ? '<span>' + esc(row.raw_tag) + '</span>' : '') +
      (row.definition ? '<span>' + esc(row.definition) + '</span>' : '') + '</div>' +
      (meta ? '<p class="record-meta">' + esc(meta) + '</p>' : '') +
      '<a class="lemma-occurrence-open" href="/occurrence.html?id=' + encodeURIComponent(row.segment_id) + '&amp;token=' + encodeURIComponent(row.token_id) + '">' +
      esc(t('lemmas.openOccurrence', 'Open full occurrence')) + '</a></article>';
  }

  function renderDetail(payload) {
    state.detail = payload;
    var lemma = payload.lemma;
    var host = document.getElementById('lemma-detail');
    var definitions = (lemma.definitions || []).filter(Boolean);
    var tags = (lemma.source_tags || []).filter(Boolean);
    var parts = (lemma.parts_of_speech || []).filter(Boolean);
    var forms = (payload.forms || []).map(function (form) {
      return '<a class="lemma-form-chip" href="/?mode=wordform&amp;q=' + encodeURIComponent(form.display_form) + '"><span lang="lbe">' +
        esc(form.display_form) + '</span><small>' + esc(number(form.occurrences)) + '</small></a>';
    }).join('');
    host.innerHTML = '<a class="lib-back" href="/lemmas.html">' + esc(t('lemmas.back', 'Back to all lemmas')) + '</a>' +
      '<header class="lemma-detail-head"><div><span class="quality-badge q-approved">' +
      esc(t('lemmas.sourceEvidence', 'PCMLBE source annotation')) + '</span><h2 lang="lbe">' + esc(lemma.display_form) + '</h2>' +
      '<p>' + esc(t('lemmas.forms', '{count} forms', { count: number(lemma.attested_forms) })) + ' · ' +
      esc(t('lemmas.occurrences', '{count} occurrences', { count: number(lemma.annotated_occurrences) })) + '</p></div></header>' +
      (definitions.length ? '<section class="lemma-detail-section"><h3>' + esc(t('lemmas.definitions', 'Source definitions')) +
        '</h3><ul class="lemma-definition-list">' + definitions.map(function (value) { return '<li>' + esc(value) + '</li>'; }).join('') + '</ul></section>' : '') +
      ((parts.length || tags.length) ? '<section class="lemma-detail-section"><h3>' + esc(t('lemmas.tags', 'Source tags')) +
        '</h3><div class="lemma-tag-list">' + parts.concat(tags).filter(function (value, index, all) { return all.indexOf(value) === index; })
          .map(function (value) { return '<span class="obs-tag">' + esc(value) + '</span>'; }).join('') + '</div></section>' : '') +
      '<section class="lemma-detail-section"><h3>' + esc(t('lemmas.attestedForms', 'Attested forms')) +
      '</h3><div class="lemma-form-list">' + forms + '</div></section>' +
      '<section class="lemma-detail-section"><h3>' + esc(t('lemmas.sentenceOccurrences', 'Sentence occurrences')) +
      '</h3><div class="lemma-occurrence-list">' + payload.occurrences.map(occurrenceCard).join('') + '</div>' +
      (payload.pages > 1 ? '<nav class="lib-pager lemma-detail-pager"><button type="button" class="lib-page-btn" data-detail-page="' + (payload.page - 1) + '"' +
        (payload.page <= 1 ? ' disabled' : '') + '>' + esc(t('lemmas.previous', 'Previous')) + '</button><span class="lib-page-status">' +
        esc(t('lemmas.page', 'Page {page} of {pages}', { page: number(payload.page), pages: number(payload.pages) })) +
        '</span><button type="button" class="lib-page-btn" data-detail-page="' + (payload.page + 1) + '"' +
        (payload.page >= payload.pages ? ' disabled' : '') + '>' + esc(t('lemmas.next', 'Next')) + '</button></nav>' : '') + '</section>';
    host.hidden = false;
    document.getElementById('lemma-browse').hidden = true;
  }

  function loadDetail(id, page) {
    var host = document.getElementById('lemma-detail');
    host.hidden = false;
    loading(host);
    fetch('/api/corpus/v2/lemmas/' + encodeURIComponent(id) + '?page=' + encodeURIComponent(page || 1) + '&limit=25', { cache: 'no-store' })
      .then(function (response) { if (!response.ok) throw new Error('failed'); return response.json(); })
      .then(renderDetail)
      .catch(function () {
        host.innerHTML = '<a class="lib-back" href="/lemmas.html">' + esc(t('lemmas.back', 'Back to all lemmas')) + '</a>' +
          '<div class="obs-error"><h2>' + esc(t('lemmas.error.title', 'Lemma data could not be loaded')) + '</h2><p>' +
          esc(t('lemmas.error.body', 'Reload the page and try again.')) + '</p></div>';
      });
  }

  function boot() {
    var id = new URLSearchParams(window.location.search).get('id');
    if (id) {
      loadDetail(id, 1);
      document.getElementById('lemma-detail').addEventListener('click', function (event) {
        var button = event.target.closest('[data-detail-page]');
        if (!button || button.disabled) return;
        state.detailPage = Number(button.dataset.detailPage);
        loadDetail(id, state.detailPage);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      return;
    }
    var debounce = null;
    document.getElementById('lemma-search').addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () { state.page = 1; loadBrowse(); }, 180);
    });
    document.getElementById('lemma-pager').addEventListener('click', function (event) {
      var button = event.target.closest('[data-page]');
      if (!button || button.disabled) return;
      state.page = Number(button.dataset.page);
      loadBrowse();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    loadBrowse();
  }

  if (I18n && I18n.onChange) I18n.onChange(function () {
    if (state.detail) renderDetail(state.detail);
    else if (state.payload) renderBrowse(state.payload);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
