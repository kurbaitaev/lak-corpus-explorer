'use strict';

document.addEventListener('DOMContentLoaded', async () => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

  // ── Localization helper (canonical dictionary in i18n.js) ──
  const t = (key, def, vars) => {
    const I = window.I18n;
    if (I && typeof I.t === 'function') {
      const out = I.t(key, vars);
      if (out != null && out !== key) return out;
    }
    return def;
  };
  // Localized display labels — canonical status/direction values are preserved.
  const statusLabel = (status) => {
    if (status === 'approved') return t('lab.status.approved', 'approved');
    if (status === 'rejected') return t('lab.status.rejected', 'rejected');
    if (status === 'pending')  return t('lab.status.pending', 'pending');
    return t('lab.status.' + String(status || '').toLowerCase(), status);
  };
  const directionLabel = (direction) =>
    direction === 'ru2lak' ? t('lab.direction.ru2lak', 'RU→LAK') : t('lab.direction.lak2ru', 'LAK→RU');
  const errorCategoryLabels = {
    no_reliable_target: ['lab.errorCat.noReliableTarget', 'No reliable target'],
    ambiguous_source: ['lab.errorCat.ambiguousSource', 'Ambiguous source'],
    dialectal_gap: ['lab.errorCat.dialectalGap', 'Dialectal gap'],
    ocr_unreliable: ['lab.errorCat.ocrUnreliable', 'OCR evidence unreliable'],
    insufficient_evidence: ['lab.errorCat.insufficient', 'Insufficient evidence'],
    out_of_scope: ['lab.errorCat.outOfScope', 'Out of scope'],
    other: ['lab.errorCat.other', 'Other'],
  };
  function localizeErrorCategories() {
    const select = document.getElementById('lab-error-cat');
    if (!select) return;
    for (const option of select.options) {
      if (!option.value) option.textContent = t('lab.errorCat.none', 'None');
      else if (errorCategoryLabels[option.value]) {
        const [key, fallback] = errorCategoryLabels[option.value];
        option.textContent = t(key, fallback);
      }
    }
  }

  const authState = document.getElementById('lab-auth-state');
  const labApp = document.getElementById('lab-app');
  const identity = await window.fetchIdentity();
  labApp.style.display = 'block';
  authState.style.display = identity.account ? 'none' : 'block';

  let proposal = null;
  const toast = (message, type = 'ok') => {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = message;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => el.remove(), 4500);
  };
  const api = async (url, options) => {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || t('lab.error.requestFailed', 'Request failed.'));
    return data;
  };

  try {
    const p = await api('/api/lab/provider');
    document.getElementById('provider-info').textContent =
      t('lab.providerInfo', `${p.provider} · model ${p.model_version} · prompt ${p.prompt_version}`,
        { provider: p.provider, model: p.model_version, prompt: p.prompt_version });
  } catch {
    document.getElementById('provider-info').textContent = t('lab.evidenceOnlyMode', 'Evidence-only mode');
  }

  const workbench = document.getElementById('lab-workbench-view');
  const history = document.getElementById('lab-history-view');
  const workBtn = document.getElementById('btn-view-workbench');
  const historyBtn = document.getElementById('btn-view-history');
  function showView(name) {
    const showingHistory = name === 'history';
    workbench.style.display = showingHistory ? 'none' : 'block';
    history.style.display = showingHistory ? 'block' : 'none';
    workBtn.classList.toggle('btn-primary', !showingHistory);
    historyBtn.classList.toggle('btn-primary', showingHistory);
    if (showingHistory) loadHistory();
  }
  workBtn.addEventListener('click', () => showView('workbench'));
  historyBtn.addEventListener('click', () => {
    if (!identity.account) return toast(t('lab.toast.loginHistory', 'Log in to view saved translation pairs.'), 'warn');
    showView('history');
  });

  document.getElementById('propose-form').addEventListener('submit', async event => {
    event.preventDefault();
    const sourceText = document.getElementById('lab-source-text').value.trim();
    const direction = document.getElementById('lab-direction').value;
    if (!sourceText) return;
    const button = document.getElementById('btn-propose');
    button.disabled = true;
    document.getElementById('lab-propose-loading').style.display = 'block';
    document.getElementById('lab-proposal-area').style.display = 'none';
    try {
      proposal = await api('/api/lab/propose', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_text: sourceText, direction }),
      });
      document.getElementById('lab-literal-target').value = proposal.literal_target || '';
      document.getElementById('lab-natural-target').value = proposal.natural_target || '';
      document.getElementById('lab-abstained').checked = !!proposal.abstained;
      const coverage = proposal.coverage || {};
      const modeLabel = proposal.mode
        ? t('lab.mode.' + String(proposal.mode).toLowerCase().replace(/[^a-z0-9]+/g, '_'), proposal.mode)
        : t('lab.mode.evidence_only', 'evidence-only');
      document.getElementById('lab-proposal-meta').innerHTML = `
        <span class="lab-stat-badge">${esc(modeLabel)}</span>
        <span class="lab-stat-badge">${esc(t('lab.confidence', `Confidence ${Math.round((proposal.confidence || 0) * 100)}%`, { pct: Math.round((proposal.confidence || 0) * 100) }))}</span>
        <span class="lab-stat-badge">${esc(t('lab.evidenceRecords', `${coverage.total_evidence || 0} evidence records`, { count: coverage.total_evidence || 0 }))}</span>
        ${proposal.abstained ? `<span class="lab-stat-badge low-conf">${esc(t('lab.abstainedBadge', 'Insufficient evidence — abstained'))}</span>` : ''}`;
      const alternatives = proposal.alternatives || [];
      const alt = document.getElementById('lab-proposal-alternatives');
      alt.style.display = alternatives.length || (proposal.unknowns || []).length ? 'block' : 'none';
      alt.innerHTML = `<strong>${esc(t('lab.altHeading', 'Alternatives and unknowns'))}</strong>
        <p>${alternatives.length ? alternatives.map(item => esc(item.target || item)).join(' · ') : esc(t('lab.noAlternative', 'No supported alternative found.'))}</p>
        ${(proposal.unknowns || []).length ? `<p><b>${esc(t('lab.unknownLabel', 'Unknown:'))}</b> ${proposal.unknowns.map(item => esc(item.detail || item.reason || item)).join(', ')}</p>` : ''}`;
      const evidence = proposal.evidence || [];
      const ev = document.getElementById('lab-proposal-evidence');
      ev.style.display = 'block';
      ev.innerHTML = `<strong>${esc(t('lab.retrievedEvidence', 'Retrieved evidence'))}</strong>${evidence.length ? evidence.map(item => `
        <article class="lab-evidence-item">
          <div><span class="quality-badge ${item.validated ? 'q-approved' : item.is_ocr ? 'q-ocr' : 'q-unreviewed'}">${esc(evidenceTypeLabel(item.evidence_type))}</span>
          <b>${esc(item.lak_text || item.gloss)}</b></div>
          <p>${esc(item.gloss)} · ${esc(item.source)} · ${esc(item.variety || t('lab.unspecified', 'unspecified'))} · ${esc(item.record_ref)}</p>
        </article>`).join('') : `<p>${esc(t('lab.noEvidence', 'No authorized evidence found. The system has not invented a translation.'))}</p>`}`;
      document.getElementById('lab-evidence-ids').value =
        evidence.map(item => item.record_ref).filter(Boolean).join(', ');
      document.getElementById('lab-proposal-area').style.display = 'block';
      document.getElementById('lab-literal-target').focus();
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      button.disabled = false;
      document.getElementById('lab-propose-loading').style.display = 'none';
    }
  });

  // Localized display for evidence types. Canonical value preserved; only the
  // shown text is translated when a dictionary key exists.
  function evidenceTypeLabel(type) {
    const raw = String(type || '');
    const key = 'lab.evidenceType.' + raw.toLowerCase();
    return t(key, raw.replace(/_/g, ' '));
  }

  document.getElementById('btn-clear-propose').addEventListener('click', () => {
    proposal = null;
    document.getElementById('lab-proposal-area').style.display = 'none';
    document.getElementById('lab-source-text').value = '';
    document.getElementById('save-pair-form').reset();
  });

  document.getElementById('save-pair-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!identity.account) return toast(t('lab.toast.loginSave', 'Log in to save a translation pair.'), 'warn');
    const literal = document.getElementById('lab-literal-target').value.trim();
    const natural = document.getElementById('lab-natural-target').value.trim();
    const abstained = document.getElementById('lab-abstained').checked;
    if (!abstained && !literal && !natural) return toast(t('lab.toast.enterTranslation', 'Enter a human translation or abstain.'), 'warn');
    const payload = {
      source_text: document.getElementById('lab-source-text').value.trim(),
      direction: document.getElementById('lab-direction').value,
      target_literal: literal, target_natural: natural,
      variety: document.getElementById('lab-variety').value,
      orthography: document.getElementById('lab-orthography').value,
      source_type: document.getElementById('lab-source-type').value,
      source_provenance: document.getElementById('lab-provenance').value.trim(),
      rights_status: document.getElementById('lab-rights').value,
      access_status: document.getElementById('lab-access').value,
      evidence_ids: document.getElementById('lab-evidence-ids').value.split(',').map(x => x.trim()).filter(Boolean),
      abstained, error_category: document.getElementById('lab-error-cat').value,
      request_id: proposal && proposal.request_id,
      proposal_id: proposal && proposal.proposal_id,
      from_evidence: !!(proposal && proposal.evidence && proposal.evidence.length),
    };
    const button = document.getElementById('btn-save-pair');
    button.disabled = true;
    try {
      await api('/api/lab/pairs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      toast(t('lab.toast.pairSubmitted', 'Translation pair submitted for independent review.'));
      showView('history');
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      button.disabled = false;
    }
  });

  let lastPairs = null;
  async function loadHistory() {
    const tbody = document.getElementById('lab-history-tbody');
    const loading = document.getElementById('lab-history-loading');
    const empty = document.getElementById('lab-history-empty');
    loading.style.display = 'block'; empty.style.display = 'none'; tbody.innerHTML = '';
    loading.textContent = t('lab.history.loading', 'Loading…');
    try {
      const data = await api('/api/lab/my-pairs');
      loading.style.display = 'none';
      lastPairs = data.pairs || [];
      renderHistory();
    } catch (error) {
      loading.textContent = error.message;
    }
  }
  function renderHistory() {
    const tbody = document.getElementById('lab-history-tbody');
    const empty = document.getElementById('lab-history-empty');
    if (!lastPairs) return;
    if (!lastPairs.length) { empty.style.display = 'block'; tbody.innerHTML = ''; return; }
    empty.style.display = 'none';
    tbody.innerHTML = lastPairs.map(pair => `<tr>
      <td data-label="${esc(t('lab.col.direction', 'Direction'))}">${esc(directionLabel(pair.direction))}</td>
      <td data-label="${esc(t('lab.col.source', 'Source'))}">${esc(pair.source_text)}</td>
      <td data-label="${esc(t('lab.col.literalTarget', 'Literal target'))}">${esc(pair.target_literal || '—')}</td>
      <td data-label="${esc(t('lab.col.naturalTarget', 'Natural target'))}">${esc(pair.target_natural || '—')}</td>
      <td data-label="${esc(t('lab.col.status', 'Status'))}"><span class="quality-badge ${pair.status === 'approved' ? 'q-approved' : pair.status === 'rejected' ? 'q-flagged' : 'q-unreviewed'}">${esc(statusLabel(pair.status))}</span></td>
    </tr>`).join('');
  }

  // ── Re-render on language change ────────────────────────────
  function relocalize() {
    authState.style.display = identity.account ? 'none' : 'block';
    localizeErrorCategories();
    if (history.style.display !== 'none') renderHistory();
  }
  if (window.I18n && typeof window.I18n.onChange === 'function') window.I18n.onChange(relocalize);
  else window.addEventListener('i18n:change', relocalize);
  localizeErrorCategories();
});
