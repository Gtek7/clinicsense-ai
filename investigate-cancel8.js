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

  // Intercept API calls
  const apiCalls = [];
  page.on('request', req => {
    if (req.url().includes('/api/')) {
      apiCalls.push({ method: req.method(), url: req.url(), body: req.postData()?.substring(0, 500) });
    }
  });

  // Click appointment to open edit form
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
  await page.screenshot({ path: 'debug-cancel8-form-open.png' });

  // Find and click "CANCEL APPOINTMENT" button
  const cancelBtnCoord = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim();
      if (txt === 'CANCEL APPOINTMENT') {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), txt };
        }
      }
    }
    return null;
  });
  console.log('Cancel button coord:', JSON.stringify(cancelBtnCoord));

  if (cancelBtnCoord) {
    await page.mouse.click(cancelBtnCoord.x, cancelBtnCoord.y);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'debug-cancel8-after-cancel-click.png' });

    // Look for confirmation dialog
    const dialogContent = await page.evaluate(() => {
      return [...document.querySelectorAll('*')].filter(el => {
        const txt = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        return (txt.includes('Yes') || txt.includes('Confirm') || txt.includes('OK') ||
                txt.includes('Are you sure') || txt.includes('cancel')) &&
               r.width > 50 && r.width < 600 && r.left > 100 && r.top > 200;
      }).map(el => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          cls: (el.className || '').substring(0, 60),
          txt: (el.innerText || '').trim().substring(0, 80),
          x: Math.round(r.left + r.width/2),
          y: Math.round(r.top + r.height/2),
          w: Math.round(r.width),
        };
      });
    });
    console.log('Dialog/buttons after cancel click:', JSON.stringify(dialogContent.slice(0, 20)));

    // Try to click "Yes" if dialog appeared
    const yesBtn = dialogContent.find(e => e.txt === 'Yes' || e.txt.toLowerCase().includes('yes, cancel'));
    if (yesBtn) {
      console.log('Clicking Yes at:', yesBtn.x, yesBtn.y);
      await page.mouse.click(yesBtn.x, yesBtn.y);
      await page.waitForTimeout(3000);
      await page.screenshot({ path: 'debug-cancel8-after-confirm.png' });
    } else {
      console.log('No "Yes" confirmation dialog found');
    }
  }

  // Check captured API calls
  await page.waitForTimeout(2000);
  console.log('\nAll API calls:', JSON.stringify(apiCalls, null, 2));

  await browser.close();
  console.log('\nDone!');
})();
