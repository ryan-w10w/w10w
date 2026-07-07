// Shared-secret auth for the w10w data endpoints.
//
// HOW TO ENABLE ENFORCEMENT:
//   Set W10W_API_KEY in the Netlify site environment (Site configuration ->
//   Environment variables) and redeploy. Until that env var is set, requireKey()
//   is a no-op and every endpoint stays open, so this module is safe to deploy
//   before the key exists.
//
// HOW CLIENTS AUTHENTICATE:
//   Send the same value in the `x-w10w-key` request header. The frontends
//   (payroll.html / index.html) store it in localStorage under 'w10w-api-key'
//   and prompt for it the first time a request comes back 401.
//
// SHARING / ROTATION:
//   Share the key value with staff who use the tools. To rotate: change
//   W10W_API_KEY in the Netlify env, trigger a redeploy, and have staff
//   re-enter the new key on their devices when prompted.

const crypto = require('crypto');

// Returns null when the request is allowed, or a ready-to-return 401 response
// object when it is denied. Usage at the top of a handler:
//   const denied = requireKey(event); if (denied) return denied;
function requireKey(event) {
  const expected = process.env.W10W_API_KEY;
  if (!expected) return null; // auth disabled until the key is configured

  const headers = (event && event.headers) || {};
  let provided = '';
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'x-w10w-key') {
      provided = headers[name] || '';
      break;
    }
  }

  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(expected));
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return null;

  return { statusCode: 401, body: JSON.stringify({ error: 'unauthorized' }) };
}

module.exports = { requireKey };
