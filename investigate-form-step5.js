require('dotenv').config();
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

  await page.goto('https://clinicsense.com/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[type="email"]');
  await page.fill('input[type="email"]', process.env.CLINICSENSE_EMAIL);
  await page.fill('input[type="password"]', process.env.CLINICSENSE_PASSWORD);
  await page.click('button[type="submit"], button:has-text("LOGIN")');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  const calDone = page.waitForResponse(r => r.url().includes('/api/2/calendar/') && r.status() === 200, { timeout: 30000 }).catch(() => {});
  await page.goto('https://clinicsense.com/dashboard/calendar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await calDone;
  await page.waitForTimeout(2000);

  // Open form
  await page.click('.linearicon-plus');
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText || '').trim() === 'Schedule New Appointment') { el.click(); return; }
    }
  });
  await page.waitForSelector('input[placeholder*="Search for a client by name"]', { timeout: 15000 });

  // Select client
  await page.fill('input[placeholder*="Search for a client by name"]', 'Nino Test');
  await page.waitForTimeout(2000);
  await page.locator('text=Nino Test').first().click();
  await page.waitForTimeout(1500);
  console.log('Client selected.');

  // ── Click Service dropdown ────────────────────────────────────────────────
  // Find "Select service" visible element and get its coordinate
  const svcCoord = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim();
      if (txt === 'Select service') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
    }
    return null;
  });
  console.log('Service dropdown coord:', JSON.stringify(svcCoord));
  await page.mouse.click(svcCoord.x, svcCoord.y);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'debug-step5-service-open.png' });

  // ── Select "Swedish Relaxation Massage" 60 MIN ───────────────────────────
  // Find the service name and then click 60 MIN button
  // The service items are: service name row, then duration buttons
  const serviceItems = await page.evaluate((targetService) => {
    const results = [];
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim().toLowerCase();
      if (txt.includes(targetService.toLowerCase()) && txt.length < 80) {
        const r = el.getBoundingClientRect();
        if (r.width > 100) {
          results.push({ tag: el.tagName, txt: (el.innerText || '').trim(), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
        }
      }
    }
    return results;
  }, 'relaxation');
  console.log('Service items matching "relaxation":', JSON.stringify(serviceItems));

  // Click the service name (Swedish Relaxation Massage)
  const svcRow = serviceItems.find(e => e.txt.toLowerCase().includes('relaxation massage'));
  if (svcRow) {
    await page.mouse.click(svcRow.x, svcRow.y);
    console.log('Clicked service row:', svcRow.txt);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'debug-step5-service-clicked.png' });
  }

  // Find and click "60 MIN" button
  const durItems = await page.evaluate(() => {
    const results = [];
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim();
      if (txt === '60 MIN' || txt === '60MIN') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) results.push({ tag: el.tagName, cls: el.className.substring(0,60), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) });
      }
    }
    return results;
  });
  console.log('60 MIN buttons:', JSON.stringify(durItems));

  if (durItems.length > 0) {
    await page.mouse.click(durItems[0].x, durItems[0].y);
    console.log('Clicked 60 MIN button!');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'debug-step5-after-service-select.png' });
  }

  // ── What inputs appear now? ──────────────────────────────────────────────
  const inputsAfterService = await page.evaluate(() => {
    return [...document.querySelectorAll('input, select')].filter(el => el.offsetParent).map(el => ({
      type: el.type, placeholder: el.placeholder, val: el.value, cls: el.className.substring(0, 60),
      x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top), w: Math.round(el.getBoundingClientRect().width)
    }));
  });
  console.log('\nInputs after service selected:', JSON.stringify(inputsAfterService));

  // ── Time spinner deep inspection ────────────────────────────────────────
  // Get full outerHTML of the time section
  const timeHTML = await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    for (const el of all) {
      if ((el.innerText || '').trim() === 'Start Time') {
        // Get parent container
        let container = el;
        for (let i = 0; i < 4; i++) container = container.parentElement;
        return container?.outerHTML?.substring(0, 3000);
      }
    }
    return null;
  });
  console.log('\n── Start Time container HTML:', timeHTML);

  // ── Inspect practitioner dropdown ───────────────────────────────────────
  console.log('\n── Investigating Practitioner dropdown...');
  const pracCoord = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim();
      if (txt === 'Select practitioner') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
    }
    return null;
  });
  console.log('Practitioner dropdown coord:', JSON.stringify(pracCoord));

  if (pracCoord) {
    await page.mouse.click(pracCoord.x, pracCoord.y);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'debug-step5-practitioner-open.png' });
    const pracItems = await page.evaluate(() => {
      return [...document.querySelectorAll('*')].filter(el => {
        const r = el.getBoundingClientRect();
        const txt = (el.innerText || '').trim();
        return r.top > 250 && r.top < 600 && r.left > 250 && r.width > 50 && txt.length > 2 && txt.length < 80 && el.children.length <= 2;
      }).map(el => ({ tag: el.tagName, cls: el.className.substring(0,60), txt: (el.innerText||'').trim(), y: Math.round(el.getBoundingClientRect().top) }));
    });
    console.log('Practitioner options:', JSON.stringify(pracItems.slice(0, 20)));
  }

  await browser.close();
  console.log('\nDone!');
})();
