export const config = { runtime: 'edge' };

const KEY = 'bb_app_data';

// ============================================================
// CALENDLY WEBHOOK
// Calendly POSTs here when someone books or cancels. Bookings become leads
// with their call scheduled, so outreach doesn't have to re-type them.
//
// Calendly only gives us a name and email — the booking form doesn't ask for
// an Instagram handle. So we match incoming bookings to leads outreach has
// already logged (by email, then by name) and flag anything we can't place,
// rather than silently creating unidentifiable records.
// ============================================================

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

const json = (b, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

// Calendly signs each request: "t=<timestamp>,v1=<hmac of timestamp.body>".
// Without this check anyone who learned the URL could inject fake bookings.
async function signatureValid(rawBody, header, secret) {
  if (!secret) return true;              // no secret configured yet
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => p.split('=').map((x) => x.trim()))
  );
  if (!parts.t || !parts.v1) return false;
  // Reject anything older than 5 minutes, so a captured request can't be replayed.
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > 300) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${parts.t}.${rawBody}`));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  // constant-time-ish comparison
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

const normName = (n) =>
  String(n || '').toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();

// Some booking forms ask for an Instagram handle as a custom question. This
// one doesn't today, but if it's ever added the answer arrives here and the
// booking will match perfectly instead of falling back to the name.
function handleFromAnswers(payload) {
  const qa = payload.questions_and_answers || [];
  const hit = qa.find((q) => /instagram|ig handle|@/i.test(q.question || ''));
  if (!hit || !hit.answer) return '';
  return String(hit.answer).trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.)?instagram\.com\//i, '')
    .split(/[/?#]/)[0]
    .replace(/^@+/, '')
    .trim();
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const raw = await request.text();
  const okSig = await signatureValid(
    raw,
    request.headers.get('calendly-webhook-signature'),
    process.env.CALENDLY_WEBHOOK_SECRET
  );
  if (!okSig) return json({ ok: false, error: 'Invalid signature' }, 401);

  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: 'Bad JSON' }, 400); }

  const event = body.event;                    // invitee.created | invitee.canceled
  const p = body.payload || {};
  const inviteeName = p.name || '';
  const inviteeEmail = (p.email || '').toLowerCase();
  const start = p.scheduled_event && p.scheduled_event.start_time;
  const eventName = (p.scheduled_event && p.scheduled_event.name) || '';
  const calendlyUri = p.uri || '';
  if (!inviteeName && !inviteeEmail) return json({ ok: true, skipped: 'no invitee details' });

  const startDate = start ? new Date(start) : null;
  // Store in the same local format the dashboard uses elsewhere.
  const fmtDate = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' });
  const fmtTime = (d) => d.toLocaleTimeString('en-GB', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit' });

  try {
    const result = await kvCommand(['GET', KEY]);
    const data = result && result.result ? JSON.parse(result.result) : { clients: [], calls: [] };
    data.calls = Array.isArray(data.calls) ? data.calls : [];

    // Already linked to this exact Calendly booking?
    let idx = data.calls.findIndex((c) => c.calendlyUri && c.calendlyUri === calendlyUri);

    // Otherwise match a lead outreach already logged: email first, then name.
    if (idx === -1 && inviteeEmail) {
      idx = data.calls.findIndex((c) => (c.email || '').toLowerCase() === inviteeEmail);
    }
    if (idx === -1 && inviteeName) {
      const n = normName(inviteeName);
      idx = data.calls.findIndex((c) => normName(c.name) === n);
    }

    if (event === 'invitee.canceled') {
      if (idx === -1) return json({ ok: true, skipped: 'no matching lead to cancel' });
      const lead = data.calls[idx];
      data.calls[idx] = {
        ...lead,
        // A reschedule arrives as a cancel followed by a new booking, so keep
        // the slot in history rather than wiping it — the new booking will
        // fill in the new time moments later.
        rescheduleHistory: [
          ...(lead.rescheduleHistory || []),
          { from: `${lead.callDate || ''}${lead.callTime ? ' ' + lead.callTime : ''}`.trim(),
            at: new Date().toISOString(), by: 'Calendly (cancelled)' },
        ],
        callDate: '', callTime: '', reminders: {},
        updatedAt: new Date().toISOString(), updatedBy: 'Calendly',
      };
      await kvCommand(['SET', KEY, JSON.stringify(data)]);
      return json({ ok: true, action: 'cancelled', lead: data.calls[idx].name });
    }

    // invitee.created
    const handle = handleFromAnswers(p);
    const booking = {
      callDate: startDate ? fmtDate(startDate) : '',
      callTime: startDate ? fmtTime(startDate) : '',
      booked: 'yes',
      calendlyUri,
      calendlyEvent: eventName,
      reminders: {},
      updatedAt: new Date().toISOString(),
      updatedBy: 'Calendly',
    };

    if (idx > -1) {
      const lead = data.calls[idx];
      data.calls[idx] = {
        ...lead,
        ...booking,
        email: lead.email || inviteeEmail,
        handle: lead.handle || handle,
        // Keep the flag only if we still have no handle for them.
        needsHandle: !(lead.handle || handle),
      };
      await kvCommand(['SET', KEY, JSON.stringify(data)]);
      return json({ ok: true, action: 'matched existing lead', lead: data.calls[idx].name });
    }

    // Nobody matched — create the lead so the call isn't lost, flagged for
    // someone to attach the right Instagram handle.
    const rec = {
      id: Math.random().toString(36).slice(2, 9),
      name: inviteeName || inviteeEmail,
      handle,
      email: inviteeEmail,
      country: '',
      source: 'Calendly',
      date: new Date().toISOString().slice(0, 10),
      showed: 'no',
      signed: 'no',
      addedAt: new Date().toISOString(),
      addedBy: 'Calendly',
      needsHandle: !handle,
      ...booking,
    };
    data.calls.unshift(rec);
    await kvCommand(['SET', KEY, JSON.stringify(data)]);
    return json({ ok: true, action: 'created new lead', lead: rec.name });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 500);
  }
}
