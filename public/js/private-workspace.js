/* Shared helpers for the private workspace screens (Source Intelligence,
 * Alignment Lab, Rights & candidate review).
 *
 * These screens only ever show data the server already decided the visitor may
 * see: every request goes to an authenticated route, and a 401/403 is rendered
 * as an access notice rather than as an error. The gate here is a courtesy for
 * the reader — the real gate is server-side.
 *
 * Canonical values (rights_status, review_state, cardinality, relationship
 * type, family keys, file digests, paths) are never rewritten: only their
 * visible labels are localized, through pw.value.* keys with the raw value as
 * the fallback.
 */
(function () {
  'use strict';

  function t(key, def, vars) {
    var I = window.I18n;
    if (I && typeof I.t === 'function') {
      var out = I.t(key, vars);
      if (out != null && out !== key) return out;
    }
    if (def == null) return key;
    if (!vars) return def;
    return String(def).replace(/\{(\w+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m;
    });
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function slug(value) {
    return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  // Display label for a canonical value. The value itself is the fallback, so
  // an unlocalized status is shown verbatim rather than as a missing key.
  function label(value) {
    if (value == null || value === '') return t('pw.value.none', '—');
    if (typeof value === 'boolean') return value ? t('pw.value.yes', 'Yes') : t('pw.value.no', 'No');
    return t('pw.value.' + slug(value), String(value));
  }

  function num(value) {
    if (value == null || value === '') return '—';
    var n = Number(value);
    if (!isFinite(n)) return String(value);
    try { return n.toLocaleString(window.I18n && window.I18n.getLanguage() === 'ru' ? 'ru-RU' : 'en-US'); }
    catch (e) { return String(n); }
  }

  function pct(value) {
    var n = Number(value);
    if (!isFinite(n)) return '—';
    return Math.round(n * 100) + '%';
  }

  // Fetch wrapper: returns { ok, status, data }. Never throws for HTTP errors,
  // so every caller can render the server's reason instead of a stack trace.
  function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    return fetch(path, init).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        return { ok: res.ok, status: res.status, data: data };
      });
    }).catch(function (err) {
      return { ok: false, status: 0, data: { error: err.message } };
    });
  }

  // Human-readable reason for a failed request, preferring the server's own
  // message so a server-side gate explains itself.
  function reasonFor(result) {
    if (!result) return t('pw.error.generic', 'Something went wrong. Try again.');
    if (result.status === 401) return t('pw.error.unauthenticated', 'Log in to open the private workspace.');
    if (result.status === 403) {
      return (result.data && result.data.error) ||
        t('pw.error.forbidden', 'Your role does not allow this action.');
    }
    if (result.status === 0) return t('pw.error.network', 'The server could not be reached.');
    return (result.data && result.data.error) || t('pw.error.generic', 'Something went wrong. Try again.');
  }

  function statusTag(state) {
    var cls = state === 'accepted_candidate' ? 'accepted'
      : state === 'rejected' ? 'rejected' : 'candidate';
    return '<span class="pw-tag ' + cls + '">' + esc(label(state)) + '</span>';
  }

  function candidateBanner() {
    return '<div class="pw-banner"><b>' + esc(t('pw.candidateBanner.title', 'Candidate, not validated.')) +
      '</b> <span>' + esc(t('pw.candidateBanner.body',
        'Everything on this screen was proposed from deterministic evidence. Nothing here is a validated ' +
        'translation until a reviewer with the right role accepts it.')) + '</span></div>';
  }

  function loading(container) {
    if (!container) return;
    container.setAttribute('aria-busy', 'true');
    container.innerHTML = '<div class="pw-loading">' + esc(t('pw.loading', 'Loading…')) + '</div>';
  }

  function empty(container, message) {
    if (!container) return;
    container.setAttribute('aria-busy', 'false');
    container.innerHTML = '<div class="pw-empty">' + esc(message || t('pw.empty', 'Nothing to show yet.')) + '</div>';
  }

  function error(container, message) {
    if (!container) return;
    container.setAttribute('aria-busy', 'false');
    container.innerHTML = '<div class="pw-error">' + esc(message || t('pw.error.generic', 'Something went wrong. Try again.')) + '</div>';
  }

  var TRUSTED_PLUS = ['trusted_validator', 'verified_expert', 'administrator'];
  var EXPERT_PLUS = ['verified_expert', 'administrator'];

  // Resolve the visitor's role. The server is asked, not the browser's memory.
  function identity() {
    return api('/api/auth/me').then(function (result) {
      var data = result.data || {};
      if (data.account) {
        return { signedIn: true, name: data.account.display_name, role: data.account.role };
      }
      if (data.reviewer) return { signedIn: true, name: data.reviewer, role: 'administrator' };
      return { signedIn: false, name: null, role: null };
    });
  }

  function gateMarkup(who) {
    if (!who.signedIn) {
      return '<div class="pw-gate"><h2>' + esc(t('pw.gate.signedOut.title', 'This workspace is private')) +
        '</h2><p>' + esc(t('pw.gate.signedOut.body',
          'Private sources, relationship candidates and alignment drafts are only available to signed-in ' +
          'reviewers. Nothing on these screens is public.')) + '</p>' +
        '<a class="btn btn-primary" href="/login.html">' + esc(t('pw.gate.logIn', 'Log in')) + '</a></div>';
    }
    return '<div class="pw-gate"><h2>' + esc(t('pw.gate.noRole.title', 'A reviewer role is required')) +
      '</h2><p>' + esc(t('pw.gate.noRole.body',
        'Your account is signed in, but only trusted validators and verified experts can open the private ' +
        'workspace.')) + '</p>' +
      '<a class="btn" href="/profile.html">' + esc(t('pw.gate.profile', 'Your profile')) + '</a></div>';
  }

  // Renders the gate into `container` and resolves with the identity when the
  // visitor may proceed, or null when they may not.
  function requireReviewer(container) {
    return identity().then(function (who) {
      if (who.signedIn && TRUSTED_PLUS.indexOf(who.role) !== -1) return who;
      if (container) {
        container.setAttribute('aria-busy', 'false');
        container.innerHTML = gateMarkup(who);
      }
      return null;
    });
  }

  function isExpert(who) { return !!who && EXPERT_PLUS.indexOf(who.role) !== -1; }

  function onLanguageChange(fn) {
    if (window.I18n && typeof window.I18n.onChange === 'function') window.I18n.onChange(fn);
    else window.addEventListener('i18n:change', fn);
  }

  function option(value, text) {
    var el = document.createElement('option');
    el.value = value;
    el.textContent = text;
    return el;
  }

  // Fills a <select> with canonical values, keeping the first (all) option.
  function fillSelect(select, values, allLabel) {
    if (!select) return;
    var previous = select.value;
    select.innerHTML = '';
    select.appendChild(option('', allLabel));
    (values || []).forEach(function (value) { select.appendChild(option(value, label(value))); });
    if (previous && values && values.indexOf(previous) !== -1) select.value = previous;
  }

  window.PW = {
    t: t, esc: esc, slug: slug, label: label, num: num, pct: pct,
    api: api, reasonFor: reasonFor, statusTag: statusTag, candidateBanner: candidateBanner,
    loading: loading, empty: empty, error: error,
    identity: identity, requireReviewer: requireReviewer, isExpert: isExpert,
    onLanguageChange: onLanguageChange, fillSelect: fillSelect,
    TRUSTED_PLUS: TRUSTED_PLUS, EXPERT_PLUS: EXPERT_PLUS,
  };
})();
