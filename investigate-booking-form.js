require('dotenv').config();
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();

  await page.goto('https://clinicsense.com/login/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('input[type="email"]', { timeout: 15000 });
  await page.fill('input[type="email"]', process.env.CLINICSENSE_EMAIL);
  await page.fill('input[type="password"]', process.env.CLINICSENSE_PASSWORD);
  await page.click('button[type="submit"], button:has-text("LOGIN"), input[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

  const calDone = page.waitForResponse(r => r.url().includes('/api/2/calendar/') && r.status() === 200, { timeout: 30000 }).catch(() => {});
  await page.goto('https://clinicsense.com/dashboard/calendar/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await calDone;
  await page.waitForTimeout(2000);

  // Step 1: Click the + FAB
  console.log('Clicking .linearicon-plus...');
  await page.click('.linearicon-plus');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'debug-form-after-fab.png' });
  console.log('Saved debug-form-after-fab.png');

  // Dump all visible text and clickables
  const state1 = await page.evaluate(() => {
    const clickables = [...document.querySelectorAll('button, a, [role="button"], [class*="btn"]')]
      .map(el => ({ tag: el.tagName, text: (el.innerText || '').trim().substring(0, 60), cls: (el.className || '').substring(0, 80) }))
      .filter(e => e.text);
    const inputs = [...document.querySelectorAll('input, textarea, select')]
      .map(el => ({ tag: el.tagName, type: el.type, placeholder: el.placeholder, name: el.name, cls: (el.className || '').substring(0, 60) }));
    return { clickables, inputs };
  });

  console.log('\n── Clickables after FAB click:');
  state1.clickables.forEach(e => console.log(`  <${e.tag}> "${e.text}" class="${e.cls}"`));
  console.log('\n── Inputs after FAB click:');
  state1.inputs.forEach(e => console.log(`  <${e.tag} type="${e.type}" placeholder="${e.placeholder}" name="${e.name}" class="${e.cls}">`));

  // Step 2: Try clicking "Schedule New Appointment" text in the popup
  console.log('\n\nTrying to click Schedule New Appointment in popup...');
  const clicked = await page.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    for (const el of all) {
      if ((el.innerText || '').trim() === 'Schedule New Appointment') {
        el.click();
        return `Clicked: <${el.tagName} class="${el.className}">`;
      }
    }
    return null;
  });
  console.log('Result:', clicked);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'debug-form-after-popup-click.png' });
  console.log('Saved debug-form-after-popup-click.png');

  // Dump again
  const state2 = await page.evaluate(() => {
    const clickables = [...document.querySelectorAll('button, a, [role="button"], [class*="btn"]')]
      .map(el => ({ tag: el.tagName, text: (el.innerText || '').trim().substring(0, 60), cls: (el.className || '').substring(0, 80) }))
      .filter(e => e.text);
    const inputs = [...document.querySelectorAll('input, textarea, select')]
      .map(el => ({ tag: el.tagName, type: el.type, placeholder: el.placeholder, name: el.name, cls: (el.className || '').substring(0, 60) }));
    const allText = (document.body.innerText || '').substring(0, 2000);
    return { clickables, inputs, allText };
  });

  console.log('\n── Clickables after popup click:');
  state2.clickables.forEach(e => console.log(`  <${e.tag}> "${e.text}" class="${e.cls}"`));
  console.log('\n── Inputs after popup click:');
  state2.inputs.forEach(e => console.log(`  <${e.tag} type="${e.type}" placeholder="${e.placeholder}" name="${e.name}" class="${e.cls}">`));

  await browser.close();
})();
