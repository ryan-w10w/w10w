// /api/payroll-labor?start=YYYY-MM-DD&end=YYYY-MM-DD
// Returns Square Labor shifts for the date range, with team member details (name, job titles).
// All times are interpreted in America/New_York. Each shift is returned with hours computed.

const SQUARE_BASE = 'https://connect.squareup.com';
const LOCATION_ID = process.env.SQUARE_LOCATION_ID || 'LHSVRCNXBB7E8';
const TZ_OFFSET_HOURS = -4; // EDT. Adjust to -5 for EST. Square stores UTC; we compare on local-day basis.

const ROLE_MAP = {
  // Job title -> internal role bucket. Edit as Square jobs evolve.
  // Tipped FOH (full share)
  'Server': 'server',
  'Bartender': 'bartender',
  'Floor Lead': 'floor_lead',
  // Partial share
  'Host': 'host',
  // Zero share
  'Training': 'training',
  // Non-tipped (BOH, ops). Anything not matched here is treated as non_tipped by default.
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

function squareHeaders() {
  return {
    'Square-Version': '2024-08-21',
    'Authorization': `Bearer ${process.env.SQUARE_TOKEN}`,
    'Content-Type': 'application/json'
  };
}

async function fetchAllShifts(startISO, endISO) {
  const shifts = [];
  let cursor;
  do {
    const body = {
      query: {
        filter: {
          location_ids: [LOCATION_ID],
          start: { start_at: startISO, end_at: endISO }
        }
      },
      limit: 200
    };
    if (cursor) body.cursor = cursor;

    const r = await fetch(`${SQUARE_BASE}/v2/labor/shifts/search`, {
      method: 'POST',
      headers: squareHeaders(),
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Labor API ${r.status}: ${await r.text()}`);
    const data = await r.json();
    if (data.shifts) shifts.push(...data.shifts);
    cursor = data.cursor;
  } while (cursor);
  return shifts;
}

async function fetchTeamMembers(ids) {
  if (!ids.length) return {};
  const r = await fetch(`${SQUARE_BASE}/v2/team-members/search`, {
    method: 'POST',
    headers: squareHeaders(),
    body: JSON.stringify({ query: { filter: { location_ids: [LOCATION_ID] } }, limit: 200 })
  });
  if (!r.ok) throw new Error(`Team members API ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const map = {};
  (data.team_members || []).forEach(tm => {
    map[tm.id] = {
      id: tm.id,
      name: [tm.given_name, tm.family_name].filter(Boolean).join(' ').trim() || 'Unknown',
      jobs: (tm.wage_setting?.job_assignments || []).map(j => j.job_title)
    };
  });
  return map;
}

async function fetchJobTitles() {
  // Map job_id -> job_title for resolving shift.job_id
  const jobs = {};
  let cursor;
  do {
    const url = new URL(`${SQUARE_BASE}/v2/labor/jobs`);
    if (cursor) url.searchParams.set('cursor', cursor);
    const r = await fetch(url.toString(), { headers: squareHeaders() });
    if (!r.ok) break;
    const data = await r.json();
    (data.jobs || []).forEach(j => { jobs[j.id] = j.title; });
    cursor = data.cursor;
  } while (cursor);
  return jobs;
}

function localDateOf(isoString) {
  // Returns YYYY-MM-DD for the local (NY) date the timestamp falls into.
  const d = new Date(isoString);
  const local = new Date(d.getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
  return local.toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  try {
    const { start, end } = event.queryStringParameters || {};
    if (!start || !end) {
      return { statusCode: 400, body: JSON.stringify({ error: 'start and end (YYYY-MM-DD) required' }) };
    }
    // Build wide UTC window so shifts that started/ended just outside local boundaries are still included.
    const startISO = new Date(`${start}T00:00:00${TZ_OFFSET_HOURS < 0 ? '-' : '+'}0${Math.abs(TZ_OFFSET_HOURS)}:00`).toISOString();
    const endExclusive = new Date(`${end}T23:59:59${TZ_OFFSET_HOURS < 0 ? '-' : '+'}0${Math.abs(TZ_OFFSET_HOURS)}:00`).toISOString();

    const [shifts, jobs] = await Promise.all([
      fetchAllShifts(startISO, endExclusive),
      fetchJobTitles()
    ]);

    const memberIds = [...new Set(shifts.map(s => s.team_member_id || s.employee_id).filter(Boolean))];
    const members = await fetchTeamMembers(memberIds);

    const enriched = shifts.map(s => {
      const startedAt = s.start_at;
      const endedAt = s.end_at;
      const memberId = s.team_member_id || s.employee_id;
      // Square sets the per-shift job title directly at s.wage.title. Prefer that over the
      // team member's primary job, which is what causes single-role display when a person
      // worked multiple roles in the week (e.g. a Server who covered a Training shift).
      const jobTitle = s.wage?.title
        || jobs[s.wage?.job_id]
        || jobs[s.job_id]
        || (members[memberId]?.jobs?.[0])
        || 'Unknown';
      const role = ROLE_MAP[jobTitle] || 'non_tipped';
      const hours = endedAt
        ? (new Date(endedAt) - new Date(startedAt)) / 3600000
        : null;
      return {
        shift_id: s.id,
        team_member_id: memberId,
        name: members[memberId]?.name || 'Unknown',
        job_title: jobTitle,
        role,
        tip_multiplier: TIP_MULTIPLIER[role] ?? 0,
        start_at: startedAt,
        end_at: endedAt,
        local_date: startedAt ? localDateOf(startedAt) : null,
        hours: hours != null ? Math.round(hours * 100) / 100 : null,
        declared_cash_tips_cents: s.declared_cash_tip_money?.amount || 0,
        open: !endedAt
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
