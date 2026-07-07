// /api/toast-orders?start=ISO&end=ISO
// TOAST shim for index.html's order reads. Fetches from the Toast Orders API and
// returns SQUARE-SHAPED orders so the dashboard's existing math (squareNetFromOrders,
// 12mo nightly averages, MTD, category split) keeps working unchanged:
//   { orders: [{ created_at, closed_at, state,
//                total_money:{amount}, total_tax_money:{amount},
//                total_tip_money:{amount}, total_service_charge_money:{amount},
//                line_items:[{ catalog_object_id, name, quantity,
//                              gross_sales_money:{amount}, category_name }] }] }
// All *_money.amount values are CENTS (Toast reports dollars; converted per field).
//
// Money contract (verified to the penny by payroll-tips.js against production):
//   - tips live on check.payments[].tipAmount (check.tipAmount is undefined in prod)
//   - check.totalAmount INCLUDES the tip
//   - net = sum(check.totalAmount) - taxAmount - paymentTips - serviceCharges
//   - skip voided/deleted orders and checks, skip payments with voidInfo,
//     subtract p.refund.tipRefundAmount
//
// Day attribution: the dashboard thinks in "service nights". Toast's businessDate
// (yyyyMMdd) is the authoritative night an order belongs to (after-midnight orders
// roll back to the prior night). So:
//   - an order is INCLUDED iff its businessDate's 4:00am America/New_York moment
//     falls inside [start, end]. index.html windows start at midnight/1am NY
//     (5am UTC), so 4am-of-the-night is inside the window exactly when the caller
//     means to include that night, and "tonight live" picks up today as soon as
//     service could plausibly exist.
//   - created_at is synthesized as businessDate NOON NY, so the 12mo-averages code
//     (which buckets by created_at's NY calendar date) buckets by business date.
//
// NOTE: pagination is capped at 50 pages x 100 orders = 5,000 orders per call.
// Plenty for daily/MTD windows; the manual "Refresh 12mo" button may truncate on a
// full year of data (falls back gracefully — averages just cover fewer orders).
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

// Toast enforces ~5 req/s per credential. index.html fires several panels at once
// (live sales, MTD, category split, labor), so 429s are expected under normal use —
// retry with backoff instead of failing the whole panel.
const sleep = ms => new Promise(res => setTimeout(res, ms));
async function toastFetch(url, headers) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers });
    if (r.status === 429 && attempt < 4) { await sleep(1200 * (attempt + 1)); continue; }
    return r;
  }
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

// Accept either a full ISO datetime (what index.html sends) or YYYY-MM-DD.
function toISO(v, endOfDay) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return endOfDay ? nyToUTCISO(v, 23, 59, 59) : nyToUTCISO(v, 0, 0, 0);
  }
  const d = new Date(v);
  if (isNaN(d)) throw new Error(`bad date: ${v}`);
  return d.toISOString();
}

// Toast businessDate int (20260628) -> "2026-06-28"
function bizDateStr(bd) {
  const s = String(bd);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// ---- Category resolution ----
// In production, selection.salesCategory is a bare {guid} reference and is null on
// most selections. But the Toast menu items were imported from Square WITH the same
// SKU convention the old dashboard split on (COCKTAIL_*, WINE*, FOOD_*) — that SKU
// logic was the verified split source pre-migration, so it stays primary here.
// Fallback: salesCategory guid -> name via /config/v2/salesCategories.
// Emits category_name as one of "Cocktail" | "Wine" | "Food" | null.
let _menuCache = { itemSku: null, catName: null, exp: 0 };
async function loadMenuMaps(token) {
  if (_menuCache.itemSku && Date.now() < _menuCache.exp) return _menuCache;
  const itemSku = {};
  const catName = {};
  // Both endpoints are single-page for this 131-item menu, but follow the
  // Toast-Next-Page-Token header anyway (same pattern as payroll-labor.js).
  for (const [path, apply] of [
    ['/config/v2/menuItems', arr => arr.forEach(i => { if (i.sku) itemSku[i.guid] = i.sku; })],
    ['/config/v2/salesCategories', arr => arr.forEach(c => { catName[c.guid] = c.name; })]
  ]) {
    let pageToken; let guard = 0;
    do {
      const u = new URL(`${TOAST_HOST}${path}`);
      u.searchParams.set('pageSize', '100');
      if (pageToken) u.searchParams.set('pageToken', pageToken);
      const r = await toastFetch(u.toString(), toastHeaders(token));
      if (!r.ok) throw new Error(`${path} ${r.status}: ${await r.text()}`);
      const batch = await r.json();
      if (Array.isArray(batch)) apply(batch);
      pageToken = r.headers.get('toast-next-page-token') || null;
      guard += 1;
    } while (pageToken && guard < 20);
  }
  _menuCache = { itemSku, catName, exp: Date.now() + 6 * 3600 * 1000 }; // 6h TTL
  return _menuCache;
}
function categoryOf(sel, menu) {
  const sku = (sel.item && menu.itemSku[sel.item.guid]) || '';
  if (sku.indexOf('COCKTAIL_') === 0) return 'Cocktail';   // same prefixes the old
  if (sku.indexOf('WINE') === 0) return 'Wine';            // Square split verified on
  if (sku.indexOf('FOOD_') === 0) return 'Food';
  const cn = (sel.salesCategory && menu.catName[sel.salesCategory.guid]) || '';
  if (/cocktail/i.test(cn)) return 'Cocktail';
  if (/wine/i.test(cn)) return 'Wine';
  if (/food|dessert/i.test(cn)) return 'Food';
  return null; // NA beverage / unmapped — old SKU logic dropped these too
}

// ordersBulk paginates with page/pageSize (max 100). startDate/endDate filter by
// last-modified time; the businessDate re-filter below makes the day buckets exact.
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
    if (page > 50) break; // safety cap — see file header
  }
  return orders;
}

const cents = x => Math.round((x || 0) * 100);

exports.handler = async (event) => {
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
    const startMs = new Date(startISO).getTime();
    const endMs = new Date(endISO).getTime();

    // Widen the ordersBulk fetch window by 10h past `end` so after-midnight orders
    // (created/modified up to ~4am NY the next calendar day but business-dated to
    // the requested night) are not missed. The businessDate filter below re-trims.
    const fetchEndISO = new Date(endMs + 10 * 3600 * 1000).toISOString();

    const token = await toastToken();
    const [menu, raw] = await Promise.all([
      loadMenuMaps(token),
      fetchOrders(token, startISO, fetchEndISO)
    ]);

    const out = [];
    raw.forEach(o => {
      if (o.voided || o.deleted) return;
      if (!o.businessDate) return;
      const bd = bizDateStr(o.businessDate);

      // Include iff this business night's 4am NY moment is inside [start, end].
      const nightMs = new Date(nyToUTCISO(bd, 4, 0, 0)).getTime();
      if (nightMs < startMs || nightMs > endMs) return;

      let total = 0, tax = 0, tip = 0, svc = 0;
      const lineItems = [];

      (o.checks || []).forEach(c => {
        if (c.voided || c.deleted) return;
        total += cents(c.totalAmount);   // includes tip (verified in production)
        tax += cents(c.taxAmount);
        (c.appliedServiceCharges || []).forEach(sc => { svc += cents(sc.chargeAmount); });
        (c.payments || []).forEach(p => {
          if (p.voidInfo) return;
          let t = p.tipAmount || 0;
          if (p.refund && p.refund.tipRefundAmount) t -= p.refund.tipRefundAmount;
          tip += Math.round(t * 100);
        });
        (c.selections || []).forEach(s => {
          if (s.voided) return;
          const gross = (s.preDiscountPrice !== undefined && s.preDiscountPrice !== null)
            ? s.preDiscountPrice : (s.price || 0);
          lineItems.push({
            catalog_object_id: (s.item && s.item.guid) || s.guid || null,
            name: s.displayName || null,
            quantity: String(s.quantity != null ? s.quantity : 1),
            gross_sales_money: { amount: cents(gross) },
            // Resolved server-side (SKU prefix first, salesCategory fallback) —
            // no client-side catalog batch-retrieve needed anymore.
            category_name: categoryOf(s, menu)
          });
        });
      });

      out.push({
        id: o.guid,
        state: 'COMPLETED',
        // Synthesized: businessDate at noon NY, so NY-date bucketing == business date.
        created_at: nyToUTCISO(bd, 12, 0, 0),
        closed_at: o.closedDate || null,
        business_date: bd,
        total_money: { amount: total },
        total_tax_money: { amount: tax },
        total_tip_money: { amount: tip },
        total_service_charge_money: { amount: svc },
        line_items: lineItems
      });
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ orders: out })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
