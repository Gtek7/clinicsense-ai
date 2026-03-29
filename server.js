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

// ─── Login Helper ─────────────────────────────────────────────────────────────

async function login(page) {
  console.log('[Login] Navigating to login page...');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });

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

  // Confirm we are no longer on the login page
  const currentUrl = page.url();
  console.log(`[Login] Current URL after login: ${currentUrl}`);

  if (currentUrl.includes('/login')) {
    throw new Error('Login failed — still on login page. Check credentials.');
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
  const { date } = req.body;

  if (!date) {
    return res.status(400).json({ success: false, error: 'Missing required field: date' });
  }

  console.log(`\n[Availability] Checking availability for date: ${date}`);
  let context, page;

  try {
    ({ page, context } = await newPage());

    // Step 1-7: Login
    await login(page);

    // Step 8: Navigate to calendar and wait for the SPA's own API call to complete.
    // ClinicSense is a Vue SPA — domcontentloaded fires before any content renders.
    // We watch for the internal calendar API response to know the page is truly ready.
    console.log('[Availability] Navigating to calendar, waiting for SPA to load...');
    const calendarApiDone = page.waitForResponse(
      r => r.url().includes('/api/2/calendar/') && r.url().includes('exact_date') && r.status() === 200,
      { timeout: TIMEOUT }
    ).catch(() => console.log('[Availability] Calendar API response not detected, falling back to timeout...'));

    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await calendarApiDone;
    await page.waitForTimeout(2000); // allow Vue to finish rendering from API data

    // Step 9 & 10: Call ClinicSense API directly using the authenticated session.
    // The UI ignores ?date= URL params — the real data comes from this internal API.
    console.log(`[Availability] Calling ClinicSense API for date: ${date}`);
    const rawData = await page.evaluate(async (targetDate) => {
      // ── A. Fetch date-specific calendar data ─────────────────────────────────
      const calResp = await fetch(
        `/api/2/calendar/?mode=day&exact_date=${targetDate}&format=json`,
        { credentials: 'include' }
      );
      const calData = await calResp.json();

      // ── B. Fetch full staff list for id → name mapping ───────────────────────
      let staffList = [];
      try {
        const staffResp = await fetch('/api/2/staff/?format=json', { credentials: 'include' });
        staffList = await staffResp.json();
      } catch (_) {}

      // ── C. Parse DOM header for working hours per practitioner ────────────────
      // ClinicSense shows "NAME\nHH:MM AM\n-\nHH:MM PM" or "NAME\nOff" in the top bar
      const bodyText = document.body.innerText;
      const headerSection = bodyText.split(/12AM\n12:15AM/)[0];
      const lines = headerSection.split('\n').map(l => l.trim()).filter(Boolean);
      const UI_SKIP = /^(CALENDAR|CLIENTS|SELL|COMMUNICATION|REPORTS|SETUP|WAIT LIST|Location|Practitioners|Office staff|Services|Treatment|Form|Scheduling|Payment|Reminders|Notification|Auto|Change|Perks|Logout|TODAY|Switch|Print|Hide|ZOOM|LINK|Schedule|VIP|★)/i;

      const domSchedule = []; // [{ name, working, start, end }]
      let i = 0;
      while (i < lines.length) {
        const line = lines[i];
        if (line.length < 2 || line.length > 90 || UI_SKIP.test(line) || /^\d/.test(line)) { i++; continue; }
        if (lines[i + 1] === 'Off') {
          domSchedule.push({ name: line, working: false, start: null, end: null });
          i += 2;
        } else if (
          lines[i + 1]?.match(/^\d{1,2}:\d{2}\s?(AM|PM)/i) &&
          lines[i + 2] === '-' &&
          lines[i + 3]?.match(/^\d{1,2}:\d{2}\s?(AM|PM)/i)
        ) {
          domSchedule.push({ name: line, working: true, start: lines[i + 1], end: lines[i + 3] });
          i += 4;
        } else { i++; }
      }

      return { calData, staffList, domSchedule };
    }, date);

    // ── Inspect raw API staff data to determine format ────────────────────────
    const rawStaff     = rawData.calData?.staff || {};
    const rawStaffList = rawData.staffList       || [];
    const isStaffArray = Array.isArray(rawStaff);
    const isStaffObj   = !isStaffArray && rawStaff && typeof rawStaff === 'object';
    console.log(`[Availability] calData.staff format: ${isStaffArray ? 'array' : isStaffObj ? 'object/dict' : typeof rawStaff}`);
    if (isStaffObj) {
      const firstKey   = Object.keys(rawStaff)[0];
      const firstEntry = rawStaff[firstKey];
      console.log(`[Availability] Sample staff entry [${firstKey}]:`, JSON.stringify(firstEntry)?.substring(0, 200));
    }

    // ── Build staff id → name map (handles all formats) ───────────────────────
    const staffIdToName = {};

    // Format A: calData.staff is a dict: { "64383": { id, name, ... } }
    if (isStaffObj) {
      for (const [sid, entry] of Object.entries(rawStaff)) {
        if (entry && typeof entry === 'object') {
          staffIdToName[sid] = entry.name || entry.full_name ||
            `${entry.first_name || ''} ${entry.last_name || ''}`.trim() || `Staff #${sid}`;
        } else if (typeof entry === 'string') {
          staffIdToName[sid] = entry;
        }
      }
    }
    // Format B: calData.staff is array of objects: [{ id, name }, ...]
    if (isStaffArray && rawStaff.length && typeof rawStaff[0] === 'object' && rawStaff[0]?.id) {
      rawStaff.forEach(s => {
        const id = s.id || s.staff_id;
        if (id) staffIdToName[id] = s.name || s.full_name ||
          `${s.first_name || ''} ${s.last_name || ''}`.trim() || `Staff #${id}`;
      });
    }
    // Format C: calData.staff is array of IDs → positional match to DOM columns
    const workingDomStaff = rawData.domSchedule.filter(s => s.working && s.start && s.end);
    if (Object.keys(staffIdToName).length === 0 &&
        isStaffArray && rawStaff.length && typeof rawStaff[0] === 'number') {
      console.log('[Availability] staff is ID array — using positional matching to DOM columns');
      rawStaff.forEach((sid, idx) => {
        const dom = workingDomStaff[idx];
        if (dom) staffIdToName[sid] = dom.name;
      });
    }

    console.log(`[Availability] Mapped ${Object.keys(staffIdToName).length} staff IDs → names:`, staffIdToName);

    // ── Group API appointments by staff_id ─────────────────────────────────────
    const apptsByStaffId = {};
    for (const appt of (rawData.calData?.appointments || [])) {
      const sid = appt.staff_id || appt.practitioner_id;
      if (!sid) continue;
      if (!apptsByStaffId[sid]) apptsByStaffId[sid] = [];
      const times = Object.values(appt.times || {})[0]?.[0];
      apptsByStaffId[sid].push({
        client:  appt.client_name || 'Unknown',
        service: appt.service_name || 'Unknown',
        start:   times?.start_time || appt.start_time,
        end:     times?.end_time   || appt.end_time,
      });
    }
    console.log(`[Availability] API returned ${rawData.calData?.appointments?.length || 0} appointments across ${Object.keys(apptsByStaffId).length} staff members`);

    // ── Time helpers ───────────────────────────────────────────────────────────
    // Convert "HH:MM:SS" or "H:MM AM/PM" → minutes since midnight
    const toMinutes = (timeStr) => {
      if (!timeStr) return null;
      timeStr = String(timeStr).trim();
      // 24-hour format: "14:30:00" or "14:30"
      const m24 = timeStr.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
      if (m24) return parseInt(m24[1]) * 60 + parseInt(m24[2]);
      // 12-hour format: "2:30 PM"
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

    // ── Build per-practitioner output ─────────────────────────────────────────
    console.log('[Availability] Computing per-practitioner available slots...');

    // Build practitioner list using working DOM staff (names + hours)
    // Match to API staff_id using the staffIdToName map (populated above)
    const seen = new Set();
    const practitionersOut = [];

    for (const domStaff of workingDomStaff) {
      // Find a matching staff_id: look for a staffIdToName entry whose value matches this DOM name
      const domNameUpper = domStaff.name.toUpperCase().replace(/[-\s]+/g, ' ');
      let matchedId = null;

      for (const [sid, apiName] of Object.entries(staffIdToName)) {
        const apiUpper = String(apiName).toUpperCase().replace(/[-\s]+/g, ' ');
        // Match if names share at least one significant word (>2 chars)
        const domWords = domNameUpper.split(' ').filter(w => w.length > 2);
        if (domWords.some(w => apiUpper.includes(w))) {
          matchedId = Number(sid);
          break;
        }
      }

      // Fallback: positional match using calData.staff index if name match fails
      if (!matchedId && Array.isArray(rawStaff) && typeof rawStaff[0] === 'number') {
        const idx = workingDomStaff.indexOf(domStaff);
        if (rawStaff[idx] !== undefined) matchedId = rawStaff[idx];
      }

      const staffId = matchedId;
      const name    = domStaff.name;
      seen.add(staffId);

      const bookings = staffId ? (apptsByStaffId[staffId] || []) : [];
      const startMin = toMinutes(domStaff.start);
      const endMin   = toMinutes(domStaff.end);

      const bookedRanges = bookings
        .map(b => ({ start: toMinutes(b.start), end: toMinutes(b.end) }))
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
        name,
        hours: `${domStaff.start} - ${domStaff.end}`,
        available_slots: freeSlots,
        booked_slots: bookings.map(b => ({
          client:  b.client,
          service: b.service,
          time:    `${fromMinutes(toMinutes(b.start))} - ${fromMinutes(toMinutes(b.end))}`,
        })),
      });
    }

    // Step 12: Take screenshot
    await screenshot(page, 'debug-availability.png');

    const totalWorking = practitionersOut.length;
    console.log(`[Availability] Working practitioners: ${totalWorking}`);
    practitionersOut.forEach(p => {
      console.log(`  ${p.name}: ${p.available_slots.length} free slots, ${p.booked_slots.length} bookings`);
    });

    // Step 13: Return clean structured result
    res.json({
      success: true,
      date,
      practitioners: practitionersOut,
      total_practitioners_working: totalWorking,
      message: `Found ${totalWorking} practitioner${totalWorking !== 1 ? 's' : ''} working on ${date}`,
    });
  } catch (err) {
    console.error('[Availability] ERROR:', err.message);
    if (page) await screenshot(page, 'debug-availability.png').catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  } finally {
    if (context) await context.close().catch(() => {});
  }
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
// minY = minimum y-coordinate (items BELOW the spinner row).
// nearX = if provided, only click items within ±80px of this x (keeps us in the open dropdown column).
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
    date,
    time,
    clientFirstName,
    clientLastName,
    clientEmail,
    clientPhone,
    service,
    duration,
    therapist,
  } = req.body;

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
    // The FAB is <span class="linearicon-plus">. Clicking it opens a welcome popup.
    // Inside the popup, "Schedule New Appointment" opens the booking form.
    console.log('[Booking] Opening new appointment form...');
    await page.waitForSelector('.linearicon-plus', { timeout: TIMEOUT });
    await page.click('.linearicon-plus');
    await page.waitForTimeout(2000);

    // Click "Schedule New Appointment" inside the popup (find by exact innerText)
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
    // ClinicSense uses an autocomplete search — type name, select from dropdown.
    // If not found, click "+ Add new client" and fill the new client form.
    console.log(`[Booking] Searching for client: ${clientFirstName} ${clientLastName}`);
    const fullName = `${clientFirstName} ${clientLastName}`;
    await page.fill('input[placeholder*="Search for a client by name"]', fullName);
    await page.waitForTimeout(2000);
    await screenshot(page, 'debug-booking-step2-client-search.png');

    // Try to click the exact matching client name in the dropdown
    let clientFound = false;
    try {
      await page.locator(`text=${fullName}`).first().click({ timeout: 5000 });
      clientFound = true;
      console.log('[Booking] Existing client selected.');
    } catch (_) {}

    if (!clientFound) {
      // Client not in system — click "+ Add new client"
      console.log('[Booking] Client not found — adding new client...');
      const addLink = await findVisibleByText(page, '+ Add new client');
      if (addLink) {
        await page.mouse.click(addLink.x, addLink.y);
        await page.waitForTimeout(2000);
        await screenshot(page, 'debug-booking-step3-new-client.png');

        // The new client form appears — fill first/last name, email, phone
        // ClinicSense new client form uses placeholder-based inputs
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

        // Save the new client (look for a "Save" / "Add" button in the client section)
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

    // ── Step 5: Select service (custom Vue dropdown) ──────────────────────────
    // The service dropdown shows a list of services, each with duration buttons
    // (60 MIN, 90 MIN, 120 MIN). Click the service name row, then the duration.
    if (service) {
      console.log(`[Booking] Selecting service: ${service} (${duration || '60'} min)`);

      // Find and click the "Select service" dropdown
      const svcDropdown = await findVisibleByText(page, 'Select service');
      if (svcDropdown) {
        await page.mouse.click(svcDropdown.x, svcDropdown.y);
        await page.waitForTimeout(1500);
        await screenshot(page, 'debug-booking-step5-service-open.png');

        // Find service by partial name match, then click its duration button
        const svcClicked = await page.evaluate(({ svcName, dur }) => {
          const allEls = [...document.querySelectorAll('*')];
          // Find the service name element (partial match, short text, no newlines)
          let serviceEl = null;
          for (const el of allEls) {
            const txt = (el.innerText || '').trim().toLowerCase();
            if (txt.includes(svcName.toLowerCase()) && !txt.includes('\n') && txt.length < 80 && el.children.length <= 2) {
              const r = el.getBoundingClientRect();
              if (r.width > 100 && r.height > 0) { serviceEl = { el, y: r.top }; break; }
            }
          }
          if (!serviceEl) return { error: `Service "${svcName}" not found` };

          // Find the duration button (e.g. "60 MIN") closest BELOW the service name
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
            // Fallback: just click first visible duration button below service
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
    // Custom dropdown — click to open, then find the practitioner name in the
    // list (which appears below the dropdown button). Filter by: no newlines in
    // the text (excludes calendar headers), text matches therapist name.
    if (therapist) {
      console.log(`[Booking] Selecting practitioner: ${therapist}`);

      const pracDropdown = await findVisibleByText(page, 'Select practitioner');
      if (pracDropdown) {
        await page.mouse.click(pracDropdown.x, pracDropdown.y);
        await page.waitForTimeout(1500);
        await screenshot(page, 'debug-booking-step6-prac-open.png');

        // Find practitioner in the dropdown list (below the dropdown, no newlines)
        const pracClicked = await page.evaluate(({ dropY, name }) => {
          for (const el of document.querySelectorAll('*')) {
            const txt = (el.innerText || '').trim();
            if (
              txt.toLowerCase().includes(name.toLowerCase()) &&
              !txt.includes('\n') &&
              txt.length < 80
            ) {
              const r = el.getBoundingClientRect();
              if (r.top > dropY && r.width > 50 && r.height > 0) {
                el.click();
                return { clicked: txt };
              }
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
    // The date field shows the current date as pre-filled text.
    // Clicking the INPUT element opens a calendar picker overlay.
    // Use page.mouse.click() to bypass BOX-flex-manager pointer intercepts.
    console.log(`[Booking] Setting date to: ${date}`);
    const targetDay = parseInt(date.split('-')[2], 10);

    // Get the date input's actual position
    const dateInputPos = await page.evaluate(() => {
      const input = document.querySelector('input[placeholder*="Select a date"]');
      const r = input?.getBoundingClientRect();
      return r ? { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), bottom: Math.round(r.bottom) } : null;
    });

    if (dateInputPos) {
      await page.mouse.click(dateInputPos.x, dateInputPos.y);
      await page.waitForTimeout(1200);
      await screenshot(page, 'debug-booking-step7-datepicker.png');

      // Click the target day in the calendar picker.
      // Strategy: find the calendar picker container first by locating the month/year
      // header text (e.g. "March 2026"), then search for the day number WITHIN it.
      // This avoids matching "29" from other page elements (appointments, time grid, etc.)
      for (let attempt = 0; attempt < 6; attempt++) {
        const dayClicked = await page.evaluate(({ day, inputBottom, inputRight }) => {
          // Step 1: find the month header element visible in the picker area
          // (something like "March 2026" positioned below the date input)
          let pickerRoot = null;
          for (const el of document.querySelectorAll('*')) {
            const txt = (el.innerText || '').trim();
            const r = el.getBoundingClientRect();
            if (/^[A-Za-z]+ \d{4}$/.test(txt) && r.top > inputBottom - 60 && r.top < inputBottom + 200) {
              // Walk up to find the calendar container (a reasonably-sized ancestor)
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

          // Step 2: search for the day number within the picker, or fallback to
          // small-cell elements below the date input
          const searchRoot = pickerRoot || document;
          const candidates = [...searchRoot.querySelectorAll('*')];
          for (const el of candidates) {
            const txt = (el.innerText || '').trim();
            if (txt !== String(day)) continue;
            const r = el.getBoundingClientRect();
            // The day cell should be small (25-60px), below the input, and near the picker x range
            if (
              r.top > inputBottom - 10 &&
              r.width >= 20 && r.width <= 70 &&
              r.height >= 18 && r.height <= 70 &&
              r.left >= 0 && r.left <= 1280
            ) {
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

        // Navigate to next month if day not visible
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
      // Press Escape to close the date picker overlay if still open,
      // then click a neutral spot so no dropdown remains open before step 8.
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    await screenshot(page, 'debug-booking-step7-after-date.png');

    // ── Step 8: Set start time ─────────────────────────────────────────────────
    // ClinicSense uses 3 custom spinner dropdowns: Hour / Minute / AM-PM.
    // Each spinner opens a dropdown when clicked via page.mouse.click().
    // Minute options are quarter-hour: 00, 15, 30, 45.
    console.log(`[Booking] Setting start time: ${time}`);
    const timeMatch = time.match(/(\d{1,2}):(\d{2})\s?(AM|PM)/i);
    if (timeMatch) {
      const tHour  = String(parseInt(timeMatch[1], 10)); // "02" → "2"
      const tAmpm  = timeMatch[3].toUpperCase();
      // Round minute to nearest quarter-hour option
      const rawMin   = parseInt(timeMatch[2], 10);
      const minOpts  = [0, 15, 30, 45];
      const rounded  = minOpts.reduce((a, b) => Math.abs(b - rawMin) < Math.abs(a - rawMin) ? b : a);
      const tMin     = String(rounded).padStart(2, '0');

      console.log(`[Booking] Parsed time → hour=${tHour}, min=${tMin}, ampm=${tAmpm}`);

      // Find the 3 start-time spinners within the [data-cs_field_name="start_time"] container.
      // Filter for BOX-flex-manager divs with width 60-85px, cluster by x separation > 50px.
      const spinnerCoords = await page.evaluate(() => {
        const container = document.querySelector('[data-cs_field_name="start_time"]');
        if (!container) return [];
        const cr = container.getBoundingClientRect();
        const candidates = [...container.querySelectorAll('.BOX-flex-manager')].filter(el => {
          const r = el.getBoundingClientRect();
          return r.width >= 60 && r.width <= 90 && r.height >= 25 && r.height <= 55 && r.top > cr.top + 5;
        });
        // Get all left-edge x values, sort ascending
        const xVals = candidates
          .map(el => Math.round(el.getBoundingClientRect().left))
          .sort((a, b) => a - b);
        // Cluster: only keep values that are >50px apart from the previous kept value
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

        // ── Hour ──────────────────────────────────────────────────────────────
        await page.mouse.click(hourSpinner.x, hourSpinner.y);
        await page.waitForTimeout(800);
        const hourOk = await selectDropdownValue(page, tHour, hourSpinner.y + 20, hourSpinner.x);
        console.log(`[Booking] Hour ${tHour} selected:`, hourOk);
        await page.waitForTimeout(500);

        // ── Minute ────────────────────────────────────────────────────────────
        await page.mouse.click(minSpinner.x, minSpinner.y);
        await page.waitForTimeout(800);
        const minOk = await selectDropdownValue(page, tMin, minSpinner.y + 20, minSpinner.x);
        console.log(`[Booking] Minute ${tMin} selected:`, minOk);
        await page.waitForTimeout(500);

        // ── AM/PM ─────────────────────────────────────────────────────────────
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
    // The SAVE & CLOSE button is at the bottom of the modal (y > 800).
    // Use mouse.click to bypass BOX-flex-manager pointer intercepts.
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
      // Fallback: try Playwright locator
      await page.locator('text=SAVE & CLOSE').last().click({ timeout: TIMEOUT });
    }

    await page.waitForTimeout(4000);
    await screenshot(page, 'debug-booking.png');

    // Verify success: the modal should have closed (check for it)
    const modalStillOpen = await page.$('input[placeholder*="Search for a client by name"]');
    if (modalStillOpen) {
      // Modal still open — check for error messages
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
      // If no error but modal open, maybe it saved successfully as a draft
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
// Cancels an appointment by navigating to the target date in the calendar,
// clicking the appointment block to open its edit form, then clicking
// "CANCEL APPOINTMENT" → "CONFIRM CANCELLATION".
//
// Required body: { date, time, clientName }
//   date       – "YYYY-MM-DD"
//   time       – "H:MM AM/PM"  (used to match the appointment when clientName is ambiguous)
//   clientName – partial or full client name (case-insensitive)

app.post('/cancel-booking', async (req, res) => {
  const { date, time, clientName } = req.body;

  if (!date || !time) {
    return res.status(400).json({ success: false, error: 'Missing required fields: date, time' });
  }

  console.log(`\n[Cancel] Cancelling booking on ${date} at ${time} for ${clientName || 'unknown client'}`);
  let context, page;

  try {
    ({ page, context } = await newPage());
    await login(page);

    // ── Step 1: Load today's calendar (wait for SPA + API) ─────────────────
    console.log('[Cancel] Loading calendar...');
    const calApiDone = page.waitForResponse(
      r => r.url().includes('/api/2/calendar/') && r.status() === 200,
      { timeout: TIMEOUT }
    ).catch(() => {});
    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await calApiDone;
    await page.waitForTimeout(2000);

    // ── Step 2: Navigate to target date ────────────────────────────────────
    // Calculate days difference between today and the target date.
    // Use the "previous/next day" chevron icons in the calendar header.
    const todayStr = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
    const [ty, tm, td] = todayStr.split('-').map(Number);
    const [gy, gm, gd] = date.split('-').map(Number);
    const todayMs  = Date.UTC(ty, tm - 1, td);
    const targetMs = Date.UTC(gy, gm - 1, gd);
    const daysDiff = Math.round((targetMs - todayMs) / 86400000);

    console.log(`[Cancel] Today: ${todayStr}, target: ${date}, diff: ${daysDiff} days`);

    if (daysDiff !== 0) {
      const arrowCls = daysDiff > 0
        ? '.linearicon-chevron-right-circle'   // forward in time
        : '.linearicon-chevron-left-circle';   // backward in time
      const steps = Math.abs(daysDiff);

      for (let i = 0; i < steps; i++) {
        const calNext = page.waitForResponse(
          r => r.url().includes('/api/2/calendar/') && r.status() === 200,
          { timeout: 15000 }
        ).catch(() => {});
        await page.evaluate((cls) => {
          const el = document.querySelector(cls);
          if (el) el.click();
        }, arrowCls);
        await calNext;
        await page.waitForTimeout(600);
      }
    }
    await page.waitForTimeout(1500);
    console.log(`[Cancel] Navigated to ${date}`);
    await screenshot(page, 'debug-cancel-step1-date.png');

    // ── Step 3: Use API to find the appointment ─────────────────────────────
    // Identify the appointment we need to cancel by client name + time.
    const apptInfo = await page.evaluate(async ({ targetDate, clientNameQ, timeStr }) => {
      const resp = await fetch(`/api/2/calendar/?mode=day&exact_date=${targetDate}&format=json`, { credentials: 'include' });
      const data  = await resp.json();
      const appts = data.appointments || [];

      // Convert "H:MM AM/PM" → "HH:MM:SS" for comparison
      const toH24 = (t) => {
        const m = t.match(/(\d{1,2}):(\d{2})\s?(AM|PM)/i);
        if (!m) return null;
        let h = parseInt(m[1]); const min = parseInt(m[2]); const ap = m[3].toUpperCase();
        if (ap === 'AM' && h === 12) h = 0;
        if (ap === 'PM' && h !== 12) h += 12;
        return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:00`;
      };
      const target24 = toH24(timeStr);

      // Match by client name (partial, case-insensitive) and start_time
      for (const a of appts) {
        const nameMatch = !clientNameQ || (a.client_name || '').toLowerCase().includes(clientNameQ.toLowerCase());
        const timeMatch = !target24  || (a.start_time || '').startsWith(target24.slice(0, 5));
        if (nameMatch && timeMatch) return { id: a.id, name: a.client_name, start: a.start_time };
      }
      // Fallback: match by name only
      for (const a of appts) {
        if (!clientNameQ) return { id: a.id, name: a.client_name, start: a.start_time };
        if ((a.client_name || '').toLowerCase().includes(clientNameQ.toLowerCase()))
          return { id: a.id, name: a.client_name, start: a.start_time };
      }
      return null;
    }, { targetDate: date, clientNameQ: clientName || '', timeStr: time });

    if (!apptInfo) {
      throw new Error(`No appointment found on ${date} for "${clientName}" at ${time}`);
    }
    console.log(`[Cancel] Found appointment #${apptInfo.id} for ${apptInfo.name} at ${apptInfo.start}`);

    // ── Step 4: Click the appointment block in the calendar ─────────────────
    // .calendar-event elements contain the appointment card. We match by client name.
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

    if (!clickedAppt) {
      throw new Error(`Could not click appointment for "${apptInfo.name}" in the calendar view`);
    }

    await page.waitForTimeout(2500);
    await screenshot(page, 'debug-cancel-step2-form.png');
    console.log('[Cancel] Appointment edit form opened');

    // ── Step 5: Click "CANCEL APPOINTMENT" button ───────────────────────────
    const cancelBtnClicked = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if ((el.innerText || '').trim() === 'CANCEL APPOINTMENT') {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { el.click(); return true; }
        }
      }
      return false;
    });

    if (!cancelBtnClicked) {
      throw new Error('"CANCEL APPOINTMENT" button not found in the edit form');
    }

    await page.waitForTimeout(1500);
    await screenshot(page, 'debug-cancel-step3-dialog.png');
    console.log('[Cancel] Cancellation dialog opened');

    // ── Step 6: Click "CONFIRM CANCELLATION" ───────────────────────────────
    const confirmClicked = await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) {
        if ((el.innerText || '').trim() === 'CONFIRM CANCELLATION') {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) { el.click(); return true; }
        }
      }
      return false;
    });

    if (!confirmClicked) {
      throw new Error('"CONFIRM CANCELLATION" button not found in the dialog');
    }

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
// Opens the existing appointment's edit form and changes the date + time,
// then saves. Reuses the same date-picker and time-spinner logic as create-booking.
//
// Required body: { oldDate, oldTime, newDate, newTime, clientName }
//   oldDate/oldTime – identify the appointment to move
//   newDate/newTime – new date/time ("YYYY-MM-DD" / "H:MM AM/PM")
//   clientName      – partial client name for matching

app.post('/reschedule-booking', async (req, res) => {
  const { oldDate, oldTime, newDate, newTime, clientName } = req.body;

  if (!oldDate || !oldTime || !newDate || !newTime) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: oldDate, oldTime, newDate, newTime',
    });
  }

  console.log(`\n[Reschedule] Moving ${clientName || 'appointment'} from ${oldDate} ${oldTime} → ${newDate} ${newTime}`);
  let context, page;

  try {
    ({ page, context } = await newPage());
    await login(page);

    // ── Step 1: Load calendar and navigate to oldDate ──────────────────────
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

    // ── Step 2: Find appointment via API ────────────────────────────────────
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

    // ── Step 3: Click the appointment in calendar to open edit form ─────────
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

    // ── Step 4: Change the date ─────────────────────────────────────────────
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

      // Navigate calendar months if needed then click target day
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

        if (dayClicked) {
          console.log(`[Reschedule] Day ${targetDay} clicked at:`, JSON.stringify(dayClicked));
          break;
        }
        // Navigate to next month
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
      // Close picker cleanly
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    await screenshot(page, 'debug-reschedule-step2-date.png');
    console.log('[Reschedule] Date updated');

    // ── Step 5: Change the time ─────────────────────────────────────────────
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

    // ── Step 6: Save & Close ────────────────────────────────────────────────
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

    // Verify: form should be gone and no validation error
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
