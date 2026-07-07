// /api/payroll-cash?start=YYYY-MM-DD&end=YYYY-MM-DD
// Reads nightly Cash Tips (Col R) and Cash Payments (Col S) from the Shift Report (Responses) sheet.
// Each row = one shift report submitted for one whole business day. Closing manager fills it out.
//
// Sheet structure:
//   Col A: Timestamp (form submit time, used for dedup only)
//   Col B: Shift Date (the actual date of the shift, source of truth)
//   Col R: Cash Tips for the night (whole-team total)
//   Col S: Cash Payments for the night (whole-team total)
//
// If multiple reports exist for the same Shift Date, the one with the latest Timestamp wins.
// All other duplicate dates are returned in `duplicates` so the UI can flag them.
//
// Auth: Google service account JSON in env var GOOGLE_SHEETS_SA_JSON.
// The service account must have Viewer access to the sheet.

const SHEET_ID = '1XDxDpEQxxEVP0XL3qhqot-KIGecEVRM6LEfxzJtcPg4';
const TAB_NAME = 'Form Responses 1';
const RANGE = `${TAB_NAME}!A2:S`;

const COL_TIMESTAMP = 0;   // A
const COL_DATE = 1;        // B (Shift Date)
const COL_CASH_TIPS = 17;  // R
const COL_CASH_PAY = 18;   // S

function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  }
  return null;
}

function parseDollars(raw) {
  if (raw == null || raw === '') return 0;
  const n = Number(String(raw).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function parseTimestamp(raw) {
  if (!raw) return 0;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : 0;
}

async function getAccessToken() {
  const sa = JSON.parse(process.env.GOOGLE_SHEETS_SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })).toString('base64url');
  const signingInput = `${header}.${claim}`;
  const crypto = require('crypto');
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(sa.private_key).toString('base64url');
  const jwt = `${signingInput}.${signature}`;

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  if (!r.ok) throw new Error(`OAuth token failed ${r.status}: ${await r.text()}`);
  return (await r.json()).access_token;
}

const { requireKey } = require('./_auth');

exports.handler = async (event) => {
  const denied = requireKey(event);
  if (denied) return denied;
  try {
    const { start, end } = event.queryStringParameters || {};
    if (!start || !end) {
      return { statusCode: 400, body: JSON.stringify({ error: 'start and end (YYYY-MM-DD) required' }) };
    }

    const token = await getAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(RANGE)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Sheets API ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const rows = data.values || [];

    // Dedup by Shift Date using the latest Timestamp
    const byDate = {};
    const duplicateDates = new Set();

    rows.forEach(row => {
      const date = parseDate(row[COL_DATE]);
      if (!date) return;
      if (date < start || date > end) return;

      const ts = parseTimestamp(row[COL_TIMESTAMP]);
      const cashTips = parseDollars(row[COL_CASH_TIPS]);
      const cashPay = parseDollars(row[COL_CASH_PAY]);

      if (byDate[date]) {
        duplicateDates.add(date);
        if (ts >= byDate[date].timestamp) {
          byDate[date] = { timestamp: ts, cash_tips: cashTips, cash_payments: cashPay };
        }
      } else {
        byDate[date] = { timestamp: ts, cash_tips: cashTips, cash_payments: cashPay };
      }
    });

    const entries = Object.entries(byDate)
      .map(([date, d]) => ({ date, cash_tips: d.cash_tips, cash_payments: d.cash_payments }))
      .filter(e => e.cash_tips !== 0 || e.cash_payments !== 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    const totals = {
      cash_tips: entries.reduce((a, e) => a + e.cash_tips, 0),
      cash_payments: entries.reduce((a, e) => a + e.cash_payments, 0)
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ entries, totals, duplicates: [...duplicateDates] })
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
