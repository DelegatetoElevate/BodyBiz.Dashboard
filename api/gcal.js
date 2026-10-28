// Node runtime (not edge) — uses the googleapis package, like api/data.js.
import crypto from 'crypto';

const KEY = 'bb_app_data';
const STATE_KEY = 'bb_gcal_state';
const LOG_KEY = 'bb_gcal_log';
const LOCK_KEY = 'bb_gcal_lock';
const BUSINESS_TZ = 'Australia/Sydney';        // call times are stored in Luke's time

// ============================================================
// GOOGLE CALENDAR BOOKINGS
// Consultations are now booked through a Google Calendar booking page. This
// does for those bookings what api/calendly.js does for Calendly's: each one
// becomes (or updates) a lead with its call scheduled. Calendly stays
// connected alongside until its remaining bookings have passed.
//
// How it hears about bookings: Google's push notification is a webhook, but
// a thin one — it only says "this calendar changed". So on each ping this
// asks Google what changed since last time (an incremental sync with a sync
// token) and processes just those events. The same sync also runs:
//   • when an open dashboard refreshes (throttled), as a safety net if a
//     ping is ever missed;
//   • daily from a Vercel cron, which also renews the push subscription —
//     Google expires them after about a week.
//
// Routes
//   POST /api/gcal                    Google's push ping (shared secret in a header)
//   GET  /api/gcal  (cron bearer)     daily renewal + sync
//   GET  /api/gcal?action=sync        admin or outreach: sync now (throttled)
//   GET  /api/gcal?action=status|connect|disconnect|log   admin only
//
// Only the CONSULTATION is sales activity. Every event must (a) have a guest
// other than the calendar owner — which is what a booking is — and (b) carry
// a consultation-type title. Anything else on the calendar (personal events,
// check-ins, internal meetings) is never touched.
// ============================================================

const CONSULTATION_EVENT = /first[\s-]*time|consultation|consultaion|discovery|strategy\s*call/i;

// ---------- storage ----------
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
async function kvGetJSON(key, fallback) {
  const r = await kvCommand(['GET', key]);
  try { return r && r.result ? JSON.parse(r.result) : fallback; } catch { return fallback; }
}
const kvSetJSON = (key, v) => kvCommand(['SET', key, JSON.stringify(v)]);

async function logAttempt(entry) {
  try {
    const list = await kvGetJSON(LOG_KEY, []);
    list.unshift({ at: new Date().toISOString(), ...entry });
    await kvSetJSON(LOG_KEY, list.slice(0, 30));
  } catch (e) { /* logging must never break the sync */ }
}

// ---------- auth ----------
function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function identityFrom(req) {
  const m = (req.headers.cookie || '').match(/(?:^|; )bb_auth=([^;]*)/);
  const token = m ? decodeURIComponent(m[1]) : null;
  const secret = process.env.AUTH_SECRET;
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const sig = crypto.createHmac('sha256', secret).update(parts[0]).digest('hex');
  if (!safeEqual(sig, parts[1])) return null;
  try { return JSON.parse(base64urlDecode(parts[0])); } catch { return null; }
}
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

let _calendar = null;
async function getCalendar() {
  if (_calendar) return _calendar;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) throw new Error('GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY are not set in Vercel');
  if (!process.env.GCAL_CALENDAR_ID) throw new Error('GCAL_CALENDAR_ID is not set in Vercel');
  const { google } = await import('googleapis');
  const auth = new google.auth.JWT({
    email,
    key: rawKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    // Only when access is granted by domain-wide delegation rather than by
    // sharing the calendar with the service account.
    subject: process.env.GCAL_IMPERSONATE || undefined,
  });
  _calendar = google.calendar({ version: 'v3', auth });
  return _calendar;
}

// ---------- cleaning untrusted text ----------
// Booking details are typed by the public and rendered as HTML on the
// dashboard, so anything that could form markup is stripped.
function clean(v, max) {
  return String(v == null ? '' : v)
    .replace(/[<>`"]/g, '')
    .replace(/'/g, '’')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}
const normName = (n) =>
  String(n || '').toLowerCase().normalize('NFKD').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const normHandle = (h) =>
  String(h || '').trim()
    .replace(/^https?:\/\//i, '')
    .replace(/^(www\.|m\.)?instagram\.com\//i, '')
    .split(/[/?#]/)[0]
    .replace(/^@+/, '')
    .toLowerCase();
const plausibleHandle = (h) =>
  /^[a-z0-9._]{1,30}$/.test(h) && !/^\.|\.$|\.\./.test(h) && !/^\d+$/.test(h);

// Google puts the booking form's answers in the event description. The exact
// layout isn't documented, so this looks for a line mentioning Instagram and
// takes the answer after the colon, or on the next line.
function descriptionText(desc) {
  return String(desc || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
}
export function handleFromDescription(desc) {
  const lines = descriptionText(desc).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    if (!/insta|\big\b/i.test(lines[i])) continue;
    let ans = '';
    const m = lines[i].match(/[:\-–]\s*(.+)$/);
    if (m && !/^\(?@?username\)?$/i.test(m[1].trim())) ans = m[1];
    else if (lines[i + 1]) ans = lines[i + 1];
    const typed = clean(ans, 60);
    if (!typed) return { handle: '', typed: '' };
    if (/\S@\S+\.[a-z]{2,}$/i.test(typed)) return { handle: '', typed };
    const h = normHandle(typed);
    return plausibleHandle(h) ? { handle: h, typed: '' } : { handle: '', typed };
  }
  return { handle: '', typed: '' };
}

// Who booked: a guest who isn't the calendar owner or a room.
function bookerOf(ev) {
  return (ev.attendees || []).find((a) => !a.self && !a.organizer && !a.resource) || null;
}
// "Body Biz Consultation (Jane Smith)" → "Body Biz Consultation"
function eventTypeName(ev) {
  return clean(String(ev.summary || '').replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+(with|and)\s+.+$/i, ''), 120);
}
const fmtDate = (d) => d.toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
const fmtTime = (d) => d.toLocaleTimeString('en-GB', { timeZone: BUSINESS_TZ, hour: '2-digit', minute: '2-digit' });

// ============================================================
// Apply a batch of changed events to the dataset. Pure: no I/O, so it can be
// tested on its own. Returns { changed, log[] }.
// ============================================================
export function applyEvents(data, events, now = new Date()) {
  data.calls = Array.isArray(data.calls) ? data.calls : [];
  const log = [];
  let changed = false;
  const stamp = now.toISOString();

  for (const ev of events) {
    if (!ev || !ev.id) continue;
    const byEventId = data.calls.findIndex((c) => c.gcalEventId === ev.id);
    const booker = bookerOf(ev);
    const cancelled = ev.status === 'cancelled' || (booker && booker.responseStatus === 'declined');

    if (cancelled) {
      // Cancelled events often arrive stripped to just their id, so only a
      // lead we linked to this exact event can be cancelled.
      if (byEventId === -1) continue;
      const lead = data.calls[byEventId];
      if (!lead.callDate) continue;                       // already cleared
      data.calls[byEventId] = {
        ...lead,
        rescheduleHistory: [...(lead.rescheduleHistory || []),
          { from: `${lead.callDate} ${lead.callTime || ''}`.trim(), at: stamp, by: 'Google Calendar (cancelled)' }],
        callDate: '', callTime: '', reminders: {},
        updatedAt: stamp, updatedBy: 'Google Calendar',
      };
      changed = true;
      log.push({ result: 'cancelled', lead: lead.name, eventType: lead.calendlyEvent || '' });
      continue;
    }

    if (!booker) continue;                                 // not a booking — personal event etc.
    const startStr = ev.start && ev.start.dateTime;
    if (!startStr) continue;                               // all-day event
    const typeName = eventTypeName(ev);
    if (!CONSULTATION_EVENT.test(ev.summary || '')) {
      if (byEventId === -1) {
        log.push({ result: `ignored — "${typeName}" is not the consultation calendar`, eventType: typeName, lead: clean(booker.displayName, 80) });
      }
      continue;
    }

    const start = new Date(startStr);
    if (isNaN(start)) continue;
    const callDate = fmtDate(start);
    const callTime = fmtTime(start);
    const email = clean(booker.email, 120).toLowerCase();
    const name = clean(booker.displayName, 80) || clean((String(ev.summary || '').match(/\(([^)]+)\)\s*$/) || [])[1], 80) || email;
    const { handle, typed: handleTyped } = handleFromDescription(ev.description);

    // Match: this exact event → email → Instagram handle → name.
    let idx = byEventId;
    let how = 'event';
    if (idx === -1 && email) { idx = data.calls.findIndex((c) => (c.email || '').toLowerCase() === email); how = 'email'; }
    if (idx === -1 && handle) { idx = data.calls.findIndex((c) => normHandle(c.handle) === handle); how = 'Instagram handle'; }
    if (idx === -1 && name) {
      const n = normName(name);
      if (n) { idx = data.calls.findIndex((c) => normName(c.name) === n); how = 'name'; }
    }

    if (idx > -1) {
      const lead = data.calls[idx];
      const sameSlot = lead.callDate === callDate && lead.callTime === callTime;
      if (sameSlot && lead.gcalEventId === ev.id && (lead.handle || !handle)) continue;   // nothing new
      const moved = lead.callDate && !sameSlot;
      data.calls[idx] = {
        ...lead,
        callDate, callTime, booked: 'yes',
        gcalEventId: ev.id,
        calendlyEvent: typeName,
        ...(sameSlot ? {} : { reminders: {}, showed: lead.signed === 'yes' ? lead.showed : 'no' }),
        rescheduleHistory: moved
          ? [...(lead.rescheduleHistory || []), {
              from: `${lead.callDate} ${lead.callTime || ''}`.trim(), at: stamp,
              by: lead.gcalEventId === ev.id ? 'Google Calendar (rescheduled)' : 'Google Calendar (new booking)' }]
          : (lead.rescheduleHistory || []),
        email: lead.email || email,
        handle: lead.handle || handle,
        needsHandle: !(lead.handle || handle),
        handleTyped: (lead.handle || handle) ? '' : (handleTyped || lead.handleTyped || ''),
        updatedAt: stamp, updatedBy: 'Google Calendar',
      };
      changed = true;
      log.push({
        result: lead.gcalEventId === ev.id ? (moved ? 'rescheduled' : 'updated booking') : `matched existing lead (by ${how})`,
        lead: lead.name, eventType: typeName, callDate, callTime,
        handle: handle || (handleTyped ? `could not use "${handleTyped}"` : ''),
      });
      continue;
    }

    const rec = {
      id: crypto.randomBytes(5).toString('hex').slice(0, 7),
      name, handle, email,
      country: '',
      source: 'Google Calendar',
      date: stamp.slice(0, 10),
      booked: 'yes', showed: 'no', signed: 'no',
      callDate, callTime,
      reminders: {},
      gcalEventId: ev.id,
      calendlyEvent: typeName,
      addedAt: stamp, addedBy: 'Google Calendar',
      updatedAt: stamp, updatedBy: 'Google Calendar',
      needsHandle: !handle,
      handleTyped,
    };
    data.calls.unshift(rec);
    changed = true;
    log.push({ result: 'created new lead', lead: rec.name, eventType: typeName, callDate, callTime,
      handle: handle || (handleTyped ? `could not use "${handleTyped}"` : '') });
  }
  return { changed, log };
}

// ============================================================
// Sync: fetch everything that changed since the last sync token.
// ============================================================
async function runSync(reason) {
  // One sync at a time — a ping and a dashboard refresh can land together.
  const lock = await kvCommand(['SET', LOCK_KEY, '1', 'NX', 'EX', 30]);
  if (!lock || lock.result !== 'OK') return { ok: true, skipped: 'another sync is running' };
  try {
    const cal = await getCalendar();
    const state = await kvGetJSON(STATE_KEY, {});
    const calendarId = process.env.GCAL_CALENDAR_ID;
    const events = [];
    let pageToken;
    let nextSyncToken;
    let full = !state.syncToken;
    for (let guard = 0; guard < 50; guard++) {
      const params = { calendarId, singleEvents: true, showDeleted: true, maxResults: 250, pageToken };
      if (full) params.timeMin = new Date(Date.now() - 24 * 3600 * 1000).toISOString();   // first sync: upcoming only
      else params.syncToken = state.syncToken;
      let r;
      try {
        r = await cal.events.list(params);
      } catch (e) {
        // 410: the sync token expired — start over with a fresh full sync.
        if (!full && (e.code === 410 || (e.response && e.response.status === 410))) {
          full = true; pageToken = undefined; events.length = 0; continue;
        }
        throw e;
      }
      events.push(...(r.data.items || []));
      pageToken = r.data.nextPageToken;
      if (!pageToken) { nextSyncToken = r.data.nextSyncToken; break; }
    }

    let summary = { changed: false, log: [] };
    if (events.length) {
      const data = await kvGetJSON(KEY, { clients: [], calls: [] });
      summary = applyEvents(data, events);
      if (summary.changed) await kvSetJSON(KEY, data);
    }
    await kvSetJSON(STATE_KEY, { ...(await kvGetJSON(STATE_KEY, {})), syncToken: nextSyncToken || state.syncToken, lastSyncAt: new Date().toISOString() });
    for (const entry of summary.log.reverse()) await logAttempt({ ...entry, via: reason });
    return { ok: true, events: events.length, changes: summary.log.length, full };
  } catch (e) {
    await logAttempt({ result: 'ERROR', error: String(e && e.message || e).slice(0, 300), via: reason });
    return { ok: false, error: String(e && e.message || e) };
  } finally {
    await kvCommand(['DEL', LOCK_KEY]).catch(() => {});
  }
}

// Start (or replace) the push subscription. Google expires them, so the
// daily cron renews when fewer than three days are left.
async function ensureChannel(req, force) {
  const secret = process.env.GCAL_WEBHOOK_SECRET;
  if (!secret) throw new Error('GCAL_WEBHOOK_SECRET is not set in Vercel');
  const state = await kvGetJSON(STATE_KEY, {});
  const ch = state.channel;
  const left = ch ? Number(ch.expiration) - Date.now() : 0;
  if (!force && ch && left > 3 * 24 * 3600 * 1000) return { renewed: false, channel: ch };

  const cal = await getCalendar();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const r = await cal.events.watch({
    calendarId: process.env.GCAL_CALENDAR_ID,
    requestBody: {
      id: crypto.randomUUID(),
      type: 'web_hook',
      address: `https://${host}/api/gcal`,
      token: secret,
      params: { ttl: String(7 * 24 * 3600) },
    },
  });
  const channel = { id: r.data.id, resourceId: r.data.resourceId, expiration: r.data.expiration, address: `https://${host}/api/gcal` };
  await kvSetJSON(STATE_KEY, { ...(await kvGetJSON(STATE_KEY, {})), channel });
  if (ch && ch.id) {
    await cal.channels.stop({ requestBody: { id: ch.id, resourceId: ch.resourceId } }).catch(() => {});
  }
  return { renewed: true, channel };
}

// ============================================================
export default async function handler(req, res) {
  // ---- Google's push ping ----
  if (req.method === 'POST') {
    if (!safeEqual(req.headers['x-goog-channel-token'], process.env.GCAL_WEBHOOK_SECRET)) {
      await logAttempt({ result: 'REJECTED — ping without the right channel token' });
      return res.status(401).json({ ok: false });
    }
    const state = await kvGetJSON(STATE_KEY, {}).catch(() => ({}));
    if (!state.channel || req.headers['x-goog-channel-id'] !== state.channel.id) {
      return res.status(200).json({ ok: true, ignored: 'old channel' });   // a replaced subscription winding down
    }
    if (req.headers['x-goog-resource-state'] === 'sync') return res.status(200).json({ ok: true });
    const r = await runSync('push');
    return res.status(200).json(r);   // always 200: Google backs off on errors, and the cron/poller retries
  }

  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  // ---- Daily cron: renew the subscription and catch anything missed ----
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (bearer && process.env.CRON_SECRET && safeEqual(bearer, process.env.CRON_SECRET)) {
    try {
      const st = await kvGetJSON(STATE_KEY, {});
      const ch = st.channel ? await ensureChannel(req, false) : { renewed: false, note: 'not connected' };
      const s = st.channel ? await runSync('daily') : { skipped: 'not connected' };
      if (ch.renewed) await logAttempt({ result: 'renewed push subscription', via: 'daily' });
      return res.status(200).json({ ok: true, channel: ch, sync: s });
    } catch (e) {
      await logAttempt({ result: 'ERROR — daily renewal failed', error: String(e.message || e).slice(0, 300), via: 'daily' });
      return res.status(500).json({ ok: false, error: String(e.message || e) });
    }
  }

  const id = identityFrom(req);
  if (!id) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  const action = (req.query && req.query.action) || 'status';

  // ---- Safety-net sync from an open dashboard (admin + outreach) ----
  if (action === 'sync') {
    if (id.role !== 'admin' && id.role !== 'outreach') return res.status(403).json({ ok: false });
    const st = await kvGetJSON(STATE_KEY, {}).catch(() => ({}));
    if (!st.channel) return res.status(200).json({ ok: true, skipped: 'not connected' });
    const force = req.query.force === '1' && id.role === 'admin';
    if (!force && st.lastSyncAt && Date.now() - Date.parse(st.lastSyncAt) < 60 * 1000) {
      return res.status(200).json({ ok: true, skipped: 'synced recently' });
    }
    return res.status(200).json(await runSync(force ? 'manual' : 'dashboard'));
  }

  if (id.role !== 'admin') return res.status(403).json({ ok: false, error: 'Admin only' });

  try {
    if (action === 'log') {
      return res.status(200).json({ ok: true, attempts: await kvGetJSON(LOG_KEY, []) });
    }
    if (action === 'connect') {
      const ch = await ensureChannel(req, true);
      await kvSetJSON(STATE_KEY, { ...(await kvGetJSON(STATE_KEY, {})), syncToken: null });
      const s = await runSync('connect');               // first sync: picks up upcoming bookings
      await logAttempt({ result: 'connected', via: 'admin' });
      return res.status(200).json({ ok: s.ok, channel: ch.channel, sync: s, error: s.error });
    }
    if (action === 'disconnect') {
      const st = await kvGetJSON(STATE_KEY, {});
      if (st.channel) {
        const cal = await getCalendar();
        await cal.channels.stop({ requestBody: { id: st.channel.id, resourceId: st.channel.resourceId } }).catch(() => {});
      }
      await kvSetJSON(STATE_KEY, {});
      await logAttempt({ result: 'disconnected', via: 'admin' });
      return res.status(200).json({ ok: true });
    }
    // status
    const st = await kvGetJSON(STATE_KEY, {});
    const missing = ['GOOGLE_SERVICE_ACCOUNT_EMAIL', 'GOOGLE_PRIVATE_KEY', 'GCAL_CALENDAR_ID', 'GCAL_WEBHOOK_SECRET', 'CRON_SECRET']
      .filter((k) => !process.env[k]);
    let access = null;
    if (!missing.some((k) => k.startsWith('GOOGLE') || k === 'GCAL_CALENDAR_ID')) {
      try {
        const cal = await getCalendar();
        await cal.events.list({ calendarId: process.env.GCAL_CALENDAR_ID, maxResults: 1, timeMin: new Date().toISOString() });
        access = { ok: true };
      } catch (e) {
        access = { ok: false, error: String(e.message || e).slice(0, 300) };
      }
    }
    return res.status(200).json({
      ok: true,
      calendarId: process.env.GCAL_CALENDAR_ID || '',
      serviceAccount: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '',
      missing,
      access,
      connected: !!st.channel,
      expires: st.channel ? new Date(Number(st.channel.expiration)).toISOString() : null,
      lastSyncAt: st.lastSyncAt || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
