// /api/toast-labor-cost?start=ISO&end=ISO
// TOAST shim for index.html's labor-cost reads (Financial Health MTD labor and the
// yesterday labor-to-sales recap). Replaces the old client-side Square
// /v2/labor/shifts/search calls. Returns:
//   { shifts: [{ shift_id, team_member_id, name, job_title,
//                hourly_rate_cents, hours, start_at, end_at, open }] }
// hours = Toast regularHours + overtimeHours (authoritative PAID hours, already net
// of unpaid breaks — same source payroll-labor.js verified to the penny).
// hourly_rate_cents = hourlyWage (dollars) * 100.
// The caller computes total labor $ as sum(hours * rate) and runs its shift-anomaly
// checks off name/job_title/start_at/end_at.
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

// Retry on Toast's 5 req/s rate limit instead of failing the panel.
const sleep = ms => new Promise(res => setTimeout(res, ms));
async function toastFetch(url, headers) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers });
    if (r.status === 429 && attempt < 4) { await sleep(1200 * (attempt + 1)); continue; }
    return r;
  }
}

// DST-aware America/New_York helper (same as payroll-labor.js)
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

// Accept either a full ISO datetime (what index.html sends) or YYYY-MM-DD.
function toISO(v, endOfDay) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return endOfDay ? nyToUTCISO(v, 23, 59, 59) : nyToUTCISO(v, 0, 0, 0);
  }
  const d = new Date(v);
  if (isNaN(d)) throw new Error(`bad date: ${v}`);
  return d.toISOString();
}

// Generic paginated GET following Toast-Next-Page-Token (same as payroll-labor.js).
async function fetchAllPages(baseUrl, token) {
  const out = [];
  let pageToken;
  let guard = 0;
  do {
    const u = new URL(baseUrl);
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const r = await toastFetch(u.toString(), toastHeaders(token));
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

async function fetchJobs(token) {
  const arr = await fetchAllPages(`${TOAST_HOST}/labor/v1/jobs`, token);
  const map = {};
  arr.forEach(j => { map[j.guid] = j.title; });
  return map;
}

const { requireKey } = require('./_auth');

exports.handler = async (event) => {
  const denied = requireKey(event);
  if (denied) return denied;
  try {
    const { start, end } = event.queryStringParameters || {};
    if (!start || !end) {
      return { statusCode: 400, body: JSON.stringify({ error: 'start and end required (ISO or YYYY-MM-DD)' }) };
    }
    if (!RID) {
      return { statusCode: 500, body: JSON.stringify({ error: 'TOAST_RESTAURANT_GUID not set' }) };
    }

    const startISO = toISO(start, false);
    const endISO = toISO(end, true);

    const token = await toastToken();
    const [employees, jobs, entries] = await Promise.all([
      fetchEmployees(token),
      fetchJobs(token),
      fetchAllPages(
        `${TOAST_HOST}/labor/v1/timeEntries?startDate=${encodeURIComponent(startISO)}&endDate=${encodeURIComponent(endISO)}`,
        token
      )
    ]);

    const shifts = entries
      .filter(te => !te.deleted)
      .map(te => {
        const memberId = (te.employeeReference && te.employeeReference.guid) || null;
        const open = !te.outDate;
        // Paid hours: regular + overtime (net of unpaid breaks). Open shifts report 0.
        const hours = open
          ? 0
          : Math.round(((te.regularHours || 0) + (te.overtimeHours || 0)) * 100) / 100;
        return {
          shift_id: te.guid,
          team_member_id: memberId,
          name: (memberId && employees[memberId]) || 'Unknown',
          job_title: (te.jobReference && jobs[te.jobReference.guid]) || 'Staff',
          hourly_rate_cents: Math.round((te.hourlyWage || 0) * 100),
          hours,
          start_at: te.inDate || null,
          end_at: te.outDate || null,
          open
        };
      });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ shifts })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
