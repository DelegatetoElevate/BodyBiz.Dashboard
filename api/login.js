export const config = { runtime: 'edge' };

function base64url(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacHex(data, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function signToken(payload, secret) {
  const payloadStr = base64url(JSON.stringify(payload));
  const sig = await hmacHex(payloadStr, secret);
  return `${payloadStr}.${sig}`;
}

function getAccessCodes() {
  try {
    return JSON.parse(process.env.ACCESS_CODES || '{}');
  } catch {
    return {};
  }
}

export default async function handler(request) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ ok: false, error: 'Bad request' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const submitted = (body?.password || '').toString().trim().toUpperCase();
  const secret = process.env.AUTH_SECRET;
  const codes = getAccessCodes();

  if (!secret || !Object.keys(codes).length) {
    return new Response(JSON.stringify({ ok: false, error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }

  const user = codes[submitted];
  if (!user) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid code' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const identity = { name: user.name, role: user.role, coach: user.coach || null };
  const token = await signToken(identity, secret);
  const maxAge = 60 * 60 * 24 * 30; // 30 days

  const headers = new Headers({ 'content-type': 'application/json' });
  // Real, tamper-proof identity — HttpOnly so JS on the page can't read
  // or forge it. Every API route re-verifies this on every request.
  headers.append(
    'set-cookie',
    `bb_auth=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
  );
  // Convenience, readable copy for the UI (which name/role to show,
  // which nav tabs to hide). Not trusted for anything security-relevant —
  // if someone edits it in dev tools, the UI might show the wrong banner,
  // but every data request is still checked against the real cookie above.
  headers.append(
    'set-cookie',
    `bb_identity=${encodeURIComponent(JSON.stringify(identity))}; Path=/; Secure; SameSite=Lax; Max-Age=${maxAge}`
  );

  return new Response(JSON.stringify({ ok: true, identity }), { status: 200, headers });
}
