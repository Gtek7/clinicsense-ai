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

  // Open the form: click FAB + click popup button
  await page.click('.linearicon-plus');
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    for (const el of all) {
      if ((el.innerText || '').trim() === 'Schedule New Appointment') { el.click(); return; }
    }
  });
  await page.waitForTimeout(2500);
  await page.waitForSelector('input[placeholder*="Search for a client by name"]', { timeout: 15000 });
  console.log('Form is open!');

  // ── 1. Inspect ALL inputs in the form ────────────────────────────────────────
  const allInputs = await page.evaluate(() => {
    return [...document.querySelectorAll('input, select, textarea')].map((el, i) => ({
      index: i,
      tag: el.tagName,
      type: el.type,
      placeholder: el.placeholder,
      name: el.name,
      value: el.value,
      cls: (el.className || '').substring(0, 100),
      id: el.id,
      visible: el.offsetParent !== null,
    }));
  });
  console.log('\n── ALL INPUTS in form:');
  allInputs.forEach(e => console.log(JSON.stringify(e)));

  // ── 2. Fill client search ─────────────────────────────────────────────────
  console.log('\n\n── Filling client search...');
  const clientInput = await page.$('input[placeholder*="Search for a client by name"]');
  await clientInput.fill('Test');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'debug-field-client-search.png' });

  // What appeared in dropdown?
  const dropdown1 = await page.evaluate(() => {
    const opts = [...document.querySelectorAll('[class*="option"], [role="option"], [class*="dropdown"] li, [class*="suggestion"]')];
    return opts.map(el => ({ text: (el.innerText || '').trim().substring(0, 80), cls: (el.className || '').substring(0, 80) }));
  });
  console.log('Client dropdown options:', JSON.stringify(dropdown1));

  // Also check for "+ Add new client" link
  const addNewLink = await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    for (const el of all) {
      const txt = (el.innerText || '').trim();
      if (txt.includes('Add new client') || txt.includes('add new client')) {
        return { tag: el.tagName, cls: el.className, txt };
      }
    }
    return null;
  });
  console.log('Add new client link:', JSON.stringify(addNewLink));

  // ── 3. Click "+ Add new client" ────────────────────────────────────────────
  console.log('\n\n── Clicking + Add new client...');
  const clickedAdd = await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    for (const el of all) {
      const txt = (el.innerText || '').trim();
      if (txt.includes('Add new client')) { el.click(); return txt; }
    }
    return null;
  });
  console.log('Clicked:', clickedAdd);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'debug-field-add-new-client.png' });

  const afterAddNew = await page.evaluate(() => {
    return [...document.querySelectorAll('input, select, textarea')].map((el, i) => ({
      index: i, tag: el.tagName, type: el.type,
      placeholder: el.placeholder, name: el.name, value: el.value,
      cls: (el.className || '').substring(0, 100), id: el.id,
      visible: el.offsetParent !== null,
    }));
  });
  console.log('\n── ALL INPUTS after Add new client:');
  afterAddNew.forEach(e => console.log(JSON.stringify(e)));

  // ── 4. Inspect the service dropdown ────────────────────────────────────────
  await page.screenshot({ path: 'debug-field-service-before-click.png' });
  console.log('\n\n── Clicking Service dropdown...');
  // The service dropdown shows "Select service" with a chevron
  const serviceDropdown = await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    for (const el of all) {
      if ((el.innerText || '').trim() === 'Select service') return { tag: el.tagName, cls: el.className };
    }
    return null;
  });
  console.log('Service dropdown element:', JSON.stringify(serviceDropdown));

  // ── 5. Check the time spinner inputs in detail ────────────────────────────
  const timeInputDetails = await page.evaluate(() => {
    // Get all number-type or spinner-type inputs
    const spinners = [...document.querySelectorAll('input[type="number"], .spinner input, [class*="time"] input, [class*="hour"], [class*="minute"]')];
    // Also get all inputs that look like spinners (no placeholder, small width)
    const allInputs = [...document.querySelectorAll('input')];
    const smallInputs = allInputs.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.width < 100 && !el.placeholder;
    });
    return {
      spinnersBySelector: spinners.map(el => ({ tag: el.tagName, type: el.type, cls: el.className, id: el.id, val: el.value, w: Math.round(el.getBoundingClientRect().width) })),
      smallInputs: smallInputs.map(el => ({ type: el.type, cls: el.className, id: el.id, val: el.value, w: Math.round(el.getBoundingClientRect().width) })),
    };
  });
  console.log('\n── Time spinners by selector:', JSON.stringify(timeInputDetails.spinnersBySelector));
  console.log('── Small inputs:', JSON.stringify(timeInputDetails.smallInputs));

  await browser.close();
  console.log('\nDone.');
})();
