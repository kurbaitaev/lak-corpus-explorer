/* Alignment Lab — the authenticated side-by-side alignment reviewer.
 *
 * A relationship is a proposal, and so is every alignment unit under it. The
 * screen never presents either as a validated translation: the banner states
 * it, each unit carries its review state, and accepting is an expert-only
 * action the server enforces.
 *
 * A stored alignment is the thing a reviewer corrects. Regenerating one that
 * carries human decisions is refused by the server, and the screen says so
 * rather than silently discarding work.
 */
(function () {
  'use strict';

  var P = window.PW;
  var state = {
    who: null,
    relationships: [],
    total: 0,
    selectedId: null,
    detail: null,
    alignment: null,
    filters: { q: '', relationship_type: '', review_state: '' },
    feedback: null,
    busy: false,
  };
  var $ = function (id) { return document.getElementById(id); };
  var app = $('align-app');

  var TYPES = ['translation', 'parallel_text', 'transliteration', 'alternate_edition', 'duplicate'];
  var REVIEW_STATES = ['source_import_unreviewed', 'in_review', 'accepted_candidate', 'rejected'];

  function candidateRow(relationship) {
    var active = relationship.id === state.selectedId;
    return '<button type="button" class="pw-item' + (active ? ' active' : '') + '" data-id="' + P.esc(relationship.id) + '">' +
      '<div class="pw-item-title">' + P.esc(relationship.left.label || relationship.left.ref) + ' ↔ ' +
      P.esc(relationship.right.label || relationship.right.ref) + '</div>' +
      '<div class="pw-item-meta">' + P.esc(relationship.family_key || '') + ' · ' +
      P.esc(P.t('align.signals.count', '{n} signals', { n: (relationship.signals || []).length })) + '</div>' +
      '<div class="pw-tags"><span class="pw-tag type">' + P.esc(P.label(relationship.relationship_type)) + '</span>' +
      P.statusTag(relationship.review_state) +
      '<span class="pw-tag">' + P.esc(P.t('align.confidence', 'Confidence {v}', { v: P.pct(relationship.confidence) })) + '</span>' +
      (relationship.alignment_units
        ? '<span class="pw-tag">' + P.esc(P.t('align.units', '{n} units', { n: relationship.alignment_units })) + '</span>'
        : '') +
      '</div></button>';
  }

  function renderList() {
    var list = $('al-list');
    var count = $('al-count');
    if (!list) return;
    if (count) count.textContent = P.t('align.list.count', '{n} candidates', { n: P.num(state.total) });
    if (!state.relationships.length) {
      P.empty(list, P.t('align.list.empty', 'No relationship candidate matches these filters.'));
      return;
    }
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = state.relationships.map(candidateRow).join('');
    Array.prototype.forEach.call(list.querySelectorAll('button[data-id]'), function (button) {
      button.addEventListener('click', function () { select(button.getAttribute('data-id')); });
    });
  }

  function sideCard(source, role, language) {
    return '<div class="pw-fact"><dt>' + P.esc(P.label(role)) + '</dt><dd>' +
      P.esc(source ? source.label : '—') + '<br><span class="pw-mono">' +
      P.esc(source ? source.file_digest : '') + '</span><br>' +
      P.esc(P.label(language)) + '</dd></div>';
  }

  function renderDetail() {
    var panel = $('al-detail');
    if (!panel) return;
    if (!state.detail) {
      P.empty(panel, P.t('align.detail.empty', 'Select a candidate pair to see the evidence behind it.'));
      return;
    }
    var relationship = state.detail.relationship;
    var sources = state.detail.sources || [];
    var byRef = {};
    sources.forEach(function (source) { byRef[source.ref] = source; });
    var expert = P.isExpert(state.who);

    panel.setAttribute('aria-busy', 'false');
    panel.innerHTML =
      '<h2>' + P.esc(P.label(relationship.relationship_type)) + '</h2>' +
      '<p class="pw-hint">' + P.esc(relationship.role_note || '') + '</p>' +
      '<div class="pw-tags">' + P.statusTag(relationship.review_state) +
      '<span class="pw-tag candidate">' + P.esc(P.t('align.notValidated', 'Not a validated translation')) + '</span>' +
      '<span class="pw-tag">' + P.esc(P.t('align.confidence', 'Confidence {v}', { v: P.pct(relationship.confidence) })) + '</span>' +
      // A seeded pair carries the same word as method and origin; show it once.
      '<span class="pw-tag">' + P.esc(P.label(relationship.method)) + '</span>' +
      (relationship.origin && relationship.origin !== relationship.method
        ? '<span class="pw-tag">' + P.esc(P.label(relationship.origin)) + '</span>' : '') + '</div>' +

      '<h3>' + P.esc(P.t('align.sources.title', 'The two sources')) + '</h3>' +
      '<dl class="pw-facts">' +
      sideCard(byRef[relationship.left.ref], relationship.left.role, relationship.left.language) +
      sideCard(byRef[relationship.right.ref], relationship.right.role, relationship.right.language) +
      '</dl>' +

      '<h3>' + P.esc(P.t('align.evidence.title', 'Signals that fired')) + '</h3>' +
      '<div class="pw-signals">' + (relationship.signals || []).map(function (signal) {
        return '<div class="pw-signal"><span>' + P.esc(P.label(signal.signal)) +
          (signal.detail == null ? '' : ' — ' + P.esc(signal.detail)) + '</span><span>' +
          P.esc(signal.weight == null ? '' : '+' + signal.weight) + '</span></div>';
      }).join('') + '</div>' +
      (Object.keys(relationship.evidence || {}).length
        ? '<h3>' + P.esc(P.t('align.measurements.title', 'Measurements')) + '</h3><div class="pw-signals">' +
          Object.keys(relationship.evidence).sort().map(function (key) {
            var value = relationship.evidence[key];
            return '<div class="pw-signal"><span>' + P.esc(P.label(key)) + '</span><span>' +
              P.esc(Array.isArray(value) ? value.join(', ') : String(value)) + '</span></div>';
          }).join('') + '</div>'
        : '') +

      '<h3>' + P.esc(P.t('align.decision.title', 'Candidate decision')) + '</h3>' +
      '<div class="field-wrap"><label for="al-note">' + P.esc(P.t('align.decision.note', 'Note')) + '</label>' +
      '<textarea class="pw-note" id="al-note" placeholder="' +
      P.esc(P.t('align.decision.notePlaceholder', 'Why this pair is or is not what it claims to be.')) + '"></textarea></div>' +
      '<div class="pw-actions">' +
      '<button class="btn btn-ok" id="al-accept"' + (expert ? '' : ' disabled') + '>' +
      P.esc(P.t('align.decision.accept', 'Accept candidate')) + '</button>' +
      '<button class="btn" id="al-in-review">' + P.esc(P.t('align.decision.inReview', 'Mark in review')) + '</button>' +
      '<button class="btn btn-warn" id="al-reject">' + P.esc(P.t('align.decision.reject', 'Reject')) + '</button>' +
      '</div>' +
      (expert ? '' : '<p class="pw-hint">' + P.esc(P.t('align.decision.roleHint',
        'Accepting a candidate is a verified-expert decision.')) + '</p>') +
      '<div class="pw-feedback' + (state.feedback ? ' ' + state.feedback.kind : '') + '" id="al-feedback">' +
      P.esc(state.feedback ? state.feedback.message : '') + '</div>';

    var bind = function (id, next) {
      var button = $(id);
      if (button) button.addEventListener('click', function () { review(next); });
    };
    bind('al-accept', 'accepted_candidate');
    bind('al-in-review', 'in_review');
    bind('al-reject', 'rejected');
  }

  function review(next) {
    if (!state.detail) return;
    var note = $('al-note') ? $('al-note').value : null;
    P.api('/api/private/relationships/' + encodeURIComponent(state.detail.relationship.id) + '/review', {
      method: 'POST', body: { review_state: next, note: note },
    }).then(function (result) {
      if (!result.ok) {
        state.feedback = { kind: 'bad', message: P.reasonFor(result) };
        renderFeedback('al-feedback');
        return;
      }
      state.feedback = { kind: 'ok', message: P.t('align.decision.saved', 'Decision recorded.') };
      select(state.detail.relationship.id);
      load();
    });
  }

  function renderFeedback(id) {
    var box = $(id);
    if (!box || !state.feedback) return;
    box.className = 'pw-feedback ' + state.feedback.kind;
    box.textContent = state.feedback.message;
  }

  function unitBlock(unit) {
    var expert = P.isExpert(state.who);
    var left = unit.left_text ? P.esc(unit.left_text)
      : '<span>' + P.esc(P.t('align.unit.noLeft', 'No counterpart on this side')) + '</span>';
    var right = unit.right_text ? P.esc(unit.right_text)
      : '<span>' + P.esc(P.t('align.unit.noRight', 'No counterpart on this side')) + '</span>';
    var cardinalitySelect = '<div class="select-wrap"><select data-adjust="' + P.esc(unit.id) + '">' +
      ['one_to_one', 'one_to_many', 'many_to_one', 'unmatched_left', 'unmatched_right'].map(function (value) {
        return '<option value="' + value + '"' + (value === unit.cardinality ? ' selected' : '') + '>' +
          P.esc(P.label(value)) + '</option>';
      }).join('') + '</select></div>';
    return '<div class="pw-unit level-' + P.esc(unit.level) + '" id="unit-' + P.esc(unit.id) + '">' +
      '<div class="pw-unit-head"><span>' + P.esc(P.label(unit.level)) + ' #' + P.esc(unit.ordinal) + ' · ' +
      P.esc(P.label(unit.cardinality)) + ' · ' + P.esc(P.t('align.confidence', 'Confidence {v}', { v: P.pct(unit.confidence) })) +
      (unit.adjusted ? ' · ' + P.esc(P.t('align.unit.adjusted', 'adjusted by a reviewer')) : '') + '</span>' +
      P.statusTag(unit.review_state) + '</div>' +
      '<div class="pw-unit-body"><div class="pw-unit-side' + (unit.left_text ? '' : ' empty') + '">' + left + '</div>' +
      '<div class="pw-unit-side' + (unit.right_text ? '' : ' empty') + '">' + right + '</div></div>' +
      '<div class="pw-unit-actions">' +
      '<button class="btn btn-sm btn-ok" data-action="accept" data-unit="' + P.esc(unit.id) + '"' + (expert ? '' : ' disabled') + '>' +
      P.esc(P.t('align.unit.accept', 'Accept')) + '</button>' +
      '<button class="btn btn-sm btn-warn" data-action="reject" data-unit="' + P.esc(unit.id) + '">' +
      P.esc(P.t('align.unit.reject', 'Reject')) + '</button>' +
      cardinalitySelect +
      '<button class="btn btn-sm" data-action="adjust" data-unit="' + P.esc(unit.id) + '">' +
      P.esc(P.t('align.unit.adjust', 'Save adjustment')) + '</button>' +
      '</div>' +
      unit.children.map(unitBlock).join('') +
      '</div>';
  }

  function renderAlignment() {
    var box = $('al-alignment');
    if (!box) return;
    if (!state.detail) { box.innerHTML = ''; return; }
    var alignment = state.alignment;
    var header = '<h2>' + P.esc(P.t('align.alignment.title', 'Alignment')) + '</h2>' +
      '<p class="pw-hint">' + P.esc(P.t('align.alignment.hint',
        'Section, paragraph and sentence units produced from the stored text. Correct a unit rather than ' +
        'regenerating the alignment: regeneration is refused once decisions exist.')) + '</p>';
    if (!alignment || !alignment.total_units) {
      box.setAttribute('aria-busy', 'false');
      box.innerHTML = header +
        '<div class="pw-empty">' + P.esc(P.t('align.alignment.empty',
          'No alignment has been produced for this pair yet.')) + '</div>' +
        '<div class="pw-actions"><button class="btn btn-primary" id="al-generate">' +
        P.esc(P.t('align.alignment.generate', 'Produce alignment')) + '</button></div>' +
        '<div class="pw-feedback" id="al-align-feedback"></div>';
      var generate = $('al-generate');
      if (generate) generate.addEventListener('click', produceAlignment);
      return;
    }
    var counts = alignment.cardinalities || {};
    box.setAttribute('aria-busy', 'false');
    box.innerHTML = header +
      '<div class="pw-tags">' + Object.keys(counts).sort().map(function (key) {
        return '<span class="pw-tag">' + P.esc(P.label(key)) + ' · ' + P.esc(P.num(counts[key])) + '</span>';
      }).join('') +
      '<span class="pw-tag candidate">' + P.esc(P.t('align.notValidated', 'Not a validated translation')) + '</span></div>' +
      '<div class="pw-feedback" id="al-align-feedback"></div>' +
      alignment.sections.map(unitBlock).join('');

    Array.prototype.forEach.call(box.querySelectorAll('button[data-unit]'), function (button) {
      button.addEventListener('click', function () {
        var id = button.getAttribute('data-unit');
        var action = button.getAttribute('data-action');
        var body = { action: action };
        if (action === 'adjust') {
          var select = box.querySelector('select[data-adjust="' + id + '"]');
          if (select) body.cardinality = select.value;
        }
        P.api('/api/private/alignment-units/' + encodeURIComponent(id) + '/review', {
          method: 'POST', body: body,
        }).then(function (result) {
          var feedback = $('al-align-feedback');
          if (!result.ok) {
            if (feedback) { feedback.className = 'pw-feedback bad'; feedback.textContent = P.reasonFor(result); }
            return;
          }
          if (feedback) {
            feedback.className = 'pw-feedback ok';
            feedback.textContent = P.t('align.unit.saved', 'Unit decision recorded.');
          }
          loadAlignment();
        });
      });
    });
  }

  function produceAlignment() {
    if (!state.detail || state.busy) return;
    state.busy = true;
    var button = $('al-generate');
    if (button) button.disabled = true;
    P.api('/api/private/relationships/' + encodeURIComponent(state.detail.relationship.id) + '/alignment', {
      method: 'POST', body: {},
    }).then(function (result) {
      state.busy = false;
      if (button) button.disabled = false;
      var feedback = $('al-align-feedback');
      if (!result.ok) {
        if (feedback) { feedback.className = 'pw-feedback bad'; feedback.textContent = P.reasonFor(result); }
        return;
      }
      if (!result.data.generated && result.data.reason === 'no_extracted_units' && feedback) {
        feedback.className = 'pw-feedback bad';
        feedback.textContent = P.t('align.alignment.noText',
          'One of these sources has no extracted text, so no alignment can be produced.');
        return;
      }
      loadAlignment();
      load();
    });
  }

  function loadAlignment() {
    if (!state.detail) return Promise.resolve();
    var box = $('al-alignment');
    P.loading(box);
    return P.api('/api/private/relationships/' + encodeURIComponent(state.detail.relationship.id) + '/alignment')
      .then(function (result) {
        if (!result.ok) { P.error(box, P.reasonFor(result)); return; }
        state.alignment = result.data;
        renderAlignment();
      });
  }

  function select(id) {
    state.selectedId = id;
    state.feedback = null;
    var panel = $('al-detail');
    P.loading(panel);
    renderList();
    return P.api('/api/private/relationships/' + encodeURIComponent(id)).then(function (result) {
      if (!result.ok) { P.error(panel, P.reasonFor(result)); return; }
      state.detail = result.data;
      renderDetail();
      return loadAlignment();
    });
  }

  function load() {
    var params = new URLSearchParams();
    if (state.filters.q) params.set('q', state.filters.q);
    if (state.filters.relationship_type) params.set('relationship_type', state.filters.relationship_type);
    if (state.filters.review_state) params.set('review_state', state.filters.review_state);
    params.set('limit', '100');
    var list = $('al-list');
    P.loading(list);
    return P.api('/api/private/relationships?' + params.toString()).then(function (result) {
      if (!result.ok) { P.error(list, P.reasonFor(result)); return; }
      state.relationships = result.data.relationships || [];
      state.total = result.data.total || 0;
      renderList();
    });
  }

  function bindFilters() {
    var debounce = null;
    var search = $('al-q');
    if (search) {
      search.addEventListener('input', function () {
        state.filters.q = search.value;
        clearTimeout(debounce);
        debounce = setTimeout(load, 220);
      });
    }
    ['al-type', 'al-review'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('change', function () {
        state.filters[id === 'al-type' ? 'relationship_type' : 'review_state'] = el.value;
        load();
      });
    });
  }

  function fillFilters() {
    P.fillSelect($('al-type'), TYPES, P.t('align.filter.type.all', 'All relationship types'));
    P.fillSelect($('al-review'), REVIEW_STATES, P.t('align.filter.review.all', 'All review statuses'));
  }

  function relocalize() {
    var banner = $('pw-banner');
    if (banner) banner.innerHTML = P.candidateBanner();
    if (!state.who) return;
    fillFilters();
    renderList();
    renderDetail();
    renderAlignment();
  }

  function boot() {
    var banner = $('pw-banner');
    if (banner) banner.innerHTML = P.candidateBanner();
    P.requireReviewer(app).then(function (who) {
      if (!who) return;
      state.who = who;
      app.setAttribute('aria-busy', 'false');
      app.innerHTML = '';
      app.appendChild($('align-template').content.cloneNode(true));
      if (window.I18n && window.I18n.apply) window.I18n.apply(app);
      fillFilters();
      bindFilters();
      renderDetail();
      load().then(function () {
        var requested = new URLSearchParams(location.search).get('relationship');
        if (requested) select(requested);
      });
      P.onLanguageChange(relocalize);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
