export const config = { runtime: 'edge' };

const KEY = 'bb_app_data';

// Fields the outreach role is allowed to set. Deliberately excludes `signed`
// — conversions are an admin call — and everything to do with clients.
const OUTREACH_FIELDS = [
  'name', 'handle', 'country', 'source',
  'callDate', 'callTime', 'booked', 'showed',
  'reminders', 'rescheduleHistory', 'bookedBy', 'notes',
];
const ADMIN_FIELDS = [...OUTREACH_FIELDS, 'signed', 'date'];

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
  if ((await hmacHex(parts[0], secret)) !== parts[1]) return null;
  try { return JSON.parse(base64urlDecode(parts[0])); } catch { return null; }
}
function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  const m = header.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default async function handler(request) {
  const identity = await verifyToken(getCookie(request, 'bb_auth'), process.env.AUTH_SECRET);
  if (!identity) return json({ ok: false, error: 'Not authenticated' }, 401);
  if (identity.role !== 'admin' && identity.role !== 'outreach') {
    return json({ ok: false, error: 'Not authorised to edit leads' }, 403);
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Bad request' }, 400); }
  const { action, lead, leadId, changes } = body || {};

  try {
    // Read-modify-write on just the leads array. Client records are never
    // touched here, so an outreach session can't damage them even by accident.
    const result = await kvCommand(['GET', KEY]);
    const data = result && result.result ? JSON.parse(result.result) : { clients: [], calls: [] };
    data.calls = Array.isArray(data.calls) ? data.calls : [];

    const allowed = identity.role === 'admin' ? ADMIN_FIELDS : OUTREACH_FIELDS;
    const pick = (src) => {
      const out = {};
      allowed.forEach((f) => { if (src && src[f] !== undefined) out[f] = src[f]; });
      return out;
    };

    if (action === 'create') {
      if (!lead || !lead.name) return json({ ok: false, error: 'Name is required' }, 400);
      const rec = {
        id: Math.random().toString(36).slice(2, 9),
        date: new Date().toISOString().slice(0, 10),
        booked: 'yes',
        showed: 'no',
        signed: 'no',
        ...pick(lead),
        bookedBy: identity.name,
      };
      data.calls.unshift(rec);
      await kvCommand(['SET', KEY, JSON.stringify(data)]);
      return json({ ok: true, lead: rec });
    }

    if (action === 'update') {
      const idx = data.calls.findIndex((c) => c.id === leadId);
      if (idx === -1) return json({ ok: false, error: 'Lead not found' }, 404);
      data.calls[idx] = { ...data.calls[idx], ...pick(changes) };
      await kvCommand(['SET', KEY, JSON.stringify(data)]);
      return json({ ok: true, lead: data.calls[idx] });
    }

    return json({ ok: false, error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}
