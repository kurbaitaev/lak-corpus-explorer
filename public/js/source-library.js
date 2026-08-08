/* Public Source Library.
 *
 * Renders the catalogue served by /api/source-library. Everything it displays
 * has already passed the public projection allowlist on the server, so this
 * file's job is presentation and honesty about gaps — never invention. Where
 * a source has no usable title, the card says what kind of material it is and
 * shows its reference; it does not make up a name.
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
    var s = t(key, fallback);
    return s.replace(/\{(\w+)\}/g, function (m, name) {
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

  // Canonical values arrive in their language-neutral form and are localized
  // for display only. The value itself is never rewritten, so filters, links
  // and the API keep speaking one vocabulary in both languages.
  function label(group, value) {
    if (!value) return t('lib.unknown', 'Not recorded');
    return t('lib.' + group + '.' + value, value.replace(/_/g, ' '));
  }

  var FACET_SELECTS = [
    ['lib-material', 'material_type', 'materialType'],
    ['lib-language', 'language_scope', 'languageScope'],
    ['lib-script', 'script_profile', 'scriptProfile'],
    ['lib-contribution', 'contribution', 'contribution'],
    ['lib-rights', 'rights_state', 'rightsState'],
    ['lib-role', 'corpus_role', 'corpusRole'],
    ['lib-quality', 'extraction_quality', 'extractionQuality'],
  ];

  var state = { facets: null, page: 1, seq: 0, lastPayload: null, detailRef: null, detail: null };

  function displayName(s) {
    if (s.title) return s.title;
    if (s.consent_withheld) {
      return tp('lib.name.withheld', 'Fieldwork material {ref}', { ref: s.ref });
    }
    if (s.name_source === 'source_family' && s.family_id) {
      return tp('lib.name.family', '{family} — {ref}', {
        family: t('lib.family.' + s.family_id, s.family_id.replace(/_/g, ' ')), ref: s.ref,
      });
    }
    return tp('lib.name.material', '{material} — {ref}', {
      material: label('materialType', s.material_type), ref: s.ref,
    });
  }

  function nameNote(s) {
    if (s.title) return '';
    return '<div class="lib-name-note">' + esc(s.consent_withheld
      ? t('lib.name.note.withheld', 'Named by material type only. Fieldwork recordings can identify the people taking part, so no filename, title or date is published.')
      : t('lib.name.note.derived', 'This file records no usable title, so the entry is named by what kind of material it is.')) + '</div>';
  }

  function sizeFact(s) {
    if (s.word_count) return tp('lib.size.words', '{n} words', { n: num(s.word_count) });
    if (s.text_chars) return tp('lib.size.chars', '{n} characters', { n: num(s.text_chars) });
    return t('lib.unknown', 'Not recorded');
  }

  function tags(s) {
    var out = '<span class="obs-tag">' + esc(label('materialType', s.material_type)) + '</span>' +
      '<span class="obs-tag status">' + esc(label('languageScope', s.language_scope)) + '</span>' +
      '<span class="obs-tag">' + esc(label('scriptProfile', s.script_profile)) + '</span>';
    if (s.rights_state === 'public_domain_candidate_review') {
      out += '<span class="obs-tag rights">' + esc(t('lib.rightsState.public_domain_candidate_review', 'Public-domain candidate — under review')) + '</span>';
    }
    if (s.is_duplicate) {
      out += '<span class="obs-tag">' + esc(s.is_canonical_copy
        ? t('lib.duplicate.canonical', 'Kept copy of a repeated file')
        : t('lib.duplicate.other', 'Repeated file')) + '</span>';
    }
    return '<div class="obs-tags">' + out + '</div>';
  }

  // Most files carry no usable name, and most carry no usable date. An absent
  // fact is left unsaid rather than announced: "No name recorded" on hundreds
  // of cards is noise, and next to a real title it reads as a contradiction.
  function byline(s, long) {
    var parts = [];
    if (s.attributed_to) {
      parts.push(long
        ? tp('lib.attributedTo', 'Attributed to {name}', { name: s.attributed_to })
        : s.attributed_to);
    }
    if (s.document_year) parts.push(tp('lib.fileYear', 'file dated {year}', { year: s.document_year }));
    if (!parts.length) return '';
    return '<div class="obs-byline">' + esc(parts.join(' · ')) + '</div>';
  }

  function card(s, index) {
    return '<article class="obs-card" style="animation-delay:' + Math.min(index * 24, 240) + 'ms">' +
      '<div class="obs-card-head"><div>' +
        '<h2><a class="lib-card-link" href="?source=' + esc(s.ref) + '">' + esc(displayName(s)) + '</a></h2>' +
        byline(s) +
        '<div class="obs-id">' + esc(s.ref) + '</div>' +
      '</div><span class="obs-priority ' + esc(String(s.priority || '').toLowerCase()) + '">' + esc(s.priority || '—') + '</span></div>' +
      nameNote(s) +
      tags(s) +
      '<dl class="obs-facts">' +
        fact(t('lib.fact.role', 'Role here'), label('corpusRole', s.corpus_role)) +
        fact(t('lib.fact.size', 'Size'), sizeFact(s)) +
        fact(t('lib.fact.contribution', 'Contributes'), label('contribution', s.contribution)) +
        fact(t('lib.fact.wordForms', 'Word forms indexed'), s.word_form_count ? num(s.word_form_count) : t('lib.none', 'None')) +
      '</dl>' +
      '<div class="obs-action"><strong>' + esc(t('lib.howUsed', 'How this source is used')) + '</strong>' +
        esc(t('lib.use.' + s.material_type, s.recommended_use || '')) + '</div>' +
      '<div class="obs-source"><a class="lib-detail-link" href="?source=' + esc(s.ref) + '">' + esc(t('lib.viewDetail', 'Full entry →')) + '</a>' +
      '</div></article>';
  }

  function fact(dt, dd) {
    return '<div class="obs-fact"><dt>' + esc(dt) + '</dt><dd>' + esc(dd) + '</dd></div>';
  }

  function stat(labelText, value) {
    return '<div class="obs-stat"><b>' + esc(value) + '</b><span>' + esc(labelText) + '</span></div>';
  }

  /* ── Detail view ─────────────────────────────────────────── */

  function renderDetail(payload) {
    var s = payload.source;
    var host = document.getElementById('lib-detail');
    var browse = document.getElementById('lib-browse');
    var related = payload.related || [];

    host.innerHTML =
      '<a class="lib-back" href="/source-library.html">' + esc(t('lib.backToList', '← All sources')) + '</a>' +
      '<article class="obs-card lib-detail-card">' +
        '<div class="obs-card-head"><div><h2>' + esc(displayName(s)) + '</h2>' +
          byline(s, true) +
          '<div class="obs-id">' + esc(s.ref) + '</div></div>' +
          '<span class="obs-priority ' + esc(String(s.priority || '').toLowerCase()) + '">' + esc(s.priority || '—') + '</span>' +
        '</div>' +
        nameNote(s) +
        (s.attributed_to ? '<p class="obs-notes">' + esc(t('lib.attributionCaveat', 'This is the name recorded inside the file. It is often the author, but it can also be whoever prepared or scanned the document.')) + '</p>' : '') +
        tags(s) +
        '<dl class="obs-facts lib-detail-facts">' +
          fact(t('lib.fact.materialType', 'Material type'), label('materialType', s.material_type)) +
          fact(t('lib.fact.language', 'Language'), label('languageScope', s.language_scope)) +
          fact(t('lib.fact.script', 'Script'), label('scriptProfile', s.script_profile)) +
          fact(t('lib.fact.role', 'Role here'), label('corpusRole', s.corpus_role)) +
          fact(t('lib.fact.rights', 'Rights state'), label('rightsState', s.rights_state)) +
          fact(t('lib.fact.format', 'File format'), label('fileFormat', s.file_format)) +
          fact(t('lib.fact.size', 'Size'), sizeFact(s)) +
          fact(t('lib.fact.pages', 'Pages'), s.pages ? num(s.pages) : t('lib.unknown', 'Not recorded')) +
          fact(t('lib.fact.extraction', 'Text extraction'), label('extractionStatus', s.extraction_status)) +
          fact(t('lib.fact.extractionQuality', 'Extraction quality'), label('extractionQuality', s.extraction_quality)) +
          fact(t('lib.fact.candidateRows', 'Rows held privately'), num(s.candidate_rows)) +
          fact(t('lib.fact.wordForms', 'Word forms indexed'), s.word_form_count ? num(s.word_form_count) : t('lib.none', 'None')) +
        '</dl>' +
        '<div class="obs-action"><strong>' + esc(t('lib.howUsed', 'How this source is used')) + '</strong>' +
          esc(t('lib.use.' + s.material_type, s.recommended_use || '')) + '</div>' +
        (s.word_form_count
          ? '<p class="obs-notes"><a href="/word-forms.html">' + esc(t('lib.seeWordForms', 'See the word-form index this source feeds →')) + '</a></p>'
          : '') +
      '</article>' +
      (related.length
        ? '<section class="lib-related"><h3>' + esc(tp('lib.related.h3', 'The same file appears {n} more times', { n: related.length })) + '</h3>' +
          '<p class="obs-private-intro">' + esc(t('lib.related.intro', 'These entries are byte-identical copies received separately. They are catalogued individually so the record of what was received stays accurate, and counted once so the totals do not double up.')) + '</p>' +
          '<div class="obs-grid">' + related.map(card).join('') + '</div></section>'
        : '');

    host.hidden = false;
    browse.hidden = true;
    document.getElementById('lib-review').hidden = true;
  }

  /* ── List view ───────────────────────────────────────────── */

  function renderList(payload) {
    var content = document.getElementById('lib-content');
    var results = document.getElementById('lib-results');
    var pager = document.getElementById('lib-pager');

    if (payload.status === 'preparing') {
      content.innerHTML = '<div class="obs-empty"><h2>' + esc(t('lib.preparing.title', 'The library is still being built')) +
        '</h2><p>' + esc(tp('lib.preparing.body', 'Descriptions are being derived from the research batch — {done} of {total} steps are done. Reload in a moment.',
          { done: payload.stages_complete, total: payload.stages_total })) + '</p></div>';
      results.textContent = '';
      pager.hidden = true;
      return;
    }

    results.textContent = tp('lib.resultCount', '{shown} of {total} sources', {
      shown: num(payload.items.length), total: num(payload.total),
    });

    content.innerHTML = payload.items.length
      ? '<div class="obs-grid">' + payload.items.map(card).join('') + '</div>'
      : '<div class="obs-empty"><h2>' + esc(t('lib.empty.title', 'No sources match these filters')) +
        '</h2><p>' + esc(t('lib.empty.body', 'Try a broader search, or clear one of the filters.')) + '</p></div>';
    content.setAttribute('aria-busy', 'false');

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

  function renderReview(payload) {
    var host = document.getElementById('lib-review-content');
    if (!payload.review_queue.length) {
      host.innerHTML = '<p class="obs-private-intro">' +
        esc(t('lib.review.empty', 'Nothing is waiting on a rights decision right now.')) + '</p>';
      return;
    }
    host.innerHTML = '<div class="obs-grid">' + payload.review_queue.map(card).join('') + '</div>';
  }

  function renderStats(facetPayload, listPayload) {
    var host = document.getElementById('lib-stats');
    if (!facetPayload) return;
    // Mid-rebuild the totals are partial; the catalogue's preparing notice
    // says what is happening, so the counters stay empty rather than lying.
    if (facetPayload.status === 'preparing') { host.innerHTML = ''; return; }
    var byRights = {};
    (facetPayload.facets.rights_state || []).forEach(function (o) { byRights[o.rights_state] = o.count; });
    var contributing = 0;
    (facetPayload.facets.contribution || []).forEach(function (o) {
      if (o.contribution === 'word_forms') contributing = o.count;
    });
    host.innerHTML =
      stat(t('lib.stat.sources', 'Sources catalogued'), num(facetPayload.sources_total != null ? facetPayload.sources_total : facetPayload.total)) +
      stat(t('lib.stat.materialTypes', 'Kinds of material'), num((facetPayload.facets.material_type || []).length)) +
      stat(t('lib.stat.contributing', 'Feeding the word-form index'), num(contributing)) +
      stat(t('lib.stat.underReview', 'Awaiting a rights decision'), num(byRights.public_domain_candidate_review || 0));
  }

  // The twelve material families, each with the role it can play once its
  // rights are cleared. Counts come from the facets endpoint; the per-family
  // text reuses the same curated use sentence the detail pages show.
  function renderCoverage(facetPayload) {
    var host = document.getElementById('lib-coverage-content');
    if (!host || !facetPayload) return;
    if (facetPayload.status === 'preparing') { host.innerHTML = ''; return; }
    host.innerHTML = (facetPayload.facets.material_type || []).map(function (o) {
      return '<div class="lib-coverage-card"><b>' + num(o.count) + '</b>' +
        '<h3>' + esc(label('materialType', o.material_type)) + '</h3>' +
        '<p>' + esc(t('lib.use.' + o.material_type, '')) + '</p></div>';
    }).join('');
  }

  /* ── Data ────────────────────────────────────────────────── */

  function currentQuery() {
    var params = new URLSearchParams();
    var q = document.getElementById('lib-search').value.trim();
    if (q) params.set('q', q);
    FACET_SELECTS.forEach(function (spec) {
      var v = document.getElementById(spec[0]).value;
      if (v) params.set(spec[1], v);
    });
    params.set('page', String(state.page));
    return params;
  }

  var inflight = null;
  function load() {
    // Every keystroke can start a request. Only the newest one may paint: an
    // earlier response arriving late must not replace newer results.
    var seq = ++state.seq;
    if (inflight) inflight.abort();
    var controller = new AbortController();
    inflight = controller;
    fetch('/api/source-library?' + currentQuery().toString(), { signal: controller.signal })
      .then(function (r) { return r.json(); })
      .then(function (payload) {
        if (seq !== state.seq) return;
        state.lastPayload = payload;
        renderList(payload);
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') return;
        if (seq !== state.seq) return;
        document.getElementById('lib-content').innerHTML =
          '<div class="obs-error"><h2>' + esc(t('lib.error.title', 'The catalogue could not be loaded')) +
          '</h2><p>' + esc(t('lib.error.body', 'Reload the page to try again.')) + '</p></div>';
      });
  }

  function loadFacets() {
    return fetch('/api/source-library/facets').then(function (r) { return r.json(); })
      .then(function (payload) {
        state.facets = payload;
        FACET_SELECTS.forEach(function (spec) {
          var select = document.getElementById(spec[0]);
          var options = payload.facets[spec[1]] || [];
          options.forEach(function (option) {
            var el = document.createElement('option');
            el.value = option[spec[1]];
            el.dataset.group = spec[2];
            el.textContent = label(spec[2], option[spec[1]]) + ' (' + num(option.count) + ')';
            select.appendChild(el);
          });
        });
        renderStats(payload, state.lastPayload);
        renderCoverage(payload);
      }).catch(function () { /* the list still works without counted filters */ });
  }

  function relocalizeFacetOptions() {
    FACET_SELECTS.forEach(function (spec) {
      var select = document.getElementById(spec[0]);
      var options = (state.facets && state.facets.facets[spec[1]]) || [];
      Array.prototype.slice.call(select.options).forEach(function (el) {
        if (!el.value) return;
        var match = null;
        options.forEach(function (o) { if (o[spec[1]] === el.value) match = o; });
        el.textContent = label(spec[2], el.value) + (match ? ' (' + num(match.count) + ')' : '');
      });
    });
  }

  function boot() {
    var urlParams = new URLSearchParams(window.location.search);
    var ref = urlParams.get('source');
    if (ref) {
      state.detailRef = ref;
      fetch('/api/source-library/' + encodeURIComponent(ref))
        .then(function (r) {
          if (!r.ok) throw new Error('not found');
          return r.json();
        })
        .then(function (payload) { state.detail = payload; renderDetail(payload); })
        .catch(function () {
          document.getElementById('lib-detail').hidden = false;
          document.getElementById('lib-browse').hidden = true;
          document.getElementById('lib-detail').innerHTML =
            '<a class="lib-back" href="/source-library.html">' + esc(t('lib.backToList', '← All sources')) + '</a>' +
            '<div class="obs-empty"><h2>' + esc(t('lib.notFound.title', 'No such source')) + '</h2><p>' +
            esc(t('lib.notFound.body', 'That reference is not in the catalogue.')) + '</p></div>';
        });
      return;
    }

    var initialQuery = urlParams.get('q');
    if (initialQuery) document.getElementById('lib-search').value = initialQuery;

    load();
    loadFacets();
    fetch('/api/source-library/review-queue').then(function (r) { return r.json(); })
      .then(renderReview).catch(function () { /* the queue is supplementary */ });

    var debounce = null;
    document.getElementById('lib-search').addEventListener('input', function () {
      clearTimeout(debounce);
      debounce = setTimeout(function () { state.page = 1; load(); }, 180);
    });
    FACET_SELECTS.forEach(function (spec) {
      document.getElementById(spec[0]).addEventListener('change', function () {
        state.page = 1;
        load();
      });
    });
    document.getElementById('lib-pager').addEventListener('click', function (e) {
      var btn = e.target.closest('.lib-page-btn');
      if (!btn || btn.disabled) return;
      state.page = Math.max(1, parseInt(btn.dataset.page, 10) || 1);
      load();
      document.getElementById('lib-content').scrollIntoView({ block: 'start' });
    });
  }

  if (I18n && I18n.onChange) {
    I18n.onChange(function () {
      if (state.detail) { renderDetail(state.detail); return; }
      relocalizeFacetOptions();
      if (state.lastPayload) renderList(state.lastPayload);
      if (state.facets) { renderStats(state.facets, state.lastPayload); renderCoverage(state.facets); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
