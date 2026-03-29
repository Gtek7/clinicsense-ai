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

  // Select client "Nino Test"
  await page.fill('input[placeholder*="Search for a client by name"]', 'Nino Test');
  await page.waitForTimeout(2000);
  await page.locator('text=Nino Test').first().click();
  await page.waitForTimeout(1500);
  console.log('Client selected.');

  // ── Click Service dropdown using Playwright native click ─────────────────────
  console.log('\n── Clicking Service dropdown with Playwright...');
  await page.click('text=Select service');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'debug-step3-service-open.png' });

  // Inspect the service options
  const serviceOptions = await page.evaluate(() => {
    // Look for any newly visible elements that might be service options
    const allVis = [...document.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.top > 200 && r.top < 700 && r.left > 250 && r.width > 100 && r.height > 10 && r.height < 60;
    });
    // Filter to leaf-level text elements
    return allVis
      .filter(el => (el.innerText||'').trim().length > 0 && el.children.length < 3)
      .map(el => ({ tag: el.tagName, cls: el.className.substring(0,60), txt: (el.innerText||'').trim().substring(0,60), y: Math.round(el.getBoundingClientRect().top) }))
      .filter(e => !['SCRIPT','STYLE'].includes(e.tag))
      .slice(0, 30);
  });
  console.log('Service area elements:', JSON.stringify(serviceOptions));

  // Try clicking "Relaxation Massage" or any massage service
  const svcInput = page.locator('input[placeholder*="Search by short code"]');
  const isVisible = await svcInput.isVisible().catch(() => false);
  console.log('Service search input visible:', isVisible);
  if (isVisible) {
    await svcInput.fill('Relaxation');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'debug-step3-service-search.png' });
    console.log('Typed "Relaxation" in service search');

    // Inspect options now
    const opts2 = await page.evaluate(() => {
      return [...document.querySelectorAll('*')].filter(el => {
        const r = el.getBoundingClientRect();
        const txt = (el.innerText||'').trim();
        return r.top > 200 && r.top < 700 && txt.toLowerCase().includes('relaxation') && txt.length < 100;
      }).map(el => ({ tag: el.tagName, cls: el.className.substring(0,60), txt: (el.innerText||'').trim() }));
    });
    console.log('Relaxation options:', JSON.stringify(opts2));

    // Click the first relaxation service
    try {
      await page.locator('text=Relaxation Massage').first().click({ timeout: 5000 });
      console.log('Clicked Relaxation Massage!');
    } catch(e) {
      console.log('Could not click via text:', e.message);
    }
  } else {
    // No search input - maybe options are listed directly. Try clicking visible option.
    console.log('No search input. Trying to click first service option...');
    try {
      const firstOption = page.locator('text=Relaxation Massage').first();
      if (await firstOption.count() > 0) {
        await firstOption.click();
        console.log('Clicked Relaxation Massage!');
      }
    } catch(e) {
      console.log('Error:', e.message);
    }
  }

  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'debug-step3-after-service.png' });

  // ── Inspect time spinners ──────────────────────────────────────────────────
  console.log('\n── Inspecting time spinners...');
  // The spinners are the 3 small boxes under "Start Time"
  // Let's find them by their screen position (they're small boxes near y=380)
  const spinnerData = await page.evaluate(() => {
    // Find the "Start Time" text and get its y position
    let startTimeY = 0;
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText||'').trim() === 'Start Time') {
        startTimeY = el.getBoundingClientRect().top;
        break;
      }
    }
    // Find all small input-like elements near the start time row
    const nearTime = [...document.querySelectorAll('input, [class*="spinner"], [class*="time-input"]')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.top > startTimeY && r.top < startTimeY + 60 && r.width > 0;
    });
    return {
      startTimeY,
      nearTime: nearTime.map(el => ({ tag: el.tagName, type: el.type, cls: el.className.substring(0,80), val: el.value, x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top), w: Math.round(el.getBoundingClientRect().width) }))
    };
  });
  console.log('Time spinner data:', JSON.stringify(spinnerData));

  // Get exact positions of all 3 start time spinners by inspecting the DOM tree
  // around the "Start Time" label
  const spinnerPositions = await page.evaluate(() => {
    const allDivs = [...document.querySelectorAll('div, span')];
    // Find divs that have exactly one input child and are small
    const spinners = allDivs.filter(el => {
      const rect = el.getBoundingClientRect();
      return rect.width > 30 && rect.width < 90 && rect.height > 30 && rect.height < 70 && el.querySelector('input');
    });
    return spinners.map(el => {
      const input = el.querySelector('input');
      return {
        containerCls: el.className.substring(0,80),
        inputType: input?.type, inputCls: input?.className.substring(0,60), inputVal: input?.value,
        rect: { x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top), w: Math.round(el.getBoundingClientRect().width) }
      };
    });
  });
  console.log('\nAll spinner-like divs:', JSON.stringify(spinnerPositions));

  // Click the first start time spinner input
  console.log('\nClicking first start time spinner...');
  const inputs = await page.$$('input');
  console.log(`Total inputs: ${inputs.length}`);
  for (const inp of inputs) {
    const visible = await inp.isVisible();
    const val = await inp.inputValue();
    const box = await inp.boundingBox();
    if (box) console.log(`  Input visible=${visible} val="${val}" x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)}`);
  }

  await browser.close();
  console.log('\nDone!');
})();
