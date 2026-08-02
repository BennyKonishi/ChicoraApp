// app.js — client-side logic for The Muster.
// Talks to the Express API for auth/data, and to Socket.IO for live updates.

(function () {
  'use strict';

  // ---------------- state ----------------
  let me = null;               // { username, avatar, lat, lng, ... }
  let socket = null;
  let map = null;
  let userMarkers = {};        // username -> L.marker
  let pinMarkers = {};         // id -> L.marker
  let lastKnownPos = null;     // { lat, lng }
  let lastSentAt = 0;
  let joinedBeer = false;

  // ---------------- helpers ----------------
  function $(sel) { return document.querySelector(sel); }
  function el(tag, cls) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }
  function timeAgo(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  }
  function avatarPill(container, avatarId) {
    const a = avatarById(avatarId);
    container.textContent = a.emoji;
    container.style.background = a.bg;
    container.style.color = '#fff';
  }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      headers: { 'Content-Type': 'application/json' },
    }, opts));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  // ---------------- avatar picker (signup) ----------------
  function renderAvatarGrid() {
    const grid = $('#avatar-grid');
    grid.innerHTML = '';
    let selected = null;
    AVATARS.forEach((a) => {
      const btn = el('button', 'avatar-choice');
      btn.type = 'button';
      btn.textContent = a.emoji;
      btn.style.background = a.bg;
      btn.dataset.id = a.id;
      btn.addEventListener('click', () => {
        grid.querySelectorAll('.avatar-choice').forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        selected = a.id;
        grid.dataset.selected = selected;
      });
      grid.appendChild(btn);
    });
  }

  // ---------------- auth view ----------------
  function showAuthError(msg) {
    const box = $('#auth-error');
    box.textContent = msg;
    box.classList.remove('hidden');
  }
  function clearAuthError() {
    $('#auth-error').classList.add('hidden');
  }

  function wireAuthTabs() {
    const tabLogin = $('#tab-login');
    const tabSignup = $('#tab-signup');
    const loginForm = $('#login-form');
    const signupForm = $('#signup-form');

    tabLogin.addEventListener('click', () => {
      tabLogin.classList.add('active');
      tabSignup.classList.remove('active');
      loginForm.classList.remove('hidden');
      signupForm.classList.add('hidden');
      clearAuthError();
    });
    tabSignup.addEventListener('click', () => {
      tabSignup.classList.add('active');
      tabLogin.classList.remove('active');
      signupForm.classList.remove('hidden');
      loginForm.classList.add('hidden');
      clearAuthError();
    });
  }

  function wireAuthForms() {
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAuthError();
      const username = $('#login-username').value.trim();
      const password = $('#login-password').value;
      try {
        const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
        enterApp(data.user);
      } catch (err) {
        showAuthError(err.message);
      }
    });

    $('#signup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      clearAuthError();
      const username = $('#signup-username').value.trim();
      const password = $('#signup-password').value;
      const password2 = $('#signup-password2').value;
      const avatar = $('#avatar-grid').dataset.selected;
      if (password !== password2) {
        showAuthError('Passwords do not match.');
        return;
      }
      if (!avatar) {
        showAuthError('Pick an icon before signing up.');
        return;
      }
      try {
        const data = await api('/api/signup', {
          method: 'POST',
          body: JSON.stringify({ username, password, confirmPassword: password2, avatar }),
        });
        enterApp(data.user);
      } catch (err) {
        showAuthError(err.message);
      }
    });
  }

  function wireGifBadges() {
    document.querySelectorAll('.gif-badge').forEach((badge) => {
      badge.addEventListener('mouseenter', () => badge.classList.add('playing'));
      badge.addEventListener('mouseleave', () => badge.classList.remove('playing'));
      badge.addEventListener('click', () => badge.classList.toggle('playing'));
    });
  }

  // ---------------- entering the app ----------------
  async function enterApp(user) {
    me = user;
    $('#auth-view').classList.add('hidden');
    $('#app-view').classList.remove('hidden');
    avatarPill($('#me-avatar'), me.avatar);
    $('#me-username').textContent = me.username;

    initMap();
    initSocket();
    startGeolocation();
    wireBeerButton();
    // Deleted Pin drop code:
    //wireMarkerForm();
    wireChatForm();

    await Promise.all([loadLocations(), loadMarkers(), loadBeer(), loadChatHistory(), loadClan()]);
  }

  $('#logout-btn') && $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    window.location.reload();
  });

  // ---------------- map ----------------
  // function initMap() {
  //   map = L.map('map', { zoomControl: true }).setView([20, 0], 2);
  //   L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  //     maxZoom: 19,
  //     attribution: '&copy; OpenStreetMap contributors',
  //   }).addTo(map);
  // }
  function initMap() {
    map = L.map('map', { zoomControl: true }).setView([20, 0], 2);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(map);
  }

  function userDivIcon(avatarId, isMe) {
    const a = avatarById(avatarId);
    const ring = isMe ? '3px solid #f0b94f' : '2px solid rgba(255,255,255,0.25)';
    return L.divIcon({
      className: '',
      html: `<div style="width:34px;height:34px;border-radius:50%;background:${a.bg};border:${ring};display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 2px 8px rgba(0,0,0,0.4);">${a.emoji}</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
  }

  function pinDivIcon() {
    return L.divIcon({
      className: '',
      html: `<div style="width:14px;height:14px;border-radius:50% 50% 50% 0;background:#d99a3f;border:2px solid #f1e6d2;transform:rotate(-45deg);box-shadow:0 2px 6px rgba(0,0,0,0.5);"></div>`,
      iconSize: [14, 14],
      iconAnchor: [7, 14],
    });
  }

  function upsertUserMarker(user) {
    if (typeof user.lat !== 'number' || typeof user.lng !== 'number') return;
    const isMe = me && user.username === me.username;
    if (userMarkers[user.username]) {
      userMarkers[user.username].setLatLng([user.lat, user.lng]);
      userMarkers[user.username].setIcon(userDivIcon(user.avatar, isMe));
    } else {
      const marker = L.marker([user.lat, user.lng], { icon: userDivIcon(user.avatar, isMe) }).addTo(map);
      userMarkers[user.username] = marker;
    }
    userMarkers[user.username].bindPopup(
      `<strong>${escapeHtml(user.username)}</strong><br/>${user.locationUpdatedAt ? timeAgo(user.locationUpdatedAt) : ''}`
    );
  }

  function renderUsers(users) {
    users.forEach(upsertUserMarker);
    renderUserSidebar(users);
  }

  function renderUserSidebar(users) {
    const list = $('#user-list');
    if (!list) return;
    list.innerHTML = '';

    const sorted = users.slice().sort((a, b) => {
      const aMe = me && a.username === me.username;
      const bMe = me && b.username === me.username;
      if (aMe && !bMe) return -1;
      if (bMe && !aMe) return 1;
      return a.username.localeCompare(b.username);
    });

    sorted.forEach((user) => {
      const isMe = me && user.username === me.username;
      const row = el('div', 'user-row' + (isMe ? ' me' : ''));

      const pill = el('div', 'avatar-pill');
      avatarPill(pill, user.avatar);

      const name = el('span', 'name');
      name.textContent = isMe ? 'me' : user.username;

      const dot = el('span', 'dot' + (typeof user.lat === 'number' ? ' live' : ''));
      dot.title = typeof user.lat === 'number' ? 'sharing location' : 'no location yet';

      const hasLocation = typeof user.lat === 'number' && typeof user.lng === 'number';
      if (hasLocation) {
        row.classList.add('clickable');
        row.title = `Zoom to ${isMe ? 'me' : user.username}`;
        row.addEventListener('click', () => {
          map.flyTo([user.lat, user.lng], Math.max(map.getZoom(), 14));
          const marker = userMarkers[user.username];
          if (marker) marker.openPopup();
        });
      }

      row.appendChild(pill);
      row.appendChild(name);
      row.appendChild(dot);
      list.appendChild(row);
    });
  }

  function renderMarkers(markers) {
    Object.values(pinMarkers).forEach((m) => map.removeLayer(m));
    pinMarkers = {};
    markers.forEach((mk) => {
      const marker = L.marker([mk.lat, mk.lng], { icon: pinDivIcon() }).addTo(map);
      marker.bindPopup(`<strong>${escapeHtml(mk.label)}</strong><br/><span style="opacity:0.6;font-size:11px;">added by ${escapeHtml(mk.addedBy)}</span>`);
      pinMarkers[mk.id] = marker;
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  async function loadLocations() {
    const data = await api('/api/locations');
    renderUsers(data.users);
    const withPos = data.users.find((u) => u.username === (me && me.username) && typeof u.lat === 'number');
    if (withPos) map.setView([withPos.lat, withPos.lng], 12);
  }

  // async function loadMarkers() {
  //   const data = await api('/api/markers');
  //   renderMarkers(data.markers);
  // }

  async function loadMarkers() {
    // Define your built-in coordinates and labels here
    const builtInMarkers = [
      { id: 'pin1', lat: 43.67599105834961, lng: -79.3990478515625, label: 'Slime Manor (retired)', addedBy: 'System' },
      { id: 'pin2', lat: 43.67374, lng: -79.42816, label: 'Shaw Jungle', addedBy: 'System' },
      { id: 'pin3', lat: 43.6475, lng: -79.41126, label: 'Bellwoods Boba Junkies', addedBy: 'System' },
      { id: 'pin4', lat: 43.66210174560547, lng: -79.42513275146484, label: 'Trevors Apartment', addedBy: 'System' },
      { id: 'pin5', lat: 43.66355, lng: -79.40393, label: 'Slime Manor (future)', addedBy: 'System' },
      { id: 'pin6', lat: 43.669889, lng: -79.38755, label: 'Earls', addedBy: 'System' },
      { id: 'pin7', lat: 43.6650713, lng: -79.3964198, label: 'Munk', addedBy: 'System' },
      { id: 'pin8', lat: 43.649196, lng: -79.4235552, label: 'TwoTwoTuesday', addedBy: 'System' },
      { id: 'pin9', lat: 43.6768704, lng: -79.389677, label: 'Ramyun Park', addedBy: 'System' },
      { id: 'pin10', lat: 43.6672285, lng: -79.4024532, label: 'I Can Touch It though...', addedBy: 'System' },
      { id: 'pin11', lat: 43.64586, lng: -79.40081, label: 'Trevors Roomate Works Here', addedBy: 'System' },
      { id: 'pin12', lat: 43.6425637, lng: -79.3870872, label: 'Nuke Blast Zone', addedBy: 'System' }
    ];

    // Pass the hardcoded array directly to the render function
    renderMarkers(builtInMarkers);
  }

  function startGeolocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(handlePosition, () => {}, { enableHighAccuracy: false, maximumAge: 60000 });
    navigator.geolocation.watchPosition(handlePosition, () => {}, { enableHighAccuracy: false, maximumAge: 30000 });
  }

  function handlePosition(pos) {
    lastKnownPos = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const now = Date.now();
    if (now - lastSentAt < 10000) return; // throttle: at most once per 10s
    lastSentAt = now;
    api('/api/location', { method: 'POST', body: JSON.stringify(lastKnownPos) }).catch(() => {});
  }
  //Removed (og pin dropper code):
  // function wireMarkerForm() {
  //   $('#marker-form').addEventListener('submit', async (e) => {
  //     e.preventDefault();
  //     const input = $('#marker-label');
  //     const label = input.value.trim();
  //     if (!label) return;
  //     if (!lastKnownPos) {
  //       alert("We don't have your current location yet — allow location access and try again in a moment.");
  //       return;
  //     }
  //     try {
  //       await api('/api/markers', { method: 'POST', body: JSON.stringify({ ...lastKnownPos, label }) });
  //       input.value = '';
  //     } catch (err) {
  //       alert(err.message);
  //     }
  //   });
  // }

  // ---------------- beer board ----------------
  function renderBeer(beerList) {
    const wrap = $('#beer-tally');
    wrap.innerHTML = '';
    $('#beer-count').textContent = `${beerList.length} in`;
    if (!beerList.length) {
      const empty = el('div', 'beer-empty');
      empty.textContent = 'Nobody yet — be the first.';
      wrap.appendChild(empty);
    }
    beerList
      .slice()
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .forEach((entry) => {
        const row = el('div', 'beer-row');
        const pill = el('div', 'avatar-pill');
        avatarPill(pill, entry.avatar);
        const name = el('span');
        name.textContent = entry.username;
        const since = el('span', 'since');
        since.textContent = timeAgo(entry.joinedAt);
        row.appendChild(pill);
        row.appendChild(name);
        row.appendChild(since);
        wrap.appendChild(row);
      });

    joinedBeer = beerList.some((b) => b.username === (me && me.username));
    const btn = $('#beer-btn');
    btn.classList.toggle('joined', joinedBeer);
    $('#beer-btn-label').textContent = joinedBeer ? "You're in — tap to leave" : "I'm in for a beer";
  }

  async function loadBeer() {
    const data = await api('/api/beer');
    renderBeer(data.beerList);
  }

  function wireBeerButton() {
    $('#beer-btn').addEventListener('click', async () => {
      try {
        await api(joinedBeer ? '/api/beer/leave' : '/api/beer/join', { method: 'POST' });
      } catch (err) {
        alert(err.message);
      }
    });
  }

  // ---------------- chat ----------------
  function appendChatMessage(msg) {
    const wrap = $('#chat-messages');
    const row = el('div', 'chat-msg' + (me && msg.username === me.username ? ' self' : ''));
    const pill = el('div', 'avatar-pill');
    avatarPill(pill, msg.avatar);
    const bubble = el('div', 'bubble');
    const meta = el('div', 'meta');
    meta.textContent = `${msg.username} · ${new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    const text = el('div');
    text.textContent = msg.text;
    bubble.appendChild(meta);
    bubble.appendChild(text);
    row.appendChild(pill);
    row.appendChild(bubble);
    wrap.appendChild(row);
    wrap.scrollTop = wrap.scrollHeight;
  }

  async function loadChatHistory() {
    const data = await api('/api/chat/history');
    $('#chat-messages').innerHTML = '';
    data.messages.forEach(appendChatMessage);
  }

  function wireChatForm() {
    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#chat-input');
      const text = input.value.trim();
      if (!text || !socket) return;
      socket.emit('chat:send', { text });
      input.value = '';
    });
  }

  // ---------------- clan dashboard ----------------
  function renderClan(clan) {
    const body = $('#clan-body');
    body.innerHTML = '';

    const header = el('div', 'clan-header');
    const crest = el('div', 'clan-crest');
    crest.textContent = '⚔️';
    const info = el('div');
    const name = el('div', 'clan-name');
    name.textContent = clan.name;
    const tag = el('div', 'clan-tag');
    tag.textContent = clan.tag;
    info.appendChild(name);
    info.appendChild(tag);
    header.appendChild(crest);
    header.appendChild(info);
    body.appendChild(header);

    const stats = el('div', 'clan-stats');
    [
      ['Members', clan.members],
      ['Clan score', clan.clanScore],
      ['War trophies', clan.clanWarTrophies],
    ].forEach(([label, value]) => {
      const stat = el('div', 'clan-stat');
      const v = el('div', 'value');
      v.textContent = value != null ? value : '—';
      const l = el('div', 'label');
      l.textContent = label;
      stat.appendChild(v);
      stat.appendChild(l);
      stats.appendChild(stat);
    });
    body.appendChild(stats);

    const members = el('div', 'clan-members');
    (clan.memberList || []).forEach((m) => {
      const row = el('div', 'clan-member-row');
      const rank = el('span', 'rank');
      rank.textContent = m.clanRank != null ? `#${m.clanRank}` : '';
      const nm = el('span', 'name');
      nm.textContent = m.name;
      const role = el('span', 'role');
      role.textContent = m.role || '';
      const trophies = el('span', 'trophies');
      trophies.textContent = m.trophies != null ? `🏆${m.trophies}` : '';
      row.appendChild(rank);
      row.appendChild(nm);
      row.appendChild(role);
      row.appendChild(trophies);
      members.appendChild(row);
    });
    body.appendChild(members);

    const refresh = el('button', 'clan-refresh');
    refresh.textContent = clan.cached ? 'refresh' : 'refreshed just now';
    refresh.addEventListener('click', () => loadClan(true));
    body.appendChild(refresh);
  }

  async function loadClan(force) {
    const body = $('#clan-body');
    try {
      const data = await api(`/api/clan${force ? '?force=1' : ''}`);
      renderClan(data.clan);
    } catch (err) {
      body.innerHTML = '';
      const errBox = el('div', 'clan-error');
      errBox.textContent = `Couldn't load clan info: ${err.message}`;
      body.appendChild(errBox);
      const refresh = el('button', 'clan-refresh');
      refresh.textContent = 'try again';
      refresh.addEventListener('click', () => loadClan(true));
      body.appendChild(refresh);
    }
  }

  // ---------------- sockets ----------------
  function initSocket() {
    socket = io();
    socket.on('presence:update', (data) => renderUsers(data.users));
    socket.on('markers:update', (data) => renderMarkers(data.markers));
    socket.on('beer:update', (data) => renderBeer(data.beerList));
    socket.on('chat:message', (msg) => appendChatMessage(msg));
  }

  // ---------------- boot ----------------
  async function boot() {
    renderAvatarGrid();
    wireAuthTabs();
    wireAuthForms();
    wireGifBadges();

    try {
      const data = await api('/api/me');
      if (data.user) {
        await enterApp(data.user);
        return;
      }
    } catch (e) { /* not logged in */ }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
