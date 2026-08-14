export const config = { runtime: 'edge' };

const DATA_KEY = 'bb_app_data';
const PULSE_KEY = 'bb_pulse_data';

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
  if ((await hmacHex(payloadStr, secret)) !== sig) return null;
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
async function getIdentity(request) {
  return verifyToken(getCookie(request, 'bb_auth'), process.env.AUTH_SECRET);
}

async function kvCommand(cmd) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error('Shared storage is not configured');
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error('KV request failed: ' + res.status);
  return res.json();
}

export default async function handler(request) {
  const identity = await getIdentity(request);
  if (!identity) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (request.method === 'GET') {
    try {
      const [pulseResult, dataResult] = await Promise.all([
        kvCommand(['GET', PULSE_KEY]),
        kvCommand(['GET', DATA_KEY]),
      ]);
      const pulseData = pulseResult && pulseResult.result ? JSON.parse(pulseResult.result) : {};
      const appData = dataResult && dataResult.result ? JSON.parse(dataResult.result) : { clients: [] };

      if (identity.role === 'admin') {
        return new Response(JSON.stringify(pulseData), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const myClientIds = new Set(
        (appData.clients || []).filter((c) => c.coach === identity.coach).map((c) => c.id)
      );
      const filtered = {};
      Object.keys(pulseData).forEach((id) => {
        if (myClientIds.has(id)) filtered[id] = pulseData[id];
      });
      return new Response(JSON.stringify(filtered), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  }

  if (request.method === 'POST') {
    try {
      const body = await request.json();
      const { clientId, status, note } = body || {};
      if (!clientId || !status) {
        return new Response(JSON.stringify({ ok: false, error: 'clientId and status required' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }

      const dataResult = await kvCommand(['GET', DATA_KEY]);
      const appData = dataResult && dataResult.result ? JSON.parse(dataResult.result) : { clients: [] };
      const client = (appData.clients || []).find((c) => c.id === clientId);
      if (!client) {
        return new Response(JSON.stringify({ ok: false, error: 'Client not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      // A coach can only update Pulse status for their own clients — checked
      // against the client's real coach field from the shared store, not
      // anything the browser claims, so this can't be spoofed client-side.
      if (identity.role !== 'admin' && client.coach !== identity.coach) {
        return new Response(JSON.stringify({ ok: false, error: 'Not your client' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }

      const pulseResult = await kvCommand(['GET', PULSE_KEY]);
      const pulseData = pulseResult && pulseResult.result ? JSON.parse(pulseResult.result) : {};
      const nowIso = new Date().toISOString();
      pulseData[clientId] = {
        status,
        note: note || '',
        // Display string for the UI, plus a machine-readable copy used for
        // freshness/staleness calculations and sorting.
        updatedAt: new Date(nowIso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }),
        updatedAtIso: nowIso,
        updatedBy: identity.name,
      };
      await kvCommand(['SET', PULSE_KEY, JSON.stringify(pulseData)]);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  }

  return new Response('Method not allowed', { status: 405 });
}
