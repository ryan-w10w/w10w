// /api/payroll-labor?start=YYYY-MM-DD&end=YYYY-MM-DD
// TOAST version. Returns the SAME JSON shape the previous Square version returned, so
// payroll.html needs no logic change:
//   { shifts: [{ shift_id, team_member_id, name, job_title, role, tip_multiplier,
//                start_at, end_at, local_date, hours, declared_cash_tips_cents, open }],
//     count }
//
// Source: Toast Labor API
//   GET /labor/v1/timeEntries?startDate&endDate   (actual clock-in/out, paid hours)
//   GET /labor/v1/employees                       (guid -> name)
//   GET /labor/v1/jobs                            (guid -> title)
//
// Env vars required:
//   TOAST_CLIENT_ID, TOAST_CLIENT_SECRET   (Standard API access credentials)
//   TOAST_RESTAURANT_GUID                  (location GUID, sent as Toast-Restaurant-External-ID)
//   TOAST_HOSTNAME                         (optional, defaults to production)

const TOAST_HOST = process.env.TOAST_HOSTNAME || 'https://ws-api.toasttab.com';
const RID = process.env.TOAST_RESTAURANT_GUID;

// Job title -> internal role bucket. Keys MUST match the job titles as named in Toast.
// Edit here as Toast jobs evolve. Anything unmatched is treated as non_tipped (BOH/ops).
const ROLE_MAP = {
  'Server': 'server',
  'Bartender': 'bartender',
  'Floor Lead': 'floor_lead',
  'Host': 'host',
  'Training': 'training',
  'Line Cook': 'non_tipped',
  'Lead Line Cook': 'non_tipped',
  'Porter': 'non_tipped',
  'Manager': 'non_tipped',
  'Managing Partner': 'non_tipped',
  'Owner': 'non_tipped'
};

const TIP_MULTIPLIER = {
  server: 1.0,
  bartender: 1.0,
  floor_lead: 1.0,
  host: 0.7,
  training: 0,
  non_tipped: 0
};

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

// DST-aware America/New_York helpers
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

// Generic paginated GET that follows Toast-Next-Page-Token. Toast labor list endpoints
// return a bare JSON array and a Toast-Next-Page-Token response header when more pages exist.
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
    const name = (e.chosenName && e.chosenName.trim())
      || [e.firstName, e.lastName].filter(Boolean).join(' ').trim()
      || 'Unknown';
    map[e.guid] = name;
  });
  return map;
}

async function fetchJobs(token) {
  const arr = await fetchAllPages(`${TOAST_HOST}/labor/v1/jobs`, token);
  const map = {};
  arr.forEach(j => { map[j.guid] = j.title; });
  return map;
}

async function fetchTimeEntries(token, startISO, endISO) {
  const base = `${TOAST_HOST}/labor/v1/timeEntries?startDate=${encodeURIComponent(startISO)}&endDate=${encodeURIComponent(endISO)}`;
  return fetchAllPages(base, token);
}

// PT#H#M#S -> hours, used only for the unpaid-break fallback path
function isoDur(iso) {
  if (!iso) return 0;
  const m = String(iso).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (+(m[1] || 0)) + (+(m[2] || 0)) / 60 + (+(m[3] || 0)) / 3600;
}

exports.handler = async (event) => {
  try {
    const { start, end } = event.queryStringParameters || {};
    if (!start || !end) {
      return { statusCode: 400, body: JSON.stringify({ error: 'start and end (YYYY-MM-DD) required' }) };
    }
    if (!RID) {
      return { statusCode: 500, body: JSON.stringify({ error: 'TOAST_RESTAURANT_GUID not set' }) };
    }

    const token = await toastToken();
    const startISO = nyToUTCISO(start, 0, 0, 0);
    const endISO = nyToUTCISO(end, 23, 59, 59);

    const [employees, jobs, entries] = await Promise.all([
      fetchEmployees(token),
      fetchJobs(token),
      fetchTimeEntries(token, startISO, endISO)
    ]);

    const enriched = entries
      .filter(te => !te.deleted)
      .map(te => {
        const memberId = te.employeeReference?.guid || null;
        const jobTitle = jobs[te.jobReference?.guid] || 'Unknown';
        const role = ROLE_MAP[jobTitle] || 'non_tipped';
        const open = !te.outDate;

        // Worked hours: Toast's regularHours + overtimeHours is the authoritative paid total
        // (already net of unpaid breaks). Fall back to gross clock time minus unpaid breaks
        // only if Toast reports zero (rare). Open shifts have no hours yet, matching the old behavior.
        let hours = null;
        if (!open) {
          const paid = (te.regularHours || 0) + (te.overtimeHours || 0);
          if (paid > 0) {
            hours = paid;
          } else {
            let gross = (new Date(te.outDate) - new Date(te.inDate)) / 3600000;
            (te.breaks || []).forEach(b => { if (b.paid === false) gross -= isoDur(b.expectedDuration); });
            hours = Math.max(0, gross);
          }
          hours = Math.round(hours * 100) / 100;
        }

        return {
          shift_id: te.guid,
          team_member_id: memberId,
          name: employees[memberId] || 'Unknown',
          job_title: jobTitle,
          role,
          tip_multiplier: TIP_MULTIPLIER[role] ?? 0,
          start_at: te.inDate || null,
          end_at: te.outDate || null,
          local_date: te.inDate ? localDateOf(te.inDate) : null,
          hours,
          declared_cash_tips_cents: Math.round((te.declaredCashTips || 0) * 100),
          open
        };
      });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ shifts: enriched, count: enriched.length })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
