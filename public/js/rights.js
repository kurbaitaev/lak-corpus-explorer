/* Rights & candidate review — the authenticated queue for private sources.
 *
 * One item at a time: the immutable provenance it arrived with (path, file
 * digest, unit/line reference), the spellings that corroborate it elsewhere,
 * and the four independent decisions — rights, access, review, training —
 * each recorded with a note into the immutable decision log.
 *
 * The gates shown here mirror the server's, which is where they are actually
 * enforced: a refused decision is reported with the server's own reason.
 */
(function () {
  'use strict';

  var P = window.PW;
  var state = {
    who: null,
    facets: null,
    items: [],
    total: 0,
    open: 0,
    offset: 0,
    limit: 25,
    selected: null,
    detail: null,
    filters: { q: '', required_action: '', material_type: '', rights_status: '', review_state: '' },
    feedback: null,
  };
  var $ = function (id) { return document.getElementById(id); };
  var app = $('rq-app');

  function renderStats() {
    var box = $('rq-stats');
    if (!box) return;
    box.innerHTML =
      '<div class="pw-stat"><b>' + P.esc(P.num(state.total)) + '</b><span>' +
      P.esc(P.t('rights.stat.total', 'Items in view')) + '</span></div>' +
      '<div class="pw-stat"><b>' + P.esc(P.num(state.open)) + '</b><span>' +
      P.esc(P.t('rights.stat.open', 'Still unreviewed')) + '</span></div>';
  }

  function itemRow(item) {
    var active = state.selected === item.ref;
    return '<button type="button" class="pw-item' + (active ? ' active' : '') + '" data-ref="' + P.esc(item.ref) + '">' +
      '<div class="pw-item-title">' + P.esc(item.label) + '</div>' +
      '<div class="pw-item-meta">' + P.esc(item.required_action || '') + '</div>' +
      '<div class="pw-tags">' + P.statusTag(item.review_state) +
      '<span class="pw-tag">' + P.esc(P.label(item.rights_status)) + '</span>' +
      '<span class="pw-tag">' + P.esc(P.label(item.material_type)) + '</span>' +
      (item.priority ? '<span class="pw-tag">' + P.esc(item.priority) + '</span>' : '') +
      '</div></button>';
  }

  function renderList() {
    var list = $('rq-list');
    var count = $('rq-count');
    if (!list) return;
    if (count) {
      count.textContent = P.t('rights.list.count', '{n} items · showing {from}–{to}', {
        n: P.num(state.total),
        from: P.num(state.total ? state.offset + 1 : 0),
        to: P.num(Math.min(state.offset + state.limit, state.total)),
      });
    }
    if (!state.items.length) {
      P.empty(list, P.t('rights.list.empty', 'No queue item matches these filters.'));
      return;
    }
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = state.items.map(itemRow).join('');
    Array.prototype.forEach.call(list.querySelectorAll('button[data-ref]'), function (button) {
      button.addEventListener('click', function () { select(button.getAttribute('data-ref')); });
    });
    var prev = $('rq-prev');
    var next = $('rq-next');
    if (prev) prev.disabled = state.offset === 0;
    if (next) next.disabled = state.offset + state.limit >= state.total;
  }

  function fact(key, def, value, mono) {
    return '<div class="pw-fact"><dt>' + P.esc(P.t(key, def)) + '</dt><dd' + (mono ? ' class="pw-mono"' : '') + '>' +
      P.esc(value == null || value === '' ? '—' : value) + '</dd></div>';
  }

  function select(ref) {
    state.selected = String(ref);
    state.feedback = null;
    var panel = $('rq-detail');
    P.loading(panel);
    renderList();
    return P.api('/api/private/rights-queue/' + encodeURIComponent(ref)).then(function (result) {
      if (!result.ok) { P.error(panel, P.reasonFor(result)); return; }
      state.detail = result.data;
      renderDetail();
    });
  }

  function decisionSelect(id, current, values) {
    return '<div class="select-wrap"><select id="' + id + '">' + values.map(function (value) {
      return '<option value="' + P.esc(value) + '"' + (value === current ? ' selected' : '') + '>' +
        P.esc(P.label(value)) + '</option>';
    }).join('') + '</select></div>';
  }

  function renderDetail() {
    var panel = $('rq-detail');
    if (!panel) return;
    if (!state.detail) {
      P.empty(panel, P.t('rights.detail.empty', 'Select a queue item to read its provenance and record decisions.'));
      return;
    }
    var detail = state.detail;
    var source = detail.source;
    var provenance = detail.provenance;
    var review = detail.rights_review || {};
    var expert = P.isExpert(state.who);

    panel.setAttribute('aria-busy', 'false');
    panel.innerHTML =
      '<h2>' + P.esc(source.label) + '</h2>' +
      '<p class="pw-hint">' + P.esc(review.required_action || P.label(source.material_type)) + '</p>' +
      '<div class="pw-tags">' + P.statusTag(source.review_state) +
      '<span class="pw-tag">' + P.esc(P.label(source.rights_status)) + '</span>' +
      '<span class="pw-tag">' + P.esc(P.label(source.access_status)) + '</span>' +
      '<span class="pw-tag">' + P.esc(P.t('rights.tag.training', 'Training: {v}', { v: P.label(source.training_ready) })) + '</span></div>' +

      '<h3>' + P.esc(P.t('rights.provenance.title', 'Immutable provenance')) + '</h3>' +
      '<p class="pw-hint">' + P.esc(P.t('rights.provenance.hint',
        'Exactly what the package recorded when the file was received. Decisions never rewrite it.')) + '</p>' +
      '<dl class="pw-facts">' +
      fact('rights.provenance.path', 'Source path', provenance.source_path, true) +
      fact('rights.provenance.digest', 'File digest (SHA-256)', provenance.file_digest, true) +
      fact('rights.provenance.sequence', 'Source sequence', provenance.source_sequence) +
      fact('rights.provenance.units', 'Page / unit reference',
        (provenance.unit_range || []).filter(function (v) { return v != null; }).join(' – ')) +
      fact('rights.provenance.lines', 'Line reference',
        (provenance.line_range || []).filter(function (v) { return v != null; }).join(' – ')) +
      fact('rights.provenance.declared', 'Declared rights', P.label(provenance.declared_rights_status)) +
      fact('rights.provenance.duplicate', 'Duplicate group', provenance.duplicate_group) +
      fact('rights.provenance.canonical', 'Canonical duplicate', provenance.canonical_duplicate, true) +
      fact('rights.provenance.chars', 'Characters', P.num(provenance.text_chars)) +
      '</dl>' +

      '<h3>' + P.esc(P.t('rights.spellings.title', 'Corroborating spellings')) + '</h3>' +
      '<p class="pw-hint">' + P.esc(P.t('rights.spellings.hint',
        'Spellings from this source attested elsewhere. Corroboration only — nothing is merged.')) + '</p>' +
      (detail.corroborating_spellings.length
        ? '<div class="pw-tags">' + detail.corroborating_spellings.map(function (entry) {
          return '<span class="pw-tag">' + P.esc(entry.form) +
            (entry.public_corpus ? ' · ' + P.esc(P.t('rights.spellings.public', 'public corpus')) : '') +
            (entry.private_sources.length
              ? ' · ' + P.esc(P.t('rights.spellings.private', '{n} private', { n: entry.private_sources.length }))
              : '') + '</span>';
        }).join('') + '</div>'
        : '<div class="pw-empty">' + P.esc(P.t('rights.spellings.empty', 'No corroborating spelling was found.')) + '</div>') +

      '<h3>' + P.esc(P.t('rights.decisions.title', 'Four independent decisions')) + '</h3>' +
      '<p class="pw-hint">' + P.esc(P.t('rights.decisions.hint',
        'Each decision is recorded separately with its note. The server refuses public access or training use ' +
        'until rights are cleared and the review is accepted.')) + '</p>' +
      '<div class="pw-decisions">' +
      '<div class="field-wrap"><label for="rq-d-rights">' + P.esc(P.t('rights.decision.rights', 'Rights')) + '</label>' +
      decisionSelect('rq-d-rights', source.rights_status,
        ['permission_pending', 'permission_granted', 'public_domain', 'restricted']) + '</div>' +
      '<div class="field-wrap"><label for="rq-d-access">' + P.esc(P.t('rights.decision.access', 'Access')) + '</label>' +
      decisionSelect('rq-d-access', source.access_status, ['private_research', 'restricted', 'public']) + '</div>' +
      '<div class="field-wrap"><label for="rq-d-review">' + P.esc(P.t('rights.decision.review', 'Review')) + '</label>' +
      decisionSelect('rq-d-review', source.review_state,
        ['source_import_unreviewed', 'in_review', 'accepted_candidate', 'rejected']) + '</div>' +
      '<div class="field-wrap"><label for="rq-d-training">' + P.esc(P.t('rights.decision.training', 'Training')) + '</label>' +
      decisionSelect('rq-d-training', source.training_ready ? 'true' : 'false', ['false', 'true']) + '</div>' +
      '</div>' +
      '<div class="field-wrap"><label for="rq-d-note">' + P.esc(P.t('rights.decision.note', 'Note')) + '</label>' +
      '<textarea class="pw-note" id="rq-d-note" placeholder="' +
      P.esc(P.t('rights.decision.notePlaceholder', 'Who was contacted, what was found, what still blocks this.')) +
      '"></textarea></div>' +
      (expert ? '' : '<p class="pw-hint">' + P.esc(P.t('rights.decision.roleHint',
        'Accepting a review and raising exposure are verified-expert decisions.')) + '</p>') +
      '<div class="pw-actions"><button class="btn btn-primary" id="rq-d-save">' +
      P.esc(P.t('rights.decision.save', 'Record decisions')) + '</button></div>' +
      '<div class="pw-feedback' + (state.feedback ? ' ' + state.feedback.kind : '') + '" id="rq-d-feedback">' +
      P.esc(state.feedback ? state.feedback.message : '') + '</div>' +

      '<h3>' + P.esc(P.t('rights.history.title', 'Decision history')) + '</h3>' +
      (detail.decisions.length
        ? detail.decisions.map(function (decision) {
          return '<div class="pw-signal"><span>' + P.esc(P.label(decision.decision_type)) + ': ' +
            P.esc(P.label(decision.from_value)) + ' → ' + P.esc(P.label(decision.to_value)) +
            (decision.note ? ' — ' + P.esc(decision.note) : '') + '</span><span>' +
            P.esc(decision.decided_by_name) + ' · ' + P.esc(P.label(decision.decided_by_role)) + '</span></div>';
        }).join('')
        : '<div class="pw-empty">' + P.esc(P.t('rights.history.empty', 'No decision has been recorded yet.')) + '</div>');

    var save = $('rq-d-save');
    if (save) save.addEventListener('click', submit);
  }

  function submit() {
    if (!state.detail) return;
    var button = $('rq-d-save');
    if (button) button.disabled = true;
    P.api('/api/private/rights-queue/' + encodeURIComponent(state.detail.source.ref) + '/decisions', {
      method: 'POST',
      body: {
        rights_status: $('rq-d-rights').value,
        access_status: $('rq-d-access').value,
        review_state: $('rq-d-review').value,
        training_ready: $('rq-d-training').value === 'true',
        note: $('rq-d-note').value || null,
      },
    }).then(function (result) {
      if (button) button.disabled = false;
      var box = $('rq-d-feedback');
      if (!result.ok) {
        var blockers = (result.data && result.data.blockers) || [];
        state.feedback = {
          kind: 'bad',
          message: P.reasonFor(result) + (blockers.length ? ' (' + blockers.map(P.label).join(', ') + ')' : ''),
        };
        if (box) { box.className = 'pw-feedback bad'; box.textContent = state.feedback.message; }
        return;
      }
      state.feedback = { kind: 'ok', message: P.t('rights.decision.saved', 'Decisions recorded.') };
      select(state.detail.source.ref);
      load();
    });
  }

  function load() {
    var params = new URLSearchParams();
    Object.keys(state.filters).forEach(function (key) {
      if (state.filters[key]) params.set(key, state.filters[key]);
    });
    params.set('limit', String(state.limit));
    params.set('offset', String(state.offset));
    var list = $('rq-list');
    P.loading(list);
    return P.api('/api/private/rights-queue?' + params.toString()).then(function (result) {
      if (!result.ok) { P.error(list, P.reasonFor(result)); return; }
      state.items = result.data.items || [];
      state.total = result.data.total || 0;
      state.open = result.data.open || 0;
      renderStats();
      renderList();
    });
  }

  function fillFilters() {
    var facets = state.facets || {};
    P.fillSelect($('rq-action'), facets.required_action, P.t('rights.filter.action.all', 'All required actions'));
    P.fillSelect($('rq-material'), facets.material_type, P.t('rights.filter.material.all', 'All material types'));
    P.fillSelect($('rq-rights'), facets.rights_status, P.t('rights.filter.rights.all', 'All rights statuses'));
    P.fillSelect($('rq-review'), facets.review_state, P.t('rights.filter.review.all', 'All review statuses'));
  }

  function bindFilters() {
    var debounce = null;
    var search = $('rq-q');
    if (search) {
      search.addEventListener('input', function () {
        state.filters.q = search.value;
        state.offset = 0;
        clearTimeout(debounce);
        debounce = setTimeout(load, 220);
      });
    }
    var map = { 'rq-action': 'required_action', 'rq-material': 'material_type', 'rq-rights': 'rights_status', 'rq-review': 'review_state' };
    Object.keys(map).forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', function () {
        state.filters[map[id]] = el.value;
        state.offset = 0;
        load();
      });
    });
    var prev = $('rq-prev');
    var next = $('rq-next');
    if (prev) prev.addEventListener('click', function () {
      state.offset = Math.max(0, state.offset - state.limit); load();
    });
    if (next) next.addEventListener('click', function () {
      if (state.offset + state.limit < state.total) { state.offset += state.limit; load(); }
    });
  }

  function relocalize() {
    var banner = $('pw-banner');
    if (banner) banner.innerHTML = P.candidateBanner();
    if (!state.who) return;
    fillFilters();
    renderStats();
    renderList();
    renderDetail();
  }

  function boot() {
    var banner = $('pw-banner');
    if (banner) banner.innerHTML = P.candidateBanner();
    P.requireReviewer(app).then(function (who) {
      if (!who) return;
      state.who = who;
      app.setAttribute('aria-busy', 'false');
      app.innerHTML = '';
      app.appendChild($('rq-template').content.cloneNode(true));
      if (window.I18n && window.I18n.apply) window.I18n.apply(app);
      P.api('/api/private/rights-queue/facets').then(function (result) {
        state.facets = result.ok ? result.data : {};
        fillFilters();
        bindFilters();
        load();
        renderDetail();
      });
      P.onLanguageChange(relocalize);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
