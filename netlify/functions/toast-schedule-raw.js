// /api/toast-schedule-raw?start=YYYY-MM-DD&end=YYYY-MM-DD
// TOAST shim for index.html's schedule reads (tonight's roster + the week view).
// Replaces the old client-side Square scheduled-shifts/team-members/team-jobs calls;
// employees and jobs are resolved server-side. Returns:
//   { scheduled_shifts: [{ id, team_member_id, name, job_title, start_at, end_at }] }
//
// Source: Toast Labor API (same endpoints payroll-scheduled.js verified):
//   GET /labor/v1/shifts?startDate&endDate   (SCHEDULED shifts; location-level works)
//   GET /labor/v1/employees                  (guid -> name)
//   GET /labor/v1/jobs                       (guid -> title)
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

// Accept either YYYY-MM-DD (what index.html sends) or a full ISO datetime.
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

exports.handler = async (event) => {
  try {
    const { start, end } = event.queryStringParameters || {};
    if (!start || !end) {
      return { statusCode: 400, body: JSON.stringify({ error: 'start and end required (YYYY-MM-DD or ISO)' }) };
    }
    if (!RID) {
      return { statusCode: 500, body: JSON.stringify({ error: 'TOAST_RESTAURANT_GUID not set' }) };
    }

    const startISO = toISO(start, false);
    const endISO = toISO(end, true);

    const token = await toastToken();
    const [employees, jobs, shifts] = await Promise.all([
      fetchEmployees(token),
      fetchJobs(token),
      fetchAllPages(
        `${TOAST_HOST}/labor/v1/shifts?startDate=${encodeURIComponent(startISO)}&endDate=${encodeURIComponent(endISO)}`,
        token
      )
    ]);

    // Defensive re-filter to the requested window + dedupe, matching the invariants
    // payroll-scheduled.js established against production data.
    const winStart = new Date(startISO).getTime();
    const winEnd = new Date(endISO).getTime();
    const seen = new Set();

    const out = [];
    shifts.forEach(s => {
      if (s.guid && seen.has(s.guid)) return;
      if (s.guid) seen.add(s.guid);
      if (s.deleted) return;                       // removed shifts are flagged, not omitted
      if (!s.inDate || !s.outDate) return;
      const startMs = new Date(s.inDate).getTime();
      if (startMs < winStart || startMs > winEnd) return;
      const grossHrs = (new Date(s.outDate) - new Date(s.inDate)) / 3600000;
      if (grossHrs > 24 || grossHrs < 0) return;   // multi-day/negative spans are data errors

      const memberId = (s.employeeReference && s.employeeReference.guid) || null;
      const jobTitle = (s.jobReference && jobs[s.jobReference.guid]) || 'Staff';
      out.push({
        id: s.guid,
        team_member_id: memberId,
        // Unassigned published slots exist; surface them under the job title.
        name: (memberId && employees[memberId]) || jobTitle,
        job_title: jobTitle,
        start_at: s.inDate,
        end_at: s.outDate
      });
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ scheduled_shifts: out })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
