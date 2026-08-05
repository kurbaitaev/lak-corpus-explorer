/* Source Intelligence — the authenticated private source browser.
 *
 * Lists every source held in the research layers (public corpus sources, the
 * audited v1.2 layer and the private v1.3 registry), filters across all of
 * them, groups them into families, and opens one source at a time with its
 * immutable provenance, its proposed relationships, corroborating spellings
 * and the four independent decisions.
 *
 * The screen shows only what the server returns over authenticated routes.
 * Relationship proposals are candidates: the banner says so and each row is
 * labelled with its review state.
 */
(function () {
  'use strict';

  var P = window.PW;
  var state = {
    who: null,
    facets: null,
    sources: [],
    total: 0,
    selected: null,
    detail: null,
    families: [],
    view: 'sources',
    filters: { q: '', scope: 'all', material_type: '', language: '', family_key: '', extraction_quality: '', rights_status: '', review_state: '', access_status: '' },
    feedback: null,
  };
  var $ = function (id) { return document.getElementById(id); };
  var app = $('si-app');

  var SCOPES = ['all', 'private_v13', 'private_v12', 'public_corpus'];

  function renderStats(status) {
    var box = $('si-stats');
    if (!box || !status) return;
    var privateSources = status.private_sources || {};
    var alignmentUnits = status.alignment_units || {};
    var queue = status.rights_queue || {};
    var stat = function (value, key, def) {
      return '<div class="pw-stat"><b>' + P.esc(P.num(value)) + '</b><span>' + P.esc(P.t(key, def)) + '</span></div>';
    };
    box.innerHTML =
      stat(privateSources.total, 'si.stat.privateSources', 'Private sources') +
      stat(status.public_sources, 'si.stat.publicSources', 'Public corpus sources') +
      stat(status.families, 'si.stat.families', 'Families') +
      stat(status.relationship_total, 'si.stat.candidates', 'Relationship candidates') +
      stat(alignmentUnits.total, 'si.stat.alignmentUnits', 'Alignment units') +
      stat(queue.open, 'si.stat.rightsOpen', 'Rights items open');
  }

  function sourceItem(source) {
    var active = state.selected && state.selected.kind === source.kind && state.selected.ref === source.ref;
    var canOpen = source.kind === 'v13_source';
    var tags = '<span class="pw-tag">' + P.esc(P.label(source.scope)) + '</span>' +
      '<span class="pw-tag">' + P.esc(P.label(source.material_type)) + '</span>' +
      P.statusTag(source.review_state) +
      '<span class="pw-tag">' + P.esc(P.label(source.rights_status)) + '</span>' +
      (source.relationship_count
        ? '<span class="pw-tag type">' + P.esc(P.t('si.tag.relationships', '{n} related', { n: source.relationship_count })) + '</span>'
        : '');
    return '<' + (canOpen ? 'button type="button"' : 'div') + ' class="pw-item' + (active ? ' active' : '') + '"' +
      (canOpen ? ' data-ref="' + P.esc(source.ref) + '"' : '') + '>' +
      '<div class="pw-item-title">' + P.esc(source.label) + '</div>' +
      '<div class="pw-item-meta">' + P.esc(source.family_key || '') +
      (source.language_scope ? ' · ' + P.esc(source.language_scope) : '') +
      (source.text_chars ? ' · ' + P.esc(P.num(source.text_chars)) + ' ' + P.esc(P.t('si.chars', 'chars')) : '') +
      '</div><div class="pw-tags">' + tags + '</div>' +
      '</' + (canOpen ? 'button' : 'div') + '>';
  }

  function renderList() {
    var list = $('si-list');
    var count = $('si-count');
    if (!list) return;
    if (count) {
      count.textContent = P.t('si.list.count', '{n} sources', { n: P.num(state.total) });
    }
    if (!state.sources.length) {
      P.empty(list, P.t('si.list.empty', 'No source matches these filters.'));
      return;
    }
    list.setAttribute('aria-busy', 'false');
    list.innerHTML = state.sources.map(sourceItem).join('');
    Array.prototype.forEach.call(list.querySelectorAll('button[data-ref]'), function (button) {
      button.addEventListener('click', function () { selectSource(button.getAttribute('data-ref')); });
    });
  }

  function fact(key, def, value, mono) {
    return '<div class="pw-fact"><dt>' + P.esc(P.t(key, def)) + '</dt><dd' + (mono ? ' class="pw-mono"' : '') + '>' +
      P.esc(value == null || value === '' ? '—' : value) + '</dd></div>';
  }

  function decisionForm(detail) {
    var source = detail.source;
    var expert = P.isExpert(state.who);
    var select = function (id, current, values) {
      return '<div class="select-wrap"><select id="' + id + '">' +
        values.map(function (value) {
          return '<option value="' + P.esc(value) + '"' + (value === current ? ' selected' : '') + '>' +
            P.esc(P.label(value)) + '</option>';
        }).join('') + '</select></div>';
    };
    return '<h3 data-i18n="si.decisions.title">' + P.esc(P.t('si.decisions.title', 'Decisions')) + '</h3>' +
      '<p class="pw-hint">' + P.esc(P.t('si.decisions.hint',
        'Rights, access, review and training are four separate decisions. The server refuses to raise exposure ' +
        'until rights are cleared and the review is accepted.')) + '</p>' +
      '<div class="pw-decisions">' +
      '<div class="field-wrap"><label for="si-d-rights">' + P.esc(P.t('si.filter.rights', 'Rights status')) + '</label>' +
      select('si-d-rights', source.rights_status, ['permission_pending', 'permission_granted', 'public_domain', 'restricted']) + '</div>' +
      '<div class="field-wrap"><label for="si-d-review">' + P.esc(P.t('si.filter.review', 'Review status')) + '</label>' +
      select('si-d-review', source.review_state, ['source_import_unreviewed', 'in_review', 'accepted_candidate', 'rejected']) + '</div>' +
      '<div class="field-wrap"><label for="si-d-access">' + P.esc(P.t('si.filter.access', 'Access')) + '</label>' +
      select('si-d-access', source.access_status, ['private_research', 'restricted', 'public']) + '</div>' +
      '<div class="field-wrap"><label for="si-d-training">' + P.esc(P.t('si.decisions.training', 'Training use')) + '</label>' +
      select('si-d-training', source.training_ready ? 'true' : 'false', ['false', 'true']) + '</div>' +
      '</div>' +
      '<div class="field-wrap"><label for="si-d-note">' + P.esc(P.t('si.decisions.note', 'Decision note')) + '</label>' +
      '<textarea class="pw-note" id="si-d-note" placeholder="' +
      P.esc(P.t('si.decisions.notePlaceholder', 'What was checked, and where the evidence came from.')) + '"></textarea></div>' +
      (expert ? '' : '<p class="pw-hint">' + P.esc(P.t('si.decisions.roleHint',
        'Accepting a review and raising exposure are verified-expert decisions.')) + '</p>') +
      '<div class="pw-actions"><button class="btn btn-primary" id="si-d-save">' +
      P.esc(P.t('si.decisions.save', 'Record decisions')) + '</button></div>' +
      '<div class="pw-feedback' + (state.feedback ? ' ' + state.feedback.kind : '') + '" id="si-d-feedback">' +
      P.esc(state.feedback ? state.feedback.message : '') + '</div>';
  }

  function relationshipRow(relationship) {
    var other = relationship.left.ref === String(state.selected.ref) ? relationship.right : relationship.left;
    var mine = relationship.left.ref === String(state.selected.ref) ? relationship.left : relationship.right;
    return '<div class="pw-item">' +
      '<div class="pw-item-title">' + P.esc(P.label(relationship.relationship_type)) + ' · ' + P.esc(other.label || other.ref) + '</div>' +
      '<div class="pw-item-meta">' +
      P.esc(P.t('si.rel.roles', 'This source: {a} · Other source: {b}', {
        a: P.label(mine.role), b: P.label(other.role),
      })) + '</div>' +
      '<div class="pw-tags">' + P.statusTag(relationship.review_state) +
      '<span class="pw-tag">' + P.esc(P.t('si.rel.confidence', 'Confidence {v}', { v: P.pct(relationship.confidence) })) + '</span>' +
      '<span class="pw-tag">' + P.esc(P.label(relationship.method)) + '</span></div>' +
      '<div class="pw-actions"><a class="btn btn-sm" href="/alignment.html?relationship=' + encodeURIComponent(relationship.id) + '">' +
      P.esc(P.t('si.rel.open', 'Open in Alignment Lab')) + '</a></div>' +
      '</div>';
  }

  function renderDetail() {
    var panel = $('si-detail');
    if (!panel) return;
    if (!state.detail) {
      P.empty(panel, P.t('si.detail.empty', 'Select a private source to see its provenance, relationships and decisions.'));
      return;
    }
    var detail = state.detail;
    var source = detail.source;
    var provenance = detail.provenance;
    panel.setAttribute('aria-busy', 'false');
    panel.innerHTML =
      '<h2>' + P.esc(source.label) + '</h2>' +
      '<p class="pw-hint">' + P.esc(P.label(source.material_type)) + ' · ' + P.esc(source.language_scope || '—') + '</p>' +
      '<div class="pw-tags">' + P.statusTag(source.review_state) +
      '<span class="pw-tag">' + P.esc(P.label(source.rights_status)) + '</span>' +
      '<span class="pw-tag">' + P.esc(P.label(source.access_status)) + '</span>' +
      '<span class="pw-tag">' + P.esc(P.t('si.tag.training', 'Training: {v}', { v: P.label(source.training_ready) })) + '</span></div>' +

      '<h3>' + P.esc(P.t('si.provenance.title', 'Provenance')) + '</h3>' +
      '<p class="pw-hint">' + P.esc(P.t('si.provenance.hint',
        'Copied verbatim from the received package. A decision never edits it.')) + '</p>' +
      '<dl class="pw-facts">' +
      fact('si.provenance.path', 'Source path', provenance.source_path, true) +
      fact('si.provenance.digest', 'File digest (SHA-256)', provenance.file_digest, true) +
      fact('si.provenance.sequence', 'Source sequence', provenance.source_sequence) +
      fact('si.provenance.units', 'Unit range', (provenance.unit_range || []).filter(function (v) { return v != null; }).join(' – ')) +
      fact('si.provenance.lines', 'Line range', (provenance.line_range || []).filter(function (v) { return v != null; }).join(' – ')) +
      fact('si.provenance.candidates', 'Extracted candidates', P.num(provenance.candidate_count)) +
      fact('si.provenance.chars', 'Characters', P.num(provenance.text_chars)) +
      fact('si.provenance.declared', 'Declared rights', P.label(provenance.declared_rights_status)) +
      fact('si.provenance.family', 'Family', source.family_key) +
      fact('si.provenance.quality', 'Extraction quality', P.label(source.extraction_quality)) +
      '</dl>' +

      '<h3>' + P.esc(P.t('si.relationships.title', 'Relationship candidates')) + '</h3>' +
      (detail.relationships.length
        ? detail.relationships.map(relationshipRow).join('')
        : '<div class="pw-empty">' + P.esc(P.t('si.relationships.empty', 'No relationship has been proposed for this source.')) + '</div>') +

      '<h3>' + P.esc(P.t('si.spellings.title', 'Corroborating spellings')) + '</h3>' +
      '<p class="pw-hint">' + P.esc(P.t('si.spellings.hint',
        'Spellings from this source that also occur elsewhere. They corroborate provenance; nothing is merged.')) + '</p>' +
      (detail.corroborating_spellings.length
        ? '<div class="pw-tags">' + detail.corroborating_spellings.map(function (entry) {
          return '<span class="pw-tag">' + P.esc(entry.form) +
            (entry.public_corpus ? ' · ' + P.esc(P.t('si.spellings.public', 'public corpus')) : '') +
            (entry.private_sources.length ? ' · ' + P.esc(P.t('si.spellings.private', '{n} private', { n: entry.private_sources.length })) : '') +
            '</span>';
        }).join('') + '</div>'
        : '<div class="pw-empty">' + P.esc(P.t('si.spellings.empty', 'No corroborating spelling was found.')) + '</div>') +

      decisionForm(detail) +

      '<h3>' + P.esc(P.t('si.history.title', 'Decision history')) + '</h3>' +
      (detail.decisions.length
        ? detail.decisions.map(function (decision) {
          return '<div class="pw-signal"><span>' + P.esc(P.label(decision.decision_type)) + ': ' +
            P.esc(P.label(decision.from_value)) + ' → ' + P.esc(P.label(decision.to_value)) +
            (decision.note ? ' — ' + P.esc(decision.note) : '') + '</span><span>' +
            P.esc(decision.decided_by_name) + '</span></div>';
        }).join('')
        : '<div class="pw-empty">' + P.esc(P.t('si.history.empty', 'No decision has been recorded yet.')) + '</div>');

    var save = $('si-d-save');
    if (save) save.addEventListener('click', submitDecisions);
  }

  function submitDecisions() {
    var detail = state.detail;
    if (!detail) return;
    var button = $('si-d-save');
    if (button) button.disabled = true;
    var body = {
      rights_status: $('si-d-rights').value,
      review_state: $('si-d-review').value,
      access_status: $('si-d-access').value,
      training_ready: $('si-d-training').value === 'true',
      note: $('si-d-note').value || null,
    };
    P.api('/api/private/rights-queue/' + encodeURIComponent(detail.source.ref) + '/decisions', {
      method: 'POST', body: body,
    }).then(function (result) {
      if (button) button.disabled = false;
      if (!result.ok) {
        var reason = P.reasonFor(result);
        var blockers = (result.data && result.data.blockers) || [];
        state.feedback = {
          kind: 'bad',
          message: reason + (blockers.length ? ' (' + blockers.map(P.label).join(', ') + ')' : ''),
        };
        renderFeedback();
        return;
      }
      state.feedback = { kind: 'ok', message: P.t('si.decisions.saved', 'Decisions recorded.') };
      selectSource(detail.source.ref);
      loadSources();
      loadStatus();
    });
  }

  function renderFeedback() {
    var box = $('si-d-feedback');
    if (!box || !state.feedback) return;
    box.className = 'pw-feedback ' + state.feedback.kind;
    box.textContent = state.feedback.message;
  }

  function familyBlock(family) {
    var counts = Object.keys(family.relationships).sort().map(function (type) {
      return '<span class="pw-tag type">' + P.esc(P.label(type)) + ' · ' + P.esc(P.num(family.relationships[type])) + '</span>';
    }).join('');
    return '<div class="pw-family"><h3>' + P.esc(family.family_key) + '</h3>' +
      '<div class="pw-tags">' +
      '<span class="pw-tag">' + P.esc(P.t('si.families.members', '{n} sources', { n: family.members.length })) + '</span>' +
      counts + '</div>' +
      '<div class="pw-list">' + family.members.map(function (member) {
        return '<div class="pw-item"><div class="pw-item-title">' + P.esc(member.label) + '</div>' +
          '<div class="pw-item-meta">' + P.esc(member.language_scope || '—') + ' · ' +
          P.esc(P.num(member.text_chars)) + ' ' + P.esc(P.t('si.chars', 'chars')) + '</div>' +
          '<div class="pw-tags">' + P.statusTag(member.review_state) +
          '<span class="pw-tag">' + P.esc(P.label(member.rights_status)) + '</span></div></div>';
      }).join('') + '</div></div>';
  }

  function renderFamilies() {
    var box = $('si-families');
    if (!box) return;
    if (!state.families.length) {
      P.empty(box, P.t('si.families.empty', 'No family groups more than one source yet.'));
      return;
    }
    box.setAttribute('aria-busy', 'false');
    box.innerHTML = state.families.map(familyBlock).join('');
  }

  function queryString() {
    var params = new URLSearchParams();
    Object.keys(state.filters).forEach(function (key) {
      if (state.filters[key]) params.set(key === 'q' ? 'q' : key, state.filters[key]);
    });
    params.set('limit', '200');
    return params.toString();
  }

  function loadSources() {
    var list = $('si-list');
    P.loading(list);
    return P.api('/api/private/intel/sources?' + queryString()).then(function (result) {
      if (!result.ok) { P.error(list, P.reasonFor(result)); return; }
      state.sources = result.data.sources || [];
      state.total = result.data.total || 0;
      renderList();
    });
  }

  function loadFamilies() {
    var box = $('si-families');
    P.loading(box);
    return P.api('/api/private/intel/families').then(function (result) {
      if (!result.ok) { P.error(box, P.reasonFor(result)); return; }
      state.families = result.data.families || [];
      renderFamilies();
    });
  }

  function loadStatus() {
    return P.api('/api/private/intel/status').then(function (result) {
      if (result.ok) renderStats(result.data);
    });
  }

  function selectSource(ref) {
    state.selected = { kind: 'v13_source', ref: String(ref) };
    state.feedback = null;
    var panel = $('si-detail');
    P.loading(panel);
    renderList();
    return P.api('/api/private/intel/sources/' + encodeURIComponent(ref)).then(function (result) {
      if (!result.ok) { P.error(panel, P.reasonFor(result)); return; }
      state.detail = result.data;
      renderDetail();
    });
  }

  function fillFilters() {
    var facets = state.facets || {};
    P.fillSelect($('si-scope'), SCOPES.slice(1), P.t('si.filter.scope.all', 'All layers'));
    var scope = $('si-scope');
    if (scope) {
      scope.innerHTML = '';
      SCOPES.forEach(function (value) {
        var option = document.createElement('option');
        option.value = value === 'all' ? '' : value;
        option.textContent = value === 'all' ? P.t('si.filter.scope.all', 'All layers') : P.label(value);
        scope.appendChild(option);
      });
      scope.value = state.filters.scope === 'all' ? '' : state.filters.scope;
    }
    P.fillSelect($('si-material'), facets.material_type, P.t('si.filter.material.all', 'All material types'));
    P.fillSelect($('si-language'), facets.language_scope, P.t('si.filter.language.all', 'All language scopes'));
    P.fillSelect($('si-family'), facets.family_key, P.t('si.filter.family.all', 'All families'));
    P.fillSelect($('si-quality'), facets.extraction_quality, P.t('si.filter.quality.all', 'All extraction qualities'));
    P.fillSelect($('si-rights'), facets.rights_status, P.t('si.filter.rights.all', 'All rights statuses'));
    P.fillSelect($('si-review'), facets.review_state, P.t('si.filter.review.all', 'All review statuses'));
    P.fillSelect($('si-access'), facets.access_status, P.t('si.filter.access.all', 'All access levels'));
  }

  function bindFilters() {
    var debounce = null;
    var bind = function (id, key, immediate) {
      var el = $(id);
      if (!el) return;
      el.addEventListener(immediate ? 'change' : 'input', function () {
        state.filters[key] = el.value;
        if (key === 'scope') state.filters.scope = el.value || 'all';
        clearTimeout(debounce);
        debounce = setTimeout(loadSources, immediate ? 0 : 220);
      });
    };
    bind('si-q', 'q', false);
    bind('si-scope', 'scope', true);
    bind('si-material', 'material_type', true);
    bind('si-language', 'language', true);
    bind('si-family', 'family_key', true);
    bind('si-quality', 'extraction_quality', true);
    bind('si-rights', 'rights_status', true);
    bind('si-review', 'review_state', true);
    bind('si-access', 'access_status', true);

    Array.prototype.forEach.call(document.querySelectorAll('.pw-tab'), function (tab) {
      tab.addEventListener('click', function () {
        state.view = tab.getAttribute('data-view');
        Array.prototype.forEach.call(document.querySelectorAll('.pw-tab'), function (other) {
          var active = other === tab;
          other.classList.toggle('active', active);
          other.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        $('si-sources-view').hidden = state.view !== 'sources';
        $('si-families-view').hidden = state.view !== 'families';
        if (state.view === 'families' && !state.families.length) loadFamilies();
      });
    });
  }

  function relocalize() {
    var banner = $('pw-banner');
    if (banner) banner.innerHTML = P.candidateBanner();
    if (!state.who) return;
    fillFilters();
    renderList();
    renderDetail();
    renderFamilies();
    loadStatus();
  }

  function boot() {
    var banner = $('pw-banner');
    if (banner) banner.innerHTML = P.candidateBanner();
    P.requireReviewer(app).then(function (who) {
      if (!who) return;
      state.who = who;
      var template = $('si-template');
      app.setAttribute('aria-busy', 'false');
      app.innerHTML = '';
      app.appendChild(template.content.cloneNode(true));
      if (window.I18n && window.I18n.apply) window.I18n.apply(app);
      P.api('/api/private/intel/facets').then(function (result) {
        state.facets = result.ok ? result.data : {};
        fillFilters();
        bindFilters();
        loadSources();
        renderDetail();
      });
      loadStatus();
      P.onLanguageChange(relocalize);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
