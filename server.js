// server.js
// Express + Socket.IO backend for "The Muster":
//   - username/password auth (signup + login), avatar chosen at signup
//   - live location sharing between logged-in friends
//   - named map markers ("specified coordinates" with text)
//   - a "beer" board that anyone can join with one click
//   - a real-time group chat
//   - a small dashboard pulling live clan info from the Clash Royale API

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const { readDb, writeDb } = require('./db');
const { getClanInfo } = require('./clashroyale');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-please-change-me';

// Keep this in sync with public/js/avatars.js on the client.
const AVATAR_IDS = [
  'fox', 'wolf', 'bear', 'owl', 'otter', 'stag',
  'cat', 'raven', 'frog', 'hawk', 'panda', 'turtle',
];

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    sameSite: 'lax',
  },
});
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

// ---------- auth routes ----------

app.post('/api/signup', async (req, res) => {
  const { username, password, confirmPassword, avatar } = req.body || {};

  if (!username || !password || !confirmPassword) {
    return res.status(400).json({ error: 'Username and both password fields are required.' });
  }
  const cleanUsername = String(username).trim();
  if (cleanUsername.length < 3 || cleanUsername.length > 20) {
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
  if (!AVATAR_IDS.includes(avatar)) {
    return res.status(400).json({ error: 'Please choose a valid avatar icon.' });
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
    avatar,
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

server.listen(PORT, () => {
  console.log(`The Muster is running at http://localhost:${PORT}`);
});
