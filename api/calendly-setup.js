export const config = { runtime: 'edge' };

// ============================================================
// CALENDLY SETUP (admin only)
// Registers the webhook with Calendly from the server, so nobody has to run
// curl commands by hand. Also reports status, and can remove the webhook.
// ============================================================

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
  const h = request.headers.get('cookie') || '';
  const m = h.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

async function cal(path, token, options = {}) {
  const res = await fetch('https://api.calendly.com' + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

export default async function handler(request) {
  const identity = await verifyToken(getCookie(request, 'bb_auth'), process.env.AUTH_SECRET);
  if (!identity) return json({ ok: false, error: 'Not authenticated' }, 401);
  if (identity.role !== 'admin') return json({ ok: false, error: 'Admin only' }, 403);

  const token = process.env.CALENDLY_TOKEN;
  if (!token) {
    return json({ ok: false, error: 'CALENDLY_TOKEN is not set in the Vercel environment variables.' }, 400);
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'status';

  // Who the token belongs to, and which organization its webhooks live under
  const me = await cal('/users/me', token);
  if (!me.ok) {
    return json({ ok: false, error: 'Calendly rejected the token', detail: me.body }, 400);
  }
  const org = me.body.resource.current_organization;
  const user = me.body.resource;
  const callbackUrl = `${url.origin}/api/calendly`;

  const listSubs = async () =>
    cal(`/webhook_subscriptions?organization=${encodeURIComponent(org)}&scope=organization&count=50`, token);

  if (action === 'log') {
    const cur = await (async () => {
      const url2 = process.env.KV_REST_API_URL, tok = process.env.KV_REST_API_TOKEN;
      const r = await fetch(url2, { method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify(['GET', 'bb_calendly_log']) });
      return r.ok ? r.json() : null;
    })();
    const list = cur && cur.result ? JSON.parse(cur.result) : [];
    return json({ ok: true, attempts: list });
  }

  if (action === 'status') {
    const subs = await listSubs();
    const ours = (subs.body.collection || []).filter((s) => s.callback_url === callbackUrl);
    return json({
      ok: true,
      account: { name: user.name, email: user.email, organization: org },
      callbackUrl,
      registered: ours.length > 0,
      subscriptions: (subs.body.collection || []).map((s) => ({
        uri: s.uri, callback_url: s.callback_url, events: s.events, state: s.state,
      })),
      secretConfigured: !!process.env.CALENDLY_WEBHOOK_SECRET,
    });
  }

  if (action === 'register') {
    const subs = await listSubs();
    const existing = (subs.body.collection || []).find((s) => s.callback_url === callbackUrl);
    if (existing) {
      return json({ ok: true, already: true, subscription: existing.uri, events: existing.events });
    }
    const payload = {
      url: callbackUrl,
      events: ['invitee.created', 'invitee.canceled'],
      organization: org,
      scope: 'organization',
    };
    // Calendly signs requests with this if supplied, which /api/calendly verifies.
    if (process.env.CALENDLY_WEBHOOK_SECRET) payload.signing_key = process.env.CALENDLY_WEBHOOK_SECRET;

    const created = await cal('/webhook_subscriptions', token, {
      method: 'POST', body: JSON.stringify(payload),
    });
    if (!created.ok) {
      return json({ ok: false, error: 'Calendly refused to create the webhook', detail: created.body }, 400);
    }
    return json({ ok: true, created: created.body.resource && created.body.resource.uri, callbackUrl });
  }

  if (action === 'unregister') {
    const subs = await listSubs();
    const ours = (subs.body.collection || []).filter((s) => s.callback_url === callbackUrl);
    const removed = [];
    for (const s of ours) {
      const uuid = s.uri.split('/').pop();
      const del = await cal(`/webhook_subscriptions/${uuid}`, token, { method: 'DELETE' });
      if (del.ok) removed.push(s.uri);
    }
    return json({ ok: true, removed });
  }

  return json({ ok: false, error: 'Unknown action' }, 400);
}
