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

  const calDone = page.waitForResponse(
    r => r.url().includes('/api/2/calendar/') && r.status() === 200,
    { timeout: 30000 }
  ).catch(() => {});
  await page.goto('https://clinicsense.com/dashboard/calendar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await calDone;
  await page.waitForTimeout(2500);

  // Navigate to March 29 by clicking the next-day arrow
  await page.evaluate(() => {
    const el = document.querySelector('.linearicon-chevron-right-circle');
    if (el) el.click();
  });

  const nextCalDone = page.waitForResponse(
    r => r.url().includes('/api/2/calendar/') && r.status() === 200,
    { timeout: 15000 }
  ).catch(() => {});
  await nextCalDone;
  await page.waitForTimeout(2000);
  console.log('On March 29');

  // Intercept network requests to capture any API calls
  const apiCalls = [];
  page.on('request', req => {
    if (req.url().includes('/api/') && req.method() !== 'GET') {
      apiCalls.push({ method: req.method(), url: req.url(), body: req.postData()?.substring(0, 200) });
    }
  });
  page.on('response', resp => {
    if (resp.url().includes('/api/') && resp.request().method() !== 'GET') {
      console.log(`API Response: ${resp.request().method()} ${resp.url()} → ${resp.status()}`);
    }
  });

  // Click the Nino Test appointment directly via DOM
  const clickResult = await page.evaluate(() => {
    // Find the calendar-event div with Nino Test
    const allEls = [...document.querySelectorAll('.calendar-event, .calendar-appointment')];
    for (const el of allEls) {
      const txt = (el.innerText || '').trim();
      if (txt.toLowerCase().includes('nino')) {
        // Scroll into view first
        el.scrollIntoView({ behavior: 'auto', block: 'center' });
        const r = el.getBoundingClientRect();
        el.click();
        return { clicked: txt.substring(0, 50), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      }
    }
    // Fallback: look in any element
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim();
      if (txt.toLowerCase().includes('nino test') && !txt.includes('\n') && el.getBoundingClientRect().width > 50) {
        el.scrollIntoView({ behavior: 'auto', block: 'center' });
        el.click();
        const r = el.getBoundingClientRect();
        return { clicked: txt.substring(0, 50), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), fallback: true };
      }
    }
    return null;
  });
  console.log('Click result:', JSON.stringify(clickResult));

  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'debug-cancel7-popup.png' });

  // Look for modal/popup content
  const modalContent = await page.evaluate(() => {
    // Look for a modal or popup overlay
    const overlays = [...document.querySelectorAll('[class*="modal"], [class*="popup"], [class*="overlay"], [class*="dialog"]')];
    if (overlays.length > 0) {
      return overlays.map(el => ({
        cls: (el.className || '').substring(0, 60),
        txt: (el.innerText || '').trim().substring(0, 200),
        visible: el.getBoundingClientRect().width > 0,
      }));
    }

    // Also look for any element that appeared in center of screen with cancel-related content
    return [...document.querySelectorAll('*')].filter(el => {
      const txt = (el.innerText || '').trim().toLowerCase();
      const r = el.getBoundingClientRect();
      return (txt.includes('cancel') || txt.includes('delete') || txt.includes('appointment') || txt.includes('nino')) &&
             r.width > 100 && r.width < 1000 && r.left > 100 && r.left < 1000 &&
             r.top > 100 && r.top < 800;
    }).map(el => {
      const r = el.getBoundingClientRect();
      return {
        cls: (el.className || '').substring(0, 60),
        txt: (el.innerText || '').trim().substring(0, 100),
        x: Math.round(r.left + r.width/2),
        y: Math.round(r.top + r.height/2),
        w: Math.round(r.width),
      };
    });
  });
  console.log('\nModal/popup content:', JSON.stringify(modalContent.slice(0, 10)));

  // Look for the appointment detail panel
  const apptDetail = await page.evaluate(() => {
    return [...document.querySelectorAll('*')].filter(el => {
      const txt = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      return txt.includes('Nino') && r.width > 100 && r.width < 800 && r.left > 100 && r.top > 0;
    }).map(el => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: (el.className || '').substring(0, 80),
        txt: (el.innerText || '').trim().substring(0, 150),
        x: Math.round(r.left),
        y: Math.round(r.top),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
  });
  console.log('\nAppointment detail panel:', JSON.stringify(apptDetail.slice(0, 5)));

  // Log captured API calls
  await page.waitForTimeout(1000);
  console.log('\nAPI calls after click:', JSON.stringify(apiCalls));

  await browser.close();
  console.log('\nDone!');
})();
