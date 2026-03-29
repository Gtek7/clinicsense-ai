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

  // Navigate to calendar
  await page.goto('https://clinicsense.com/dashboard/calendar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'debug-cancel-step1-today.png' });
  console.log('Calendar loaded (today = March 28)');

  // Try to use the API to find the appointment for March 29
  const apptData = await page.evaluate(async () => {
    const resp = await fetch('/api/2/calendar/?mode=day&exact_date=2026-03-29&format=json', { credentials: 'include' });
    return await resp.json();
  });
  console.log('\n=== API Response for March 29 ===');
  console.log('Keys:', Object.keys(apptData));
  console.log('Appointments count:', apptData.appointments?.length);
  if (apptData.appointments?.length > 0) {
    console.log('First appointment:', JSON.stringify(apptData.appointments[0], null, 2));
  }
  console.log('Full response (first 2000 chars):', JSON.stringify(apptData).substring(0, 2000));

  // Now try to navigate to March 29 via the "next day" navigation
  console.log('\n=== Trying to navigate to March 29 ===');
  // Find the "next" navigation button in the calendar header
  const navButtons = await page.evaluate(() => {
    return [...document.querySelectorAll('*')].filter(el => {
      const txt = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      return (txt === '>' || txt === '›' || txt === '→' || txt === 'Next' ||
              el.className.includes('next') || el.className.includes('forward') || el.className.includes('arrow')) &&
             r.width > 0 && r.height > 0 && r.top < 200;
    }).map(el => ({
      tag: el.tagName,
      cls: el.className.substring(0, 60),
      txt: (el.innerText || '').trim(),
      x: Math.round(el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2),
      y: Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2),
    }));
  });
  console.log('Navigation buttons found:', JSON.stringify(navButtons));

  // Find the date header/navigation area
  const headerElements = await page.evaluate(() => {
    return [...document.querySelectorAll('*')].filter(el => {
      const txt = (el.innerText || '').trim();
      const r = el.getBoundingClientRect();
      return txt.includes('March') && r.top < 150 && r.width > 0;
    }).map(el => ({
      tag: el.tagName, cls: el.className.substring(0, 60), txt: txt.substring(0, 50),
      x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top),
      w: Math.round(el.getBoundingClientRect().width),
    }));
  });
  console.log('Header elements with March:', JSON.stringify(headerElements));

  // Look at all elements in the top bar area
  const topBarEls = await page.evaluate(() => {
    return [...document.querySelectorAll('*')].filter(el => {
      const r = el.getBoundingClientRect();
      return r.top >= 30 && r.top < 80 && r.width > 5 && r.height > 5;
    }).map(el => ({
      tag: el.tagName, cls: el.className.substring(0, 60), txt: (el.innerText || '').trim().substring(0, 30),
      x: Math.round(el.getBoundingClientRect().left), y: Math.round(el.getBoundingClientRect().top),
      w: Math.round(el.getBoundingClientRect().width),
    })).slice(0, 30);
  });
  console.log('\nTop bar elements (y 30-80):');
  topBarEls.forEach(e => console.log(JSON.stringify(e)));

  await browser.close();
  console.log('\nDone!');
})();
