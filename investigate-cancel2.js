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

  // Find Nino Test appointment on March 29
  const result = await page.evaluate(async () => {
    const resp = await fetch('/api/2/calendar/?mode=day&exact_date=2026-03-29&format=json', { credentials: 'include' });
    const data = await resp.json();

    // Find Nino Test appointment
    const ninoAppt = data.appointments?.find(a =>
      (a.client_name || '').toLowerCase().includes('nino')
    );

    if (!ninoAppt) {
      return { error: 'Nino Test appointment not found', all: data.appointments?.map(a => ({ id: a.id, name: a.client_name, start: a.start_time })) };
    }

    return { found: ninoAppt };
  });

  console.log('Find result:', JSON.stringify(result, null, 2));

  if (!result.found) {
    console.log('Appointment not found. Done.');
    await browser.close();
    return;
  }

  const apptId = result.found.id;
  console.log(`\nFound appointment ID: ${apptId}`);

  // Get CSRF token
  const csrf = await page.evaluate(() => {
    // Try to get from cookie
    const cookie = document.cookie.split(';').find(c => c.trim().startsWith('csrftoken='));
    if (cookie) return cookie.trim().split('=')[1];
    // Try to get from meta tag
    const meta = document.querySelector('meta[name="csrf-token"]') || document.querySelector('[name="csrfmiddlewaretoken"]');
    return meta?.content || meta?.value || null;
  });
  console.log('CSRF token:', csrf ? csrf.substring(0, 20) + '...' : 'not found');

  // Try to cancel via API
  console.log('\n=== Testing DELETE /api/2/appointments/{id}/ ===');
  const deleteResult = await page.evaluate(async ({ id, csrf }) => {
    try {
      const resp = await fetch(`/api/2/appointments/${id}/`, {
        method: 'DELETE',
        credentials: 'include',
        headers: {
          'X-CSRFToken': csrf || '',
          'Content-Type': 'application/json',
        }
      });
      return { status: resp.status, ok: resp.ok, text: await resp.text() };
    } catch (e) {
      return { error: e.message };
    }
  }, { id: apptId, csrf });
  console.log('DELETE result:', JSON.stringify(deleteResult));

  // Check if appointment still exists
  const checkAfter = await page.evaluate(async () => {
    const resp = await fetch('/api/2/calendar/?mode=day&exact_date=2026-03-29&format=json', { credentials: 'include' });
    const data = await resp.json();
    const ninoAppt = data.appointments?.find(a => (a.client_name || '').toLowerCase().includes('nino'));
    return { stillExists: !!ninoAppt, count: data.appointments?.length };
  });
  console.log('After DELETE check:', JSON.stringify(checkAfter));

  await browser.close();
  console.log('\nDone!');
})();
