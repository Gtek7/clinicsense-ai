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

  // Select service
  const svcCoord = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText || '').trim() === 'Select service') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      }
    }
    return null;
  });
  await page.mouse.click(svcCoord.x, svcCoord.y);
  await page.waitForTimeout(1500);

  // Click Swedish Relaxation Massage 60 MIN
  await page.evaluate(() => {
    const allEls = [...document.querySelectorAll('*')];
    let serviceEl = null;
    for (const el of allEls) {
      const txt = (el.innerText || '').trim().toLowerCase();
      if (txt.includes('relaxation') && txt.length < 80 && el.children.length <= 2) {
        const r = el.getBoundingClientRect();
        if (r.width > 100 && r.height > 0) { serviceEl = { el, y: r.top }; break; }
      }
    }
    if (!serviceEl) return;
    const serviceY = serviceEl.y;
    for (const el of allEls) {
      if ((el.innerText || '').trim() === '60 MIN') {
        const r = el.getBoundingClientRect();
        if (r.top > serviceY && r.top < serviceY + 100 && r.width > 20) { el.click(); return; }
      }
    }
  });
  await page.waitForTimeout(1500);

  // Select practitioner: click dropdown then find correct list item
  const pracCoord = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText || '').trim() === 'Select practitioner') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), dropdownY: Math.round(r.bottom) };
      }
    }
    return null;
  });
  await page.mouse.click(pracCoord.x, pracCoord.y);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'debug-final-prac-open.png' });

  // Find practitioner items: must be BELOW the dropdown (y > dropdownY) and no newlines
  const pracItems = await page.evaluate(({ dropdownY, targetName }) => {
    const allEls = [...document.querySelectorAll('*')];
    const results = [];
    for (const el of allEls) {
      const txt = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      // Must be below dropdown, single-line text, contain target name
      if (r.top > dropdownY && !txt.includes('\n') && txt.length > 2 && txt.length < 80 && r.width > 50) {
        if (txt.toLowerCase().includes(targetName.toLowerCase())) {
          results.push({ tag: el.tagName, cls: el.className.substring(0, 60), txt, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) });
        }
      }
    }
    return results;
  }, { dropdownY: pracCoord.dropdownY, targetName: 'walaipun' });
  console.log('Practitioner items below dropdown:', JSON.stringify(pracItems));

  // Click the first matching practitioner item
  if (pracItems.length > 0) {
    const item = pracItems[0];
    await page.mouse.click(item.x + item.w/2, item.y + 10);
    console.log('Clicked practitioner:', item.txt);
  }
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'debug-final-after-prac.png' });

  // ── Time spinners: get outerHTML of start_time field ─────────────────────
  const startTimeHTML = await page.evaluate(() => {
    const el = document.querySelector('[data-cs_field_name="start_time"]');
    return el ? el.outerHTML.substring(0, 5000) : 'NOT FOUND';
  });
  console.log('\n── start_time outerHTML (first 3000 chars):');
  console.log(startTimeHTML.substring(0, 3000));

  // Find all inputs inside start_time container
  const startTimeInputs = await page.evaluate(() => {
    const container = document.querySelector('[data-cs_field_name="start_time"]');
    if (!container) return [];
    return [...container.querySelectorAll('input, select, button, [onclick], [class*="spinner"], [class*="arrow"], [class*="up"], [class*="down"]')]
      .map(el => ({ tag: el.tagName, type: el.type, cls: el.className.substring(0, 80), val: el.value, txt: (el.innerText||'').trim().substring(0, 20),
        x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top), w: Math.round(el.getBoundingClientRect().width) }));
  });
  console.log('\n── Inputs inside start_time:', JSON.stringify(startTimeInputs));

  // Try clicking directly on the start_time container
  const startTimeCoord = await page.evaluate(() => {
    const el = document.querySelector('[data-cs_field_name="start_time"]');
    const r = el?.getBoundingClientRect();
    return r ? { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } : null;
  });
  console.log('\nstart_time container coord:', JSON.stringify(startTimeCoord));

  // Now try to click within the start_time div area and see what gets focused
  // The start_time is at x=280, y=338 based on earlier data
  // The first spinner should be just below the label
  if (startTimeCoord) {
    console.log('\nClicking start_time container center...');
    await page.mouse.click(startTimeCoord.x, startTimeCoord.y);
    await page.waitForTimeout(500);
    const foc = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el?.tagName, type: el?.type, cls: el?.className?.substring(0,60), val: el?.value };
    });
    console.log('Focused:', JSON.stringify(foc));
    await page.screenshot({ path: 'debug-final-spinner-click.png' });
  }

  // Try intercepting the API call by clicking SAVE & CLOSE
  // First intercept network
  const apiRequest = new Promise(resolve => {
    page.on('request', req => {
      if (req.url().includes('/api/') && req.method() === 'POST') {
        resolve({ url: req.url(), method: req.method(), body: req.postData() });
      }
    });
    setTimeout(() => resolve(null), 10000);
  });

  console.log('\n── Clicking SAVE & CLOSE to capture API call...');
  await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    for (const el of all) {
      if ((el.innerText || '').trim() === 'SAVE & CLOSE') { el.click(); return; }
    }
  });
  const captured = await apiRequest;
  console.log('API request captured:', JSON.stringify(captured));
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'debug-final-after-save.png' });

  await browser.close();
  console.log('\nDone!');
})();
