// NOTE: squareup.com support below is LEGACY — the POS migrated to Toast (2026-06-24)
// and index.html now reads Toast via the toast-* shim functions. This proxy is still
// used for Google Sheets/Docs. The SQUARE_TOKEN injection is harmless and kept in
// case anything historical still points at Square.
exports.handler = async function(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  try {
    const { url, method, headers, body } = JSON.parse(event.body);

    const allowed = ["connect.squareup.com", "docs.google.com", "sheets.googleapis.com"];
    const hostname = new URL(url).hostname;
    if (!allowed.some(function(d){ return hostname.includes(d); })) {
      return { statusCode: 403, body: JSON.stringify({ error: "Domain not permitted: " + hostname }) };
    }

    const reqHeaders = Object.assign({}, headers || {});

    if (hostname.includes("squareup.com") && process.env.SQUARE_TOKEN) {
      reqHeaders["Authorization"] = "Bearer " + process.env.SQUARE_TOKEN;
      reqHeaders["Square-Version"] = "2024-01-18";
      reqHeaders["Content-Type"] = "application/json";
    }

    const response = await fetch(url, {
      method: method || "GET",
      headers: reqHeaders,
      body: (method === "POST" && body) ? body : undefined
    });

    const text = await response.text();
    return {
      statusCode: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") || "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: text
    };
  } catch(e) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: e.message })
    };
  }
};
