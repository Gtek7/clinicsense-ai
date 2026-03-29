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
  await page.waitForTimeout(2000);
  await page.goto('https://clinicsense.com/dashboard/calendar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const apptId = 33235056; // Nino Test appointment
  const csrf = await page.evaluate(() => {
    const cookie = document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='));
    return cookie ? cookie.trim().split('=')[1] : null;
  });

  // Try various API approaches
  const tests = [
    { method: 'OPTIONS', url: `/api/2/appointments/${apptId}/`, body: null },
    { method: 'PUT', url: `/api/2/appointments/${apptId}/`, body: JSON.stringify({ is_cancelled: true }) },
    { method: 'PATCH', url: `/api/2/appointments/${apptId}/`, body: JSON.stringify({ is_cancelled: true }) },
    { method: 'POST', url: `/api/2/appointments/${apptId}/cancel/`, body: JSON.stringify({}) },
    { method: 'POST', url: `/api/2/appointments/cancel/`, body: JSON.stringify({ id: apptId }) },
    { method: 'GET', url: `/api/2/appointments/${apptId}/`, body: null },
  ];

  for (const test of tests) {
    const result = await page.evaluate(async ({ method, url, body, csrf }) => {
      try {
        const opts = {
          method,
          credentials: 'include',
          headers: {
            'X-CSRFToken': csrf || '',
            'Content-Type': 'application/json',
          }
        };
        if (body) opts.body = body;
        const resp = await fetch(url, opts);
        const text = await resp.text();
        return { method, url, status: resp.status, ok: resp.ok, text: text.substring(0, 300) };
      } catch (e) {
        return { method, url, error: e.message };
      }
    }, { ...test, csrf });
    console.log(`${test.method} ${test.url}: ${result.status} - ${result.text?.substring(0, 200) || result.error}`);
  }

  // Now try to navigate to the appointment via UI
  // First, let's navigate to March 29 via the API link directly
  console.log('\n=== Trying UI navigation to March 29 ===');

  // Navigate to the calendar with a date that might work
  await page.goto('https://clinicsense.com/dashboard/calendar/?d=2026-03-29', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'debug-cancel-nav1.png' });

  const headerDate = await page.evaluate(() => {
    const header = document.querySelector('.calendar-header, .date-header, [class*="date"]');
    return document.body.innerText.split('\n').slice(0, 5).join(' | ');
  });
  console.log('Calendar header after d= param:', headerDate);

  // Check for date navigation elements
  const allIconEls = await page.evaluate(() => {
    return [...document.querySelectorAll('span, i, button, a')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.top >= 25 && r.top <= 80 && r.width > 0 && r.height > 0;
    }).map(el => ({
      tag: el.tagName,
      cls: (el.className?.toString() || '').substring(0, 80),
      txt: (el.innerText || '').trim().substring(0, 30),
      x: Math.round(r.left + r.width/2),
      y: Math.round(r.top + r.height/2),
    }));
  });
  // Fixed version
  const allIconEls2 = await page.evaluate(() => {
    return [...document.querySelectorAll('span, i, button, a, svg')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.top >= 25 && r.top <= 80 && r.width > 0 && r.height > 0 && r.width < 200;
    }).map(el => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: (typeof el.className === 'string' ? el.className : el.className?.baseVal || '').substring(0, 80),
        txt: (el.innerText || el.textContent || '').trim().substring(0, 30),
        x: Math.round(r.left + r.width/2),
        y: Math.round(r.top + r.height/2),
      };
    });
  });
  console.log('Top bar icons/buttons:', JSON.stringify(allIconEls2));

  await browser.close();
  console.log('\nDone!');
})();
