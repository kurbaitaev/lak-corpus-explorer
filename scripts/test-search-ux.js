'use strict';

const assert = require('assert');
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000';

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

    console.log('Search UX checks passed: EN/RU intent, results, help, and 390px touch');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});