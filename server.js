// server.js
// Express + Socket.IO backend for "The Muster":
//   - username/password auth (signup + login), avatar chosen at signup
//   - live location sharing between logged-in friends
//   - named map markers ("specified coordinates" with text)
//   - a "beer" board that anyone can join with one click
//   - a real-time group chat
//   - a small dashboard pulling live clan info from the Clash Royale API

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const { initDb, readDb, writeDb, flushNow } = require('./db');
const { getClanInfo } = require('./clashroyale');
const webpush = require('web-push');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-please-change-me';

// ---- beer alert sound ----
// Whatever audio file sits in public/assets/sounds is the alert sound, so
// dropping in "PG_Laugh.mp3" works without renaming it to something specific.
function findBeerSound() {
  try {
    const dir = path.join(__dirname, 'public', 'assets', 'sounds');
    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.(mp3|m4a|aac|ogg|wav)$/i.test(f))
      .sort();
    // A file literally named beer.* wins if several are present.
    const preferred = files.find((f) => /^beer\./i.test(f)) || files[0];
    return preferred ? `/assets/sounds/${encodeURIComponent(preferred)}` : '';
  } catch (e) {
    return '';
  }
}
const BEER_SOUND_URL = findBeerSound();
console.log(BEER_SOUND_URL ? `[sound] alert sound: ${BEER_SOUND_URL}` : '[sound] no audio file in public/assets/sounds — using the synthesised clink');

// ---- push notifications ----
// Browsers hold a subscription tied to this VAPID key pair. Rotating the keys
// invalidates every existing subscription, so treat them as permanent.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const pushEnabled = Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
  );
} else {
  console.warn('[push] VAPID keys not set — notifications are disabled.');
}

// Keep this in sync with public/js/avatars.js on the client.
// These are "status" options chosen from the main page, not at signup.
const AVATAR_IDS = ['boba_junky', 'horny', 'rodent', 'gnome', 'john_blue'];

// ---- beer counter settings ----
const BEER_GOAL = 50;
const BEER_MILESTONE_STEP = 3; // small celebration every 3 beers, big one at BEER_GOAL
const BEER_WINDOW_MS = 12 * 60 * 60 * 1000; // the counter only looks at the last 12 hours
const BEER_RETAIN_MS = 24 * 60 * 60 * 1000; // keep a day of history on disk, prune beyond that

function beerCountInWindow(events, now) {
  const windowStart = now - BEER_WINDOW_MS;
  const sum = events
      .filter((e) => e.createdAt >= windowStart)
      .reduce((total, e) => total + e.delta, 0);
  return Math.max(0, Math.min(BEER_GOAL, sum));
}

function beerLogForClient(events, now, db) {
  const windowStart = now - BEER_WINDOW_MS;
  return events
      .filter((e) => e.createdAt >= windowStart)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 50)
      .map((e) => ({
        username: e.username,
        avatar: db.users[e.username] ? db.users[e.username].avatar : null,
        delta: e.delta,
        createdAt: e.createdAt,
      }));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sessions. With no store, express-session keeps them in memory, so every
// restart (and every Render spin-down) logs everybody out. When DATABASE_URL is
// set we park them in the same Postgres instead, so logins survive a restart.
const sessionOptions = {
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax',
  },
};

if (process.env.DATABASE_URL) {
  const PgSession = require('connect-pg-simple')(session);
  const isLocalDb = /@(localhost|127\.0\.0\.1)/.test(process.env.DATABASE_URL);
  sessionOptions.store = new PgSession({
    conObject: {
      connectionString: process.env.DATABASE_URL,
      ssl: isLocalDb ? false : { rejectUnauthorized: false },
      max: 2,
    },
    tableName: 'session',
    createTableIfMissing: true,
  });
}

const sessionMiddleware = session(sessionOptions);
app.use(sessionMiddleware);

// Share the session with Socket.IO so sockets know who's logged in.
io.engine.use(sessionMiddleware);

// ---------- helpers ----------

function publicUser(u) {
  if (!u) return null;
  return {
    username: u.username,
    avatar: u.avatar,
    lat: typeof u.lat === 'number' ? u.lat : null,
    lng: typeof u.lng === 'number' ? u.lng : null,
    locationUpdatedAt: u.locationUpdatedAt || null,
  };
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.username) {
    return res.status(401).json({ error: 'Not logged in.' });
  }
  next();
}

async function broadcastPresence() {
  const db = readDb();
  const users = Object.values(db.users).map(publicUser);
  io.emit('presence:update', { users });
}

async function broadcastBeer() {
  const db = readDb();
  const list = db.beerList.map((entry) => {
    const u = db.users[entry.username];
    return {
      username: entry.username,
      joinedAt: entry.joinedAt,
      avatar: u ? u.avatar : null,
    };
  });
  io.emit('beer:update', { beerList: list });
}

function broadcastBeerCounter(extra) {
  const db = readDb();
  const now = Date.now();
  const payload = Object.assign(
      {
        count: beerCountInWindow(db.beerCounter, now),
        log: beerLogForClient(db.beerCounter, now, db),
      },
      extra
  );
  io.emit('beercounter:update', payload);
}

// ---------- auth routes ----------

app.post('/api/signup', async (req, res) => {
  const { username, password, confirmPassword } = req.body || {};

  if (!username || !password || !confirmPassword) {
    return res.status(400).json({ error: 'Username and both password fields are required.' });
  }
  const cleanUsername = String(username).trim();
  if (cleanUsername.length < 3 || cleanUsername.length > 12) {
    return res.status(400).json({ error: 'Username must be 3-20 characters.' });
  }
  if (!/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
    return res.status(400).json({ error: 'Username can only contain letters, numbers, and underscores.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  if (password !== confirmPassword) {
    return res.status(400).json({ error: 'Passwords do not match.' });
  }

  const db = readDb();
  const key = cleanUsername.toLowerCase();
  const duplicate = Object.keys(db.users).some((k) => k.toLowerCase() === key);
  if (duplicate) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  db.users[cleanUsername] = {
    username: cleanUsername,
    passwordHash,
    avatar: null, // status is chosen from the main page after logging in
    createdAt: Date.now(),
    lastSeen: Date.now(),
    lat: null,
    lng: null,
    locationUpdatedAt: null,
  };
  await writeDb(db);

  req.session.username = cleanUsername;
  res.json({ user: publicUser(db.users[cleanUsername]) });
  broadcastPresence();
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  const db = readDb();
  const key = Object.keys(db.users).find(
    (k) => k.toLowerCase() === String(username).trim().toLowerCase()
  );
  const user = key ? db.users[key] : null;
  if (!user) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }
  user.lastSeen = Date.now();
  await writeDb(db);
  req.session.username = user.username;
  res.json({ user: publicUser(user) });
  broadcastPresence();
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session || !req.session.username) return res.json({ user: null });
  const db = readDb();
  const user = db.users[req.session.username];
  if (!user) return res.json({ user: null });
  res.json({ user: publicUser(user), avatars: AVATAR_IDS });
});

app.get('/api/avatars', (req, res) => res.json({ avatars: AVATAR_IDS }));

// Front-end config. The CARTO key is a browser-side basemap key (it ends up in
// tile URLs either way), so serving it here just keeps it out of the source.
app.get('/api/config', (req, res) => {
  res.json({
    cartoApiKey: process.env.CARTO_API_KEY || '',
    vapidPublicKey: VAPID_PUBLIC_KEY,
    pushEnabled,
    beerSoundUrl: BEER_SOUND_URL,
  });
});

app.post('/api/status', requireAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!AVATAR_IDS.includes(status)) {
    return res.status(400).json({ error: 'Not a valid status.' });
  }
  const db = readDb();
  const user = db.users[req.session.username];
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  user.avatar = status;
  await writeDb(db);
  res.json({ user: publicUser(user) });
  broadcastPresence();
});

// ---------- location + markers ----------

app.post('/api/location', requireAuth, async (req, res) => {
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat and lng must be numbers.' });
  }
  const db = readDb();
  const user = db.users[req.session.username];
  if (!user) return res.status(401).json({ error: 'Not logged in.' });
  user.lat = lat;
  user.lng = lng;
  user.locationUpdatedAt = Date.now();
  user.lastSeen = Date.now();
  await writeDb(db);
  res.json({ ok: true });
  broadcastPresence();
});

app.get('/api/locations', requireAuth, (req, res) => {
  const db = readDb();
  res.json({ users: Object.values(db.users).map(publicUser) });
});

app.get('/api/markers', requireAuth, (req, res) => {
  const db = readDb();
  res.json({ markers: db.markers });
});

app.post('/api/markers', requireAuth, async (req, res) => {
  const { lat, lng, label } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number' || !label || !label.trim()) {
    return res.status(400).json({ error: 'lat, lng, and a label are required.' });
  }
  const db = readDb();
  const marker = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    lat,
    lng,
    label: label.trim().slice(0, 60),
    addedBy: req.session.username,
    createdAt: Date.now(),
  };
  db.markers.push(marker);
  await writeDb(db);
  io.emit('markers:update', { markers: db.markers });
  res.json({ marker });
});

// ---------- beer board ----------

app.get('/api/beer', requireAuth, (req, res) => {
  const db = readDb();
  const list = db.beerList.map((entry) => {
    const u = db.users[entry.username];
    return { username: entry.username, joinedAt: entry.joinedAt, avatar: u ? u.avatar : null };
  });
  res.json({ beerList: list });
});

app.post('/api/beer/join', requireAuth, async (req, res) => {
  const db = readDb();
  const already = db.beerList.some((e) => e.username === req.session.username);
  if (!already) {
    db.beerList.push({ username: req.session.username, joinedAt: Date.now() });
    await writeDb(db);
    broadcastBeer();
  }
  res.json({ ok: true });
});

app.post('/api/beer/leave', requireAuth, async (req, res) => {
  const db = readDb();
  db.beerList = db.beerList.filter((e) => e.username !== req.session.username);
  await writeDb(db);
  broadcastBeer();
  res.json({ ok: true });
});

// ---------- beer counter (rolling 12-hour mug) ----------

// ---------- push notifications ----------

app.post('/api/push/subscribe', requireAuth, async (req, res) => {
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Missing subscription.' });

  const db = readDb();
  if (!db.pushSubscriptions) db.pushSubscriptions = {};
  // Keyed by endpoint, so re-subscribing the same browser updates in place
  // instead of piling up duplicates.
  db.pushSubscriptions[sub.endpoint] = {
    endpoint: sub.endpoint,
    username: req.session.username,
    subscription: sub,
    createdAt: Date.now(),
  };
  await writeDb(db);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', requireAuth, async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint.' });

  const db = readDb();
  if (db.pushSubscriptions && db.pushSubscriptions[endpoint]) {
    delete db.pushSubscriptions[endpoint];
    await writeDb(db);
  }
  res.json({ ok: true });
});

// Fan a beer out to everyone except whoever clicked — they already saw the
// confetti. Dead subscriptions (uninstalled apps, revoked permission) answer
// 404/410 and are pruned so the list doesn't rot.
async function sendBeerPush({ actor, count }) {
  if (!pushEnabled) return;

  const db = readDb();
  const targets = Object.values(db.pushSubscriptions || {}).filter((s) => s.username !== actor);
  if (!targets.length) return;

  const payload = JSON.stringify({
    title: `${actor} cracked one 🍺`,
    body: `${count}/${BEER_GOAL} beers in the last 12 hours.`,
    tag: 'beer-counter',
    url: '/',
  });

  const dead = [];
  await Promise.all(
    targets.map((target) =>
      webpush.sendNotification(target.subscription, payload).catch((err) => {
        if (err.statusCode === 404 || err.statusCode === 410) dead.push(target.endpoint);
        else console.error('[push] send failed', err.statusCode || err.message);
      })
    )
  );

  if (dead.length) {
    const fresh = readDb();
    dead.forEach((endpoint) => delete fresh.pushSubscriptions[endpoint]);
    await writeDb(fresh);
    console.log(`[push] pruned ${dead.length} dead subscription(s)`);
  }
}

app.get('/api/beercounter', requireAuth, (req, res) => {
  const db = readDb();
  const now = Date.now();
  res.json({
    count: beerCountInWindow(db.beerCounter, now),
    log: beerLogForClient(db.beerCounter, now, db),
    goal: BEER_GOAL,
  });
});

app.post('/api/beercounter/click', requireAuth, async (req, res) => {
  const { delta } = req.body || {};
  if (delta !== 1 && delta !== -1) {
    return res.status(400).json({ error: 'delta must be 1 or -1.' });
  }
  const db = readDb();
  const now = Date.now();

  const beforeCount = beerCountInWindow(db.beerCounter, now);
  db.beerCounter.push({ username: req.session.username, delta, createdAt: now });
  // Keep a day of history on disk; the 12-hour window is applied on read.
  db.beerCounter = db.beerCounter.filter((e) => now - e.createdAt < BEER_RETAIN_MS);
  await writeDb(db);

  const afterCount = beerCountInWindow(db.beerCounter, now);
  const celebrate = delta > 0 && beforeCount < BEER_GOAL && afterCount >= BEER_GOAL;
  // A milestone is any multiple of BEER_MILESTONE_STEP crossed upward by this click,
  // except the goal itself — that gets the bigger "celebrate" treatment instead.
  const milestone =
      !celebrate && delta > 0 && afterCount > beforeCount && afterCount % BEER_MILESTONE_STEP === 0
          ? afterCount
          : null;

  res.json({ count: afterCount, celebrate, milestone });
  broadcastBeerCounter({ celebrate, milestone, triggeredBy: req.session.username });

  // Only on the way up, and never awaited — a slow push service must not hold
  // up the response to the person who tapped.
  if (delta > 0) {
    sendBeerPush({ actor: req.session.username, count: afterCount }).catch((err) =>
      console.error('[push] fan-out failed', err)
    );
  }
});

// ---------- chat history ----------

app.get('/api/chat/history', requireAuth, (req, res) => {
  const db = readDb();
  res.json({ messages: db.chat.slice(-100) });
});

// ---------- clash royale clan dashboard ----------

app.get('/api/clan', requireAuth, async (req, res) => {
  try {
    const info = await getClanInfo({ force: req.query.force === '1' });
    res.json({ clan: info });
  } catch (err) {
    console.error('Clash Royale API error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------- sockets: chat + presence ----------

io.on('connection', (socket) => {
  const session = socket.request.session;
  const username = session && session.username;

  if (!username) {
    // Not logged in — allow the connection to sit idle, but ignore chat from it.
    socket.emit('auth:error', { error: 'Not logged in.' });
  }

  socket.on('chat:send', async (payload) => {
    const currentSession = socket.request.session;
    const user = currentSession && currentSession.username;
    if (!user) return;
    const text = (payload && payload.text ? String(payload.text) : '').trim().slice(0, 500);
    if (!text) return;

    const db = readDb();
    const u = db.users[user];
    const message = {
      username: user,
      avatar: u ? u.avatar : null,
      text,
      createdAt: Date.now(),
    };
    db.chat.push(message);
    if (db.chat.length > 500) db.chat = db.chat.slice(-500);
    await writeDb(db);
    io.emit('chat:message', message);
  });
});

// Render terminates the old instance on deploy; flush anything still queued.
['SIGTERM', 'SIGINT'].forEach((signal) => {
  process.once(signal, async () => {
    console.log(`Received ${signal}, saving before exit...`);
    try { await flushNow(); } catch (e) { console.error('Final save failed', e); }
    process.exit(0);
  });
});

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`The Muster is running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Could not open the database — refusing to start.', err);
    process.exit(1);
  });
