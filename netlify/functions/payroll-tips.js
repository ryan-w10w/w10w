// /api/payroll-tips?start=YYYY-MM-DD&end=YYYY-MM-DD
// Sums card tip_money per local NY business date for the date range.
// Uses POST /v2/orders/search with state_filter COMPLETED, paginated via cursor (500-row hard limit per page).

const SQUARE_BASE = 'https://connect.squareup.com';
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || 'LHSVRCNXBB7E8';
const TZ_OFFSET_HOURS = -4; // EDT

function squareHeaders() {
  return {
    'Square-Version': '2024-08-21',
    'Authorization': `Bearer ${process.env.SQUARE_ACCESS_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

function localDateOf(isoString) {
  const d = new Date(isoString);
  const local = new Date(d.getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

async function fetchAllOrders(startISO, endISO) {
  const orders = [];
  let cursor;
  let pages = 0;
  do {
    const body = {
      location_ids: [LOCATION_ID],
      query: {
        filter: {
          state_filter: { states: ['COMPLETED'] },
          date_time_filter: { closed_at: { start_at: startISO, end_at: endISO } }
        },
        sort: { sort_field: 'CLOSED_AT', sort_order: 'ASC' }
      },
      limit: 500
    };
    if (cursor) body.cursor = cursor;

    const r = await fetch(`${SQUARE_BASE}/v2/orders/search`, {
      method: 'POST',
      headers: squareHeaders(),
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Orders API ${r.status}: ${await r.text()}`);
    const data = await r.json();
    if (data.orders) orders.push(...data.orders);
    cursor = data.cursor;
    pages += 1;
    if (pages > 40) break; // safety: 20k orders is well beyond a week's volume
  } while (cursor);
  return orders;
}

exports.handler = async (event) => {
  try {
    const { start, end } = event.queryStringParameters || {};
    if (!start || !end) {
      return { statusCode: 400, body: JSON.stringify({ error: 'start and end (YYYY-MM-DD) required' }) };
    }
    const startISO = new Date(`${start}T00:00:00${TZ_OFFSET_HOURS < 0 ? '-' : '+'}0${Math.abs(TZ_OFFSET_HOURS)}:00`).toISOString();
    const endISO = new Date(`${end}T23:59:59${TZ_OFFSET_HOURS < 0 ? '-' : '+'}0${Math.abs(TZ_OFFSET_HOURS)}:00`).toISOString();

    const orders = await fetchAllOrders(startISO, endISO);

    const byDay = {};
    let weekTotalCents = 0;
    let orderCount = 0;

    orders.forEach(o => {
      if (!o.closed_at) return;
      const day = localDateOf(o.closed_at);
      let tipCents = 0;
      (o.tenders || []).forEach(t => {
        // Card tips only. Cash tenders may carry tip_money in some flows but those are recorded separately.
        if (t.type === 'CARD' && t.tip_money?.amount) {
          tipCents += t.tip_money.amount;
        }
      });
      if (!byDay[day]) byDay[day] = { date: day, card_tips_cents: 0, orders: 0 };
      byDay[day].card_tips_cents += tipCents;
      byDay[day].orders += 1;
      weekTotalCents += tipCents;
      orderCount += 1;
    });

    const days = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        days,
        totals: {
          card_tips_cents: weekTotalCents,
          orders: orderCount
        }
      })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
