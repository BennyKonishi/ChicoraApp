# The Muster

A small hangout app for a friend group: log in, see everyone's live location on a
map, drop labeled pins, join the "beer" board, chat, and check a live Clash Royale
clan dashboard.

Stack: **Node.js + Express + Socket.IO**, a tiny JSON-file database (no separate
database server to set up), and a vanilla HTML/CSS/JS frontend with **Leaflet**
for the map. Nothing here needs a build step.

## What's included

| Feature | How it works |
|---|---|
| Login / signup | Username + password (hashed with bcrypt), duplicate usernames blocked, password confirmed twice, avatar icon chosen at signup |
| Hover/click GIF | A static poster image swaps to an animated GIF on hover or tap (top-left badge) |
| Live map | Each browser shares its geolocation every ~10s; everyone's dot updates in real time via Socket.IO |
| Named map pins | "Drop pin here" adds a labeled marker at your current location, visible to everyone |
| Beer board | One button adds/removes you from a shared list showing your name, icon, and when you joined |
| Group chat | Real-time chat over Socket.IO, with the last 100 messages persisted |
| Clan dashboard | Server-side call to the official Clash Royale API for a clan (defaults to "Chicora Goblins") |

## 1. Run it locally

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd beer-app
npm install
cp .env.example .env
# edit .env — at minimum set SESSION_SECRET to any long random string
npm start
```

Open **http://localhost:3000**. Sign up with a username, password, and an icon,
and you're in. Open it in a second browser (or incognito window) to see a second
"friend" appear on the map and in chat.

The whole database is one file: `data/db.json`. Delete it any time to reset
everything. It's git-ignored on purpose — don't commit it, since it holds
password hashes.

## 2. The Clash Royale dashboard

This is the one piece that needs a little setup, because Supercell's official
API only answers requests from IP addresses you've explicitly approved.

1. Go to https://developer.clashroyale.com and sign in.
2. Under **My Account → Create New Key**, make a key.
3. **The key needs the IP address of wherever this app is actually running**,
   not your own computer's IP (unless you're only ever running it locally).
   - Running locally to test: use whatever https://api.ipify.org shows you.
   - Deployed to a host with a fixed IP: use that host's IP.
   - Deployed to a host **without** a fixed outbound IP (Render, Railway, Vercel,
     etc. usually fall in this bucket): you have two options —
     a) look up that platform's static outbound IP add-on if it has one, or
     b) use RoyaleAPI's free proxy, which has one stable IP you whitelist once:
        whitelist `45.79.218.79` on your key, then set
        `CLASH_ROYALE_API_BASE=https://proxy.royaleapi.dev/v1` in `.env`.
        See https://docs.royaleapi.com/proxy for details.
4. Put the key in `.env` as `CLASH_ROYALE_API_TOKEN`.
5. Optional but recommended: look up "Chicora Goblins" on https://royaleapi.com,
   copy its clan tag (looks like `#2Y0GC8V0`), and set `CLAN_TAG` in `.env`. This
   skips a name-search API call and guarantees you get the exact right clan.

If the token or tag is wrong, the dashboard card shows a plain-language error
instead of crashing the rest of the app.

## 3. Put your own GIF in

Drop your own files in over the placeholders (same names, or update the two
`<img>` tags in `public/index.html`):

- `public/assets/gif/mascot.gif` — the animated version
- `public/assets/gif/mascot-poster.png` — a static frame shown before hover/click

## 4. Hosting it so your friends can actually open it

This can't run out of a sandbox with no persistent public address — it needs a
real (even if tiny/free) host. The easiest options for a Node + WebSocket app
like this one:

### Render (free tier, simplest)
1. Push this folder to a GitHub repo.
2. On https://render.com: **New → Web Service**, connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add your `.env` values under **Environment**.
5. Deploy. Render gives you a public `https://your-app.onrender.com` URL —
   send that to your friends. (Free tier sleeps after inactivity, so the first
   load after a while takes ~30s to wake up.)

### Railway
Same idea: connect the GitHub repo, add the environment variables from `.env`,
Railway detects the Node app and runs `npm start` automatically.

### Fly.io
Good if you want the app to stay warm (no sleep) on a free/cheap always-on VM;
`fly launch` in this folder will scaffold the config for you, then `fly deploy`.

Whichever you pick, make sure to:
- Set every variable from `.env.example` in the host's environment settings
  (never commit the actual `.env` file).
- Use `https://` — browsers block geolocation on plain `http://` for anything
  other than `localhost`, so live location sharing needs a real SSL URL, which
  all three hosts above provide automatically.

## Notes on scope / things to harden if this grows past a friend group

- Sessions are stored in memory, so restarting the server logs everyone out.
  Fine for casual use; swap in `connect-redis` or similar if you want it to
  survive restarts.
- `data/db.json` is a flat file — perfect for dozens of users, not thousands.
  If you outgrow it, the `db.js` module is a thin enough wrapper that swapping
  in SQLite/Postgres only touches that one file.
- There's no email/password-reset flow — if someone forgets their password,
  the fix today is deleting their entry from `data/db.json` and signing up
  again.
