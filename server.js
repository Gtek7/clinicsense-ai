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

    // Login
    await login(page);

    // Go to calendar on the given date
    console.log('[Booking] Navigating to calendar...');
    const calendarUrl = `${CALENDAR_URL}?date=${date}`;
    await page.goto(calendarUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(3000);

    // Click the time slot
    console.log(`[Booking] Looking for time slot: ${time}`);
    // Try to find and click the slot by time text or data attribute
    const slotClicked = await page.evaluate((targetTime) => {
      // Normalize time formats (e.g. "14:00" or "2:00 PM")
      const selectors = [
        `[data-time="${targetTime}"]`,
        `[data-start="${targetTime}"]`,
        `.time-slot[title*="${targetTime}"]`,
        `.fc-timegrid-slot[data-time]`,
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) { el.click(); return true; }
      }
      return false;
    }, time);

    if (!slotClicked) {
      // Fallback: look for a cell containing that time and click it
      console.log('[Booking] Direct slot click failed, trying text-based click...');
      await page.click(`text="${time}"`, { timeout: 5000 }).catch(() => {
        console.log('[Booking] Text click also failed, trying coordinate-based approach...');
      });
    }

    await page.waitForTimeout(2000);

    // Fill in client details — forms vary per platform; handle common patterns
    console.log('[Booking] Filling in client details...');

    const fillField = async (selectors, value) => {
      for (const sel of selectors) {
        try {
          await page.waitForSelector(sel, { timeout: 3000 });
          await page.fill(sel, value);
          console.log(`[Booking] Filled "${sel}" with "${value}"`);
          return;
        } catch (_) {}
      }
      console.log(`[Booking] Could not find a field for value: "${value}"`);
    };

    await fillField(
      ['input[name*="first"], input[placeholder*="First"], input[id*="first"]'],
      clientFirstName
    );
    await fillField(
      ['input[name*="last"], input[placeholder*="Last"], input[id*="last"]'],
      clientLastName
    );
    if (clientEmail) {
      await fillField(
        ['input[type="email"], input[name*="email"], input[placeholder*="Email"]'],
        clientEmail
      );
    }
    if (clientPhone) {
      await fillField(
        ['input[type="tel"], input[name*="phone"], input[placeholder*="Phone"]'],
        clientPhone
      );
    }

    // Select service if field exists
    if (service) {
      console.log(`[Booking] Selecting service: ${service}`);
      await page.selectOption('select[name*="service"], select[id*="service"]', { label: service }).catch(() => {
        console.log('[Booking] Service dropdown not found by standard selector, skipping...');
      });
    }

    // Select therapist if field exists
    if (therapist) {
      console.log(`[Booking] Selecting therapist: ${therapist}`);
      await page.selectOption('select[name*="therapist"], select[id*="therapist"], select[name*="practitioner"]', { label: therapist }).catch(() => {
        console.log('[Booking] Therapist dropdown not found, skipping...');
      });
    }

    // Select duration if field exists
    if (duration) {
      console.log(`[Booking] Selecting duration: ${duration}`);
      await page.selectOption('select[name*="duration"], select[id*="duration"]', { label: duration }).catch(async () => {
        await page.selectOption('select[name*="duration"], select[id*="duration"]', { value: duration }).catch(() => {
          console.log('[Booking] Duration dropdown not found, skipping...');
        });
      });
    }

    // Save the appointment
    console.log('[Booking] Saving appointment...');
    await page.click(
      'button[type="submit"], button:has-text("Save"), button:has-text("Book"), button:has-text("Create"), button:has-text("Confirm")',
      { timeout: TIMEOUT }
    );

    await page.waitForTimeout(3000);

    // Take screenshot
    await screenshot(page, 'debug-booking.png');

    console.log('[Booking] Booking complete!');

    res.json({
      success: true,
      message: 'Appointment booked successfully',
      details: {
        date,
        time,
        client: `${clientFirstName} ${clientLastName}`,
      },
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
  const { date, time, clientName } = req.body;

  if (!date || !time) {
    return res.status(400).json({ success: false, error: 'Missing required fields: date, time' });
  }

  console.log(`\n[Cancel] Cancelling booking on ${date} at ${time} for ${clientName || 'unknown client'}`);
  let context, page;

  try {
    ({ page, context } = await newPage());

    // Login
    await login(page);

    // Go to calendar on the given date
    console.log('[Cancel] Navigating to calendar...');
    const calendarUrl = `${CALENDAR_URL}?date=${date}`;
    await page.goto(calendarUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(3000);

    // Find and click the appointment
    console.log(`[Cancel] Looking for appointment at ${time}${clientName ? ` for ${clientName}` : ''}...`);
    let appointmentClicked = false;

    // Try to click by client name first
    if (clientName) {
      appointmentClicked = await page.click(`text="${clientName}"`, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    }

    // Fallback: click by time
    if (!appointmentClicked) {
      appointmentClicked = await page.click(`[data-time="${time}"] .appointment, [data-start="${time}"]`, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    }

    if (!appointmentClicked) {
      console.log('[Cancel] Could not find appointment by name or time, checking page content...');
    }

    await page.waitForTimeout(2000);

    // Find and click the Cancel button in the popup/modal
    console.log('[Cancel] Looking for Cancel button...');
    await page.click(
      'button:has-text("Cancel"), button:has-text("Cancel Appointment"), a:has-text("Cancel"), [class*="cancel"]',
      { timeout: TIMEOUT }
    );

    await page.waitForTimeout(1000);

    // Confirm cancellation if a confirmation dialog appears
    console.log('[Cancel] Looking for confirmation dialog...');
    await page.click(
      'button:has-text("Yes"), button:has-text("Confirm"), button:has-text("OK"), button:has-text("Yes, Cancel")',
      { timeout: 5000 }
    ).catch(() => {
      console.log('[Cancel] No confirmation dialog found, continuing...');
    });

    await page.waitForTimeout(2000);

    // Take screenshot
    await screenshot(page, 'debug-cancel.png');

    console.log('[Cancel] Cancellation complete!');

    res.json({ success: true, message: 'Appointment cancelled' });
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
  const { oldDate, oldTime, newDate, newTime, clientName } = req.body;

  if (!oldDate || !oldTime || !newDate || !newTime) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: oldDate, oldTime, newDate, newTime',
    });
  }

  console.log(`\n[Reschedule] Moving appointment from ${oldDate} ${oldTime} to ${newDate} ${newTime}`);
  let context, page;

  try {
    ({ page, context } = await newPage());

    // Login
    await login(page);

    // Go to calendar on the old date
    console.log('[Reschedule] Navigating to original appointment date...');
    const calendarUrl = `${CALENDAR_URL}?date=${oldDate}`;
    await page.goto(calendarUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await page.waitForTimeout(3000);

    // Find and click the existing appointment
    console.log(`[Reschedule] Looking for appointment at ${oldTime}${clientName ? ` for ${clientName}` : ''}...`);
    let appointmentClicked = false;

    if (clientName) {
      appointmentClicked = await page.click(`text="${clientName}"`, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    }

    if (!appointmentClicked) {
      appointmentClicked = await page.click(`[data-time="${oldTime}"] .appointment, [data-start="${oldTime}"]`, { timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    }

    await page.waitForTimeout(2000);

    // Look for a Reschedule or Edit button
    console.log('[Reschedule] Looking for Reschedule/Edit button...');
    await page.click(
      'button:has-text("Reschedule"), button:has-text("Edit"), button:has-text("Move"), a:has-text("Reschedule"), a:has-text("Edit")',
      { timeout: TIMEOUT }
    );

    await page.waitForTimeout(2000);

    // Update the date field
    console.log(`[Reschedule] Setting new date: ${newDate}`);
    await page.fill(
      'input[type="date"], input[name*="date"], input[placeholder*="date"], input[id*="date"]',
      newDate
    ).catch(() => {
      console.log('[Reschedule] Could not fill date field directly...');
    });

    // Update the time field
    console.log(`[Reschedule] Setting new time: ${newTime}`);
    await page.fill(
      'input[type="time"], input[name*="time"], input[placeholder*="time"], input[id*="time"]',
      newTime
    ).catch(async () => {
      // Try selecting from a dropdown
      await page.selectOption(
        'select[name*="time"], select[id*="time"]',
        { label: newTime }
      ).catch(() => {
        console.log('[Reschedule] Could not set time — manual review may be needed.');
      });
    });

    await page.waitForTimeout(1000);

    // Save changes
    console.log('[Reschedule] Saving rescheduled appointment...');
    await page.click(
      'button[type="submit"], button:has-text("Save"), button:has-text("Update"), button:has-text("Confirm")',
      { timeout: TIMEOUT }
    );

    await page.waitForTimeout(3000);

    // Take screenshot
    await screenshot(page, 'debug-reschedule.png');

    console.log('[Reschedule] Rescheduling complete!');

    res.json({ success: true, message: 'Appointment rescheduled' });
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
