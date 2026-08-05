/* Public Lak word-form index.
 *
 * A list of word forms and counts, and deliberately nothing more. There is no
 * context, no example sentence and no line reference here, because those would
 * be the restricted text itself rather than a fact about it. Every form shown
 * is attested by at least two independent sources; the server enforces that,
 * and this page explains it.
 */
(function () {
  'use strict';

  var I18n = window.I18n;
  function t(key, fallback) {
    if (I18n && typeof I18n.t === 'function') {
      var v = I18n.t(key);
      if (v && v !== key) return v;
    }
    return fallback;
  }
  function tp(key, fallback, vars) {
    return t(key, fallback).replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars || {}, name) ? String(vars[name]) : m;
    });
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(n) {
    return Number(n || 0).toLocaleString(I18n && I18n.getLanguage ? I18n.getLanguage() : 'en');
  }
  function label(group, value) {
    if (!value) return t('lib.unknown', 'Not recorded');
    return t('lib.' + group + '.' + value, value.replace(/_/g, ' '));
  }

  var SCRIPTS = ['cyrillic', 'latin', 'mixed'];
  var CONFIDENCES = ['high', 'medium', 'low'];
  var state = { page: 1, seq: 0, last: null, total: null };

  function row(f) {
    return '<tr>' +
      '<td class="wf-form" lang="lbe">' + esc(f.form) +
        (f.lak_marker ? ' <span class="wf-marker" title="' + esc(t('wf.markerTitle', 'Contains a Lak-specific letter')) + '">' +
          esc(t('wf.markerShort', 'Lak')) + '</span>' : '') + '</td>' +
      '<td class="wf-num">' + esc(num(f.occurrences)) + '</td>' +
      '<td class="wf-num">' + esc(num(f.sources)) + '</td>' +
      '<td><span class="obs-tag">' + esc(label('scriptProfile', f.script_profile)) + '</span></td>' +
      '<td><span class="wf-confidence ' + esc(f.confidence) + '">' +
        esc(label('confidence', f.confidence)) + '</span></td>' +
      '<td><a href="/source-library.html?q=' + encodeURIComponent(f.form) + '">' +
        esc(t('wf.findSources', 'Sources')) + '</a></td>' +
      '</tr>';
  }

  function render(payload) {
    var content = document.getElementById('wf-content');
    var results = document.getElementById('wf-results');
    var pager = document.getElementById('wf-pager');
    content.setAttribute('aria-busy', 'false');

    if (payload.status === 'preparing') {
      content.innerHTML = '<div class="obs-empty"><h2>' + esc(t('wf.preparing.title', 'The index is still being built')) +
        '</h2><p>' + esc(tp('wf.preparing.body', 'Word forms are being derived from the research batch — {done} of {total} steps are done. Reload in a moment.',
          { done: payload.stages_complete, total: payload.stages_total })) + '</p></div>';
      results.textContent = '';
      pager.hidden = true;
      return;
    }

    results.textContent = tp('wf.resultCount', '{shown} of {total} forms', {
      shown: num(payload.items.length), total: num(payload.total),
    });

    content.innerHTML = payload.items.length
      ? '<div class="wf-table-wrap"><table class="wf-table">' +
        '<caption class="sr-only">' + esc(t('wf.tableCaption', 'Lak word forms with occurrence and source counts')) + '</caption>' +
        '<thead><tr>' +
          '<th scope="col">' + esc(t('wf.col.form', 'Form')) + '</th>' +
          '<th scope="col" class="wf-num">' + esc(t('wf.col.occurrences', 'Occurrences')) + '</th>' +
          '<th scope="col" class="wf-num">' + esc(t('wf.col.sources', 'Sources')) + '</th>' +
          '<th scope="col">' + esc(t('wf.col.script', 'Script')) + '</th>' +
          '<th scope="col">' + esc(t('wf.col.confidence', 'Attestation')) + '</th>' +
          '<th scope="col">' + esc(t('wf.col.explore', 'Explore')) + '</th>' +
        '</tr></thead><tbody>' + payload.items.map(row).join('') + '</tbody></table></div>'
      : '<div class="obs-empty"><h2>' + esc(t('wf.empty.title', 'No forms match')) + '</h2><p>' +
        esc(t('wf.empty.body', 'A form appears here only when at least two independent sources use it. Try a shorter beginning, or clear a filter.')) + '</p></div>';

    if (payload.pages_total > 1) {
      pager.hidden = false;
      pager.innerHTML =
        '<button type="button" class="lib-page-btn" data-page="' + (payload.page - 1) + '"' +
          (payload.page <= 1 ? ' disabled' : '') + '>' + esc(t('lib.prev', '← Previous')) + '</button>' +
        '<span class="lib-page-status">' + esc(tp('lib.pageOf', 'Page {page} of {pages}',
          { page: num(payload.page), pages: num(payload.pages_total) })) + '</span>' +
        '<button type="button" class="lib-page-btn" data-page="' + (payload.page + 1) + '"' +
          (payload.page >= payload.pages_total ? ' disabled' : '') + '>' + esc(t('lib.next', 'Next →')) + '</button>';
    } else {
      pager.hidden = true;
    }
  }

  function renderStats(payload) {
    if (!state.total) state.total = payload.total;
    var host = document.getElementById('wf-stats');
    host.innerHTML =
      '<div class="obs-stat"><b>' + esc(num(state.total)) + '</b><span>' +
        esc(t('wf.stat.forms', 'Published word forms')) + '</span></div>' +
      '<div class="obs-stat"><b>' + esc(t('wf.stat.thresholdValue', '2+')) + '</b><span>' +
        esc(t('wf.stat.threshold', 'Sources needed to publish a form')) + '</span></div>';
  }

  function currentQuery() {
    var params = new URLSearchParams();
    var q = document.getElementById('wf-search').value.trim();
    if (q) params.set('q', q);
    var script = document.getElementById('wf-script').value;
    if (script) params.set('script_profile', script);
    var confidence = document.getElementById('wf-confidence').value;
    if (confidence) params.set('confidence', confidence);
    if (document.getElementById('wf-marker').checked) params.set('lak_marker', 'true');
    params.set('sort', document.getElementById('wf-sort').value);
    params.set('page', String(state.page));
    return params;
  }

  var inflight = null;
  function load() {
    var seq = ++state.seq;
    if (inflight) inflight.abort();
    var controller = new AbortController();
    inflight = controller;
    fetch('/api/word-forms?' + currentQuery().toString(), { signal: controller.signal })
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        if (seq !== state.seq) return;
        state.last = payload;
        render(payload);
        renderStats(payload);
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (seq !== state.seq) return;
        document.getElementById('wf-content').innerHTML =
          '<div class="obs-error"><h2>' + esc(t('wf.error.title', 'The index could not be loaded')) +
          '</h2><p>' + esc(t('wf.error.body', 'Reload the page to try again.')) + '</p></div>';
      });
  }

  function fillSelects() {
    var script = document.getElementById('wf-script');
    SCRIPTS.forEach(function (value) {
      var el = document.createElement('option');
      el.value = value;
      el.textContent = label('scriptProfile', value);
      script.appendChild(el);
    });
    var confidence = document.getElementById('wf-confidence');
    CONFIDENCES.forEach(function (value) {
      var el = document.createElement('option');
      el.value = value;
      el.textContent = label('confidence', value);
      confidence.appendChild(el);
    });
  }

  function relocalizeSelects() {
    Array.prototype.slice.call(document.getElementById('wf-script').options)
      .forEach(function (el) { if (el.value) el.textContent = label('scriptProfile', el.value); });
    Array.prototype.slice.call(document.getElementById('wf-confidence').options)
      .forEach(function (el) { if (el.value) el.textContent = label('confidence', el.value); });
  }

  function boot() {
    fillSelects();
    var initial = new URLSearchParams(window.location.search).get('q');
    if (initial) document.getElementById('wf-search').value = initial;
    load();

    var debounce = null;
    document.getElementById('wf-search').addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () { state.page = 1; load(); }, 180);
    });
    ['wf-script', 'wf-confidence', 'wf-sort', 'wf-marker'].forEach(function (id) {
      document.getElementById(id).addEventListener('change', function () { state.page = 1; load(); });
    });
    document.getElementById('wf-pager').addEventListener('click', function (e) {
      var btn = e.target.closest('.lib-page-btn');
      if (!btn || btn.disabled) return;
      state.page = Math.max(1, parseInt(btn.dataset.page, 10) || 1);
      load();
      document.getElementById('wf-content').scrollIntoView({ block: 'start' });
    });
  }

  if (I18n && I18n.onChange) {
    I18n.onChange(function () {
      relocalizeSelects();
      if (state.last) { render(state.last); renderStats(state.last); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
