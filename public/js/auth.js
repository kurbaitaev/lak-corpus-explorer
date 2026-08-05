'use strict';

// Shared identity helper: updates the nav auth link on every page.
// Supports both contributor accounts and the legacy reviewer session.
window.REVIEWER = null;
window.ACCOUNT = null;

// Safe localization wrapper. The canonical dictionary lives in i18n.js; this
// only forwards calls and falls back to the supplied English default when
// I18n (or a specific key) is unavailable, so pages never break.
function t(key, def, vars) {
  const I = window.I18n;
  if (I && typeof I.t === 'function') {
    const out = I.t(key, vars);
    if (out != null && out !== key) return out;
  }
  return def;
}

window.fetchIdentity = async function() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error('me failed');
    const data = await res.json();
    window.REVIEWER = data.reviewer || null;
    window.ACCOUNT = data.account || null;
  } catch {
    window.REVIEWER = null;
    window.ACCOUNT = null;
  }
  updateAuthLink();
  updatePrivateLink();
  return { reviewer: window.REVIEWER, account: window.ACCOUNT };
};

// Roles allowed into the private workspace. This mirrors the server's gate; it
// only decides whether the nav link is shown, never what data is available.
const TRUSTED_PLUS_ROLES = ['trusted_validator', 'verified_expert', 'administrator'];

// The role the current visitor holds, or null when signed out. Pages use it
// to decide whether calling an authorized route is worth attempting; the
// server's gate is still the only thing that decides what data comes back.
window.identityRole = function() {
  if (window.ACCOUNT) return window.ACCOUNT.role;
  return window.REVIEWER ? 'administrator' : null;
};
window.hasTrustedRole = function() {
  return TRUSTED_PLUS_ROLES.includes(window.identityRole());
};

function updatePrivateLink() {
  const allowed = window.hasTrustedRole();
  document.querySelectorAll('.nav-links a[href="/intelligence.html"]').forEach((link) => {
    link.hidden = !allowed;
  });
}

// Backward-compatible helper used by the reviewer pages.
window.fetchReviewer = async function() {
  const id = await window.fetchIdentity();
  return id.reviewer;
};

document.addEventListener('DOMContentLoaded', () => { window.fetchIdentity(); });

function updateAuthLink() {
  const link = document.getElementById('auth-link');
  if (!link) return;
  if (window.ACCOUNT) {
    link.textContent = window.ACCOUNT.display_name || t('auth.myProfile', 'My profile');
    link.href = '/profile.html';
    link.title = t('auth.profileTooltip', 'Your contributor profile');
  } else if (window.REVIEWER) {
    link.textContent = t('auth.reviewerName', `Reviewer: ${window.REVIEWER}`, { name: window.REVIEWER });
    link.href = '/login.html';
    link.title = t('auth.reviewerTooltip', 'Manage reviewer session');
  } else {
    link.textContent = t('auth.logInSignUp', 'Log in / Sign up');
    link.href = '/login.html';
  }
}

// Re-render the auth link when the language changes.
(function () {
  function relocalize() { updateAuthLink(); }
  if (window.I18n && typeof window.I18n.onChange === 'function') {
    window.I18n.onChange(relocalize);
  } else {
    window.addEventListener('i18n:change', relocalize);
  }
})();
