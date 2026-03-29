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

  // Click the "next day" arrow - linearicon-chevron-right-circle
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

  // Find Nino appointment
  const apptElements = await page.evaluate(() => {
    return [...document.querySelectorAll('*')].filter(el => {
      const txt = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      return txt.toLowerCase().includes('nino') && r.width > 0 && r.height > 0;
    }).map(el => {
      const txt = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: (el.className || '').substring(0, 80),
        txt: txt.substring(0, 60),
        x: Math.round(r.left + r.width/2),
        y: Math.round(r.top + r.height/2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
  });
  console.log('Nino elements:', JSON.stringify(apptElements));

  // Click the appointment block (prefer calendar-event elements)
  const apptBlock = apptElements.find(e =>
    (e.cls.includes('calendar-event') || e.cls.includes('appointment')) && e.w > 50
  ) || apptElements.find(e => e.w > 50 && e.w < 400);

  if (apptBlock) {
    console.log('Clicking appointment at:', apptBlock.x, apptBlock.y);
    await page.mouse.click(apptBlock.x, apptBlock.y);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: 'debug-cancel6-popup.png' });

    // Find cancel/delete button in popup
    const popupItems = await page.evaluate(() => {
      return [...document.querySelectorAll('*')].filter(el => {
        const txt = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        return txt.length > 0 && txt.length < 80 && !txt.includes('\n') && r.width > 0 && r.height > 0 && r.top > 100;
      }).map(el => {
        const txt = (el.innerText || '').trim();
        const r = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          cls: (el.className || '').substring(0, 60),
          txt: txt.substring(0, 50),
          x: Math.round(r.left + r.width/2),
          y: Math.round(r.top + r.height/2),
          w: Math.round(r.width),
        };
      }).filter(e => !e.txt.match(/^(\d{1,2}:\d{2}(AM|PM)?|\d{1,2}(AM|PM)|SU|MO|TU|WE|TH|FR|SA|\d{1,2}|-)$/) &&
                     e.w < 600);
    });
    console.log('\nElements visible after click (filtered):');
    // Show only unique text elements
    const seen = new Set();
    popupItems.forEach(e => {
      if (!seen.has(e.txt)) {
        seen.add(e.txt);
        console.log(JSON.stringify(e));
      }
    });
  } else {
    console.log('No appointment block found');
  }

  await browser.close();
  console.log('\nDone!');
})();
