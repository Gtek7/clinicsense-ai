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

  // Wait for calendar to fully load with API response
  const calDone = page.waitForResponse(
    r => r.url().includes('/api/2/calendar/') && r.status() === 200,
    { timeout: 30000 }
  ).catch(() => {});
  await page.goto('https://clinicsense.com/dashboard/calendar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await calDone;
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'debug-cancel4-loaded.png' });

  // Find all clickable elements near the date header
  const dateArea = await page.evaluate(() => {
    const els = [...document.querySelectorAll('*')];
    return els.filter(el => {
      const r = el.getBoundingClientRect();
      const txt = (el.innerText || el.textContent || '').trim();
      return r.top >= 30 && r.top <= 85 && r.width > 0 && r.height > 0 &&
             (r.width < 100 || txt.length > 0);
    }).map(el => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        id: el.id || '',
        cls: (typeof el.className === 'string' ? el.className : '').substring(0, 100),
        txt: (el.innerText || el.textContent || '').trim().substring(0, 40),
        x: Math.round(r.left + r.width/2),
        y: Math.round(r.top + r.height/2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    }).filter(e => e.w < 300);  // exclude full-width containers
  });
  console.log('Date area elements (y=30-85):');
  dateArea.forEach(e => console.log(JSON.stringify(e)));

  // Look specifically for linearicon elements (navigation arrows)
  const linearicons = await page.evaluate(() => {
    return [...document.querySelectorAll('[class*="linearicon"], [class*="icon"]')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).map(el => {
      const r = el.getBoundingClientRect();
      return {
        cls: (typeof el.className === 'string' ? el.className : '').substring(0, 100),
        txt: (el.innerText || el.textContent || '').trim().substring(0, 20),
        x: Math.round(r.left + r.width/2),
        y: Math.round(r.top + r.height/2),
      };
    });
  });
  console.log('\nLinearicon/icon elements:', JSON.stringify(linearicons));

  // Try to click the "next day" or "next week" navigation
  // Looking for the ▶ or › arrow on the right side of the date header
  const nextArrow = await page.evaluate(() => {
    // Look for elements in the date header area that might be navigation
    const headerText = [...document.querySelectorAll('*')].find(el => {
      const txt = (el.innerText || '').trim();
      return txt.includes('March 28') && el.getBoundingClientRect().top < 100;
    });
    if (!headerText) return null;
    const r = headerText.getBoundingClientRect();
    // Find elements to the right of the date header
    const rightEls = [...document.querySelectorAll('*')].filter(el => {
      const er = el.getBoundingClientRect();
      return er.left > r.right - 20 && er.left < r.right + 200 &&
             er.top >= r.top - 30 && er.top <= r.bottom + 30 &&
             er.width > 0 && er.width < 100;
    }).map(el => {
      const er = el.getBoundingClientRect();
      return {
        cls: (typeof el.className === 'string' ? el.className : '').substring(0, 80),
        txt: (el.innerText || el.textContent || '').trim().substring(0, 20),
        x: Math.round(er.left + er.width/2),
        y: Math.round(er.top + er.height/2),
      };
    });
    return { headerRight: Math.round(r.right), headerY: Math.round(r.top), rightEls };
  });
  console.log('\nDate header navigation area:', JSON.stringify(nextArrow));

  // Try clicking what seems like a "next" navigation icon
  // The calendar usually has navigation buttons - try linearicon-chevron-right or similar
  const navResult = await page.evaluate(() => {
    // Look for any element that could be "next day" - typically right-facing chevron
    const allEls = [...document.querySelectorAll('*')];
    for (const el of allEls) {
      const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
      const r = el.getBoundingClientRect();
      if ((cls.includes('next') || cls.includes('forward') || cls.includes('right') || cls.includes('chevron-right') || cls.includes('arrow-right')) &&
          r.top > 30 && r.top < 100 && r.width > 0) {
        return { found: cls.substring(0, 60), x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      }
    }
    return null;
  });
  console.log('\nNext nav element:', JSON.stringify(navResult));

  // Actually navigate to March 29 by clicking the "tomorrow" arrow
  // Looking at the calendar, navigation is typically to right of date
  // Let me look at the innerHTML of the date header area
  const headerHTML = await page.evaluate(() => {
    const allEls = [...document.querySelectorAll('*')];
    for (const el of allEls) {
      const txt = (el.innerText || '').trim();
      if (txt.includes('March 28') && !txt.includes('\n') && el.getBoundingClientRect().top < 100) {
        // Get the parent that contains the navigation
        let parent = el.parentElement;
        for (let i = 0; i < 5 && parent; i++) {
          const r = parent.getBoundingClientRect();
          if (r.width > 200) return parent.outerHTML.substring(0, 2000);
          parent = parent.parentElement;
        }
      }
    }
    return null;
  });
  console.log('\nDate header HTML:', headerHTML);

  await browser.close();
  console.log('\nDone!');
})();
