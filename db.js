// db.js
// Tiny file-backed "database" — plenty for a friends-group app.
// Everything lives in data/db.json. No native modules, no external DB to set up.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');

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
  ]
};

function ensureDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
  }
}

function readDb() {
  ensureDb();
  const raw = fs.readFileSync(DB_PATH, 'utf-8');
  try {
    const parsed = JSON.parse(raw);
    // Backfill any top-level keys added in newer versions (e.g. beerCounter)
    // so existing data/db.json files upgrade automatically instead of crashing.
    let changed = false;
    Object.keys(DEFAULT_DB).forEach((key) => {
      if (!(key in parsed)) {
        parsed[key] = JSON.parse(JSON.stringify(DEFAULT_DB[key]));
        changed = true;
      }
    });
    if (changed) fs.writeFileSync(DB_PATH, JSON.stringify(parsed, null, 2));
    return parsed;
  } catch (e) {
    console.error('db.json was corrupt, resetting to defaults', e);
    fs.writeFileSync(DB_PATH, JSON.stringify(DEFAULT_DB, null, 2));
    return JSON.parse(JSON.stringify(DEFAULT_DB));
  }
}

// Very small write queue so concurrent requests don't clobber each other.
let writeChain = Promise.resolve();
function writeDb(db) {
  writeChain = writeChain.then(
    () =>
      new Promise((resolve, reject) => {
        fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), (err) => {
          if (err) return reject(err);
          resolve();
        });
      })
  );
  return writeChain;
}

module.exports = { readDb, writeDb, ensureDb };
