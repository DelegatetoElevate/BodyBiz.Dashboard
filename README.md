# BODY BIZ Dashboard — Deploy Guide

## How it works
- `middleware.js` runs on **every** request before any file is served.
  It checks for a valid, signed `bb_auth` cookie that encodes *who* is
  logged in (name, role, coach), not just a shared password. No cookie →
  redirected to `/login.html`. The dashboard HTML/JS/data is never sent
  to an unauthenticated browser.
- `login.html` is the code-entry screen — one input, no separate login
  per role. Whatever code someone types determines who they are.
- `api/login.js` looks the submitted code up in `ACCESS_CODES` (an
  environment variable — never shipped to the browser). On a match it
  sets two cookies: `bb_auth` (HttpOnly, signed — the real credential)
  and `bb_identity` (readable by the page's JS, just for showing the
  right name/banner — not trusted for anything security-relevant).
- `api/data.js` and `api/pulse.js` re-verify `bb_auth` on every request
  and filter what they return based on the *real* signed identity —
  an admin gets everything, a coach only ever receives their own
  clients' data, at the network level, not just hidden in the UI.
- `index.html` is your original dashboard. The old in-app second login
  (the `BUSINESS2026` / `TOME2026` code screen) has been replaced —
  identity now comes from the outer login above, so there's only one
  login, and it determines both site access and role/view together.
  The font link was also fixed (it pointed at a file on your local Mac,
  which wouldn't resolve once hosted).

## Roles

| Person | Code | Access |
|---|---|---|
| Luke (Admin) | `BUSINESS2026` | Full dashboard — all clients, all leads, all tabs |
| Tome | `TOME2026` | Client Pulse only, Tome's clients only |
| Kane | `KANE2026` | Client Pulse only, Kane's clients only |
| Stevan | `STEVAN2026` | Client Pulse only, Stevan's clients only |

Coach accounts can view and update **Pulse status/notes** for their own
clients only — they cannot see or edit the full client list, leads,
revenue, or any other tab. This is enforced server-side (see `api/data.js`
and `api/pulse.js`), not just hidden in the UI, so it holds even if
someone pokes around in dev tools.

## One-time setup

1. Push this folder to a GitHub repo (or `vercel deploy` directly from here).
2. **Add shared storage:** in the Vercel project → **Storage** tab →
   **Create Database** → choose a KV / Redis store (Vercel's own KV
   product, powered by Upstash) → connect it to this project. Vercel
   automatically adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` — you
   don't set these by hand. This is what makes client data and Pulse
   status shared across everyone who logs in, instead of stuck in one
   person's browser.
3. In the Vercel project settings → **Environment Variables**, add:
   - `ACCESS_CODES` — one JSON value with all four logins baked in.
     Paste this exactly:
     ```json
     {"BUSINESS2026":{"name":"Luke","role":"admin","coach":null},"TOME2026":{"name":"Tome","role":"coach","coach":"Tome"},"KANE2026":{"name":"Kane","role":"coach","coach":"Kane"},"STEVAN2026":{"name":"Stevan","role":"coach","coach":"Stevan"}}
     ```
   - `AUTH_SECRET` — any long random string, used internally to sign
     the login cookie. Generate one with:
     ```
     openssl rand -hex 32
     ```
     Nobody types this in — it's not a login code, just an internal
     signing key.
4. Deploy (or redeploy) so the env vars take effect.
5. Visit the site — everyone lands on the same login screen and types
   their own code (`BUSINESS2026`, `TOME2026`, `KANE2026`, or
   `STEVAN2026`). The cookie lasts 30 days per person, so no one needs
   to re-enter it every visit.
6. The first admin load after setup seeds the shared store with the
   existing baked-in client list. After that, every add, edit, status
   change, or note — from anyone logged in, on any device — is saved to
   the shared store and shows up for everyone else within about a
   second.

## Optional: mirror clients + leads to a Google Sheet

The dashboard's real data still lives in Vercel KV — this just keeps a
read-only, always-current copy in a spreadsheet anyone can open, filter,
or export from. It's entirely optional; skip this section and everything
above still works exactly the same. (Coach accounts don't see this data
either way — the Sheet mirror only reflects what admin edits.)

1. **The Sheet.** ✅ Already set up —
   ["Dashboard Client Log 2026"](https://docs.google.com/spreadsheets/d/1Gixw8dA4iD_BeLTDR7vhPL2fJPooHozpkoItOYlTsLs/edit),
   with a `clients` tab and a `leads` tab. Its Sheet ID (the part of the
   URL between `/d/` and `/edit`) is:
   ```
   1Gixw8dA4iD_BeLTDR7vhPL2fJPooHozpkoItOYlTsLs
   ```
2. **Create a Google Cloud service account:**
   - Go to console.cloud.google.com → create or pick a project.
   - Enable the **Google Sheets API** for that project.
   - Go to IAM & Admin → Service Accounts → Create Service Account (any
     name, e.g. "bodybiz-sheets-writer"). No special roles needed.
   - Open the service account → Keys → Add Key → Create new key → JSON.
     This downloads a JSON file — keep it private, it's a credential.
3. **Share the Sheet** with the service account: open the JSON file,
   copy the `client_email` value, then share your Google Sheet with that
   email address as an **Editor** (same as sharing with a person).
4. **Add the following environment variables** in Vercel:
   - `GOOGLE_SHEET_ID` — `1Gixw8dA4iD_BeLTDR7vhPL2fJPooHozpkoItOYlTsLs`
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL` — the `client_email` from the JSON file.
   - `GOOGLE_PRIVATE_KEY` — the `private_key` value from the JSON file,
     pasted exactly as-is.
   - `GOOGLE_SHEET_TAB` — *(optional, defaults to `clients`)*
   - `GOOGLE_SHEET_LEADS_TAB` — *(optional, defaults to `leads`)*
5. Redeploy.

If the three required variables (`GOOGLE_SHEET_ID`,
`GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`) are missing, both
mirror steps are silently skipped and the dashboard behaves exactly as it
does without this section.

## Changing or adding codes later
Edit the `ACCESS_CODES` JSON value in Vercel's env var settings (add a
person, change a code, change someone's role) and redeploy. Anyone with
an old session will need to log in again with the updated code the next
time their cookie expires or is cleared — or you can force that
immediately for everyone by rotating `AUTH_SECRET`, which invalidates
all existing sessions at once.

## Notes
- This protects the *whole* deployment — every route, asset, and the
  data baked into `index.html`, since the middleware runs before any
  static file is returned.
- Added a `noindex` header in `vercel.json` so search engines won't
  crawl or index this deployment.
- **What's shared vs. local:** clients (add/edit/status/notes), sales
  calls/leads, and Pulse status are all synced through shared storage —
  everyone with permission sees the same data. Touch-point logs and
  follow-up logs still save to each browser's local storage only, same
  as the original file. Say the word if you'd like those folded into
  shared storage too — same pattern, just more surface area to wire up.
- The optional Google Sheets mirror covers the `clients` and `leads`
  lists (admin-edited data), not Pulse status.
