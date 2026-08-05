(function () {
  'use strict';

  // Public research-update page.
  //
  // Everything shown here comes from /api/research/update, which can only
  // emit counts, booleans and canonical identifiers. This script therefore
  // never renders free text from the server: canonical ids are turned into
  // localized labels through the dictionary, and unknown ids fall back to a
  // neutral placeholder rather than being printed raw.

  const state = { summary: null, error: null };
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function t(key, def, vars) {
    const I = window.I18n;
    if (I && typeof I.t === 'function') {
      const out = I.t(key, vars);
      if (out != null && out !== key) return out;
    }
    return def;
  }
  function localeTag() {
    const I = window.I18n;
    return (I && I.getLanguage && I.getLanguage() === 'ru') ? 'ru-RU' : 'en-GB';
  }
  const num = value => (typeof value === 'number' && isFinite(value))
    ? value.toLocaleString(localeTag())
    : t('research.value.unknown', 'not counted yet');

  // Canonical id → localized label, with a neutral fallback so a new id from
  // the server can never appear as a raw key.
  function label(kind, value) {
    if (!value) return t('research.value.unknown', 'not counted yet');
    return t('research.' + kind + '.' + value, String(value).replace(/_/g, ' '));
  }

  const AGGREGATES = [
    ['source_routes', 'research.stat.sourceRoutes', 'Files audited'],
    ['rights_review_items', 'research.stat.rightsReviews', 'Substantive materials'],
    ['usable_private_extractions', 'research.stat.extractions', 'Usable extractions'],
    ['private_lexicon_lines', 'research.stat.lexiconLines', 'Lexicon candidate lines'],
    ['private_text_segments', 'research.stat.textBlocks', 'Text blocks'],
    ['private_grammar_examples', 'research.stat.grammarExamples', 'Grammar-example candidates'],
    ['private_reference_index', 'research.stat.referenceRecords', 'Reference records'],
  ];

  const WORKFLOW_STEPS = [
    ['research.step.discover', 'Spot the versions',
      'Audited files are grouped into families when the same work appears more than once — two languages, two scripts, two editions, or a recording with its transcription.'],
    ['research.step.route', 'Route, never merge',
      'Each file is routed to a private candidate layer with its rights state attached. Nothing is merged into the corpus, and a duplicate is only ever linked as corroboration.'],
    ['research.step.pair', 'Human pairing',
      'A person decides which passages actually correspond. Proximity of filenames is not evidence of sentence equivalence, so no automatic alignment is trusted.'],
    ['research.step.review', 'Expert review and rights',
      'A pair becomes usable only after an expert approves it and the rights holder has cleared the source. Only then can it reach a public surface.'],
  ];

  function stat(labelText, value, note) {
    return '<div class="obs-stat"><b>' + esc(value) + '</b><span>' + esc(labelText) +
      (note ? ' <em class="research-stat-note">' + esc(note) + '</em>' : '') + '</span></div>';
  }

  function renderStats() {
    const summary = state.summary;
    const box = $('research-stats');
    if (!box) return;
    if (!summary) { box.innerHTML = ''; return; }
    const audited = summary.audited || {};
    box.innerHTML = AGGREGATES
      .map(([key, i18nKey, fallback]) => stat(t(i18nKey, fallback), num(audited[key])))
      .join('');
  }

  function renderPublic() {
    const box = $('research-public');
    if (!box) return;
    const summary = state.summary;
    if (state.error) {
      box.innerHTML = '<div class="research-note research-note-error"><h2>' +
        esc(t('research.error.title', 'The research summary could not be loaded')) + '</h2><p>' +
        esc(t('research.error.body', 'Nothing is missing from the corpus — only this summary is unavailable. Please try again later.')) +
        '</p></div>';
      return;
    }
    if (!summary) {
      box.innerHTML = '<div class="research-note"><p>' + esc(t('research.loading', 'Loading the research update…')) + '</p></div>';
      return;
    }
    const corpus = summary.public_corpus || {};
    const staged = summary.staged;
    const progress = summary.progress;
    const verification = summary.package ? summary.package.verification_status : 'preparing';

    const checks = [
      [t('research.public.corpusRecords', 'Public corpus records'), num(corpus.records),
        t('research.public.corpusRecordsNote', 'unchanged by this research round')],
      [t('research.public.observatory', 'Observatory resources'), num(corpus.observatory_resources),
        t('research.public.observatoryNote', 'counted separately from the corpus')],
      [t('research.public.added', 'Records added to the public corpus'), num(corpus.records_added_by_v13),
        t('research.public.addedNote', 'every candidate stays private')],
      [t('research.public.searchable', 'Private candidates searchable here'), num(corpus.public_candidates),
        t('research.public.searchableNote', 'excluded from search and exports')],
    ];

    const stagedRows = staged
      ? AGGREGATES.map(([key, i18nKey, fallback]) =>
        '<tr><td data-label="' + esc(t('research.table.measure', 'Measure')) + '">' + esc(t(i18nKey, fallback)) + '</td>' +
        '<td data-label="' + esc(t('research.table.audited', 'Audited')) + '">' + esc(num(summary.audited[key])) + '</td>' +
        '<td data-label="' + esc(t('research.table.staged', 'Staged')) + '">' + esc(num(staged[key])) + '</td></tr>').join('')
      : '';

    box.innerHTML =
      '<div class="research-note"><h2>' + esc(t('research.public.h2', 'The public corpus did not change')) + '</h2>' +
      '<p>' + esc(t('research.public.body',
        'Everything counted above lives in the private research layer. It is not searchable on this site, not exported, and not used for training.')) + '</p>' +
      '<div class="obs-stats research-checks">' +
      checks.map(([labelText, value, note]) => stat(labelText, value, note)).join('') + '</div></div>' +
      '<div class="research-verify">' +
      '<span class="research-chip ' + (verification === 'verified' ? 'ok' : 'warn') + '">' +
      esc(t('research.verify.' + verification, verification === 'verified' ? 'Package verified' : 'Verification pending')) + '</span>' +
      // While the package is still landing, say how far it has got rather than
      // leaving an unexplained "pending" chip on the page.
      (progress && !progress.complete
        ? '<span class="research-chip warn">' + esc(t('research.verify.progress', {
          staged: num(progress.records_staged),
          declared: num(progress.records_declared),
          done: num(progress.layers_complete),
          total: num(progress.layers_total),
        })) + '</span>'
        : '') +
      '<span class="research-chip ' + (summary.counts_match ? 'ok' : 'warn') + '">' +
      esc(summary.counts_match
        ? t('research.verify.countsMatch', 'Staged counts match the audit')
        : t('research.verify.countsUnconfirmed', 'Staged counts not confirmed against the audit')) + '</span>' +
      '</div>' +
      (stagedRows
        ? '<div class="table-wrap research-table"><table><thead><tr>' +
          '<th>' + esc(t('research.table.measure', 'Measure')) + '</th>' +
          '<th>' + esc(t('research.table.audited', 'Audited')) + '</th>' +
          '<th>' + esc(t('research.table.staged', 'Staged')) + '</th>' +
          '</tr></thead><tbody>' + stagedRows + '</tbody></table></div>'
        : '<p class="research-lede">' + esc(t('research.table.none',
          'Nothing has been staged yet, so only the audited expectations are shown.')) + '</p>');
  }

  function renderSteps() {
    const box = $('research-steps');
    if (!box) return;
    box.innerHTML = WORKFLOW_STEPS.map(([key, title, body]) =>
      '<li class="research-step"><h3>' + esc(t(key + '.title', title)) + '</h3><p>' +
      esc(t(key + '.body', body)) + '</p></li>').join('');
  }

  function familyCard(family, index) {
    const files = family.files;
    const counts = files == null
      ? '<span class="research-chip warn">' + esc(t('research.family.countsPending', 'File counts pending verification')) + '</span>'
      : '<span class="research-chip">' + esc(t('research.family.files', files + ' files in this family',
        { count: files.toLocaleString(localeTag()) })) + '</span>' +
        '<span class="research-chip">' + esc(t('research.family.candidateFiles',
          family.candidate_files + ' produced candidates',
          { count: (family.candidate_files || 0).toLocaleString(localeTag()) })) + '</span>';

    const steps = (family.blocking_steps || []).map(step =>
      '<li>' + esc(label('blocking', step)) + '</li>').join('');

    return '<article class="obs-card research-family" style="animation-delay:' + Math.min(index * 24, 240) + 'ms">' +
      '<div class="obs-card-head"><div><h3>' + esc(t('research.family.' + family.id, family.title || '')) + '</h3>' +
      '<div class="obs-byline">' + esc(label('familyKind', family.family)) + '</div></div>' +
      '<span class="obs-priority p2">' + esc(label('status', family.review_status)) + '</span></div>' +
      '<div class="obs-tags"><span class="obs-tag">' + esc(label('method', family.method)) + '</span>' +
      '<span class="obs-tag status">' + esc(label('route', family.route)) + '</span>' +
      '<span class="obs-tag rights">' + esc(label('rights', family.rights_status)) + '</span>' +
      '<span class="obs-tag rights">' + esc(label('access', family.access_status)) + '</span></div>' +
      '<div class="research-chips">' + counts + '</div>' +
      '<div class="obs-action"><strong>' + esc(t('research.family.before', 'Before anything here becomes public')) + '</strong>' +
      '<ul class="research-family-steps">' + steps + '</ul></div>' +
      '<p class="obs-notes">' + esc(t('research.family.noContent',
        'Metadata only — no passage, page image or extracted line from this family is published.')) + '</p>' +
      '</article>';
  }

  function renderFamilies() {
    const box = $('research-families');
    if (!box) return;
    box.setAttribute('aria-busy', 'false');
    if (state.error) {
      box.innerHTML = '<div class="obs-empty"><h3>' + esc(t('research.error.title', 'The research summary could not be loaded')) +
        '</h3><p>' + esc(t('research.error.body',
          'Nothing is missing from the corpus — only this summary is unavailable. Please try again later.')) + '</p></div>';
      return;
    }
    const families = (state.summary && state.summary.families) || [];
    if (!families.length) {
      box.innerHTML = '<div class="obs-empty"><h3>' + esc(t('research.families.empty.title', 'No source families to show yet')) +
        '</h3><p>' + esc(t('research.families.empty.body',
          'Families appear here once a package has been verified.')) + '</p></div>';
      return;
    }
    box.innerHTML = '<div class="obs-grid">' + families.map(familyCard).join('') + '</div>';
  }

  function renderGate() {
    const box = $('research-gate');
    if (!box) return;
    const steps = (state.summary && state.summary.families && state.summary.families[0]
      && state.summary.families[0].blocking_steps) || ['rights_clearance', 'human_pairing_map', 'expert_review'];
    box.innerHTML = steps.map(step =>
      '<li><strong>' + esc(label('blocking', step)) + '</strong> ' +
      esc(t('research.blockingBody.' + step, '')) + '</li>').join('');
  }

  function renderAll() {
    renderStats();
    renderPublic();
    renderSteps();
    renderFamilies();
    renderGate();
  }

  async function load() {
    try {
      const res = await fetch('/api/research/update');
      if (!res.ok) throw new Error('request failed');
      state.summary = await res.json();
      state.error = null;
    } catch (err) {
      state.summary = null;
      state.error = err;
    }
    renderAll();
  }

  renderAll();
  load();
  if (window.I18n && typeof window.I18n.onChange === 'function') {
    window.I18n.onChange(renderAll);
  }
})();
