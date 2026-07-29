'use strict';

// Shared reviewer-session helper: updates the nav auth link on every page.
window.REVIEWER = null;

window.fetchReviewer = async function() {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return null;
    const data = await res.json();
    window.REVIEWER = data.reviewer || null;
  } catch { window.REVIEWER = null; }
  updateAuthLink();
  return window.REVIEWER;
};

document.addEventListener('DOMContentLoaded', () => { window.fetchReviewer(); });

function updateAuthLink() {
  const link = document.getElementById('auth-link');
  if (!link) return;
  if (window.REVIEWER) {
    link.textContent = `Reviewer: ${window.REVIEWER}`;
    link.href = '/login.html';
    link.title = 'Manage reviewer session';
  } else {
    link.textContent = 'Log in as reviewer';
    link.href = '/login.html';
  }
}
