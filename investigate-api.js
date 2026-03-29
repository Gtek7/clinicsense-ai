require('dotenv').config();
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Login
  await page.goto('https://clinicsense.com/login/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"], input[name="email"]', process.env.CLINICSENSE_EMAIL);
  await page.fill('input[type="password"]', process.env.CLINICSENSE_PASSWORD);
  await page.click('button[type="submit"], button:has-text("LOGIN")');
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  console.log('Logged in. URL:', page.url());

  // Navigate to calendar so session is active
  await page.goto('https://clinicsense.com/dashboard/calendar/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Call the API directly using the authenticated session cookies
  console.log('\n── Fetching API for 2026-03-28 (today)...');
  const data28 = await page.evaluate(async () => {
    const r = await fetch('/api/2/calendar/?mode=day&exact_date=2026-03-28&format=json', { credentials: 'include' });
    return r.json();
  });
  console.log('API response keys:', Object.keys(data28));
  console.log('Full response (truncated):');
  console.log(JSON.stringify(data28, null, 2).substring(0, 3000));

  console.log('\n── Fetching API for 2026-03-29 (tomorrow)...');
  const data29 = await page.evaluate(async () => {
    const r = await fetch('/api/2/calendar/?mode=day&exact_date=2026-03-29&format=json', { credentials: 'include' });
    return r.json();
  });
  console.log('API response keys:', Object.keys(data29));
  console.log('Full response (truncated):');
  console.log(JSON.stringify(data29, null, 2).substring(0, 3000));

  await browser.close();
})();
// Extra: print the staff structure
