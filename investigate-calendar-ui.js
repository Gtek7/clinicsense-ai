require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

  // Login
  await page.goto('https://clinicsense.com/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.fill('input[type="email"]', process.env.CLINICSENSE_EMAIL);
  await page.fill('input[type="password"]', process.env.CLINICSENSE_PASSWORD);
  await page.click('button[type="submit"], button:has-text("LOGIN"), input[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  // Navigate to calendar
  const calDone = page.waitForResponse(r => r.url().includes('/api/2/calendar/') && r.status() === 200, { timeout: 30000 }).catch(() => {});
  await page.goto('https://clinicsense.com/dashboard/calendar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await calDone;
  await page.waitForTimeout(2000);

  // Screenshot of full calendar
  await page.screenshot({ path: 'debug-calendar-full.png', fullPage: true });
  console.log('Saved debug-calendar-full.png');

  // Log all clickable elements (buttons, links, role=button)
  const clickables = await page.evaluate(() => {
    const els = [...document.querySelectorAll('button, a, [role="button"], [class*="btn"]')];
    return els
      .map(el => ({ tag: el.tagName, text: el.innerText?.trim().substring(0, 60), cls: el.className?.substring(0, 80) }))
      .filter(e => e.text);
  });
  console.log('\n── All clickable elements:');
  clickables.forEach(e => console.log(`  <${e.tag}> "${e.text}" class="${e.cls}"`));

  await browser.close();
})();
