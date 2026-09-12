// db.js
// Storage for The Muster.
//
// Two backends behind one tiny API:
//   - DATABASE_URL set   -> Postgres. The whole document lives in a single
//                           JSONB row, which survives Render restarts, redeploys
//                           and the free tier's 15-minute spin-down.
//   - DATABASE_URL unset -> data/db.json on local disk. Fine for development.
//
// Either way the document is held in memory, so readDb() stays SYNCHRONOUS and
// every route in server.js is unchanged. writeDb() updates memory immediately
// and flushes to storage in the background, debounced so a burst of beer clicks
// costs one write instead of ten.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const FLUSH_DEBOUNCE_MS = 250;

const DEFAULT_DB = {
  users: {
    // username: { username, passwordHash, avatar, createdAt, lastSeen, lat, lng, locationUpdatedAt }
  },
  markers: [
    // { id, lat, lng, label, addedBy, createdAt }  -- "specified coordinates" pinned to the map
  ],
  beerList: [
    // { username, joinedAt }
  ],
  chat: [
    // { username, avatar, text, createdAt }
  ],
  beerCounter: [
    // { username, delta, createdAt }  -- +1/-1 clicks feeding the 12-hour mug counter
  ],
  pushSubscriptions: {
    // endpoint: { endpoint, username, subscription, createdAt }  -- Web Push targets
  }
};

let cache = null;        // the whole document, in memory
let pool = null;         // pg Pool, only when DATABASE_URL is set
let flushTimer = null;
let flushChain = Promise.resolve();
let pending = null;      // { promise, resolve } for writes not yet flushed

// ---------------------------------------------------------------- helpers ---

// Backfill any top-level keys added in newer versions (e.g. beerCounter) so
// older saved documents upgrade automatically instead of crashing.
function withDefaults(doc) {
  const out = doc && typeof doc === 'object' ? doc : {};
  Object.keys(DEFAULT_DB).forEach((key) => {
    if (!(key in out)) out[key] = JSON.parse(JSON.stringify(DEFAULT_DB[key]));
  });
  return out;
}

function readLocalFile() {
  try {
    if (!fs.existsSync(DB_PATH)) return JSON.parse(JSON.stringify(DEFAULT_DB));
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  } catch (e) {
    console.error('[db] data/db.json was unreadable, starting from defaults', e);
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

// ------------------------------------------------------------------- init ---

// Call once, before the HTTP server starts listening.
async function initDb() {
  const url = process.env.DATABASE_URL || '';

  if (!url) {
    cache = withDefaults(readLocalFile());
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    console.warn('[db] DATABASE_URL not set — using data/db.json. Fine locally; on Render this data is wiped on every restart.');
    return cache;
  }

  const { Pool } = require('pg');
  const isLocal = /@(localhost|127\.0\.0\.1)/.test(url);
  pool = new Pool({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 3,
    // Neon and friends suspend idle compute; the first query after a nap can
    // take a few seconds to wake it.
    connectionTimeoutMillis: 15000,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id         text PRIMARY KEY,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await pool.query("SELECT data FROM app_state WHERE id = 'main'");

  if (rows.length) {
    cache = withDefaults(rows[0].data);
    console.log('[db] loaded from Postgres');
  } else {
    // First boot against an empty database: carry over whatever is in
    // data/db.json so an existing deployment doesn't start from nothing.
    cache = withDefaults(readLocalFile());
    await persist(JSON.stringify(cache));
    console.log('[db] initialised Postgres (seeded from data/db.json)');
  }

  return cache;
}

// ------------------------------------------------------------------ write ---

async function persist(json) {
  if (pool) {
    await pool.query(
      `INSERT INTO app_state (id, data, updated_at)
       VALUES ('main', $1::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [json]
    );
  } else {
    await fs.promises.writeFile(DB_PATH, JSON.stringify(JSON.parse(json), null, 2));
  }
}

function runFlush() {
  flushTimer = null;
  const settled = pending;
  pending = null;

  const snapshot = JSON.stringify(cache);
  flushChain = flushChain.then(() =>
    persist(snapshot).then(
      () => settled.resolve(),
      (err) => {
        // Deliberately resolve rather than reject: routes await writeDb() without
        // a try/catch, so a rejection would hang the request. The write is lost,
        // but the in-memory state is intact and the next write retries it all.
        console.error('[db] write failed, keeping in-memory state', err);
        settled.resolve();
      }
    )
  );
}

function readDb() {
  if (!cache) throw new Error('initDb() must be awaited before readDb() is called.');
  return cache;
}

function writeDb(db) {
  cache = db;

  if (!pending) {
    let resolve;
    const promise = new Promise((res) => { resolve = res; });
    pending = { promise, resolve };
  }
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(runFlush, FLUSH_DEBOUNCE_MS);

  return pending.promise;
}

// Write anything still queued — used on shutdown so Render's SIGTERM during a
// deploy doesn't drop the last few seconds of activity.
async function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    runFlush();
  }
  await flushChain;
}

function getPool() {
  return pool;
}

module.exports = { initDb, readDb, writeDb, flushNow, getPool };
