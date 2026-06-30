// /api/payroll-tips?start=YYYY-MM-DD&end=YYYY-MM-DD
// TOAST version. Sums CARD (CREDIT) tip amounts per local NY date for the range.
// Returns the SAME JSON shape the Square version returned:
//   { days: [{ date, card_tips_cents, orders }], totals: { card_tips_cents, orders } }
//
// Source: Toast Orders API
//   GET /orders/v2/ordersBulk?startDate&endDate&pageSize&page
//   Each order -> checks[] -> payments[]; card tip = payment.tipAmount where payment.type === 'CREDIT'.
//   Toast monetary values are in DOLLARS, so we convert to cents to keep the existing contract.
//
// Env vars required:
//   TOAST_CLIENT_ID, TOAST_CLIENT_SECRET, TOAST_RESTAURANT_GUID, [TOAST_HOSTNAME]

const TOAST_HOST = process.env.TOAST_HOSTNAME || 'https://ws-api.toasttab.com';
const RID = process.env.TOAST_RESTAURANT_GUID;

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

// ordersBulk paginates with page/pageSize (max 100). startDate/endDate filter by last-modified
// time; we re-filter each payment by its paidDate below so the day buckets are exact.
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
    const r = await fetch(u.toString(), { headers: toastHeaders(token) });
    if (!r.ok) throw new Error(`ordersBulk ${r.status}: ${await r.text()}`);
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    orders.push(...batch);
    if (batch.length < pageSize) break;
    page += 1;
    if (page > 50) break; // safety: 5000 orders is well beyond a week's volume
  }
  return orders;
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

    const orders = await fetchOrders(token, startISO, endISO);

    const byDay = {};
    let weekTotalCents = 0;
    let orderCount = 0;
    const countedOrders = new Set();

    orders.forEach(o => {
      (o.checks || []).forEach(c => {
        (c.payments || []).forEach(p => {
          if (p.type !== 'CREDIT') return;   // card tips only (CASH/GIFTCARD/etc excluded)
          if (p.voidInfo) return;            // skip voided payments
          const when = p.paidDate || o.closedDate || o.modifiedDate;
          if (!when) return;
          const day = localDateOf(when);
          if (day < start || day > end) return; // re-filter to the exact pay period

          let tip = p.tipAmount || 0;
          if (p.refund && p.refund.tipRefundAmount) tip -= p.refund.tipRefundAmount;
          const cents = Math.round(tip * 100);

          if (!byDay[day]) byDay[day] = { date: day, card_tips_cents: 0, orders: 0 };
          byDay[day].card_tips_cents += cents;
          weekTotalCents += cents;

          if (o.guid && !countedOrders.has(o.guid)) {
            countedOrders.add(o.guid);
            byDay[day].orders += 1;
            orderCount += 1;
          }
        });
      });
    });

    const days = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        days,
        totals: { card_tips_cents: weekTotalCents, orders: orderCount }
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
