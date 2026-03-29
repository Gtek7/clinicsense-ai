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

  // Load calendar
  const calDone = page.waitForResponse(
    r => r.url().includes('/api/2/calendar/') && r.status() === 200,
    { timeout: 30000 }
  ).catch(() => {});
  await page.goto('https://clinicsense.com/dashboard/calendar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await calDone;
  await page.waitForTimeout(2500);
  console.log('Calendar loaded on March 28');

  // Click the "next day" arrow to navigate to March 29
  // The linearicon-chevron-right-circle is visible at ~(804, 107)
  const nextDayClicked = await page.evaluate(() => {
    const el = document.querySelector('.linearicon-chevron-right-circle');
    if (el) {
      const r = el.getBoundingClientRect();
      el.click();
      return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    }
    return null;
  });
  console.log('Next day clicked:', JSON.stringify(nextDayClicked));

  // Wait for calendar to update
  const nextCalDone = page.waitForResponse(
    r => r.url().includes('/api/2/calendar/') && r.status() === 200,
    { timeout: 15000 }
  ).catch(() => {});
  await nextCalDone;
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'debug-cancel5-march29.png' });

  // Verify we're on March 29
  const currentDate = await page.evaluate(() => {
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim();
      if (txt.includes('March 29') && el.getBoundingClientRect().top < 200) return txt.substring(0, 50);
    }
    return 'March 29 not found in header';
  });
  console.log('Current date header:', currentDate);

  // Find the Nino Test appointment
  const apptElements = await page.evaluate(() => {
    return [...document.querySelectorAll('*')].filter(el => {
      const txt = (el.innerText || '').trim();
      return txt.toLowerCase().includes('nino') && el.getBoundingClientRect().width > 0;
    }).map(el => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: (el.className || '').substring(0, 80),
        txt: txt.substring(0, 60),
        x: Math.round(r.left + r.width/2),
        y: Math.round(r.top + r.height/2),
        w: Math.round(r.width),
      };
    });
  });
  console.log('Nino elements:', JSON.stringify(apptElements));

  // Click the appointment block
  const apptBlock = apptElements.find(e =>
    e.cls.includes('calendar-event') || e.cls.includes('appointment') ||
    (e.w > 50 && e.w < 300)
  ) || apptElements[0];

  if (apptBlock) {
    console.log('Clicking appointment at:', apptBlock.x, apptBlock.y);
    await page.mouse.click(apptBlock.x, apptBlock.y);
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'debug-cancel5-appt-popup.png' });

    // Find cancel/delete button in popup
    const popupButtons = await page.evaluate(() => {
      return [...document.querySelectorAll('*')].filter(el => {
        const txt = (el.innerText || '').trim().toLowerCase();
        const r = el.getBoundingClientRect();
        return (txt.includes('cancel') || txt.includes('delete') || txt.includes('remove') || txt === 'cancel') &&
               r.width > 0 && r.height > 0 && r.top > 100;
      }).map(el => {
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          cls: (el.className || '').substring(0, 60),
          txt: (el.innerText || '').trim().substring(0, 40),
          x: Math.round(r.left + r.width/2),
          y: Math.round(r.top + r.height/2),
        };
      });
    });
    console.log('\nPopup buttons with cancel/delete:', JSON.stringify(popupButtons));

    // Look at all visible elements after clicking appointment
    const allVisibleAfterClick = await page.evaluate(() => {
      return [...document.querySelectorAll('*')].filter(el => {
        const r = el.getBoundingClientRect();
        const txt = (el.innerText || '').trim();
        return r.top > 80 && r.width > 20 && r.height > 10 && txt.length > 0 && txt.length < 80 &&
               !txt.includes('\n') && r.width < 500;
      }).map(el => {
        const r = el.getBoundingClientRect();
        return {
          cls: (el.className || '').substring(0, 60),
          txt: (el.innerText || '').trim().substring(0, 40),
          x: Math.round(r.left + r.width/2),
          y: Math.round(r.top + r.height/2),
        };
      }).filter(e => !e.txt.match(/^(AM|PM|\d{1,2}:\d{2}(AM|PM)?|SU|MO|TU|WE|TH|FR|SA|\d{1,2})$/));
    });
    console.log('\nAll visible elements after clicking appointment (filtered):');
    allVisibleAfterClick.slice(0, 30).forEach(e => console.log(JSON.stringify(e)));
  }

  await browser.close();
  console.log('\nDone!');
})();
