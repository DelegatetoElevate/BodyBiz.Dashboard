// Vercel Edge Middleware — runs on every request BEFORE any file is served.
// Verifies a signed identity token (set at login) rather than a single
// shared password, so the gate itself knows WHO is asking, not just
// whether they know a code. Actual data filtering by role happens in
// the API routes (api/data.js, api/pulse.js), not here.

export const config = {
  matcher: [
    '/((?!login.html|api/login|api/logout|favicon.ico|_vercel).*)',
  ],
};

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

async function hmacHex(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verifyToken(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadStr, sig] = parts;
  const expected = await hmacHex(payloadStr, secret);
  if (sig !== expected) return null;
  try {
    return JSON.parse(base64urlDecode(payloadStr));
  } catch {
    return null;
  }
}

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  const match = header.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

export default async function middleware(request) {
  const secret = process.env.AUTH_SECRET;
  if (!secret || !process.env.ACCESS_CODES) {
    return new Response('Server misconfigured: AUTH_SECRET / ACCESS_CODES not set.', { status: 500 });
  }

  const token = getCookie(request, 'bb_auth');
  const identity = await verifyToken(token, secret);

  if (!identity) {
    const url = new URL(request.url);
    const loginUrl = new URL('/login.html', url);
    loginUrl.searchParams.set('next', url.pathname + url.search);
    return Response.redirect(loginUrl, 302);
  }

  return undefined;
}
