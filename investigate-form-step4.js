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

  // Find ALL visible elements with their coordinates
  const visibleElements = await page.evaluate(() => {
    return [...document.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect();
      // Must be in modal area (roughly)
      return r.top > 80 && r.top < 600 && r.left > 250 && r.width > 20 && r.height > 10 && r.height < 80;
    }).map(el => ({
      tag: el.tagName, cls: el.className.substring(0, 60),
      txt: (el.innerText || '').trim().substring(0, 40),
      visible: window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden',
      x: Math.round(el.getBoundingClientRect().left),
      y: Math.round(el.getBoundingClientRect().top),
      w: Math.round(el.getBoundingClientRect().width),
      h: Math.round(el.getBoundingClientRect().height),
    })).filter(e => e.txt && e.visible);
  });
  console.log('\nAll visible elements in modal:');
  visibleElements.forEach(e => console.log(`  y=${e.y} x=${e.x} "${e.txt}" <${e.tag} class="${e.cls}">`));

  // Find the "Select service" element with correct visibility
  const serviceEl = visibleElements.find(e => e.txt === 'Select service');
  console.log('\nService dropdown el:', JSON.stringify(serviceEl));

  // Click service dropdown by coordinates
  if (serviceEl) {
    const cx = serviceEl.x + serviceEl.w / 2;
    const cy = serviceEl.y + serviceEl.h / 2;
    console.log(`Clicking service at (${cx}, ${cy})...`);
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'debug-step4-service-open.png' });

    // Find what opened
    const after = await page.evaluate(() => {
      return [...document.querySelectorAll('*')].filter(el => {
        const r = el.getBoundingClientRect();
        const txt = (el.innerText || '').trim();
        return r.top > 200 && r.top < 750 && r.left > 250 && r.width > 100 && txt && txt.length < 80 && el.children.length <= 3;
      }).map(el => ({
        tag: el.tagName, cls: el.className.substring(0, 60),
        txt: (el.innerText || '').trim().substring(0, 60),
        y: Math.round(el.getBoundingClientRect().top),
        x: Math.round(el.getBoundingClientRect().left),
      }));
    });
    console.log('\nAfter service click - elements:', JSON.stringify(after.slice(0, 30)));

    // Try typing in the search box if visible
    const searchVisible = await page.$eval('input[placeholder*="Search by short code"]', el => el.offsetParent !== null).catch(() => false);
    console.log('Service search input visible:', searchVisible);

    if (searchVisible) {
      await page.fill('input[placeholder*="Search by short code"]', 'Relaxation');
      await page.waitForTimeout(1500);
      await page.screenshot({ path: 'debug-step4-service-searched.png' });
      console.log('Searched for "Relaxation"');

      // Find and click the option
      const relaxEl = await page.evaluate(() => {
        return [...document.querySelectorAll('*')].filter(el => {
          const txt = (el.innerText || '').trim();
          return txt.toLowerCase().includes('relaxation massage') && txt.length < 100;
        }).map(el => ({
          tag: el.tagName, cls: el.className.substring(0, 60), txt: (el.innerText || '').trim(),
          x: Math.round(el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2),
          y: Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2),
        }));
      });
      console.log('Relaxation Massage options:', JSON.stringify(relaxEl));

      if (relaxEl.length > 0) {
        await page.mouse.click(relaxEl[0].x, relaxEl[0].y);
        console.log('Clicked Relaxation Massage!');
        await page.waitForTimeout(1500);
        await page.screenshot({ path: 'debug-step4-after-service.png' });
      }
    }
  }

  // ── Time Spinners: Find by coordinate ─────────────────────────────────────
  console.log('\n\n── Time spinner investigation...');
  await page.screenshot({ path: 'debug-step4-before-time.png' });

  const timeSpinners = await page.evaluate(() => {
    // Find "Start Time" label
    let startY = 300;
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText || '').trim() === 'Start Time') {
        startY = el.getBoundingClientRect().top;
        break;
      }
    }
    console.log('startY:', startY);

    // Find inputs in the time row
    const inputs = [...document.querySelectorAll('input')];
    return inputs.map(el => {
      const r = el.getBoundingClientRect();
      return { type: el.type, placeholder: el.placeholder, value: el.value, cls: el.className.substring(0,60), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), visible: el.offsetParent !== null };
    });
  });
  console.log('All inputs (with position):', JSON.stringify(timeSpinners));

  // Try clicking on each visible non-text input area (the time spinners)
  // Based on the form screenshot, start time is around y=380 x=280-580
  console.log('\nClicking at approximate start time positions...');
  // Click hour input (first spinner, approx x=325, y=380)
  await page.mouse.click(325, 380);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'debug-step4-hour-click.png' });

  // Check which element got focused
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return { tag: el?.tagName, type: el?.type, cls: el?.className, val: el?.value, placeholder: el?.placeholder };
  });
  console.log('Focused element:', JSON.stringify(focused));

  // Type a value and see what happens
  await page.keyboard.type('2');
  await page.waitForTimeout(300);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  await page.keyboard.type('00');
  await page.waitForTimeout(300);
  await page.keyboard.press('Tab');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'debug-step4-time-typed.png' });
  console.log('Typed time values');

  // Get current state of inputs
  const afterTyping = await page.evaluate(() => {
    return [...document.querySelectorAll('input')].filter(el => el.offsetParent).map(el => ({
      val: el.value, placeholder: el.placeholder, x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top)
    }));
  });
  console.log('Inputs after typing:', JSON.stringify(afterTyping));

  await browser.close();
  console.log('\nDone!');
})();
