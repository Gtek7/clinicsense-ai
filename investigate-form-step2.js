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
  console.log('Form is open!');

  // ── Step 1: Type "Nino Test" and click the matching dropdown item ───────────
  console.log('\n── Searching for "Nino Test"...');
  await page.fill('input[placeholder*="Search for a client by name"]', 'Nino Test');
  await page.waitForTimeout(2000);

  // Inspect what's in the dropdown overlay
  const dropdownItems = await page.evaluate(() => {
    // Find all elements that are currently visible and contain client names
    // The dropdown is likely a sibling/child of the input's container
    const input = document.querySelector('input[placeholder*="Search for a client by name"]');
    if (!input) return [];
    // Walk up to find the container, then find all list items
    let container = input.parentElement;
    for (let i = 0; i < 5; i++) {
      const items = container.querySelectorAll('li, [class*="item"], [class*="option"]');
      if (items.length > 0) {
        return [...items].map(el => ({
          tag: el.tagName, cls: el.className, txt: (el.innerText || '').trim().substring(0, 80),
          rect: { top: Math.round(el.getBoundingClientRect().top), left: Math.round(el.getBoundingClientRect().left) }
        }));
      }
      container = container.parentElement;
      if (!container) break;
    }
    // Fallback: look for any positioned overlay
    return [...document.querySelectorAll('li')].filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.top > 100 && rect.top < 600 && rect.left > 200 && rect.width > 100;
    }).map(el => ({ tag: el.tagName, cls: el.className, txt: (el.innerText || '').trim().substring(0, 80),
      rect: { top: Math.round(el.getBoundingClientRect().top) } }));
  });
  console.log('Dropdown items found:', JSON.stringify(dropdownItems));

  // Try Playwright's built-in text selector
  const nino = page.getByText('Nino Test', { exact: true });
  const ninoCount = await nino.count();
  console.log('Playwright getByText("Nino Test") count:', ninoCount);
  if (ninoCount > 0) {
    const rects = await nino.evaluateAll(els => els.map(el => ({
      tag: el.tagName, cls: el.className, visible: el.offsetParent !== null,
      rect: { top: Math.round(el.getBoundingClientRect().top), left: Math.round(el.getBoundingClientRect().left) }
    })));
    console.log('Elements:', JSON.stringify(rects));
  }

  // Screenshot of dropdown
  await page.screenshot({ path: 'debug-step2-client-dropdown.png' });

  // Click "Nino Test" using Playwright first() visible
  console.log('\n── Clicking "Nino Test"...');
  try {
    await page.locator('text=Nino Test').first().click({ timeout: 5000 });
    console.log('Clicked via Playwright locator!');
  } catch (e) {
    console.log('Playwright click failed:', e.message);
    // Fallback: click by coordinate
    const found = await page.evaluate(() => {
      const els = [...document.querySelectorAll('*')];
      for (const el of els) {
        if ((el.innerText || '').trim() === 'Nino Test') {
          const rect = el.getBoundingClientRect();
          return { x: rect.left + rect.width/2, y: rect.top + rect.height/2, tag: el.tagName, cls: el.className };
        }
      }
      return null;
    });
    console.log('Found by innerText:', JSON.stringify(found));
    if (found) {
      await page.mouse.click(found.x, found.y);
      console.log(`Clicked at (${found.x}, ${found.y})`);
    }
  }

  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'debug-step2-after-client-select.png' });

  // What's in the form now?
  const afterClient = await page.evaluate(() => {
    return [...document.querySelectorAll('input, select, textarea')].filter(el => el.offsetParent).map(el => ({
      type: el.type, placeholder: el.placeholder, value: el.value, cls: el.className.substring(0, 60)
    }));
  });
  console.log('Inputs after client select:', JSON.stringify(afterClient));

  // ── Step 2: Service dropdown ────────────────────────────────────────────────
  console.log('\n── Investigating Service dropdown...');
  // Inspect the service dropdown container
  const serviceInfo = await page.evaluate(() => {
    // Find the element showing "Select service"
    const els = [...document.querySelectorAll('*')];
    for (const el of els) {
      if ((el.innerText || '').trim() === 'Select service') {
        const parent = el.parentElement;
        return {
          el: { tag: el.tagName, cls: el.className },
          parent: { tag: parent?.tagName, cls: parent?.className },
          grandparent: { tag: parent?.parentElement?.tagName, cls: parent?.parentElement?.className },
        };
      }
    }
    return null;
  });
  console.log('Service dropdown info:', JSON.stringify(serviceInfo));

  // Click service dropdown
  await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')];
    for (const el of els) {
      if ((el.innerText || '').trim() === 'Select service') { el.click(); return; }
    }
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'debug-step2-service-dropdown.png' });

  // What appeared?
  const afterServiceClick = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('li, [class*="item"]')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.top > 0 && r.height > 10 && r.width > 50;
    });
    return visible.slice(0, 20).map(el => ({ tag: el.tagName, cls: el.className, txt: (el.innerText||'').trim().substring(0,60) }));
  });
  console.log('After service click items:', JSON.stringify(afterServiceClick));

  // Search for service
  const serviceInput = await page.$('input[placeholder*="Search by short code"]');
  if (serviceInput && await serviceInput.isVisible()) {
    await serviceInput.fill('Relaxation');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'debug-step2-service-search.png' });
    console.log('Filled service search with "Relaxation"');
  }

  // Inspect the time spinners area
  console.log('\n── Time spinner inspection...');
  const timeArea = await page.evaluate(() => {
    // Find the "Start Time" label and then inspect nearby elements
    const allEls = [...document.querySelectorAll('*')];
    for (const el of allEls) {
      if ((el.innerText || '').trim() === 'Start Time') {
        const container = el.parentElement;
        const sibling = container?.nextElementSibling || container?.parentElement;
        const allChildren = [...(sibling?.querySelectorAll('*') || [])];
        return {
          labelEl: { tag: el.tagName, cls: el.className },
          nearbyInputs: allChildren.filter(c => c.tagName === 'INPUT' || c.tagName === 'SELECT').map(c => ({
            tag: c.tagName, type: c.type, placeholder: c.placeholder, cls: c.className.substring(0, 80), val: c.value
          })),
          nearbyDivs: allChildren.slice(0, 10).map(c => ({ tag: c.tagName, cls: c.className.substring(0, 60), txt: (c.innerText||'').trim().substring(0,20) }))
        };
      }
    }
    return null;
  });
  console.log('Time area:', JSON.stringify(timeArea));

  await browser.close();
  console.log('\nDone!');
})();
