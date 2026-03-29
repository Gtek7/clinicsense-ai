require('dotenv').config();
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

  await page.goto('https://clinicsense.com/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.fill('input[type="email"]', process.env.CLINICSENSE_EMAIL);
  await page.fill('input[type="password"]', process.env.CLINICSENSE_PASSWORD);
  await page.click('button[type="submit"], button:has-text("LOGIN"), input[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  const calDone = page.waitForResponse(r => r.url().includes('/api/2/calendar/') && r.status() === 200, { timeout: 30000 }).catch(() => {});
  await page.goto('https://clinicsense.com/dashboard/calendar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await calDone;
  await page.waitForTimeout(2000);

  // Find elements by position (bottom-right fixed elements = FAB)
  const fabInfo = await page.evaluate(() => {
    const results = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE') continue;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const cls = typeof el.className === 'string' ? el.className : '';
      const txt = (el.innerText || '').trim();
      // Fixed positioned in bottom-right quarter
      if (style.position === 'fixed' && rect.bottom > 400 && rect.right > 600) {
        results.push({ tag: el.tagName, cls: cls.substring(0, 100), txt: txt.substring(0, 30), rect: { top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom), left: Math.round(rect.left) } });
      }
    }
    return results;
  });
  console.log('Fixed bottom-right elements (FAB candidates):');
  fabInfo.forEach(f => console.log(JSON.stringify(f)));

  // Also dump all elements with class containing common FAB terms
  const fabByClass = await page.evaluate(() => {
    const terms = ['fab', 'float', 'add-btn', 'new-btn', 'create', 'plus', 'add-appointment'];
    const results = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
      if (terms.some(t => cls.includes(t))) {
        results.push({ tag: el.tagName, cls: el.className?.substring(0, 100), txt: (el.innerText || '').trim().substring(0, 30) });
      }
    }
    return results.slice(0, 20);
  });
  console.log('\nElements with FAB-related class names:');
  fabByClass.forEach(f => console.log(JSON.stringify(f)));

  // Try clicking the bottom-right corner of the viewport where the + button is
  const vp = page.viewportSize();
  console.log(`\nViewport: ${vp.width}x${vp.height}`);
  console.log('Clicking bottom-right corner...');
  await page.mouse.click(vp.width - 25, vp.height - 25);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'debug-after-corner-click.png' });
  console.log('Saved debug-after-corner-click.png');

  await browser.close();
})();
