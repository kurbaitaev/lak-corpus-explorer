'use strict';

const { chromium } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:5000';

function linear(value) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function parseColor(color) {
  const rgb = color.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
  if (rgb) return { rgb: rgb.slice(1, 4).map(Number), alpha: rgb[4] == null ? 1 : Number(rgb[4]) };
  const srgb = color.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/);
  if (srgb) return { rgb: srgb.slice(1, 4).map(value => Number(value) * 255), alpha: srgb[4] == null ? 1 : Number(srgb[4]) };
  throw new Error(`Unsupported computed color: ${color}`);
}

function blend(foreground, background) {
  return foreground.rgb.map((channel, index) =>
    channel * foreground.alpha + background.rgb[index] * (1 - foreground.alpha));
}

function ratio(foreground, background) {
  const fg = blend(parseColor(foreground), parseColor(background));
  const bg = parseColor(background).rgb;
  const luminance = rgb => rgb.map(linear).reduce((sum, value, index) =>
    sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const [lighter, darker] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

async function styleSample(page, name, selector) {
  const sample = await page.locator(selector).first().evaluate(element => {
    const style = getComputedStyle(element);
    let background = style.backgroundColor;
    let current = element;
    while ((background === 'rgba(0, 0, 0, 0)' || /\/\s*0\)$/.test(background)) && current.parentElement) {
      current = current.parentElement;
      background = getComputedStyle(current).backgroundColor;
    }
    return {
      color: style.color,
      background,
      fontSize: parseFloat(style.fontSize),
      fontWeight: style.fontWeight,
      outlineWidth: style.outlineWidth,
      outlineStyle: style.outlineStyle,
    };
  });
  return { name, ...sample, ratio: Number(ratio(sample.color, sample.background).toFixed(2)) };
}

async function runViewport(browser, name, viewport) {
  const context = await browser.newContext({ viewport, colorScheme: 'dark' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(`${BASE}/observatory.html`, { waitUntil: 'networkidle' });
  await page.locator('.obs-card').first().waitFor();
  const cardCount = await page.locator('.obs-card').count();
  const dimensions = await page.evaluate(() => ({
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
  const selectors = [
    ['title', '.obs-card h2'],
    ['creator', '.obs-byline'],
    ['fact value', '.obs-fact dd'],
    ['fact label', '.obs-fact dt'],
    ['notes', '.obs-notes'],
    ['next action', '.obs-action'],
    ['next action label', '.obs-action strong'],
    ['public button', '.obs-source-button'],
    ['local provenance', '.obs-local'],
    ['control label', '.obs-controls label'],
    ['search value', '#resource-search'],
    ['inactive tab', '.obs-tab:not(.active)'],
    ['active tab', '.obs-tab.active'],
    ['result count', '.obs-result-count'],
  ];
  const contrasts = [];
  for (const [label, selector] of selectors) contrasts.push(await styleSample(page, label, selector));
  const failingContrast = contrasts.filter(sample =>
    sample.ratio < (sample.fontSize >= 24 || (sample.fontSize >= 18.66 && Number(sample.fontWeight) >= 700) ? 3 : 4.5));

  const publicButtons = await page.locator('.obs-source-button').count();
  const publicLabel = await page.locator('.obs-source-button').first().innerText();
  const cardIsClickable = await page.locator('.obs-card').first().evaluate(card =>
    card.matches('a,button,[role="link"]') || !!card.onclick || getComputedStyle(card).cursor === 'pointer');
  const local = page.locator('.obs-local').first();
  const localState = await local.evaluate(element => ({
    text: element.textContent.trim(),
    tag: element.tagName,
    cursor: getComputedStyle(element).cursor,
    hasHref: element.hasAttribute('href'),
    onclick: !!element.onclick,
  }));

  const focusChecks = [];
  for (const selector of ['#resource-search', '#category-filter', '#status-filter', '#priority-filter', '.obs-tab', '.obs-source-button']) {
    const locator = page.locator(selector).first();
    await locator.focus();
    focusChecks.push(await locator.evaluate(element => {
      const style = getComputedStyle(element);
      return { selector: element.id ? `#${element.id}` : `.${element.classList[0]}`, outlineWidth: style.outlineWidth, outlineStyle: style.outlineStyle };
    }));
  }

  await page.locator('#resource-search').fill('Ilchi');
  await page.waitForTimeout(100);
  const searchedCount = await page.locator('.obs-card').count();
  await page.locator('#resource-search').fill('');
  await page.locator('#priority-filter').selectOption({ label: 'P0' });
  await page.waitForTimeout(100);
  const p0Count = await page.locator('.obs-card').count();
  await page.locator('#priority-filter').selectOption('');
  await page.locator('.obs-tab[data-view="contact"]').click();
  await page.waitForTimeout(100);
  const contactCount = await page.locator('.obs-card').count();
  await page.locator('.obs-tab[data-view="all"]').click();

  let clickedUrl = null;
  const popupPromise = page.waitForEvent('popup');
  await page.locator('.obs-source-button').first().click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  clickedUrl = popup.url();
  await popup.close();

  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(100);
  const bottomVisible = await page.locator('.obs-card').last().isVisible();
  await page.locator('.obs-card').nth(2).scrollIntoViewIfNeeded();
  await page.waitForTimeout(100);

  fs.mkdirSync('screenshots', { recursive: true });
  const screenshot = `screenshots/observatory-${name}-dark.png`;
  await page.screenshot({ path: screenshot, fullPage: false });
  await context.close();
  return {
    name, viewport, cardCount, dimensions, contrasts, failingContrast, publicButtons,
    publicLabel, cardIsClickable, localState, focusChecks, searchedCount, p0Count,
    contactCount, clickedUrl, bottomVisible, consoleErrors, screenshot,
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const desktop = await runViewport(browser, 'desktop', { width: 1280, height: 720 });
    const mobile = await runViewport(browser, '390x844', { width: 390, height: 844 });
    const report = { generatedAt: new Date().toISOString(), desktop, mobile };
    fs.writeFileSync('screenshots/observatory-audit.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    const failures = [desktop, mobile].flatMap(result => [
      ...(result.cardCount !== 68 ? [`${result.name}: card count ${result.cardCount}`] : []),
      ...(result.dimensions.scrollWidth > result.dimensions.clientWidth ? [`${result.name}: horizontal overflow`] : []),
      ...result.failingContrast.map(sample => `${result.name}: ${sample.name} contrast ${sample.ratio}`),
      ...(result.cardIsClickable ? [`${result.name}: card appears clickable`] : []),
      ...(result.localState.text !== 'Local provenance — not publicly accessible' ? [`${result.name}: local label mismatch`] : []),
      ...(result.localState.hasHref || result.localState.onclick || result.localState.cursor === 'pointer' ? [`${result.name}: local provenance interactive`] : []),
      ...(!/Open public source/.test(result.publicLabel) || !/↗/.test(result.publicLabel) ? [`${result.name}: source button label`] : []),
      ...result.focusChecks.filter(check => check.outlineStyle === 'none' || parseFloat(check.outlineWidth) < 2).map(check => `${result.name}: weak focus ${check.selector}`),
      ...(result.consoleErrors.length ? [`${result.name}: console errors ${result.consoleErrors.join('; ')}`] : []),
    ]);
    if (failures.length) {
      console.error('\nAUDIT FAILURES\n' + failures.join('\n'));
      process.exit(1);
    }
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});