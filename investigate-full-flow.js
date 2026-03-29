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

  // ── Helper: click element by exact innerText ───────────────────────────────
  const clickByText = async (text) => {
    return page.evaluate((t) => {
      for (const el of document.querySelectorAll('*')) {
        if ((el.innerText || '').trim() === t) { el.click(); return true; }
      }
      return false;
    }, text);
  };

  // ── Helper: find visible dropdown coordinate ───────────────────────────────
  const findVisibleByText = async (text) => {
    return page.evaluate((t) => {
      for (const el of document.querySelectorAll('*')) {
        const txt = (el.innerText || '').trim();
        if (txt === t) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), bottom: Math.round(r.bottom) };
        }
      }
      return null;
    }, text);
  };

  // ── Open form ──────────────────────────────────────────────────────────────
  await page.click('.linearicon-plus');
  await page.waitForTimeout(2000);
  await clickByText('Schedule New Appointment');
  await page.waitForSelector('input[placeholder*="Search for a client by name"]', { timeout: 15000 });
  console.log('Form open.');

  // ── Client ─────────────────────────────────────────────────────────────────
  await page.fill('input[placeholder*="Search for a client by name"]', 'Nino Test');
  await page.waitForTimeout(2000);
  await page.locator('text=Nino Test').first().click();
  await page.waitForTimeout(1500);
  console.log('Client: Nino Test');

  // ── Service ────────────────────────────────────────────────────────────────
  const svc = await findVisibleByText('Select service');
  await page.mouse.click(svc.x, svc.y);
  await page.waitForTimeout(1500);

  // Find service + click closest 60 MIN button
  await page.evaluate(() => {
    const allEls = [...document.querySelectorAll('*')];
    let serviceEl = null;
    for (const el of allEls) {
      const txt = (el.innerText || '').trim().toLowerCase();
      if (txt.includes('relaxation') && txt.length < 80 && el.children.length <= 2) {
        const r = el.getBoundingClientRect();
        if (r.width > 100) { serviceEl = { el, y: r.top }; break; }
      }
    }
    if (!serviceEl) return;
    for (const el of allEls) {
      if ((el.innerText || '').trim() === '60 MIN') {
        const r = el.getBoundingClientRect();
        if (r.top > serviceEl.y && r.top < serviceEl.y + 100 && r.width > 20) { el.click(); return; }
      }
    }
  });
  await page.waitForTimeout(1500);
  console.log('Service: 60 minute Swedish Relaxation Massage');

  // ── Practitioner ───────────────────────────────────────────────────────────
  const prac = await findVisibleByText('Select practitioner');
  await page.mouse.click(prac.x, prac.y);
  await page.waitForTimeout(1500);

  // Find practitioner below dropdown
  await page.evaluate(({ dropY, name }) => {
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim();
      if (txt.toLowerCase().includes(name) && !txt.includes('\n') && txt.length < 80) {
        const r = el.getBoundingClientRect();
        if (r.top > dropY && r.width > 50) { el.click(); return; }
      }
    }
  }, { dropY: prac.bottom, name: 'walaipun' });
  await page.waitForTimeout(1500);
  console.log('Practitioner: Walaipun');

  // ── Date ──────────────────────────────────────────────────────────────────
  // Click the start_date container using mouse (BOX-flex-manager intercepts direct clicks)
  const dateContainerCoord = await page.evaluate(() => {
    const el = document.querySelector('[data-cs_field_name="start_date"]');
    const r = el?.getBoundingClientRect();
    // Find the input inside the container
    const input = el?.querySelector('input');
    const ir = input?.getBoundingClientRect();
    return ir ? { x: Math.round(ir.left + ir.width/2), y: Math.round(ir.top + ir.height/2) } : (r ? { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } : null);
  });
  console.log('Date container coord:', JSON.stringify(dateContainerCoord));
  if (dateContainerCoord) {
    await page.mouse.click(dateContainerCoord.x, dateContainerCoord.y);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'debug-flow-date-open.png' });

    // Navigate to March 29 using the date picker
    // Click "next" to go to next day, or select the day directly
    // Try clicking "29" in the calendar
    const dayClicked = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        const txt = (el.innerText || '').trim();
        if (txt === '29') {
          const r = el.getBoundingClientRect();
          if (r.width > 10 && r.width < 60 && r.top > 200) { el.click(); return { x: Math.round(r.left), y: Math.round(r.top) }; }
        }
      }
      return null;
    });
    console.log('Day 29 clicked:', JSON.stringify(dayClicked));
    await page.waitForTimeout(1000);
  }
  await page.screenshot({ path: 'debug-flow-date.png' });
  console.log('Date set attempt');

  // ── Get time spinner coordinates ────────────────────────────────────────
  // Find the start_time container and calculate spinner positions
  const timeCoords = await page.evaluate(() => {
    const startEl = document.querySelector('[data-cs_field_name="start_time"]');
    const endEl = document.querySelector('[data-cs_field_name="end_time"]');
    if (!startEl || !endEl) return null;

    const sr = startEl.getBoundingClientRect();
    const er = endEl.getBoundingClientRect();

    // Find the actual spinner BOX elements within start_time
    const startSpinners = [...startEl.querySelectorAll('.BOX-flex-manager')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 30 && r.width < 90 && r.height > 20 && r.height < 60 && r.top > sr.top + 10;
    });
    // Take unique x positions (to find the 3 spinners)
    const uniqueX = [...new Set(startSpinners.map(el => Math.round(el.getBoundingClientRect().left)))];
    const spinners = uniqueX.slice(0, 3).map(x => {
      const el = startSpinners.find(e => Math.round(e.getBoundingClientRect().left) === x);
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    });

    // For end_time, same approach
    const endSpinners = [...endEl.querySelectorAll('.BOX-flex-manager')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 30 && r.width < 90 && r.height > 20 && r.height < 60 && r.top > er.top + 10;
    });
    const uniqueEndX = [...new Set(endSpinners.map(el => Math.round(el.getBoundingClientRect().left)))];
    const endSpinnersCoords = uniqueEndX.slice(0, 3).map(x => {
      const el = endSpinners.find(e => Math.round(e.getBoundingClientRect().left) === x);
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    });

    return { start: spinners, end: endSpinnersCoords, startContainer: { x: Math.round(sr.left), y: Math.round(sr.top), w: Math.round(sr.width) } };
  });
  console.log('Time spinner coords:', JSON.stringify(timeCoords));

  // ── Set Start Time: 2:00 PM ────────────────────────────────────────────────
  // Target: 2:00 PM → hour=2, min=00, ampm=PM
  if (timeCoords && timeCoords.start.length >= 3) {
    const [hourSpinner, minSpinner, ampmSpinner] = timeCoords.start;

    // Click HOUR spinner
    console.log(`Clicking hour spinner at (${hourSpinner.x}, ${hourSpinner.y})...`);
    await page.mouse.click(hourSpinner.x, hourSpinner.y);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'debug-flow-hour-dropdown.png' });

    // Select hour 2
    const hourClicked = await page.evaluate(() => {
      // Find visible dropdown items that are single numbers
      for (const el of document.querySelectorAll('*')) {
        const txt = (el.innerText || '').trim();
        if (txt === '2') {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.top > 300 && r.top < 700) { el.click(); return true; }
        }
      }
      return false;
    });
    console.log('Hour 2 clicked:', hourClicked);
    await page.waitForTimeout(800);

    // Click MINUTE spinner
    console.log(`Clicking minute spinner at (${minSpinner.x}, ${minSpinner.y})...`);
    await page.mouse.click(minSpinner.x, minSpinner.y);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'debug-flow-min-dropdown.png' });

    // Select minute 00
    const minClicked = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        const txt = (el.innerText || '').trim();
        if (txt === '00') {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.top > 300 && r.top < 700) { el.click(); return true; }
        }
      }
      return false;
    });
    console.log('Minute 00 clicked:', minClicked);
    await page.waitForTimeout(800);

    // Click AM/PM spinner
    console.log(`Clicking AM/PM spinner at (${ampmSpinner.x}, ${ampmSpinner.y})...`);
    await page.mouse.click(ampmSpinner.x, ampmSpinner.y);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'debug-flow-ampm-dropdown.png' });

    // Select PM
    const pmClicked = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        const txt = (el.innerText || '').trim();
        if (txt === 'PM') {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.top > 300 && r.top < 700) { el.click(); return true; }
        }
      }
      return false;
    });
    console.log('PM clicked:', pmClicked);
    await page.waitForTimeout(800);
  }

  await page.screenshot({ path: 'debug-flow-before-save.png' });
  console.log('Screenshot before save');

  // ── Intercept API call ────────────────────────────────────────────────────
  const allRequests = [];
  page.on('request', req => {
    if (req.method() === 'POST' || req.url().includes('/api/')) {
      allRequests.push({ url: req.url(), method: req.method(), body: req.postData()?.substring(0, 200) });
    }
  });

  // ── Click SAVE & CLOSE ────────────────────────────────────────────────────
  console.log('\nClicking SAVE & CLOSE...');
  try {
    // Use Playwright's click with last() to get the button at the bottom
    await page.locator('text=SAVE & CLOSE').last().click({ timeout: 10000 });
  } catch {
    // Fallback: find SAVE & CLOSE button by coordinate (bottom of page)
    const saveCoord = await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')];
      let btn = null;
      for (const el of all) {
        if ((el.innerText || '').trim() === 'SAVE & CLOSE') {
          const r = el.getBoundingClientRect();
          if (r.bottom > 800 && r.width > 50) btn = { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
        }
      }
      return btn;
    });
    if (saveCoord) {
      await page.mouse.click(saveCoord.x, saveCoord.y);
      console.log('Clicked SAVE & CLOSE at coordinate');
    }
  }

  await page.waitForTimeout(4000);
  await page.screenshot({ path: 'debug-flow-after-save.png' });

  console.log('\nAll requests captured:');
  allRequests.forEach(r => console.log(JSON.stringify(r)));

  await browser.close();
  console.log('\nDone!');
})();
