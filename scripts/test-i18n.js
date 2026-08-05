'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000';
const routes = [
  '/', '/lab.html', '/observatory.html', '/research.html', '/validate.html', '/queue.html',
  '/leaderboard.html', '/about.html', '/how-it-works.html', '/login.html',
  '/register.html', '/profile.html', '/dashboard.html',
];

function loadRuntime(language) {
  const storage = new Map(language ? [['lang', language]] : []);
  const document = {
    readyState: 'complete',
    documentElement: { setAttribute() {} },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
  const sandbox = {
    window: {},
    document,
    location: { hostname: 'production.example' },
    navigator: { language: 'en-US' },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, value); },
    },
    Intl,
    CustomEvent: function CustomEvent(type, detail) { return { type, detail }; },
    console,
  };
  sandbox.window.dispatchEvent = () => {};
  vm.runInNewContext(fs.readFileSync('public/js/i18n.js', 'utf8'), sandbox);
  return sandbox.window.I18n;
}

async function main() {
  const ru = loadRuntime('ru');
  const en = loadRuntime('en');
  assert.strictEqual(ru.getLanguage(), 'ru');
  assert.strictEqual(en.getLanguage(), 'en');
  assert.strictEqual(ru.t('__missing_test_key__'), '__missing_test_key__');
  assert.strictEqual(ru.t('nav.search'), 'Поиск');
  assert.strictEqual(en.t('nav.search'), 'Search');

  for (const [key, entry] of Object.entries(ru._dict)) {
    assert(entry.en, `${key} is missing English`);
    assert(entry.ru, `${key} is missing Russian`);
    assert(!/^([a-z]+\.)+[a-z]/i.test(String(entry.ru)), `${key} exposes a raw key`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    // Browser language applies only when no explicit choice has been stored.
    const firstVisit = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1280, height: 720 } });
    let page = await firstVisit.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    assert.strictEqual(await page.locator('html').getAttribute('lang'), 'ru');
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('lang')), null);
    await page.locator('.lang-toggle-desktop .lang-btn[data-lang="en"]').click();
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('lang')), 'en');
    await page.reload({ waitUntil: 'networkidle' });
    assert.strictEqual(await page.locator('html').getAttribute('lang'), 'en');
    await firstVisit.close();

    const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
    await page.goto(`${BASE}/observatory.html`, { waitUntil: 'networkidle' });
    await page.locator('.lang-toggle-desktop .lang-btn[data-lang="ru"]').click();
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('lang')), 'ru');
    await page.reload({ waitUntil: 'networkidle' });
    assert.strictEqual(await page.locator('html').getAttribute('lang'), 'ru');
    assert.strictEqual(await page.locator('.obs-method[data-i18n-html="obs.method"]').textContent()
      .then(v => /Публичная доступность/.test(v)), true);

    // Private research layer: bilingual, count-accurate, content-free.
    await page.locator('.obs-private-card').first().waitFor();
    const privateRu = await page.locator('.obs-private').innerText();
    assert(/Закрытый исследовательский слой/.test(privateRu), 'private panel is not in Russian');
    assert(/9294|9\u00a0294|9 294/.test(privateRu), 'private panel does not show the Khaydakov count');
    assert(/3154\.894/.test(privateRu), 'private panel does not show the audited audio duration');
    assert(!/Дагучпедгиз/.test(privateRu), 'private panel leaks candidate content');
    assert.strictEqual(await page.locator('.obs-private-card').count(), 5,
      'private panel does not list the five audited source groups');
    await page.locator('.lang-toggle-desktop .lang-btn[data-lang="en"]').click();
    await page.locator('.obs-private-card').first().waitFor();
    const privateEn = await page.locator('.obs-private').innerText();
    assert(/Private research layer/.test(privateEn), 'private panel did not switch to English');
    assert(/Permission pending/i.test(privateEn), 'private panel hides the permission state');
    assert(/Not training-ready/i.test(privateEn), 'private panel hides the training state');
    assert(/Consent unknown/i.test(privateEn), 'private panel hides the unknown audio consent');
    assert.deepStrictEqual(
      (privateEn.match(/\b(?:obs|help)\.[a-z][\w.]+/gi) || []), [], 'private panel exposes raw keys');
    await page.locator('.lang-toggle-desktop .lang-btn[data-lang="ru"]').click();
    await page.locator('.obs-private-card').first().waitFor();
    assert.strictEqual(await page.locator('.obs-local').first().textContent(), ru.t('obs.localProvenance'));
    assert.deepStrictEqual(await page.locator('#priority-filter option').evaluateAll(options => options.map(o => o.value)), ['', 'P0', 'P1', 'P2']);

    const routeResults = [];
    for (const route of routes) {
      await page.goto(BASE + route, { waitUntil: 'networkidle' });
      routeResults.push({
        route,
        lang: await page.locator('html').getAttribute('lang'),
        width: await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]),
        toggle: await page.locator('.lang-toggle-desktop').isVisible(),
        rawKeys: await page.locator('body').evaluate(body => body.innerText).then(text =>
          (text.match(/\b(?:nav|search|lab|obs|research|queue|leaderboard|profile|dashboard|auth)\.[a-z][\w.]+/g) || [])),
      });
    }
    for (const result of routeResults) {
      assert.strictEqual(result.lang, 'ru', `${result.route} did not preserve Russian`);
      assert.strictEqual(result.toggle, true, `${result.route} has no visible language toggle`);
      assert.strictEqual(result.width[0], result.width[1], `${result.route} overflows at desktop`);
      assert.deepStrictEqual(result.rawKeys, [], `${result.route} exposes raw translation keys`);
    }
    await page.goto(`${BASE}/about.html`, { waitUntil: 'networkidle' });
    assert.strictEqual(
      (await page.locator('#lex-by-variety tbody tr').first().locator('td').first().textContent()).trim(),
      ru.t('variety.standard'),
      'About variety table did not render in Russian'
    );

    await page.route('**/api/auth/account-login', route =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await page.goto(`${BASE}/login.html`, { waitUntil: 'networkidle' });
    await page.locator('#a-email').fill('test@example.com');
    await page.locator('#a-pass').fill('not-a-real-password');
    await page.locator('#account-form button[type="submit"]').click();
    await page.locator('#account-error').waitFor({ state: 'visible' });
    assert.strictEqual((await page.locator('#account-error').textContent()).trim(), ru.t('auth.loginFailed'));
    await page.unroute('**/api/auth/account-login');

    await page.route('**/api/auth/register', route =>
      route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
    await page.goto(`${BASE}/register.html`, { waitUntil: 'networkidle' });
    await page.locator('#r-name').fill('Тест');
    await page.locator('#r-email').fill('test@example.com');
    await page.locator('#r-pass').fill('not-a-real-password');
    await page.locator('#reg-form button[type="submit"]').click();
    await page.locator('#reg-error').waitFor({ state: 'visible' });
    assert.strictEqual((await page.locator('#reg-error').textContent()).trim(), ru.t('auth.registrationFailed'));
    await page.unroute('**/api/auth/register');

    fs.mkdirSync('screenshots', { recursive: true });
    await page.goto(`${BASE}/observatory.html`, { waitUntil: 'networkidle' });
    await page.locator('.obs-card').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'screenshots/i18n-observatory-ru-desktop.png' });
    await context.close();

    const mobile = await browser.newContext({ locale: 'ru-RU', viewport: { width: 390, height: 844 } });
    page = await mobile.newPage();
    await page.addInitScript(() => localStorage.setItem('lang', 'ru'));
    const mobileResults = [];
    for (const route of routes) {
      await page.goto(BASE + route, { waitUntil: 'networkidle' });
      const menu = page.locator('.nav-toggle');
      if (await menu.count()) await menu.click();
      const toggle = page.locator('.lang-toggle-drawer');
      mobileResults.push({
        route,
        viewport: await page.evaluate(() => [innerWidth, innerHeight]),
        widths: await page.evaluate(() => [document.documentElement.clientWidth, document.documentElement.scrollWidth]),
        toggleVisible: await toggle.isVisible().catch(() => false),
        touchHeight: await toggle.boundingBox().then(box => box ? box.height : 0).catch(() => 0),
      });
    }
    for (const result of mobileResults) {
      assert.deepStrictEqual(result.viewport, [390, 844]);
      assert.strictEqual(result.widths[0], result.widths[1], `${result.route} overflows at 390px`);
      assert(result.toggleVisible, `${result.route} mobile toggle hidden`);
      assert(result.touchHeight >= 44, `${result.route} mobile toggle below 44px`);
    }
    await page.goto(`${BASE}/observatory.html`, { waitUntil: 'networkidle' });
    await page.locator('.obs-card').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'screenshots/i18n-observatory-ru-390x844.png' });

    // The private research panel must also fit and read correctly on mobile.
    await page.locator('.obs-private-card').first().scrollIntoViewIfNeeded();
    const privateMobile = await page.evaluate(() => {
      const section = document.querySelector('.obs-private');
      const card = document.querySelector('.obs-private-card');
      return {
        text: section.innerText,
        cards: document.querySelectorAll('.obs-private-card').length,
        cardRight: card.getBoundingClientRect().right,
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    assert.strictEqual(privateMobile.cards, 5, 'private panel is incomplete at 390px');
    assert.strictEqual(privateMobile.clientWidth, privateMobile.scrollWidth,
      'private panel overflows at 390px');
    assert(privateMobile.cardRight <= 390, 'private card is wider than the 390px viewport');
    assert(/Закрытое исследование/.test(privateMobile.text), 'mobile private panel is not in Russian');
    await page.screenshot({ path: 'screenshots/i18n-observatory-private-ru-390x844.png' });
    await mobile.close();
    console.log(`i18n checks passed: ${Object.keys(ru._dict).length} keys, ${routes.length} routes, desktop + 390x844`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});