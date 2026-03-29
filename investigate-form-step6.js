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

  // ── Select service: find service name then click its 60 MIN button ─────────
  const svcCoord = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText || '').trim() === 'Select service') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
    }
    return null;
  });
  await page.mouse.click(svcCoord.x, svcCoord.y);
  await page.waitForTimeout(1500);
  console.log('Service dropdown opened.');

  // Find service by name and click the correct duration button
  // Strategy: find service name, then find 60 MIN button closest below it
  const clickResult = await page.evaluate(({ targetService, targetDuration }) => {
    // Find all elements matching service name
    const allEls = [...document.querySelectorAll('*')];

    // Find the service name element
    let serviceEl = null;
    for (const el of allEls) {
      const txt = (el.innerText || '').trim().toLowerCase();
      if (txt.includes(targetService.toLowerCase()) && txt.length < 80 && el.children.length <= 2) {
        const r = el.getBoundingClientRect();
        if (r.width > 100 && r.height > 0) {
          serviceEl = { el, y: r.top, x: r.left };
          break;
        }
      }
    }

    if (!serviceEl) return { error: `Service "${targetService}" not found` };

    const serviceY = serviceEl.y;
    console.log('Found service at y:', serviceY);

    // Find duration buttons with matching text that are below the service name
    const durationText = targetDuration + ' MIN';
    let closestBtn = null;
    let closestDist = Infinity;

    for (const el of allEls) {
      const txt = (el.innerText || '').trim();
      if (txt === durationText) {
        const r = el.getBoundingClientRect();
        if (r.top > serviceY && r.top < serviceY + 100 && r.width > 20) {
          const dist = r.top - serviceY;
          if (dist < closestDist) {
            closestDist = dist;
            closestBtn = { el, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
          }
        }
      }
    }

    if (!closestBtn) return { error: `Duration button "${durationText}" not found below service`, serviceY };

    closestBtn.el.click();
    return { success: true, serviceY, btnY: closestBtn.y, btnX: closestBtn.x };
  }, { targetService: 'relaxation', targetDuration: '60' });

  console.log('Service click result:', JSON.stringify(clickResult));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'debug-step6-after-service.png' });

  // ── Select practitioner ──────────────────────────────────────────────────
  const pracCoord = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText || '').trim() === 'Select practitioner') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
    }
    return null;
  });
  console.log('\nPractitioner dropdown coord:', JSON.stringify(pracCoord));
  await page.mouse.click(pracCoord.x, pracCoord.y);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'debug-step6-practitioner-open.png' });

  // Find and click practitioner by name
  const pracResult = await page.evaluate(({ targetPrac }) => {
    const allEls = [...document.querySelectorAll('*')];
    for (const el of allEls) {
      const txt = (el.innerText || '').trim();
      if (txt.toLowerCase().includes(targetPrac.toLowerCase()) && txt.length < 80 && el.children.length <= 2) {
        const r = el.getBoundingClientRect();
        if (r.width > 50 && r.height > 0) {
          el.click();
          return { clicked: txt, x: Math.round(r.left), y: Math.round(r.top) };
        }
      }
    }
    return { error: `Practitioner "${targetPrac}" not found` };
  }, { targetPrac: 'Walaipun' });
  console.log('Practitioner click result:', JSON.stringify(pracResult));
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'debug-step6-after-practitioner.png' });

  // ── Inspect all elements with data-cs_field_name ─────────────────────────
  console.log('\n── Elements with data-cs_field_name:');
  const csFields = await page.evaluate(() => {
    return [...document.querySelectorAll('[data-cs_field_name]')].map(el => ({
      tag: el.tagName, name: el.dataset.cs_field_name, cls: el.className.substring(0, 60),
      txt: (el.innerText || '').trim().substring(0, 40),
      visible: el.offsetParent !== null,
      x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top)
    }));
  });
  csFields.forEach(f => console.log(JSON.stringify(f)));

  // ── Inspect time spinner elements ─────────────────────────────────────────
  console.log('\n── All elements between Start Time and End Time labels:');
  const timeElements = await page.evaluate(() => {
    let startY = 0, endY = 9999;
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim();
      if (txt === 'Start Time') startY = el.getBoundingClientRect().top;
      if (txt === 'End Time') { endY = el.getBoundingClientRect().top; break; }
    }

    return [...document.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.top >= startY - 5 && r.top <= endY + 50 && r.width > 10 && r.height > 0;
    }).map(el => ({
      tag: el.tagName, cls: el.className.substring(0, 80), txt: (el.innerText || '').trim().substring(0, 20),
      x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top),
      w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height),
      isInput: el.tagName === 'INPUT',
      dataAttrs: Object.keys(el.dataset || {}).join(','),
    })).slice(0, 60);
  });
  console.log('Time area elements:');
  timeElements.forEach(e => console.log(JSON.stringify(e)));

  // ── Try clicking on each spinner area ───────────────────────────────────
  // Look for any element in the start time spinner area
  console.log('\n── Looking for clickable time elements...');
  const spinnerEls = await page.evaluate(() => {
    // Find the 6 spinner boxes (3 for start, 3 for end)
    // They should be at the time row, with small width
    let startY = 0;
    for (const el of document.querySelectorAll('*')) {
      if ((el.innerText || '').trim() === 'Start Time') { startY = el.getBoundingClientRect().top; break; }
    }

    return [...document.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.top > startY && r.top < startY + 70 && r.width > 30 && r.width < 80 && r.height > 20;
    }).map(el => ({
      tag: el.tagName, cls: el.className.substring(0, 80), txt: (el.innerText || '').trim().substring(0, 20),
      x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top),
      w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height),
    }));
  });
  console.log('Spinner elements in start time row:', JSON.stringify(spinnerEls));

  // Click on the first spinner area and see what gets focused
  if (spinnerEls.length > 0) {
    const firstSpinner = spinnerEls[0];
    console.log(`Clicking first spinner at (${firstSpinner.x + firstSpinner.w/2}, ${firstSpinner.y + firstSpinner.h/2})`);
    await page.mouse.click(firstSpinner.x + firstSpinner.w/2, firstSpinner.y + firstSpinner.h/2);
    await page.waitForTimeout(500);
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      return { tag: el?.tagName, type: el?.type, cls: el?.className?.substring(0,60), val: el?.value };
    });
    console.log('Focused after click:', JSON.stringify(focused));
    await page.screenshot({ path: 'debug-step6-spinner-click.png' });
  }

  // ── Try to set date ──────────────────────────────────────────────────────
  console.log('\n── Setting date...');
  const dateInput = await page.$('input[placeholder*="Select a date"]');
  if (dateInput) {
    await dateInput.triple_click();
    await page.keyboard.type('2026-03-29');
    await page.waitForTimeout(500);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'debug-step6-date-set.png' });
    console.log('Date set attempt done');
  }

  await browser.close();
  console.log('\nDone!');
})();
