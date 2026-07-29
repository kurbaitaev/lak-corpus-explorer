/* Shared mobile navigation.
 *
 * Injects a "Menu" toggle into the shared header and wires the drawer:
 *   - links hidden by default (aria-expanded="false"), zero height when closed
 *   - solid in-flow drawer while open (pushes content down, never overlays)
 *   - toggle button doubles as the close control
 *   - Escape / outside-click / link click close the drawer
 *   - focus moves to the first link on open and back to the toggle on close
 *   - closes on navigation; page scrolling is never locked
 */
(function () {
  'use strict';

  function initNav() {
    const nav = document.querySelector('.nav');
    if (!nav) return;
    const inner = nav.querySelector('.nav-inner');
    const links = nav.querySelector('.nav-links');
    if (!inner || !links) return;

    // Keep newer public sections present on every legacy page without requiring
    // duplicated navigation fragments to stay in sync.
    if (!links.querySelector('a[href="/observatory.html"]')) {
      const observatory = document.createElement('a');
      observatory.className = 'nav-link';
      observatory.href = '/observatory.html';
      observatory.textContent = 'Observatory';
      const validate = links.querySelector('a[href="/validate.html"]');
      links.insertBefore(observatory, validate || links.firstChild);
    }

    if (!links.querySelector('a[href="/lab.html"]')) {
      const lab = document.createElement('a');
      lab.className = 'nav-link';
      lab.href = '/lab.html';
      lab.textContent = 'Translation Lab';
      const validate = links.querySelector('a[href="/validate.html"]');
      links.insertBefore(lab, validate || links.firstChild);
    }

    if (!links.id) links.id = 'nav-links';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-toggle';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', links.id);
    btn.setAttribute('aria-label', 'Open menu');
    btn.innerHTML = '<span class="nav-toggle-icon" aria-hidden="true">☰</span> Menu';

    nav.classList.add('nav-collapsible');
    inner.insertBefore(btn, links);

    function onKeydown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenu(true);
      }
    }

    function onDocClick(e) {
      if (!nav.contains(e.target)) closeMenu(false);
    }

    function openMenu() {
      nav.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      btn.setAttribute('aria-label', 'Close menu');
      btn.innerHTML = '<span class="nav-toggle-icon" aria-hidden="true">✕</span> Close';
      document.addEventListener('keydown', onKeydown);
      document.addEventListener('click', onDocClick, true);
      const first = links.querySelector('.nav-link');
      if (first) first.focus();
    }

    function closeMenu(returnFocus) {
      if (!nav.classList.contains('open')) return;
      nav.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', 'Open menu');
      btn.innerHTML = '<span class="nav-toggle-icon" aria-hidden="true">☰</span> Menu';
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('click', onDocClick, true);
      if (returnFocus) btn.focus();
    }

    btn.addEventListener('click', function () {
      if (nav.classList.contains('open')) closeMenu(true);
      else openMenu();
    });

    links.addEventListener('click', function (e) {
      if (e.target.closest('a')) closeMenu(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();
