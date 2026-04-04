require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const path = require('path');
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const EMAIL = process.env.CLINICSENSE_EMAIL;
const PASSWORD = process.env.CLINICSENSE_PASSWORD;
const LOGIN_URL = 'https://clinicsense.com/login/';
const CALENDAR_URL = 'https://clinicsense.com/dashboard/calendar/';
const TIMEOUT = 30000;

// ─── Browser Singleton ───────────────────────────────────────────────────────
let browserInstance = null;
async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    console.log('[Browser] Launching new Chromium browser...');
    browserInstance = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    console.log('[Browser] Browser launched successfully.');
  }
  return browserInstance;
}

async function newPage() {
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  return { page, context };
}

// ─── Availability Session Cache ───────────────────────────────────────────────
// Keep ONE persistent logged-in Playwright context/page for /check-availability
// so we don't pay the ~15-second login cost on every request.
// Subsequent requests only need to navigate the calendar — saving ~20s per call.
let availSession = null; // { context, page }

async function getAvailabilityPage() {
  // Validate cached session
  if (availSession) {
    try {
      const url = availSession.page.url();
      if (url.length > 5 && !url.includes('/login')) {
        console.log('[Session] Reusing cached availability session.');
        return availSession.page;
      }
    } catch (e) {
      console.log('[Session] Cached session check failed:', e.message);
    }
    // Stale — close it
    await availSession.context.close().catch(() => {});
    availSession = null;
  }

  // Build a fresh logged-in session
  console.log('[Session] Creating new availability session (login required)...');
  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);
  await login(page);
  availSession = { context, page };
  return page;
}

// ─── Login Helper ─────────────────────────────────────────────────────────────
async function login(page) {
  console.log('[Login] Navigating to login page...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(2000);
  await screenshot(page, 'debug-login-page.png');
  console.log('[Login] Waiting for email field...');
  await page.waitForSelector('input[type="email"], input[name="email"], input[placeholder*="Email"], input[id*="email"]', { timeout: TIMEOUT });
  console.log('[Login] Typing email...');
  await page.fill('input[type="email"], input[name="email"], input[placeholder*="Email"], input[id*="email"]', EMAIL);
  console.log('[Login] Typing password...');
  await page.fill('input[type="password"], input[name="password"]', PASSWORD);
  console.log('[Login] Clicking LOGIN button...');
  await page.click('button[type="submit"], input[type="submit"], button:has-text("LOGIN"), button:has-text("Log in"), button:has-text("Sign in")');
  console.log('[Login] Waiting for navigation after login...');
  await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: TIMEOUT }).catch(() => {
    console.log('[Login] Navigation event not fired, continuing...');
  });
  // Extra wait to let the SPA fully initialise after redirect
  await page.waitForTimeout(5000);
  await screenshot(page, 'debug-login-result.png');
  // Confirm we are no longer on the login page
  const currentUrl = page.url();
  console.log(`[Login] Current URL after login: ${currentUrl}`);
  if (currentUrl.includes('/login')) {
    throw new Error('Login failed — still on login page. Check credentials or network.');
  }
  console.log('[Login] Login successful!');
}

// ─── Screenshot Helper ────────────────────────────────────────────────────────
async function screenshot(page, filename) {
  const filepath = path.join(__dirname, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`[Screenshot] Saved: ${filepath}`);
}

// ─── ENDPOINT 1: GET /health ──────────────────────────────────────────────────
app.get('/health', (req, res) => {
  console.log('[Health] Health check OK');
  res.json({ status: 'ok' });
});

// ─── ENDPOINT 2: POST /check-availability ────────────────────────────────────
app.post('/check-availability', async (req, res) => {
  // Strip leading '=' artifact that n8n injects when evaluating expressions
  // e.g. n8n sends "=2026-03-31" → we strip to "2026-03-31"
  const date = (req.body.date || '').replace(/^=/, '');

  if (!date) {
    return res.status(400).json({ success: false, error: 'Missing required field: date' });
  }
  console.log(`\n[Availability] Checking availability for date: ${date}`);

  let page;
  try {
    page = await getAvailabilityPage();

    // Navigate to calendar. Already logged in, so this is fast.
    // Detect readiness via the calendar API response instead of a fixed 8s delay.
    console.log('[Availability] Navigating to calendar page...');
    const calReady = page.waitForResponse(
      r => r.url().includes('/api/2/calendar/') && r.status() === 200,
      { timeout: TIMEOUT }
    ).catch(() => {});
    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await calReady;
    await page.waitForTimeout(1000); // short buffer for SPA rendering

    // If redirected to login the session expired — invalidate & retry once
    if (page.url().includes('/login')) {
      console.log('[Session] Session expired, re-authenticating...');
      await availSession.context.close().catch(() => {});
      availSession = null;
      page = await getAvailabilityPage();
      const calReady2 = page.waitForResponse(
        r => r.url().includes('/api/2/calendar/') && r.status() === 200,
        { timeout: TIMEOUT }
      ).catch(() => {});
      await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      await calReady2;
      await page.waitForTimeout(1000);
    }

    console.log(`[Availability] Calendar loaded. URL: ${page.url()}`);

    // Use Calgary Mountain Time as the "today" reference so daysDiff is correct
    // regardless of what timezone the Railway server runs in.
    const todayMT = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Edmonton',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    const [ty, tm, td] = todayMT.split('-').map(Number);
    const [dy, dm, dd] = date.split('-').map(Number);
    const todayMs  = Date.UTC(ty, tm - 1, td);
    const targetMs = Date.UTC(dy, dm - 1, dd);
    const daysDiff = Math.round((targetMs - todayMs) / 86400000);

    console.log(`[Availability] Today (MT): ${todayMT}, target: ${date}, diff: ${daysDiff}`);

    if (daysDiff !== 0) {
      const arrowCls = daysDiff > 0
        ? '.linearicon-chevron-right-circle'
        : '.linearicon-chevron-left-circle';
      for (let i = 0; i < Math.abs(daysDiff); i++) {
        await page.evaluate((cls) => { document.querySelector(cls)?.click(); }, arrowCls);
        await page.waitForTimeout(800);
      }
      await page.waitForTimeout(1000);
      await screenshot(page, 'debug-availability-target-date.png');
      console.log('[Availability] Navigated to target date.');
    }

    // Step 10: Parse all data from DOM — no API calls needed
    console.log('[Availability] Parsing calendar DOM...');
    const calendarData = await page.evaluate(() => {
      // ── A. Parse practitioner schedule from text header ──────────────────────
      const UI_SKIP = /^(CALENDAR|CLIENTS|SELL|COMMUNICATION|REPORTS|SETUP|WAIT LIST|Location|Practitioners|Office staff|Services|Treatment|Form|Scheduling|Payment|Reminders|Notification|Auto|Change|Perks|Logout|TODAY|Switch|Print|Hide|ZOOM|LINK|Schedule|VIP|★)/i;
      const bodyText = document.body.innerText;
      const headerSection = bodyText.split(/12AM\n12:15AM/)[0];
      const lines = headerSection.split('\n').map(l => l.trim()).filter(Boolean);
      const practitioners = [];
      let idx = 0;
      while (idx < lines.length) {
        const line = lines[idx];
        if (line.length < 2 || line.length > 90 || UI_SKIP.test(line) || /^\d/.test(line)) { idx++; continue; }
        if (lines[idx + 1] === 'Off') {
          practitioners.push({ name: line, working: false, start: null, end: null, colX: null });
          idx += 2;
        } else if (
          lines[idx + 1]?.match(/^\d{1,2}:\d{2}\s?(AM|PM)/i) &&
          lines[idx + 2] === '-' &&
          lines[idx + 3]?.match(/^\d{1,2}:\d{2}\s?(AM|PM)/i)
        ) {
          practitioners.push({ name: line, working: true, start: lines[idx + 1], end: lines[idx + 3], colX: null });
          idx += 4;
        } else { idx++; }
      }
      // ── B. Find each working practitioner's column x-position from the DOM ──
      for (const prac of practitioners.filter(p => p.working)) {
        const nameNorm = prac.name.toUpperCase().replace(/\s+/g, ' ').trim();
        for (const el of document.querySelectorAll('*')) {
          const txt = (el.innerText || '').trim().toUpperCase().replace(/\s+/g, ' ');
          if ((txt === nameNorm || txt.startsWith(nameNorm + '\n') || txt.startsWith(nameNorm + ' ')) &&
              el.children.length < 5) {
            const r = el.getBoundingClientRect();
            if (r.width > 20 && r.height > 0 && r.top < 350) {
              prac.colX = Math.round(r.left + r.width / 2);
              break;
            }
          }
        }
      }
      // ── C. Calibrate time grid: map pixel y-positions to clock times ─────────
      const timeLabels = [];
      for (const el of document.querySelectorAll('*')) {
        const txt = (el.innerText || '').trim();
        const m = txt.match(/^(\d{1,2})(AM|PM)$/i);
        if (!m) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.top < 100) continue;
        let h = parseInt(m[1]);
        if (m[2].toUpperCase() === 'PM' && h !== 12) h += 12;
        if (m[2].toUpperCase() === 'AM' && h === 12) h = 0;
        if (!timeLabels.some(t => Math.abs(t.mins - h * 60) < 30 && Math.abs(t.y - r.top) < 5)) {
          timeLabels.push({ mins: h * 60, y: r.top });
        }
      }
      timeLabels.sort((a, b) => a.y - b.y);
      let pxPerMin = null, refLabel = null;
      if (timeLabels.length >= 2) {
        const first = timeLabels[0];
        const last  = timeLabels[timeLabels.length - 1];
        if (last.mins !== first.mins) {
          pxPerMin = (last.y - first.y) / (last.mins - first.mins);
          refLabel = first;
        }
      }
      // ── D. Parse booked appointment blocks from the calendar grid ────────────
      const appointments = [];
      const eventEls = document.querySelectorAll(
        '.calendar-event, .calendar-appointment, [class*="calendar-event"], [class*="appt"], [class*="appointment"]'
      );
      const parseTime12 = (str) => {
        const m = str.trim().match(/(\d{1,2}):(\d{2})\s?(AM|PM)/i);
        if (!m) return null;
        let h = parseInt(m[1]);
        const min = parseInt(m[2]);
        if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
        if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
        return h * 60 + min;
      };
      for (const el of eventEls) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0 || r.top < 100) continue;
        const text = (el.innerText || '').trim();
        const elX  = Math.round(r.left + r.width / 2);
        let startMins = null, endMins = null;
        const timeMatches = [...text.matchAll(/(\d{1,2}:\d{2}\s?(?:AM|PM))/gi)].map(x => x[1]);
        if (timeMatches.length >= 2) {
          startMins = parseTime12(timeMatches[0]);
          endMins   = parseTime12(timeMatches[1]);
        } else if (timeMatches.length === 1) {
          startMins = parseTime12(timeMatches[0]);
          if (startMins !== null && pxPerMin) endMins = startMins + Math.round(r.height / pxPerMin);
        }
        if (startMins === null && pxPerMin && refLabel) {
          startMins = Math.round(refLabel.mins + (r.top    - refLabel.y) / pxPerMin);
          endMins   = Math.round(refLabel.mins + (r.bottom - refLabel.y) / pxPerMin);
          startMins = Math.round(startMins / 15) * 15;
          endMins   = Math.round(endMins   / 15) * 15;
        }
        if (startMins !== null && endMins !== null && endMins > startMins) {
          appointments.push({ text: text.substring(0, 120), x: elX, startMins, endMins });
        }
      }
      return {
        practitioners,
        appointments,
        debug: { pxPerMin, timeLabelsCount: timeLabels.length, eventsFound: eventEls.length },
      };
    });

    console.log(`[Availability] DOM parse: ${calendarData.practitioners.length} practitioners, ` +
      `${calendarData.appointments.length} appointments found. ` +
      `pxPerMin=${calendarData.debug.pxPerMin?.toFixed(2)}, timeLabels=${calendarData.debug.timeLabelsCount}`);

    // ── Time helpers ───────────────────────────────────────────────────────────
    const toMinutes = (timeStr) => {
      if (!timeStr) return null;
      timeStr = String(timeStr).trim();
      const m24 = timeStr.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
      if (m24) return parseInt(m24[1]) * 60 + parseInt(m24[2]);
      const m12 = timeStr.match(/(\d{1,2}):(\d{2})\s?(AM|PM)/i);
      if (!m12) return null;
      let h = parseInt(m12[1]);
      const min = parseInt(m12[2]);
      const ampm = m12[3].toUpperCase();
      if (ampm === 'PM' && h !== 12) h += 12;
      if (ampm === 'AM' && h === 12) h = 0;
      return h * 60 + min;
    };
    const fromMinutes = (mins) => {
      const h24 = Math.floor(mins / 60);
      const m   = mins % 60;
      const ampm = h24 >= 12 ? 'PM' : 'AM';
      const h12  = h24 % 12 || 12;
      return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
    };

    // ── Step 11: Match appointments to practitioners by column x-position ──────
    const workingPractitioners = calendarData.practitioners.filter(p => p.working && p.start && p.end);
    console.log(`[Availability] Working practitioners: ${workingPractitioners.length}`);
    workingPractitioners.forEach(p => console.log(`  ${p.name} | ${p.start} - ${p.end} | colX=${p.colX}`));

    const bookedByPrac = {};
    for (const appt of calendarData.appointments) {
      if (workingPractitioners.length === 0) break;
      let bestPrac = null, bestDist = Infinity;
      for (const prac of workingPractitioners) {
        if (prac.colX === null) continue;
        const dist = Math.abs(prac.colX - appt.x);
        if (dist < bestDist) { bestDist = dist; bestPrac = prac; }
      }
      if (bestPrac && bestDist < 200) {
        if (!bookedByPrac[bestPrac.name]) bookedByPrac[bestPrac.name] = [];
        bookedByPrac[bestPrac.name].push(appt);
      }
    }

    // ── Step 12: Build per-practitioner output ────────────────────────────────
    const practitionersOut = [];
    for (const prac of workingPractitioners) {
      const startMin  = toMinutes(prac.start);
      const endMin    = toMinutes(prac.end);
      const bookings  = bookedByPrac[prac.name] || [];
      const bookedRanges = bookings
        .map(b => ({ start: b.startMins, end: b.endMins, text: b.text }))
        .filter(r => r.start !== null && r.end !== null);
      const freeSlots = [];
      if (startMin !== null && endMin !== null) {
        for (let t = startMin; t + 60 <= endMin; t += 60) {
          const slotEnd = t + 60;
          const blocked = bookedRanges.some(r => r.start < slotEnd && r.end > t);
          if (!blocked) freeSlots.push(fromMinutes(t));
        }
      }
      practitionersOut.push({
        name:            prac.name,
        hours:           `${prac.start} - ${prac.end}`,
        available_slots: freeSlots,
        booked_slots:    bookedRanges.map(r => ({
          time: `${fromMinutes(r.start)} - ${fromMinutes(r.end)}`,
          info: r.text,
        })),
      });
      console.log(`  ${prac.name}: ${freeSlots.length} free slots, ${bookedRanges.length} bookings`);
    }

    await screenshot(page, 'debug-availability.png');
    res.json({
      success: true,
      date,
      practitioners: practitionersOut,
      total_practitioners_working: practitionersOut.length,
      message: `Found ${practitionersOut.length} practitioner${practitionersOut.length !== 1 ? 's' : ''} working on ${date}`,
    });

  } catch (err) {
    console.error('[Availability] ERROR:', err.message);
    // Invalidate the cached session on error so next request gets a fresh one
    if (availSession) {
      await availSession.context.close().catch(() => {});
      availSession = null;
    }
    if (page) await screenshot(page, 'debug-availability.png').catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  }
  // NOTE: Do NOT close the context here — we keep it alive for the next request.
});

// ─── ENDPOINT 3: POST /create-booking ────────────────────────────────────────
// Helper: find visible element by exact innerText and return its center coord + bottom
async function findVisibleByText(page, text) {
  return page.evaluate((t) => {
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim();
      if (txt === t) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0)
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), bottom: Math.round(r.bottom) };
      }
    }
    return null;
  }, text);
}

// Helper: select a value from a dropdown that just opened.
async function selectDropdownValue(page, value, minY = 200, nearX = null) {
  return page.evaluate(({ v, minY, nearX }) => {
    for (const el of document.querySelectorAll('*')) {
      const txt = (el.innerText || '').trim();
      if (txt === v) {
        const r = el.getBoundingClientRect();
        const xOk = nearX === null || (r.left + r.width / 2 >= nearX - 80 && r.left + r.width / 2 <= nearX + 80);
        if (r.width > 0 && r.top > minY && r.top < 900 && xOk) { el.click(); return true; }
      }
    }
    return false;
  }, { v: value, minY, nearX });
}

app.post('/create-booking', async (req, res) => {
  const {
    date: rawDate,
    time,
    clientFirstName,
    clientLastName,
    clientEmail,
    clientPhone,
    service,
    duration,
    therapist,
  } = req.body;
  // Strip leading '=' artifact from n8n expression evaluation
  const date = (rawDate || '').replace(/^=/, '');
  const required = { date, time, clientFirstName, clientLastName };
  for (const [key, val] of Object.entries(required)) {
    if (!val) return res.status(400).json({ success: false, error: `Missing required field: ${key}` });
  }
  console.log(`\n[Booking] Creating booking for ${clientFirstName} ${clientLastName} on ${date} at ${time}`);
  let context, page;
  try {
    ({ page, context } = await newPage());
    // ── Step 1: Login ────────────────────────────────────────────────────────
    await login(page);
    // ── Step 2: Navigate to calendar and wait for SPA to load ────────────────
    console.log('[Booking] Navigating to calendar...');
    const calReady = page.waitForResponse(
      r => r.url().includes('/api/2/calendar/') && r.status() === 200,
      { timeout: TIMEOUT }
    ).catch(() => {});
    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await calReady;
    await page.waitForTimeout(2000);
    // ── Step 3: Click the "+" FAB then "Schedule New Appointment" popup ───────
    console.log('[Booking] Opening new appointment form...');
    await page.waitForSelector('.linearicon-plus', { timeout: TIMEOUT });
    await page.click('.linearicon-plus');
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if ((el.innerText || '').trim() === 'Schedule New Appointment') { el.click(); return; }
      }
    });
    await page.waitForSelector('input[placeholder*="Search for a client by name"]', { timeout: TIMEOUT });
    await page.waitForTimeout(500);
    console.log('[Booking] New appointment form opened.');
    await screenshot(page, 'debug-booking-step1-form.png');
    // ── Step 4: Client search ─────────────────────────────────────────────────
    console.log(`[Booking] Searching for client: ${clientFirstName} ${clientLastName}`);
    const fullName = `${clientFirstName} ${clientLastName}`;
    await page.fill('input[placeholder*="Search for a client by name"]', fullName);
    await page.waitForTimeout(2000);
    await screenshot(page, 'debug-booking-step2-client-search.png');
    let clientFound = false;
    try {
      await page.locator(`text=${fullName}`).first().click({ timeout: 5000 });
      clientFound = true;
      console.log('[Booking] Existing client selected.');
    } catch (_) {}
    if (!clientFound) {
      console.log('[Booking] Client not found — adding new client...');
      const addLink = await findVisibleByText(page, '+ Add new client');
      if (addLink) {
        await page.mouse.click(addLink.x, addLink.y);
        await page.waitForTimeout(2000);
        await screenshot(page, 'debug-booking-step3-new-client.png');
        const fieldMap = [
          ['input[placeholder*="First" i]',  clientFirstName],
          ['input[placeholder*="Last" i]',   clientLastName],
          ['input[placeholder*="email" i], input[type="email"]', clientEmail || ''],
          ['input[placeholder*="phone" i], input[type="tel"]',   clientPhone || ''],
        ];
        for (const [sel, val] of fieldMap) {
          if (!val) continue;
          const el = await page.$(sel);
          if (el) { await el.fill(val); console.log(`[Booking] New client field filled: ${val}`); }
        }
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('button, [role="button"]')) {
            const txt = (el.innerText || '').trim().toLowerCase();
            if (txt === 'save' || txt === 'add client' || txt === 'add') { el.click(); return; }
          }
        });
        await page.waitForTimeout(2000);
      } else {
        console.log('[Booking] "+ Add new client" link not found, continuing...');
      }
    }
    await screenshot(page, 'debug-booking-step4-after-client.png');
    // ── Step 5: Select service ────────────────────────────────────────────────
    if (service) {
      console.log(`[Booking] Selecting service: ${service} (${duration || '60'} min)`);
      const svcDropdown = await findVisibleByText(page, 'Select service');
      if (svcDropdown) {
        await page.mouse.click(svcDropdown.x, svcDropdown.y);
        await page.waitForTimeout(1500);
        await screenshot(page, 'debug-booking-step5-service-open.png');
        const svcClicked = await page.evaluate(({ svcName, dur }) => {
          const allEls = [...document.querySelectorAll('*')];
          let serviceEl = null;
          for (const el of allEls) {
            const txt = (el.innerText || '').trim().toLowerCase();
            if (txt.includes(svcName.toLowerCase()) && !txt.includes('\n') && txt.length < 80 && el.children.length <= 2) {
              const r = el.getBoundingClientRect();
              if (r.width > 100 && r.height > 0) { serviceEl = { el, y: r.top }; break; }
            }
          }
          if (!serviceEl) return { error: `Service "${svcName}" not found` };
          const durText = dur + ' MIN';
          let closestBtn = null, closestDist = Infinity;
          for (const el of allEls) {
            if ((el.innerText || '').trim() === durText) {
              const r = el.getBoundingClientRect();
              if (r.top > serviceEl.y && r.top < serviceEl.y + 100 && r.width > 20) {
                const dist = r.top - serviceEl.y;
                if (dist < closestDist) { closestDist = dist; closestBtn = el; }
              }
            }
          }
          if (!closestBtn) {
            for (const el of allEls) {
              const r = el.getBoundingClientRect();
              if (r.top > serviceEl.y && r.top < serviceEl.y + 120 && r.width > 20 && r.height > 0) {
                const txt = (el.innerText || '').trim();
                if (/^\d+ MIN$/.test(txt)) { closestBtn = el; break; }
              }
            }
          }
          if (closestBtn) { closestBtn.click(); return { success: true }; }
          return { error: `Duration "${durText}" not found below service` };
        }, { svcName: service, dur: String(duration || '60') });
        console.log('[Booking] Service click result:', JSON.stringify(svcClicked));
        await page.waitForTimeout(1500);
        await screenshot(page, 'debug-booking-step5-after-service.png');
      }
    }
    // ── Step 6: Select practitioner ───────────────────────────────────────────
    if (therapist) {
      console.log(`[Booking] Selecting practitioner: ${therapist}`);
      const pracDropdown = await findVisibleByText(page, 'Select practitioner');
      if (pracDropdown) {
        await page.mouse.click(pracDropdown.x, pracDropdown.y);
        await page.waitForTimeout(1500);
        await screenshot(page, 'debug-booking-step6-prac-open.png');
        const pracClicked = await page.evaluate(({ dropY, name }) => {
          for (const el of document.querySelectorAll('*')) {
            const txt = (el.innerText || '').trim();
            if (txt.toLowerCase().includes(name.toLowerCase()) && !txt.includes('\n') && txt.length < 80) {
              const r = el.getBoundingClientRect();
              if (r.top > dropY && r.width > 50 && r.height > 0) { el.click(); return { clicked: txt }; }
            }
          }
          return { error: `Practitioner "${name}" not found in dropdown` };
        }, { dropY: pracDropdown.bottom, name: therapist });
        console.log('[Booking] Practitioner click result:', JSON.stringify(pracClicked));
        await page.waitForTimeout(1500);
        await screenshot(page, 'debug-booking-step6-after-prac.png');
      }
    }
    // ── Step 7: Set date ──────────────────────────────────────────────────────
    console.log(`[Booking] Setting date to: ${date}`);
    const targetDay = parseInt(date.split('-')[2], 10);
    const dateInputPos = await page.evaluate(() => {
      const input = document.querySelector('input[placeholder*="Select a date"]');
      const r = input?.getBoundingClientRect();
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), bottom: Math.round(r.bottom) } : null;
    });
    if (dateInputPos) {
      await page.mouse.click(dateInputPos.x, dateInputPos.y);
      await page.waitForTimeout(1200);
      await screenshot(page, 'debug-booking-step7-datepicker.png');
      for (let attempt = 0; attempt < 6; attempt++) {
        const dayClicked = await page.evaluate(({ day, inputBottom, inputRight }) => {
          let pickerRoot = null;
          for (const el of document.querySelectorAll('*')) {
            const txt = (el.innerText || '').trim();
            const r = el.getBoundingClientRect();
            if (/^[A-Za-z]+ \d{4}$/.test(txt) && r.top > inputBottom - 60 && r.top < inputBottom + 200) {
              let ancestor = el.parentElement;
              for (let i = 0; i < 8 && ancestor; i++) {
                const ar = ancestor.getBoundingClientRect();
                if (ar.width > 100 && ar.height > 100) { pickerRoot = ancestor; break; }
                ancestor = ancestor.parentElement;
              }
      2       if (!pickerRoot) pickerRoot = el.parentElement;
              break;
            }
          }
          const searchRoot = pickerRoot || document;
          const candidates = [...searchRoot.querySelectorAll('*')];
          for (const el of candidates) {
            const txt = (el.innerText || '').trim();
            if (txt !== String(day)) continue;
            const r = el.getBoundingClientRect();
            if (r.top > inputBottom - 10 && r.width >= 20 && r.width <= 70 && r.height >= 18 && r.height <= 70 && r.left >= 0 && r.left <= 1280) {
              el.click();
              return { x: Math.round(r.left), y: Math.round(r.top), inPicker: !!pickerRoot };
            }
          }
          return null;
        }, { day: targetDay, inputBottom: dateInputPos.bottom, inputRight: dateInputPos.x + 140 });
        if (dayClicked) {
          console.log(`[Booking] Day ${targetDay} clicked at:`, JSON.stringify(dayClicked));
          break;
        }
        const nextClicked = await page.evaluate(({ inputBottom }) => {
          for (const el of document.querySelectorAll('*')) {
            const txt = (el.innerText || '').trim();
            const r = el.getBoundingClientRect();
            if ((txt === '›' || txt === '>') && r.top > inputBottom - 30) { el.click(); return true; }
          }
          return false;
        }, { inputBottom: dateInputPos.bottom });
        if (!nextClicked) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1000);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
    await screenshot(page, 'debug-booking-step7-after-date.png');
    // ── Step 8: Set start time ─────────────────────────────────────────────────
    console.log(`[Booking] Setting start time: ${time}`);
    const timeMatch = time.match(/(\d{1,2}):(\d{2})\s?(AM|PM)/i);
    if (timeMatch) {
      const tHour  = String(parseInt(timeMatch[1], 10));
      const tAmpm  = timeMatch[3].toUpperCase();
      const rawMin   = parseInt(timeMatch[2], 10);
      const minOpts  = [0, 15, 30, 45];
      const rounded  = minOpts.reduce((a, b) => Math.abs(b - rawMin) < Math.abs(a - rawMin) ? b : a);
      const tMin     = String(rounded).padStart(2, '0');
      console.log(`[Booking] Parsed time → hour=${tHour}, min=${tMin}, ampm=${tAmpm}`);
      const spinnerCoords = await page.evaluate(() => {
        const container = document.querySelector('[data-cs_field_name="start_time"]');
        if (!container) return [];
        const cr = container.getBoundingClientRect();
        const candidates = [...container.querySelectorAll('.BOX-flex-manager')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width >= 60 && r.width <= 90 && r.height >= 25 && r.height <= 55 && r.top > cr.top + 5;
        });
        const xVals = candidates.map(el => Math.round(el.getBoundingClientRect().left)).sort((a, b) => a - b);
        const clusters = [];
        for (const x of xVals) {
          if (clusters.length === 0 || x - clusters[clusters.length - 1] > 50) clusters.push(x);
          if (clusters.length === 3) break;
        }
        return clusters.map(x => {
          const el = candidates.find(e => Math.abs(Math.round(e.getBoundingClientRect().left) - x) <= 5);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }).filter(Boolean);
      });
      console.log('[Booking] Start time spinner coords:', JSON.stringify(spinnerCoords));
      if (spinnerCoords.length >= 3) {
        const [hourSpinner, minSpinner, ampmSpinner] = spinnerCoords;
        await page.mouse.click(hourSpinner.x, hourSpinner.y);
        await page.waitForTimeout(800);
        const hourOk = await selectDropdownValue(page, tHour, hourSpinner.y + 20, hourSpinner.x);
        console.log(`[Booking] Hour ${tHour} selected:`, hourOk);
        await page.waitForTimeout(500);
        await page.mouse.click(minSpinner.x, minSpinner.y);
        await page.waitForTimeout(800);
        const minOk = await selectDropdownValue(page, tMin, minSpinner.y + 20, minSpinner.x);
        console.log(`[Booking] Minute ${tMin} selected:`, minOk);
        await page.waitForTimeout(500);
        await page.mouse.click(ampmSpinner.x, ampmSpinner.y);
        await page.waitForTimeout(800);
        const ampmOk = await selectDropdownValue(page, tAmpm, ampmSpinner.y + 20, ampmSpinner.x);
        console.log(`[Booking] AM/PM ${tAmpm} selected:`, ampmOk);
        await page.waitForTimeout(500);
      } else {
        console.log(`[Booking] WARNING: only ${spinnerCoords.length} spinners found (expected 3)`);
      }
    }
    await page.waitForTimeout(1000);
    await screenshot(page, 'debug-booking-step8-before-save.png');
    // ── Step 9: Save & Close ──────────────────────────────────────────────────
    console.log('[Booking] Clicking SAVE & CLOSE...');
    const saveCoord = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if ((el.innerText || '').trim() === 'SAVE & CLOSE') {
          const r = el.getBoundingClientRect();
          if (r.bottom > 800 && r.width > 50)
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    });
    if (saveCoord) {
      await page.mouse.click(saveCoord.x, saveCoord.y);
    } else {
      await page.locator('text=SAVE & CLOSE').last().click({ timeout: TIMEOUT });
    }
    await page.waitForTimeout(4000);
    await screenshot(page, 'debug-booking.png');
    const modalStillOpen = await page.$('input[placeholder*="Search for a client by name"]');
    if (modalStillOpen) {
      const errorText = await page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
          const txt = (el.innerText || '').trim();
          if (txt.includes('required') || txt.includes('error') || txt.includes('Error')) {
            if (txt.length < 200) return txt;
          }
        }
        return null;
      });
      if (errorText) throw new Error(`Form validation error: ${errorText}`);
    }
    console.log('[Booking] Booking complete!');
    res.json({
      success: true,
      message: 'Appointment booked successfully',
      details: { date, time, client: `${clientFirstName} ${clientLastName}` },
    });
  } catch (err) {
    console.error('[Booking] ERROR:', err.message);
    if (page) await screenshot(page, 'debug-booking.png').catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (context) await context.close().catch(() => {});
  }
});

// ─── ENDPOINT 4: POST /cancel-booking ────────────────────────────────────────
app.post('/cancel-booking', async (req, res) => {
  const { date: rawDate, time, clientName } = req.body;
  const date = (rawDate || '').replace(/^=/, '');
  if (!date || !time) {
    return res.status(400).json({ success: false, error: 'Missing required fields: date, time' });
  }
  console.log(`\n[Cancel] Cancelling booking on ${date} at ${time} for ${clientName || 'unknown client'}`);
  let context, page;
  try {
    ({ page, context } = await newPage());
    await login(page);
    console.log('[Cancel] Loading calendar...');
    const calApiDone = page.waitForResponse(
      r => r.url().includes('/api/2/calendar/') && r.status() === 200,
      { timeout: TIMEOUT }
    ).catch(() => {});
    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await calApiDone;
    await page.waitForTimeout(2000);
    const todayStr = new Date().toISOString().slice(0, 10);
    const [ty, tm, td] = todayStr.split('-').map(Number);
    const [gy, gm, gd] = date.split('-').map(Number);
    const todayMs  = Date.UTC(ty, tm - 1, td);
    const targetMs = Date.UTC(gy, gm - 1, gd);
    const daysDiff = Math.round((targetMs - todayMs) / 86400000);
    console.log(`[Cancel] Today: ${todayStr}, target: ${date}, diff: ${daysDiff} days`);
    if (daysDiff !== 0) {
      const arrowCls = daysDiff > 0 ? '.linearicon-chevron-right-circle' : '.linearicon-chevron-left-circle';
      const steps = Math.abs(daysDiff);
      for (let i = 0; i < steps; i++) {
        const calNext = page.waitForResponse(
          r => r.url().includes('/api/2/calendar/') && r.status() === 200,
          { timeout: 15000 }
        ).catch(() => {});
        await page.evaluate((cls) => { const el = document.querySelector(cls); if (el) el.click(); }, arrowCls);
        await calNext;
        await page.waitForTimeout(600);
      }
    }
    await page.waitForTimeout(1500);
    console.log(`[Cancel] Navigated to ${date}`);
    await screenshot(page, 'debug-cancel-step1-date.png');
    const apptInfo = await page.evaluate(async ({ targetDate, clientNameQ, timeStr }) => {
      const resp = await fetch(`/api/2/calendar/?mode=day&exact_date=${targetDate}&format=json`, { credentials: 'include' });
      const data  = await resp.json();
      const appts = data.appointments || [];
      const toH24 = (t) => {
        const m = t.match(/(\d{1,2}):(\d{2})\s?(AM|PM)/i);
        if (!m) return null;
        let h = parseInt(m[1]); const min = parseInt(m[2]); const ap = m[3].toUpperCase();
        if (ap === 'AM' && h === 12) h = 0;
        if (ap === 'PM' && h !== 12) h += 12;
        return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;
      };
      const target24 = toH24(timeStr);
      for (const a of appts) {
        const nameMatch = !clientNameQ || (a.client_name || '').toLowerCase().includes(clientNameQ.toLowerCase());
        const timeMatch = !target24  || (a.start_time || '').startsWith(target24.slice(0, 5));
        if (nameMatch && timeMatch) return { id: a.id, name: a.client_name, start: a.start_time };
      }
      for (const a of appts) {
        if (!clientNameQ) return { id: a.id, name: a.client_name, start: a.start_time };
        if ((a.client_name || '').toLowerCase().includes(clientNameQ.toLowerCase()))
          return { id: a.id, name: a.client_name, start: a.start_time };
      }
      return null;
    }, { targetDate: date, clientNameQ: clientName || '', timeStr: time });
    if (!apptInfo) throw new Error(`No appointment found on ${date} for "${clientName}" at ${time}`);
    console.log(`[Cancel] Found appointment #${apptInfo.id} for ${apptInfo.name} at ${apptInfo.start}`);
    const clickedAppt = await page.evaluate(({ name }) => {
      for (const el of document.querySelectorAll('.calendar-event, .calendar-appointment')) {
        const txt = (el.innerText || '').toLowerCase();
        if (txt.includes(name.toLowerCase())) {
          el.scrollIntoView({ behavior: 'auto', block: 'center' });
          el.click();
          return true;
        }
      }
      return false;
    }, { name: apptInfo.name });
    if (!clickedAppt) throw new Error(`Could not click appointment for "${apptInfo.name}" in the calendar view`);
    await page.waitForTimeout(2500);
    await screenshot(page, 'debug-cancel-step2-form.png');
    console.log('[Cancel] Appointment edit form opened');
    const cancelBtnClicked = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if ((el.innerText || '').trim() === 'CANCEL APPOINTMENT') {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { el.click(); return true; }
        }
      }
      return false;
    });
    if (!cancelBtnClicked) throw new Error('"CANCEL APPOINTMENT" button not found in the edit form');
    await page.waitForTimeout(1500);
    await screenshot(page, 'debug-cancel-step3-dialog.png');
    console.log('[Cancel] Cancellation dialog opened');
    const confirmClicked = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if ((el.innerText || '').trim() === 'CONFIRM CANCELLATION') {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { el.click(); return true; }
        }
      }
      return false;
    });
    if (!confirmClicked) throw new Error('"CONFIRM CANCELLATION" button not found in the dialog');
    await page.waitForTimeout(3000);
    await screenshot(page, 'debug-cancel.png');
    console.log('[Cancel] Cancellation confirmed!');
    res.json({ success: true, message: 'Appointment cancelled', details: { date, time, client: clientName } });
  } catch (err) {
    console.error('[Cancel] ERROR:', err.message);
    if (page) await screenshot(page, 'debug-cancel.png').catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (context) await context.close().catch(() => {});
  }
});

// ─── ENDPOINT 5: POST /reschedule-booking ────────────────────────────────────
app.post('/reschedule-booking', async (req, res) => {
  const { oldDate: rawOldDate, oldTime, newDate: rawNewDate, newTime, clientName } = req.body;
  const oldDate = (rawOldDate || '').replace(/^=/, '');
  const newDate = (rawNewDate || '').replace(/^=/, '');
  if (!oldDate || !oldTime || !newDate || !newTime) {
    return res.status(400).json({ success: false, error: 'Missing required fields: oldDate, oldTime, newDate, newTime' });
  }
  console.log(`\n[Reschedule] Moving ${clientName || 'appointment'} from ${oldDate} ${oldTime} → ${newDate} ${newTime}`);
  let context, page;
  try {
    ({ page, context } = await newPage());
    await login(page);
    console.log('[Reschedule] Loading calendar...');
    const calApiDone = page.waitForResponse(
      r => r.url().includes('/api/2/calendar/') && r.status() === 200,
      { timeout: TIMEOUT }
    ).catch(() => {});
    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await calApiDone;
    await page.waitForTimeout(2000);
    const todayStr = new Date().toISOString().slice(0, 10);
    const msPerDay = 86400000;
    const toDays = (s) => { const [y,m,d] = s.split('-').map(Number); return Date.UTC(y,m-1,d) / msPerDay; };
    const daysDiff = Math.round(toDays(oldDate) - toDays(todayStr));
    if (daysDiff !== 0) {
      const arrowCls = daysDiff > 0 ? '.linearicon-chevron-right-circle' : '.linearicon-chevron-left-circle';
      for (let i = 0; i < Math.abs(daysDiff); i++) {
        const calNext = page.waitForResponse(
          r => r.url().includes('/api/2/calendar/') && r.status() === 200, { timeout: 15000 }
        ).catch(() => {});
        await page.evaluate((cls) => { document.querySelector(cls)?.click(); }, arrowCls);
        await calNext;
        await page.waitForTimeout(600);
      }
    }
    await page.waitForTimeout(1500);
    console.log(`[Reschedule] On ${oldDate}`);
    const apptInfo = await page.evaluate(async ({ targetDate, clientNameQ, timeStr }) => {
      const resp = await fetch(`/api/2/calendar/?mode=day&exact_date=${targetDate}&format=json`, { credentials: 'include' });
      const data  = await resp.json();
      const appts = data.appointments || [];
      const toH24 = (t) => {
        const m = t.match(/(\d{1,2}):(\d{2})\s?(AM|PM)/i);
        if (!m) return null;
        let h = parseInt(m[1]); const min = parseInt(m[2]); const ap = m[3].toUpperCase();
        if (ap === 'AM' && h === 12) h = 0;
        if (ap === 'PM' && h !== 12) h += 12;
        return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}`;
      };
      const target24 = toH24(timeStr);
      for (const a of appts) {
        const nameOk = !clientNameQ || (a.client_name || '').toLowerCase().includes(clientNameQ.toLowerCase());
        const timeOk = !target24   || (a.start_time || '').startsWith(target24);
        if (nameOk && timeOk) return { id: a.id, name: a.client_name, start: a.start_time };
      }
      for (const a of appts) {
        if (!clientNameQ || (a.client_name || '').toLowerCase().includes(clientNameQ.toLowerCase()))
          return { id: a.id, name: a.client_name, start: a.start_time };
      }
      return null;
    }, { targetDate: oldDate, clientNameQ: clientName || '', timeStr: oldTime });
    if (!apptInfo) throw new Error(`No appointment found on ${oldDate} for "${clientName}" at ${oldTime}`);
    console.log(`[Reschedule] Found appointment #${apptInfo.id} for ${apptInfo.name}`);
    const clickedAppt = await page.evaluate(({ name }) => {
      for (const el of document.querySelectorAll('.calendar-event, .calendar-appointment')) {
        if ((el.innerText || '').toLowerCase().includes(name.toLowerCase())) {
          el.scrollIntoView({ behavior: 'auto', block: 'center' });
          el.click();
          return true;
        }
      }
      return false;
    }, { name: apptInfo.name });
    if (!clickedAppt) throw new Error(`Could not click appointment for "${apptInfo.name}" in calendar`);
    await page.waitForTimeout(2500);
    await screenshot(page, 'debug-reschedule-step1-form.png');
    console.log('[Reschedule] Edit form opened');
    // ── Change the date ─────────────────────────────────────────────────────
    const targetDay = parseInt(newDate.split('-')[2], 10);
    console.log(`[Reschedule] Setting new date: ${newDate} (day ${targetDay})`);
    const dateInputPos = await page.evaluate(() => {
      const input = document.querySelector('input[placeholder*="Select a date"]');
      const r = input?.getBoundingClientRect();
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), bottom: Math.round(r.bottom) } : null;
    });
    if (dateInputPos) {
      await page.mouse.click(dateInputPos.x, dateInputPos.y);
      await page.waitForTimeout(1200);
      for (let attempt = 0; attempt < 6; attempt++) {
        const dayClicked = await page.evaluate(({ day, inputBottom }) => {
          let pickerRoot = null;
          for (const el of document.querySelectorAll('*')) {
            const txt = (el.innerText || '').trim();
            const r   = el.getBoundingClientRect();
            if (/^[A-Za-z]+ \d{4}$/.test(txt) && r.top > inputBottom - 60 && r.top < inputBottom + 200) {
              let ancestor = el.parentElement;
              for (let i = 0; i < 8 && ancestor; i++) {
                const ar = ancestor.getBoundingClientRect();
                if (ar.width > 100 && ar.height > 100) { pickerRoot = ancestor; break; }
                ancestor = ancestor.parentElement;
              }
              if (!pickerRoot) pickerRoot = el.parentElement;
              break;
            }
          }
          const root = pickerRoot || document;
          for (const el of [...root.querySelectorAll('*')]) {
            if ((el.innerText || '').trim() !== String(day)) continue;
            const r = el.getBoundingClientRect();
            if (r.top > inputBottom - 10 && r.width >= 20 && r.width <= 70 && r.height >= 18 && r.height <= 70) {
              el.click();
              return { x: Math.round(r.left), y: Math.round(r.top) };
            }
          }
          return null;
        }, { day: targetDay, inputBottom: dateInputPos.bottom });
        if (dayClicked) { console.log(`[Reschedule] Day ${targetDay} clicked at:`, JSON.stringify(dayClicked)); break; }
        const nextClicked = await page.evaluate(({ inputBottom }) => {
          for (const el of document.querySelectorAll('*')) {
            const txt = (el.innerText || '').trim();
            const r   = el.getBoundingClientRect();
            if ((txt === '›' || txt === '>') && r.top > inputBottom - 30) { el.click(); return true; }
          }
          return false;
        }, { inputBottom: dateInputPos.bottom });
        if (!nextClicked) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1000);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
    await screenshot(page, 'debug-reschedule-step2-date.png');
    console.log('[Reschedule] Date updated');
    // ── Change the time ─────────────────────────────────────────────────────
    console.log(`[Reschedule] Setting new time: ${newTime}`);
    const timeMatch = newTime.match(/(\d{1,2}):(\d{2})\s?(AM|PM)/i);
    if (timeMatch) {
      const tHour = String(parseInt(timeMatch[1], 10));
      const tAmpm = timeMatch[3].toUpperCase();
      const rawMin = parseInt(timeMatch[2], 10);
      const minOpts = [0, 15, 30, 45];
      const rounded = minOpts.reduce((a, b) => Math.abs(b - rawMin) < Math.abs(a - rawMin) ? b : a);
      const tMin = String(rounded).padStart(2, '0');
      console.log(`[Reschedule] Parsed time → hour=${tHour}, min=${tMin}, ampm=${tAmpm}`);
      const spinnerCoords = await page.evaluate(() => {
        const container = document.querySelector('[data-cs_field_name="start_time"]');
        if (!container) return [];
        const cr = container.getBoundingClientRect();
        const candidates = [...container.querySelectorAll('.BOX-flex-manager')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width >= 60 && r.width <= 90 && r.height >= 25 && r.height <= 55 && r.top > cr.top + 5;
        });
        const xVals = candidates.map(el => Math.round(el.getBoundingClientRect().left)).sort((a, b) => a - b);
        const clusters = [];
        for (const x of xVals) {
          if (clusters.length === 0 || x - clusters[clusters.length - 1] > 50) clusters.push(x);
          if (clusters.length === 3) break;
        }
        return clusters.map(x => {
          const el = candidates.find(e => Math.abs(Math.round(e.getBoundingClientRect().left) - x) <= 5);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }).filter(Boolean);
      });
      console.log('[Reschedule] Spinner coords:', JSON.stringify(spinnerCoords));
      if (spinnerCoords.length >= 3) {
        const [hourSpinner, minSpinner, ampmSpinner] = spinnerCoords;
        await page.mouse.click(hourSpinner.x, hourSpinner.y);
        await page.waitForTimeout(800);
        const hourOk = await selectDropdownValue(page, tHour, hourSpinner.y + 20, hourSpinner.x);
        console.log(`[Reschedule] Hour ${tHour}:`, hourOk);
        await page.waitForTimeout(500);
        await page.mouse.click(minSpinner.x, minSpinner.y);
        await page.waitForTimeout(800);
        const minOk = await selectDropdownValue(page, tMin, minSpinner.y + 20, minSpinner.x);
        console.log(`[Reschedule] Minute ${tMin}:`, minOk);
        await page.waitForTimeout(500);
        await page.mouse.click(ampmSpinner.x, ampmSpinner.y);
        await page.waitForTimeout(800);
        const ampmOk = await selectDropdownValue(page, tAmpm, ampmSpinner.y + 20, ampmSpinner.x);
        console.log(`[Reschedule] AM/PM ${tAmpm}:`, ampmOk);
        await page.waitForTimeout(500);
      } else {
        console.log('[Reschedule] WARNING: could not find all 3 spinners');
      }
    }
    await page.waitForTimeout(1000);
    await screenshot(page, 'debug-reschedule-step3-time.png');
    // ── Save & Close ────────────────────────────────────────────────────────
    console.log('[Reschedule] Clicking SAVE & CLOSE...');
    const saveCoord = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if ((el.innerText || '').trim() === 'SAVE & CLOSE') {
          const r = el.getBoundingClientRect();
          if (r.bottom > 800 && r.width > 50)
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        }
      }
      return null;
    });
    if (saveCoord) {
      await page.mouse.click(saveCoord.x, saveCoord.y);
    } else {
      await page.locator('text=SAVE & CLOSE').last().click({ timeout: TIMEOUT });
    }
    await page.waitForTimeout(4000);
    await screenshot(page, 'debug-reschedule.png');
    const errorText = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        const txt = (el.innerText || '').trim();
        if (txt.toLowerCase().includes('please correct') || txt.toLowerCase().includes('server error')) return txt;
      }
      return null;
    });
    if (errorText) throw new Error(`Form validation error: ${errorText}`);
    console.log('[Reschedule] Rescheduled successfully!');
    res.json({
      success: true,
      message: 'Appointment rescheduled',
      details: { from: `${oldDate} ${oldTime}`, to: `${newDate} ${newTime}`, client: clientName },
    });
  } catch (err) {
    console.error('[Reschedule] ERROR:', err.message);
    if (page) await screenshot(page, 'debug-reschedule.png').catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (context) await context.close().catch(() => {});
  }
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on('SIGINT', async () => {
  console.log('\n[Server] Shutting down...');
  if (availSession) {
    await availSession.context.close().catch(() => {});
    console.log('[Server] Availability session closed.');
  }
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    console.log('[Server] Browser closed.');
  }
  process.exit(0);
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════╗');
  console.log(`║  ClinicSense Automation Server                   ║`);
  console.log(`║  Running at http://localhost:${PORT}               ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Endpoints:                                      ║');
  console.log('║   GET  /health                                   ║');
  console.log('║   POST /check-availability                       ║');
  console.log('║   POST /create-booking                           ║');
  console.log('║   POST /cancel-booking                           ║');
  console.log('║   POST /reschedule-booking                       ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log('');
});
