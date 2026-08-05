'use strict';

const assert = require('assert');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Synthetic payloads for the "latest search wins" race test. The loser (A) is a
// broad filter-only search; the winner (B) is the query the user typed straight
// after. Every visible surface differs so a half-applied loser is detectable.
const RACE_SLOW_MS = 1200;
const raceBody = (tag, total, pages, expanded) => JSON.stringify({
  total, pages, page: 1, expanded, senses: expanded.length ? [tag + '-sense'] : [], ocrSenses: [],
  rows: [['text', tag + '-lak-text', tag + '-doc', 'PCMLBE', 'standard', 'race-' + tag + ':1', '']],
  matches: [[[0, 1]]],
});

// Request A (filter change, no q) resolves *after* request B (the typed query).
// Only B may ever reach the DOM.
async function raceTest(browser, { abortable }) {
  const label = abortable ? 'abortable' : 'no-AbortController';
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('lang', 'en'));
  // Force the pure sequence-guard path so a superseded response really does
  // arrive late and must be discarded on its own merits, not just aborted.
  if (!abortable) await page.addInitScript(() => { delete window.AbortController; });

  let slowServed = 0, fastServed = 0;
  await page.route('**/api/corpus/search*', async route => {
    const isTyped = new URL(route.request().url()).searchParams.get('q') === 'race-winner';
    if (isTyped) fastServed += 1; else slowServed += 1;
    if (!isTyped) await sleep(RACE_SLOW_MS);
    try {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: isTyped ? raceBody('B', 7, 1, []) : raceBody('A', 4242, 9, ['барз']),
      });
    } catch { /* the loser may already be aborted by the browser */ }
  });

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });

  const requestA = page.waitForRequest(r =>
    r.url().includes('/api/corpus/search') && !new URL(r.url()).searchParams.get('q'));
  await page.locator('#source').selectOption({ label: 'PCMLBE' });
  await requestA;

  // Supersede A before it can resolve.
  await page.locator('#q').fill('race-winner');
  await page.locator('#search-form').evaluate(form => form.requestSubmit());

  await page.locator('#tbody tr .lak-text').first().waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await page.locator('#tbody').innerText(), /B-lak-text/, `${label}: winner rows never rendered`);

  // Let the loser resolve well after the winner and prove it changes nothing.
  await sleep(RACE_SLOW_MS + 600);
  assert.strictEqual(slowServed, 1, `${label}: unexpected number of filter searches (${slowServed})`);
  assert.strictEqual(fastServed, 1, `${label}: typed search was dropped (${fastServed} served)`);

  const body = await page.locator('#tbody').innerText();
  assert.match(body, /B-lak-text/, `${label}: stale request overwrote the newest rows`);
  assert.doesNotMatch(body, /A-lak-text/, `${label}: stale request rendered its own rows`);
  assert.doesNotMatch(body, /Searching/, `${label}: loading state never resolved`);
  assert.strictEqual(await page.locator('#tbody tr').count(), 1, `${label}: row count is not the winner's`);

  // Derived UI must belong to the same (winning) request.
  assert.match(await page.locator('#count-label').innerText(), /\b7\b/, `${label}: count came from the stale request`);
  assert.doesNotMatch(await page.locator('#count-label').innerText(), /4,?242/, `${label}: stale total leaked into the count`);
  assert.strictEqual(await page.locator('#page-label').innerText(), 'Page 1 of 1', `${label}: stale pagination applied`);
  assert.strictEqual(await page.locator('#next-btn').isDisabled(), true, `${label}: pager enabled from stale pages`);
  assert.strictEqual(await page.locator('#concept-card.visible').count(), 0, `${label}: stale concept card rendered`);
  assert.strictEqual(await page.locator('#tbody mark.hl').count(), 1, `${label}: winner highlight spans missing`);

  await context.close();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const language of ['en', 'ru']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const page = await context.newPage();
      await page.addInitScript(lang => localStorage.setItem('lang', lang), language);
      let searchRequests = 0;
      page.on('request', request => {
        if (request.url().includes('/api/corpus/search')) searchRequests += 1;
      });

      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      assert.strictEqual(searchRequests, 0, `${language}: searched before user intent`);
      assert.strictEqual(await page.locator('#table-wrap').isVisible(), false, `${language}: raw table visible initially`);
      assert.strictEqual(await page.locator('.search-guidance').isVisible(), true);
      assert.strictEqual(await page.locator('.search-actions .btn').count(), 3);

      const help = page.locator('.search-guidance .help-trigger');
      await help.hover();
      assert.strictEqual(await page.locator('.help-popover:not([hidden])').count(), 1, `${language}: hover did not open help`);
      await page.mouse.click(5, 780);
      assert.strictEqual(await page.locator('.help-popover:not([hidden])').count(), 0, `${language}: outside click did not close help`);
      await help.focus();
      await page.keyboard.press('Enter');
      if ((await help.getAttribute('aria-expanded')) !== 'true') await page.keyboard.press('Enter');
      assert.strictEqual(await help.getAttribute('aria-expanded'), 'true');
      await page.keyboard.press('Escape');
      assert.strictEqual(await help.getAttribute('aria-expanded'), 'false');
      assert.strictEqual(await help.evaluate(el => el === document.activeElement), true);

      await page.locator('#source').selectOption({ label: 'PCMLBE' });
      await page.waitForResponse(response => response.url().includes('/api/corpus/search') && response.ok());
      assert(searchRequests >= 1, `${language}: filter did not express search intent`);
      assert.strictEqual(await page.locator('#table-wrap').isVisible(), true);
      const first = page.locator('#tbody tr').first();
      assert.strictEqual((await first.locator('.td-meaning').innerText()).trim(),
        language === 'ru' ? 'Перевод пока не добавлен' : 'Translation not added yet');
      assert.match(await first.locator('.td-document').innerText(), /NovoL2007_01-p105/);
      assert.match(await first.locator('td').nth(4).innerText(), /PCMLBE/);
      assert.strictEqual(await first.locator('.td-actions a').getAttribute('href').then(v => v.startsWith('/validate.html')), true);

      await page.locator('#q').fill('яяяяяяъъъъъ999999');
      await page.locator('#search-form').evaluate(form => form.requestSubmit());
      await page.waitForResponse(response => response.url().includes('/api/corpus/search') && response.ok());
      // The response landing is not the same instant as the render: the page still
      // has to read the JSON body. Wait for the rendered state, then assert it.
      await page.locator('.empty-state').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
      assert.strictEqual(await page.locator('.empty-state').isVisible(), true, `${language}: empty search state missing`);
      assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth), 1280, `${language}: desktop overflow`);
      await context.close();
    }

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const page = await mobile.newPage();
    await page.addInitScript(() => localStorage.setItem('lang', 'ru'));
    await page.goto(BASE + '/', { waitUntil: 'networkidle' });
    const help = page.locator('.search-guidance .help-trigger');
    let box = await help.evaluate(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    assert(box && box.width >= 44 && box.height >= 44, 'mobile help target is below 44px');
    await help.tap();
    const popover = page.locator('.help-popover:not([hidden])');
    const popBox = await popover.evaluate(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    box = await help.evaluate(el => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    assert(popBox && popBox.x >= -1 && popBox.x + popBox.width <= 391 &&
      popBox.y >= -1 && popBox.y + popBox.height <= 845,
      `mobile help popover leaves viewport: ${JSON.stringify(popBox)}`);
    assert(popBox.y + popBox.height <= box.y || popBox.y >= box.y + box.height,
      'mobile help popover covers its active control');
    assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'mobile landing overflows');
    await page.locator('#browse-all').tap();
    await page.waitForResponse(response => response.url().includes('/api/corpus/search') && response.ok());
    assert.strictEqual(await page.locator('#tbody tr').first().isVisible(), true);
    assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'mobile results overflow');
    await mobile.close();

    await raceTest(browser, { abortable: true });
    await raceTest(browser, { abortable: false });

    console.log('Search UX checks passed: EN/RU intent, results, help, 390px touch, and latest-search-wins');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});