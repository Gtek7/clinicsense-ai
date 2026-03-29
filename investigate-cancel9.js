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

  // Navigate to March 29
  await page.evaluate(() => { document.querySelector('.linearicon-chevron-right-circle')?.click(); });
  const nextCalDone = page.waitForResponse(
    r => r.url().includes('/api/2/calendar/') && r.status() === 200,
    { timeout: 15000 }
  ).catch(() => {});
  await nextCalDone;
  await page.waitForTimeout(2000);
  console.log('On March 29');

  // Intercept API calls
  const apiCalls = [];
  page.on('request', req => {
    if (req.url().includes('/api/') && req.method() !== 'GET') {
      apiCalls.push({ method: req.method(), url: req.url(), body: req.postData()?.substring(0, 500) });
    }
  });
  page.on('response', async resp => {
    if (resp.url().includes('/api/') && resp.request().method() !== 'GET') {
      const body = await resp.text().catch(() => '');
      console.log(`API: ${resp.request().method()} ${resp.url()} → ${resp.status()}: ${body.substring(0, 200)}`);
    }
  });

  // Click the Nino Test appointment
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('.calendar-event, .calendar-appointment')) {
      if ((el.innerText || '').toLowerCase().includes('nino')) {
        el.scrollIntoView({ behavior: 'auto', block: 'center' });
        el.click();
        return;
      }
    }
  });
  await page.waitForTimeout(2500);
  console.log('Appointment clicked');

  // Click "CANCEL APPOINTMENT" button
  const cancelBtnClicked = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim();
      if (txt === 'CANCEL APPOINTMENT') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { el.click(); return true; }
      }
    }
    return false;
  });
  console.log('Cancel appointment button clicked:', cancelBtnClicked);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'debug-cancel9-dialog.png' });

  // Click "CONFIRM CANCELLATION" button in the dialog
  const confirmClicked = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim();
      if (txt === 'CONFIRM CANCELLATION') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) { el.click(); return true; }
      }
    }
    return false;
  });
  console.log('Confirm cancellation clicked:', confirmClicked);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: 'debug-cancel9-after-confirm.png' });

  console.log('\nAll API calls:', JSON.stringify(apiCalls, null, 2));

  // Verify appointment is gone
  const verifyGone = await page.evaluate(async () => {
    const resp = await fetch('/api/2/calendar/?mode=day&exact_date=2026-03-29&format=json', { credentials: 'include' });
    const data = await resp.json();
    const ninoAppt = data.appointments?.find(a => (a.client_name || '').toLowerCase().includes('nino'));
    return { stillExists: !!ninoAppt, count: data.appointments?.length };
  });
  console.log('Appointment after cancel:', JSON.stringify(verifyGone));

  await browser.close();
  console.log('\nDone!');
})();
