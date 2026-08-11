// Node runtime (not edge) — the googleapis package used for the optional
// Google Sheets mirror needs Node APIs that aren't available on the edge.
import crypto from 'crypto';

const KEY = 'bb_app_data';

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}
function hmacHex(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
function verifyToken(token, secret) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadStr, sig] = parts;
  if (hmacHex(payloadStr, secret) !== sig) return null;
  try {
    return JSON.parse(base64urlDecode(payloadStr));
  } catch {
    return null;
  }
}
function getCookie(req, name) {
  const header = req.headers.cookie || '';
  const match = header.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}
function getIdentity(req) {
  return verifyToken(getCookie(req, 'bb_auth'), process.env.AUTH_SECRET);
}

async function kvCommand(cmd) {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) {
    throw new Error('Shared storage is not configured (missing KV_REST_API_URL / KV_REST_API_TOKEN)');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  if (!res.ok) throw new Error('KV request failed: ' + res.status);
  return res.json();
}

// ============================================================
// OPTIONAL: mirror clients + leads to a Google Sheet.
// Fully non-blocking — if it's not configured or it fails, the app
// keeps working normally off Vercel KV (the real backend).
// ============================================================
let _sheetsClient = null;
async function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !rawKey) return null;
  if (_sheetsClient) return _sheetsClient;
  const { google } = await import('googleapis');
  const privateKey = rawKey.replace(/\\n/g, '\n');
  const auth = new google.auth.JWT(email, undefined, privateKey, [
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}
async function writeSheetTab(tab, header, rows) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheets = await getSheetsClient();
  if (!sheetId || !sheets) return;
  const values = [header, ...rows];
  await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: `${tab}!A:Z` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}
async function mirrorClientsToSheet(clients) {
  const tab = process.env.GOOGLE_SHEET_TAB || 'clients';
  const header = [
    'ID', 'Name', 'Coach', 'Status', 'Currency', 'Rate', 'Billing',
    'Start', 'End', 'Source', 'Payment', 'Resign', 'Reason', 'Notes', 'Instagram',
  ];
  const rows = (clients || []).map((c) => [
    c.id || '', c.name || '', c.coach || '', c.status || '', c.currency || '',
    c.rate ?? '', c.billing || '', c.start || '', c.end || '', c.source || '',
    c.payment || '', c.resign || '', c.reason || '', c.notes || '', c.instagram || '',
  ]);
  await writeSheetTab(tab, header, rows);
}
async function mirrorLeadsToSheet(calls) {
  const tab = process.env.GOOGLE_SHEET_LEADS_TAB || 'leads';
  const header = ['ID', 'Name', 'Handle', 'Country', 'Source', 'Date', 'Booked', 'Showed', 'Signed', 'Notes'];
  const rows = (calls || []).map((l) => [
    l.id || '', l.name || '', l.handle || '', l.country || '', l.source || '',
    l.date || '', l.booked || '', l.showed || '', l.signed || '', l.notes || '',
  ]);
  await writeSheetTab(tab, header, rows);
}

export default async function handler(req, res) {
  const identity = getIdentity(req);
  if (!identity) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (req.method === 'GET') {
    try {
      const result = await kvCommand(['GET', KEY]);
      const data = result && result.result ? JSON.parse(result.result) : { clients: [], calls: [] };

      if (identity.role === 'admin') {
        return res.status(200).json(data);
      }
      // Coach role: only ever see their own clients, and no lead/call data
      // (that's outside "Client Pulse" scope). Filtered here, server-side,
      // so a restricted account's browser never receives the rest of the
      // team's data in the first place.
      const filteredClients = (data.clients || []).filter((c) => c.coach === identity.coach);
      return res.status(200).json({ clients: filteredClients, calls: [] });
    } catch (e) {
      return res.status(500).json({ error: String(e) });
    }
  }

  if (req.method === 'POST') {
    // Only admin can replace the full client/lead list. Coach accounts
    // never see the unfiltered list, so letting them POST here would
    // silently wipe out everyone else's data with just their own subset.
    if (identity.role !== 'admin') {
      return res.status(403).json({ ok: false, error: 'Not authorized to edit the full client/lead list' });
    }
    try {
      const payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      await kvCommand(['SET', KEY, JSON.stringify(payload)]);
      mirrorClientsToSheet(payload && payload.clients).catch((e) => console.error('Sheets clients mirror failed:', e));
      mirrorLeadsToSheet(payload && payload.calls).catch((e) => console.error('Sheets leads mirror failed:', e));
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ ok: false, error: String(e) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).send('Method not allowed');
}
