// clashroyale.js
// Talks to the official Clash Royale API (https://developer.clashroyale.com)
// to pull clan info for a given clan (defaults to "Chicora Goblins").
//
// You need your own API token — see README.md for setup, including the
// IP-whitelist step, which is the part almost everyone trips over.

const fetch = require('node-fetch');

// Defaults to the official API. If your host has no fixed outbound IP, set
// CLASH_ROYALE_API_BASE=https://proxy.royaleapi.dev/v1 in .env instead — see
// README.md's "Clash Royale dashboard" section.
const API_BASE = process.env.CLASH_ROYALE_API_BASE || 'https://api.clashroyale.com/v1';
const CLAN_NAME = process.env.CLAN_NAME || 'Chicora Goblins';
let CLAN_TAG = process.env.CLAN_TAG || '#RUVYUJUV'; // e.g. "#2Y0GC8V0" — set this once you know it, it's faster & exact

let cache = { data: null, fetchedAt: 0 };
const CACHE_MS = 5 * 60 * 1000; // 5 minutes — be polite to the API & avoid rate limits

function authHeaders() {
  const token = process.env.CLASH_ROYALE_API_TOKEN;
  if (!token) {
    throw new Error(
      'CLASH_ROYALE_API_TOKEN is not set. Add it to your .env file (see README.md).'
    );
  }
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
}

async function findClanTagByName(name) {
  'const url = `${API_BASE}/clans?name=${encodeURIComponent(name)}&limit=5`;'
  const url = 'https://api.clashroyale.com/v1/clans/%23RUVYUJUV/members?limit=1000'
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clan search failed (${res.status}): ${body}`);
  }
  const json = await res.json();
  const items = json.items || [];
  const exact = items.find(
    (c) => c.name.toLowerCase() === name.toLowerCase()
  );
  const match = exact || items[0];
  if (!match) throw new Error(`No clan found matching "${name}"`);
  return match.tag; // includes leading '#'
}

async function fetchClan(tag) {
  const url = `${API_BASE}/clans/${encodeURIComponent(tag)}`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Clan lookup failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function getClanInfo({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.data && now - cache.fetchedAt < CACHE_MS) {
    return { ...cache.data, cached: true };
  }

  if (!CLAN_TAG) {
    CLAN_TAG = await findClanTagByName(CLAN_NAME);
  }

  const raw = await fetchClan(CLAN_TAG);

  const shaped = {
    name: raw.name,
    tag: raw.tag,
    description: raw.description,
    badgeId: raw.badgeId,
    clanScore: raw.clanScore,
    clanWarTrophies: raw.clanWarTrophies,
    location: raw.location && raw.location.name,
    members: raw.members,
    memberList: (raw.memberList || []).map((m) => ({
      name: m.name,
      tag: m.tag,
      role: m.role,
      expLevel: m.expLevel,
      trophies: m.trophies,
      donations: m.donations,
      clanRank: m.clanRank,
    })),
    fetchedAt: now,
    cached: false,
  };

  cache = { data: shaped, fetchedAt: now };
  return shaped;
}

module.exports = { getClanInfo };
