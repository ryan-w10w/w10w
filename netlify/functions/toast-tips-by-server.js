// /api/toast-tips-by-server?start=ISO&end=ISO
// TOAST shim for index.html's tip-pool intelligence panel. Replaces the old
// client-side Square /v2/payments call (which needed a browser-held Square token —
// now deleted; auth lives server-side only). Returns:
//   { payments: [{ tip_money: { amount }, created_at, server_name }] }
// tip_money.amount is CENTS. Only payments with a non-zero tip are returned.
//
// Source: Toast Orders API ordersBulk. Money contract (verified by payroll-tips.js):
// tips live on check.payments[].tipAmount; skip voided/deleted orders and checks,
// skip payments with voidInfo, subtract p.refund.tipRefundAmount. The server is
// order.server.guid resolved to a name via /labor/v1/employees.
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

// ordersBulk paginates with page/pageSize (max 100).
async function fetchOrders(token, startISO, endISO) {
  const orders = [];
  const pageSize = 100;
  let page = 1;
  for (;;) {
    const u = new URL(`${TOAST_HOST}/orders/v2/ordersBulk`);
    u.searchParams.set('startDate', startISO);
    u.searchParams.set('endDate', endISO);
    u.searchParams.set('pageSize', String(pageSize));
    u.searchParams.set('page', String(page));
    const r = await toastFetch(u.toString(), toastHeaders(token));
    if (!r.ok) throw new Error(`ordersBulk ${r.status}: ${await r.text()}`);
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    orders.push(...batch);
    if (batch.length < pageSize) break;
    page += 1;
    if (page > 50) break; // safety: 5,000 orders is well beyond a week's volume
  }
  return orders;
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
    const [employees, orders] = await Promise.all([
      fetchEmployees(token),
      fetchOrders(token, startISO, endISO)
    ]);

    const payments = [];
    orders.forEach(o => {
      if (o.voided || o.deleted) return;
      const serverName = (o.server && o.server.guid && employees[o.server.guid]) || 'Unknown';
      (o.checks || []).forEach(c => {
        if (c.voided || c.deleted) return;
        (c.payments || []).forEach(p => {
          if (p.voidInfo) return;
          let tip = p.tipAmount || 0;
          if (p.refund && p.refund.tipRefundAmount) tip -= p.refund.tipRefundAmount;
          const centsTip = Math.round(tip * 100);
          if (centsTip === 0) return;
          payments.push({
            tip_money: { amount: centsTip },
            created_at: p.paidDate || o.closedDate || o.modifiedDate || null,
            server_name: serverName
          });
        });
      });
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ payments })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
