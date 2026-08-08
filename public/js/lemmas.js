/* Source-backed synthesized Lak dictionary and corpus occurrence browser. */
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
  function shorten(value, limit) {
    var text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > (limit || 220) ? text.slice(0, (limit || 220) - 1).trim() + '…' : text;
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
      ' · ' + esc(t('lemmas.occurrences', '{count} occurrences', { count: number(row.annotated_occurrences) })) +
      (row.source_count ? ' · ' + esc(t('lemmas.sources','{count} sources',{count:number(row.source_count)})) : '') + '</span>' +
      '<span class="lemma-open">' + esc(t('lemmas.open', 'Open lemma')) + '</span></a>';
  }

  function dictionaryCard(row) {
    var lemmas = (row.lak_lemmas || []).filter(Boolean);
    var lemmaIds = row.lemma_ids || [];
    var title = lemmas.length ? lemmas.join(', ') : row.headword_original;
    var gloss = (row.glosses_ru || []).concat(row.glosses_en || []).filter(Boolean).slice(0, 3);
    var links = lemmas.map(function(lemma,index) { return '<a class="lemma-form-chip" href="/lemmas.html?id=' + encodeURIComponent(lemmaIds[index]) + '&amp;entry=' + encodeURIComponent(row.id) + '">' + esc(lemma) + '</a>'; }).join('');
    return '<article class="lemma-dictionary-card">' +
      '<span class="lemma-index-form" lang="lbe">' + esc(title) + '</span>' +
      '<span class="lemma-index-definition">' + esc(row.headword_original + (row.homonym_number ? ' ' + row.homonym_number : '')) + '</span>' +
      (gloss.length ? '<span class="lemma-index-pos">' + esc(shorten(gloss.join('; '), 220)) + '</span>' : '') +
      '<span class="lemma-index-counts">' + esc(row.source_title || '') + ' · ' + esc(t('lemmas.match', 'Matched {term}', { term: row.matched_term })) + '</span>' +
      '<span class="lemma-form-list">' + links + '</span></article>';
  }

  function renderBrowse(payload) {
    state.payload = payload;
    var grid = document.getElementById('lemma-grid');
    grid.setAttribute('aria-busy', 'false');
    document.getElementById('lemma-total').textContent = payload.mode === 'dictionary' ? t('lemmas.matches', '{count} dictionary entries', { count:number(payload.total) }) : t('lemmas.total', '{count} lemmas', { count: number(payload.total) });
    grid.innerHTML = payload.rows.length ? payload.rows.map(payload.mode === 'dictionary' ? dictionaryCard : card).join('') :
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
    var endpoint = query ? '/api/corpus/v2/dictionary?' : '/api/corpus/v2/lemmas?';
    fetch(endpoint + params.toString(), { cache: 'no-store', signal: state.controller.signal })
      .then(function (response) { if (!response.ok) throw new Error('failed'); return response.json(); })
      .then(function (payload) { if (sequence === state.sequence) { if (query) payload.mode='dictionary'; renderBrowse(payload); } })
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
    var entries = payload.source_entries || [];
    var forms = (payload.forms || []).map(function (form) {
      return '<a class="lemma-form-chip" href="/?mode=wordform&amp;q=' + encodeURIComponent(form.display_form) + '"><span lang="lbe">' +
        esc(form.display_form) + '</span>' + (form.feature_atoms || []).map(function(value){ return '<small>' + esc(value) + '</small>'; }).join('') +
        '<small>' + esc(number(form.occurrences)) + '</small></a>';
    }).join('');
    host.innerHTML = '<a class="lib-back" href="/lemmas.html">' + esc(t('lemmas.back', 'Back to all lemmas')) + '</a>' +
      '<header class="lemma-detail-head"><div><span class="quality-badge q-approved">' +
      esc(t('lemmas.sourceEvidence', 'PCMLBE source annotation')) + '</span><h2 lang="lbe">' + esc(lemma.display_form) + '</h2>' +
      '<p>' + esc(t('lemmas.forms', '{count} forms', { count: number(lemma.attested_forms) })) + ' · ' +
      esc(t('lemmas.occurrences', '{count} occurrences', { count: number(lemma.annotated_occurrences) })) + '</p></div></header>' +
      '<section class="lemma-detail-section"><h3>' + esc(t('lemmas.entries', 'Dictionary evidence')) + '</h3><div class="lemma-source-list">' + entries.map(function(entry) {
        var meta=[entry.source_title,entry.source_locator].filter(Boolean).join(' · ');
        var senses=(entry.senses || []).map(function(sense){ return sense.gloss_ru || sense.gloss_en || sense.definition || sense.raw_sense; }).filter(Boolean);
        var evidence=senses.join('; ') || (String(entry.raw_entry || '').trim().charAt(0)==='{' ? '' : entry.raw_entry);
        return '<article class="lemma-occurrence-card"><h4>' + esc(entry.headword_original + (entry.homonym_number ? ' ' + entry.homonym_number : '')) + '</h4>' +
          (evidence ? '<p>' + esc(shorten(evidence, 320)) + '</p>' : '') + (meta ? '<p class="record-meta">' + esc(meta) + '</p>' : '') +
          (String(entry.raw_entry || '').length > 340 && String(entry.raw_entry || '').trim().charAt(0)!=='{' ? '<details><summary>' + esc(t('lemmas.fullEntry','Full source entry')) + '</summary><p>' + esc(entry.raw_entry) + '</p></details>' : '') + '</article>';
      }).join('') + '</div></section>' +
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

  function loadDetail(id, page, entry) {
    var host = document.getElementById('lemma-detail');
    host.hidden = false;
    loading(host);
    var params=new URLSearchParams({page:String(page||1),limit:'25'}); if(entry) params.set('entry',entry);
    fetch('/api/corpus/v2/lemmas/' + encodeURIComponent(id) + '?' + params.toString(), { cache: 'no-store' })
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
    var entry = new URLSearchParams(window.location.search).get('entry');
    if (id) {
      loadDetail(id, 1, entry);
      document.getElementById('lemma-detail').addEventListener('click', function (event) {
        var button = event.target.closest('[data-detail-page]');
        if (!button || button.disabled) return;
        state.detailPage = Number(button.dataset.detailPage);
        loadDetail(id, state.detailPage, entry);
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
