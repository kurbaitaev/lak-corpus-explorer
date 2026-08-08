/* Shared mobile navigation + EN/RU language toggle.
 *
 * Navigation drawer:
 *   - links hidden by default (aria-expanded="false"), zero height when closed
 *   - solid in-flow drawer while open (pushes content down, never overlays)
 *   - toggle button doubles as the close control
 *   - Escape / outside-click / link click close the drawer
 *   - focus moves to the first link on open and back to the toggle on close
 *   - closes on navigation; page scrolling is never locked
 *
 * Language toggle:
 *   - an accessible EN/RU segmented control injected into the shared nav
 *   - present on both desktop and mobile (mobile copy lives inside the drawer)
 *   - keyboard operable (native buttons + arrow keys) and touch-friendly
 *   - high-contrast active state; reflects and updates window.I18n
 */
(function () {
  'use strict';

  var I18n = window.I18n;

  function tr(key, fallback) {
    if (I18n && typeof I18n.t === 'function') {
      var v = I18n.t(key);
      if (v && v !== key) return v;
    }
    return fallback;
  }

  var helpOpen = null;
  var helpGlobalsReady = false;
  function initHelp() {
    var markers = document.querySelectorAll('[data-help]');
    if (!markers.length) return;
    markers.forEach(function (marker, index) {
      if (marker.dataset.helpReady) return;
      marker.dataset.helpReady = 'true';
      var id = 'help-' + index + '-' + Date.now();
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'help-trigger';
      button.textContent = '?';
      button.setAttribute('aria-controls', id);
      button.setAttribute('aria-expanded', 'false');
      marker.replaceWith(button);
      var panel = document.createElement('div');
      panel.id = id;
      panel.className = 'help-popover';
      panel.setAttribute('role', 'dialog');
      panel.hidden = true;
      document.body.appendChild(panel);
      function label() { return tr('help.button.aria', 'What does this mean?'); }
      function closeLabel() { return tr('help.close.aria', 'Close help'); }
      function render() {
        button.setAttribute('aria-label', button.getAttribute('aria-expanded') === 'true' ? closeLabel() : label());
        panel.textContent = tr(button.dataset.helpKey || marker.dataset.help, marker.dataset.helpFallback || 'More information.');
      }
      button.dataset.helpKey = marker.dataset.help;
      function close(returnFocus) {
        if (helpOpen !== button) return;
        panel.hidden = true; button.setAttribute('aria-expanded', 'false'); helpOpen = null;
        if (returnFocus) button.focus();
      }
      function open() {
        if (helpOpen && helpOpen !== button && typeof helpOpen._closeHelp === 'function') helpOpen._closeHelp(false);
        panel.hidden = false; button.setAttribute('aria-expanded', 'true'); helpOpen = button;
        var r = button.getBoundingClientRect(), width = Math.min(320, window.innerWidth - 24);
        panel.style.width = width + 'px';
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.left = Math.max(12, Math.min(window.innerWidth - width - 12, r.left)) + 'px';
        var below = r.bottom + 10;
        var above = r.top - panel.offsetHeight - 10;
        panel.style.top = (below + panel.offsetHeight <= window.innerHeight - 12
          ? below : Math.max(12, above)) + 'px';
      }
      button._closeHelp = close;
      button.addEventListener('click', function () { button.getAttribute('aria-expanded') === 'true' ? close(false) : open(); });
      if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
        button.addEventListener('mouseenter', open);
      }
      render();
      if (I18n && I18n.onChange) I18n.onChange(render);
    });
    if (!helpGlobalsReady) {
      helpGlobalsReady = true;
      document.addEventListener('click', function (e) {
        if (helpOpen && !e.target.closest('.help-trigger, .help-popover')) helpOpen._closeHelp(false);
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && helpOpen) {
          e.preventDefault();
          helpOpen._closeHelp(true);
        }
      });
    }
  }
  var helpObserver = new MutationObserver(function () { initHelp(); });

  function buildToggle(placement) {
    // placement: 'desktop' | 'mobile' — only affects class hooks.
    var group = document.createElement('div');
    group.className = 'lang-toggle lang-toggle-' + placement;
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', tr('lang.label', 'Language'));

    var current = (I18n && I18n.getLanguage) ? I18n.getLanguage() : 'en';

    [['en', 'lang.en.short', 'lang.switchTo.en', 'English'],
     ['ru', 'lang.ru.short', 'lang.switchTo.ru', 'Russian']].forEach(function (spec) {
      var lang = spec[0];
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lang-btn';
      btn.dataset.lang = lang;
      btn.textContent = tr(spec[1], lang.toUpperCase());
      btn.setAttribute('aria-label', tr(spec[2], 'Switch to ' + spec[3]));
      var active = current === lang;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      if (active) btn.classList.add('active');

      btn.addEventListener('click', function () {
        if (I18n && I18n.setLanguage) I18n.setLanguage(lang);
      });
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          var sibling = e.key === 'ArrowRight'
            ? btn.nextElementSibling : btn.previousElementSibling;
          if (sibling) { sibling.focus(); sibling.click(); }
        }
      });
      group.appendChild(btn);
    });

    return group;
  }

  function syncToggles() {
    var current = (I18n && I18n.getLanguage) ? I18n.getLanguage() : 'en';
    document.querySelectorAll('.lang-toggle .lang-btn').forEach(function (btn) {
      var active = btn.dataset.lang === current;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    document.querySelectorAll('.lang-toggle').forEach(function (g) {
      g.setAttribute('aria-label', tr('lang.label', 'Language'));
    });
  }

  function initNav() {
    var nav = document.querySelector('.nav');
    if (!nav) return;
    var inner = nav.querySelector('.nav-inner');
    var links = nav.querySelector('.nav-links');
    if (!inner || !links) return;

    // Keep newer public sections present on every legacy page without requiring
    // duplicated navigation fragments to stay in sync.
    if (!links.querySelector('a[href="/observatory.html"]')) {
      var observatory = document.createElement('a');
      observatory.className = 'nav-link';
      observatory.href = '/observatory.html';
      observatory.setAttribute('data-i18n', 'nav.observatory');
      observatory.textContent = tr('nav.observatory', 'Observatory');
      var validate = links.querySelector('a[href="/validate.html"]');
      links.insertBefore(observatory, validate || links.firstChild);
    }

    if (!links.querySelector('a[href="/source-library.html"]')) {
      var library = document.createElement('a');
      library.className = 'nav-link';
      library.href = '/source-library.html';
      library.setAttribute('data-i18n', 'nav.sourceLibrary');
      library.textContent = tr('nav.sourceLibrary', 'Sources');
      var firstLink = links.querySelector('a[href="/observatory.html"]') || links.firstChild;
      links.insertBefore(library, firstLink);
    }

    if (!links.querySelector('a[href="/lemmas.html"]')) {
      var lemmas = document.createElement('a');
      lemmas.className = 'nav-link';
      lemmas.href = '/lemmas.html';
      lemmas.setAttribute('data-i18n', 'nav.lemmas');
      lemmas.textContent = tr('nav.lemmas', 'Dictionary');
      var beforeLibrary = links.querySelector('a[href="/source-library.html"]');
      links.insertBefore(lemmas, beforeLibrary || links.firstChild);
    }

    if (!links.querySelector('a[href="/research.html"]')) {
      var research = document.createElement('a');
      research.className = 'nav-link';
      research.href = '/research.html';
      research.setAttribute('data-i18n', 'nav.research');
      research.textContent = tr('nav.research', 'Research update');
      var beforeObservatory = links.querySelector('a[href="/observatory.html"]');
      links.insertBefore(research, beforeObservatory || links.firstChild);
    }

    if (!links.querySelector('a[href="/lab.html"]')) {
      var lab = document.createElement('a');
      lab.className = 'nav-link';
      lab.href = '/lab.html';
      lab.setAttribute('data-i18n', 'nav.lab');
      lab.textContent = tr('nav.lab', 'Translation Lab');
      var validate2 = links.querySelector('a[href="/validate.html"]');
      links.insertBefore(lab, validate2 || links.firstChild);
    }

    // The private workspace is only meaningful to signed-in reviewers, so the
    // link ships hidden and auth.js reveals it once a trusted role is known.
    if (!links.querySelector('a[href="/intelligence.html"]')) {
      var intelligence = document.createElement('a');
      intelligence.className = 'nav-link';
      intelligence.href = '/intelligence.html';
      intelligence.hidden = true;
      intelligence.setAttribute('data-i18n', 'nav.intelligence');
      intelligence.textContent = tr('nav.intelligence', 'Private workspace');
      var about = links.querySelector('a[href="/about.html"]');
      links.insertBefore(intelligence, about || links.querySelector('#auth-link') || null);
    }

    // Keep the primary navigation task-based and compact. Secondary tools are
    // linked from their relevant pages instead of competing in the main bar.
    var primaryOrder = ['/', '/lemmas.html', '/source-library.html', '/research.html', '/lab.html', '/validate.html', '/about.html'];
    links.querySelectorAll('.nav-link').forEach(function (link) {
      var path = link.getAttribute('href');
      if (path === '/intelligence.html' || link.id === 'auth-link') return;
      if (!primaryOrder.includes(path)) link.remove();
    });
    primaryOrder.forEach(function (path) {
      var link = links.querySelector('a[href="' + path + '"]');
      if (link) links.appendChild(link);
    });
    var privateLink = links.querySelector('a[href="/intelligence.html"]');
    var authLink = links.querySelector('#auth-link');
    if (privateLink) links.appendChild(privateLink);
    if (authLink) links.appendChild(authLink);

    if (!links.id) links.id = 'nav-links';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav-toggle';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', links.id);
    btn.setAttribute('aria-label', tr('nav.openMenu', 'Open menu'));
    btn.innerHTML = '<span class="nav-toggle-icon" aria-hidden="true">☰</span> ' +
      '<span class="nav-toggle-label">' + tr('nav.menu', 'Menu') + '</span>';

    nav.classList.add('nav-collapsible');

    // Desktop language toggle sits at the end of the nav bar; the mobile one
    // lives inside the collapsible drawer so it is reachable on small screens.
    var desktopToggle = buildToggle('desktop');
    inner.appendChild(btn);
    inner.appendChild(desktopToggle);

    var mobileToggle = buildToggle('mobile');
    mobileToggle.classList.add('lang-toggle-drawer');
    links.appendChild(mobileToggle);

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
      btn.setAttribute('aria-label', tr('nav.closeMenu', 'Close menu'));
      btn.innerHTML = '<span class="nav-toggle-icon" aria-hidden="true">✕</span> ' +
        '<span class="nav-toggle-label">' + tr('nav.close', 'Close') + '</span>';
      document.addEventListener('keydown', onKeydown);
      document.addEventListener('click', onDocClick, true);
      var first = links.querySelector('.nav-link');
      if (first) first.focus();
    }

    function closeMenu(returnFocus) {
      if (!nav.classList.contains('open')) return;
      nav.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      btn.setAttribute('aria-label', tr('nav.openMenu', 'Open menu'));
      btn.innerHTML = '<span class="nav-toggle-icon" aria-hidden="true">☰</span> ' +
        '<span class="nav-toggle-label">' + tr('nav.menu', 'Menu') + '</span>';
      document.removeEventListener('keydown', onKeydown);
      document.removeEventListener('click', onDocClick, true);
      if (returnFocus) btn.focus();
    }

    btn.addEventListener('click', function () {
      if (nav.classList.contains('open')) closeMenu(true);
      else openMenu();
    });

    links.addEventListener('click', function (e) {
      // Language buttons inside the drawer must not close/navigate.
      if (e.target.closest('.lang-toggle')) return;
      if (e.target.closest('a')) closeMenu(false);
    });

    // Keep toggle labels and the menu button text in sync on language change.
    if (I18n && I18n.onChange) {
      I18n.onChange(function () {
        syncToggles();
        var open = nav.classList.contains('open');
        var labelEl = btn.querySelector('.nav-toggle-label');
        if (labelEl) labelEl.textContent = open ? tr('nav.close', 'Close') : tr('nav.menu', 'Menu');
        btn.setAttribute('aria-label', open ? tr('nav.closeMenu', 'Close menu') : tr('nav.openMenu', 'Open menu'));
      });
    }

    syncToggles();
    initHelp();
    helpObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNav);
  } else {
    initNav();
  }
})();
