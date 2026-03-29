// Quick investigation script — NOT part of the server
// Logs in, checks URLs and network requests when navigating dates
require('dotenv').config();
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Capture every URL navigation
  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) console.log('[NAV]', frame.url());
  });

  // Capture all network requests to spot any date-related API calls
  page.on('request', req => {
    const url = req.url();
    if (url.includes('date') || url.includes('calendar') || url.includes('schedule') || url.includes('appointment')) {
      console.log('[REQ]', req.method(), url);
    }
  });

  // ── Login ──────────────────────────────────────────────────────────────────
  console.log('\n── Logging in...');
  await page.goto('https://clinicsense.com/login/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type="email"], input[name="email"]', process.env.CLINICSENSE_EMAIL);
  await page.fill('input[type="password"]', process.env.CLINICSENSE_PASSWORD);
  await page.click('button[type="submit"], button:has-text("LOGIN")');
  await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  console.log('After login URL:', page.url());

  // ── Go to calendar ─────────────────────────────────────────────────────────
  console.log('\n── Navigating to calendar...');
  await page.goto('https://clinicsense.com/dashboard/calendar/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);
  console.log('Calendar URL:', page.url());

  // ── Try ?date= param formats ───────────────────────────────────────────────
  const formats = [
    'https://clinicsense.com/dashboard/calendar/?date=2026-03-30',
    'https://clinicsense.com/dashboard/calendar/?date=03/30/2026',
    'https://clinicsense.com/dashboard/calendar/?date=03-30-2026',
  ];

  for (const url of formats) {
    console.log(`\n── Trying: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    console.log('  Final URL:', finalUrl);

    // Check what date the calendar actually shows
    const calendarDate = await page.evaluate(() => {
      // Look for the displayed date in the page
      const candidates = [
        document.querySelector('[class*="date"]'),
        document.querySelector('[class*="Date"]'),
        document.querySelector('h1, h2, h3'),
        document.querySelector('[class*="header"]'),
      ];
      return candidates.map(el => el?.innerText?.trim()).filter(Boolean).slice(0, 3);
    });
    console.log('  Displayed date elements:', calendarDate);
    await page.screenshot({ path: `debug-nav-test-${formats.indexOf(url)}.png` });
  }

  // ── Click the "next day" button and observe URL change ─────────────────────
  console.log('\n── Back to calendar, clicking Next Day button...');
  await page.goto('https://clinicsense.com/dashboard/calendar/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Try common "next" button selectors
  const nextSelectors = [
    'button[aria-label*="next"]', 'button[aria-label*="Next"]',
    '[class*="next"]', '[class*="Next"]',
    'button:has-text(">")', 'button:has-text("→")',
    '.fc-next-button',
  ];

  for (const sel of nextSelectors) {
    const btn = await page.$(sel);
    if (btn) {
      console.log('  Found next button:', sel);
      await btn.click();
      await page.waitForTimeout(2000);
      console.log('  URL after clicking next:', page.url());

      // Check what the page title/header shows
      const header = await page.evaluate(() => {
        const el = document.querySelector('[class*="CalendarHeader"], [class*="date"], h1, h2, .title');
        return el?.innerText?.trim();
      });
      console.log('  Header after next click:', header);
      await page.screenshot({ path: 'debug-after-next-click.png' });
      break;
    }
  }

  // ── Final: inspect the page's JS state for date routing ───────────────────
  console.log('\n── Checking window location and JS state...');
  const jsState = await page.evaluate(() => ({
    href: window.location.href,
    hash: window.location.hash,
    search: window.location.search,
    pathname: window.location.pathname,
  }));
  console.log('  JS location:', jsState);

  await browser.close();
  console.log('\n── Investigation complete. Check debug-nav-test-*.png screenshots.');
})();
