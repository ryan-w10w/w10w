// /api/payroll-scheduled?start=YYYY-MM-DD&end=YYYY-MM-DD
// TOAST version. Fetches PUBLISHED scheduled shifts from Toast Scheduling.
// Returns the SAME JSON shape the Square version returned, so payroll.html
// needs no logic change:
//   { employees: { "Name": { hours, shift_count, by_date: { date: hours } } },
//     scheduled_shifts, raw_shifts_received, skipped, warning }
//
// The Square version needed a per-team-member fan-out (~25 parallel calls)
// because Square's location-level scheduled-shifts endpoint silently capped
// at ~107 shifts. Toast's location-level endpoint works, so this is ONE
// paginated call plus the employee lookup.
//
// Source: Toast Labor API
//   GET /labor/v1/shifts?startDate&endDate   (SCHEDULED shifts; timeEntries are actuals)
//   GET /labor/v1/employees                  (guid -> name)
//
// Env vars required:
//   TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, TOAST_RESTAURANT_GUID, [TOAST_HOSTNAME]

const TOAST_HOST = process.env.TOAST_HOSTNAME || 'https://ws-api.toasttab.com';
const RID = process.env.TOAST_RESTAURANT_GUID;

// ---- Toast auth (cached in the warm container; tokens last ~24h) ----
let _tok = { value: null, exp: 0 };
async function toastToken() {
  if (_tok.value && Date.now() < _tok.exp - 60000) return _tok.value;
  const r = await fetch(`${TOAST_HOST}/authentication/v1/authentication/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: process.env.TOAST_CLIENT_ID,
      clientSecret: process.env.TOAST_CLIENT_SECRET,
      userAccessType: 'TOAST_MACHINE_CLIENT'
    })
  });
  if (!r.ok) throw new Error(`Toast auth ${r.status}: ${await r.text()}`);
  const t = (await r.json()).token || {};
  _tok = { value: t.accessToken, exp: Date.now() + (t.expiresIn ? t.expiresIn * 1000 : 3600000) };
  return _tok.value;
}
function toastHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Toast-Restaurant-External-ID': RID,
    'Content-Type': 'application/json'
  };
}

// DST-aware America/New_York helpers (same as payroll-labor.js)
function nyToUTCISO(dateStr, h, m, s) {
  const pad = n => String(n).padStart(2, '0');
  const timeStr = `${pad(h)}:${pad(m)}:${pad(s)}`;
  for (const off of ['-04:00', '-05:00']) {
    const cand = new Date(`${dateStr}T${timeStr}${off}`);
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(cand);
    if (fmt === dateStr) return cand.toISOString();
  }
  return new Date(`${dateStr}T${timeStr}-04:00`).toISOString();
}
function localDateOf(iso) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(iso));
}

// Generic paginated GET following Toast-Next-Page-Token (same as payroll-labor.js).
async function fetchAllPages(baseUrl, token) {
  const out = [];
  let pageToken;
  let guard = 0;
  do {
    const u = new URL(baseUrl);
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await fetch(u.toString(), { headers: toastHeaders(token) });
    if (!r.ok) throw new Error(`${u.pathname} ${r.status}: ${await r.text()}`);
    const batch = await r.json();
    if (Array.isArray(batch)) out.push(...batch);
    pageToken = r.headers.get('toast-next-page-token') || null;
    guard += 1;
  } while (pageToken && guard < 50);
  return out;
}

async function fetchEmployees(token) {
  const arr = await fetchAllPages(`${TOAST_HOST}/labor/v1/employees`, token);
  const map = {};
  arr.forEach(e => {
    const first = (e.chosenName && e.chosenName.trim()) || (e.firstName && e.firstName.trim()) || '';
    const last = (e.lastName && e.lastName.trim()) || '';
    map[e.guid] = [first, last].filter(Boolean).join(' ') || 'Unknown';
  });
  return map;
}

async function fetchScheduledShifts(token, startISO, endISO) {
  const base = `${TOAST_HOST}/labor/v1/shifts?startDate=${encodeURIComponent(startISO)}&endDate=${encodeURIComponent(endISO)}`;
  return fetchAllPages(base, token);
}

const { requireKey } = require('./_auth');

exports.handler = async (event) => {
  const denied = requireKey(event);
  if (denied) return denied;
  try {
    const { start, end, debug } = event.queryStringParameters || {};
    if (!start || !end) {
      return { statusCode: 400, body: JSON.stringify({ error: 'start and end (YYYY-MM-DD) required' }) };
    }
    if (!RID) {
      return { statusCode: 500, body: JSON.stringify({ error: 'TOAST_RESTAURANT_GUID not set' }) };
    }

    const startISO = nyToUTCISO(start, 0, 0, 0);
    const endISO = nyToUTCISO(end, 23, 59, 59);

    const token = await toastToken();
    const [employees, shifts] = await Promise.all([
      fetchEmployees(token),
      fetchScheduledShifts(token, startISO, endISO)
    ]);

    const byEmployee = {};
    let countedShifts = 0;
    let skippedDeleted = 0;
    let skippedUnassigned = 0;
    let skippedUnknownMember = 0;
    let skippedBogusDuration = 0;
    let skippedOutOfRange = 0;
    let skippedDuplicate = 0;
    let skippedNoDetails = 0;
    const noDetailsSamples = [];
    const inRangeSamples = [];

    const winStart = new Date(startISO).getTime();
    const winEnd = new Date(endISO).getTime();
    const seenIds = new Set();

    shifts.forEach(s => {
      if (s.guid && seenIds.has(s.guid)) { skippedDuplicate += 1; return; }
      if (s.guid) seenIds.add(s.guid);

      // Toast marks removed shifts rather than omitting them.
      if (s.deleted) { skippedDeleted += 1; return; }

      if (!s.inDate || !s.outDate) {
        skippedNoDetails += 1;
        if (debug && noDetailsSamples.length < 3) noDetailsSamples.push(s);
        return;
      }

      // Defensive re-filter: keep only shifts whose scheduled start falls
      // in the requested window (the Square version needed this because its
      // API filter was unreliable; kept here as a cheap invariant).
      const shiftStartMs = new Date(s.inDate).getTime();
      if (shiftStartMs < winStart || shiftStartMs > winEnd) {
        skippedOutOfRange += 1;
        return;
      }

      if (debug && inRangeSamples.length < 2) inRangeSamples.push(s);

      // Unassigned slots (published template shifts with nobody in them).
      const memberId = s.employeeReference && s.employeeReference.guid;
      if (!memberId) { skippedUnassigned += 1; return; }

      const name = employees[memberId];
      if (!name) { skippedUnknownMember += 1; return; }

      // Sanity-check duration: skip multi-day or negative spans.
      const grossHrs = (new Date(s.outDate) - new Date(s.inDate)) / 3600000;
      if (grossHrs > 24 || grossHrs < 0) {
        skippedBogusDuration += 1;
        console.warn(`Skipping bogus scheduled shift: ${grossHrs}h for ${name} (${s.inDate} to ${s.outDate})`);
        return;
      }

      // Toast scheduled shifts do not carry unpaid-break details the way
      // Square's published_shift_details.breaks did; scheduled hours are
      // the gross span. Actual paid hours (net of breaks) come from
      // payroll-labor's timeEntries, which is what pay is based on; this
      // endpoint only feeds the scheduled-vs-actual variance check.
      const netHrs = grossHrs;
      const localDate = localDateOf(s.inDate);

      if (!byEmployee[name]) byEmployee[name] = { hours: 0, shift_count: 0, by_date: {} };
      byEmployee[name].hours += netHrs;
      byEmployee[name].shift_count += 1;
      byEmployee[name].by_date[localDate] = (byEmployee[name].by_date[localDate] || 0) + netHrs;
      countedShifts += 1;
    });

    const result = {
      employees: byEmployee,
      scheduled_shifts: countedShifts,
      raw_shifts_received: shifts.length,
      skipped: {
        unassigned: skippedUnassigned,
        unknown_member: skippedUnknownMember,
        bogus_duration: skippedBogusDuration,
        out_of_range: skippedOutOfRange,
        duplicate: skippedDuplicate,
        no_details: skippedNoDetails,
        deleted: skippedDeleted
      },
      warning: null
    };

    if (debug) {
      const dateCounts = {};
      shifts.forEach(s => {
        if (s.inDate) {
          const d = localDateOf(s.inDate);
          dateCounts[d] = (dateCounts[d] || 0) + 1;
        }
      });
      const sortedDateCounts = Object.fromEntries(
        Object.entries(dateCounts).sort(([a], [b]) => a.localeCompare(b))
      );
      result.debug = {
        window_utc: { start: startISO, end: endISO },
        strategy: 'toast-location-level',
        employees_on_file: Object.keys(employees).length,
        date_distribution: sortedDateCounts,
        no_details_samples: noDetailsSamples,
        in_range_samples: inRangeSamples
      };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(result)
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
