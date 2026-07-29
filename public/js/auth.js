'use strict';

// Shared identity helper: updates the nav auth link on every page.
// Supports both contributor accounts and the legacy reviewer session.
window.REVIEWER = null;
window.ACCOUNT = null;

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
  return { reviewer: window.REVIEWER, account: window.ACCOUNT };
};

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
    link.textContent = window.ACCOUNT.display_name || 'My profile';
    link.href = '/profile.html';
    link.title = 'Your contributor profile';
  } else if (window.REVIEWER) {
    link.textContent = `Reviewer: ${window.REVIEWER}`;
    link.href = '/login.html';
    link.title = 'Manage reviewer session';
  } else {
    link.textContent = 'Log in / Sign up';
    link.href = '/login.html';
  }
}
