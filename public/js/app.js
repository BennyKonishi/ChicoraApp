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
  let lastRenderedBeerCount = null;   // so we only chime on an increase

  const BEER_COOLDOWN_MS = 30000;
  let cooldownEnabled = localStorage.getItem('beerCooldownDisabled') !== 'true'; // on by default
  let lastPlusClickAt = parseInt(localStorage.getItem('beerLastPlusClickAt') || '0', 10);
  let cooldownInterval = null;
  let confirmYesHandler = null;

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
  // Removed for icon/status update
  // function renderAvatarGrid() {
  //   const grid = $('#avatar-grid');
  //   grid.innerHTML = '';
  //   let selected = null;
  //   AVATARS.forEach((a) => {
  //     const btn = el('button', 'avatar-choice');
  //     btn.type = 'button';
  //     btn.textContent = a.emoji;
  //     btn.style.background = a.bg;
  //     btn.dataset.id = a.id;
  //     btn.addEventListener('click', () => {
  //       grid.querySelectorAll('.avatar-choice').forEach((b) => b.classList.remove('selected'));
  //       btn.classList.add('selected');
  //       selected = a.id;
  //       grid.dataset.selected = selected;
  //     });
  //     grid.appendChild(btn);
  //   });
  // }

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
      if (password !== password2) {
        showAuthError('Passwords do not match.');
        return;
      }
      try {
        const data = await api('/api/signup', {
          method: 'POST',
          body: JSON.stringify({ username, password, confirmPassword: password2 }),
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
    wireChatForm();
    wireStatusBar();
    wireCounterButtons();
    wireConfirmModal();
    wireSettingsNav();
    wireSettingsToggle();
    wirePushToggle();
    wireSoundControls();
    startCooldownWatch();

    await Promise.all([loadLocations(), loadMarkers(), loadBeer(), loadBeerCounter(), loadChatHistory(), loadClan()]);
  }

  // ---------------- status bar ----------------
  function wireStatusBar() {
    const container = $('#status-options');
    if (!container) return;
    container.innerHTML = '';

    AVATARS.forEach((status) => {
      const btn = el('button', 'status-btn' + (me && me.avatar === status.id ? ' selected' : ''));
      btn.type = 'button';
      btn.dataset.status = status.id;

      const circle = el('div', 'status-emoji');
      circle.style.setProperty('--status-bg', status.bg);
      circle.textContent = status.emoji;

      const label = el('span', 'status-text');
      label.textContent = status.label;

      btn.appendChild(circle);
      btn.appendChild(label);

      btn.addEventListener('click', async () => {
        try {
          const data = await api('/api/status', { method: 'POST', body: JSON.stringify({ status: status.id }) });
          me = data.user;
          avatarPill($('#me-avatar'), me.avatar);
          container.querySelectorAll('.status-btn').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
        } catch (err) {
          alert(err.message);
        }
      });

      container.appendChild(btn);
    });
  }

  $('#logout-btn') && $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    window.location.reload();
  });

  // Server-provided public config (CARTO key, VAPID key). Fetched once.
  let configPromise = null;
  function getConfig() {
    if (!configPromise) configPromise = api('/api/config').catch(() => ({}));
    return configPromise;
  }

  async function initMap() {
    map = L.map('map', { zoomControl: true }).setView([20, 0], 2);

    // CARTO basemaps require an API key as of 2026 — without one the tiles come
    // back stamped with an "API KEY REQUIRED" watermark. Free key (5M tiles/mo):
    // https://carto.com/basemaps/apikey  -> put it in .env as CARTO_API_KEY
    const cfg = await getConfig();
    const cartoApiKey = cfg.cartoApiKey || '';
    if (!cartoApiKey) {
      console.warn('No CARTO_API_KEY set — basemap tiles will be watermarked. See .env.example.');
    }

    const keyParam = cartoApiKey ? `?key=${encodeURIComponent(cartoApiKey)}` : '';
    L.tileLayer(`https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png${keyParam}`, {
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

  // ---------------- beer counter (12-hour mug) ----------------
  const BEER_GOAL = 50;

  function renderMug(count) {
    const pct = Math.max(0, Math.min(100, (count / BEER_GOAL) * 100));
    const fill = $('#mug-fill');
    if (fill) fill.style.height = pct + '%';
    const label = $('#mug-count');
    if (label) label.textContent = `${count} / ${BEER_GOAL}`;
  }

  function renderCounterLog(log) {
    const list = $('#counter-log-list');
    if (!list) return;
    list.innerHTML = '';
    if (!log.length) {
      const empty = el('div', 'counter-log-empty');
      empty.textContent = 'No clicks in the last 12 hours yet.';
      list.appendChild(empty);
      return;
    }
    log.forEach((entry) => {
      const row = el('div', 'counter-log-row');
      const pill = el('div', 'avatar-pill');
      avatarPill(pill, entry.avatar);
      const name = el('span');
      name.textContent = entry.username;
      const delta = el('span', 'delta ' + (entry.delta > 0 ? 'plus' : 'minus'));
      delta.textContent = entry.delta > 0 ? '+1' : '−1';
      const time = el('span', 'time');
      time.textContent = timeAgo(entry.createdAt);
      row.appendChild(pill);
      row.appendChild(name);
      row.appendChild(delta);
      row.appendChild(time);
      list.appendChild(row);
    });
  }

  // ---------------- beer alert: sound + vibration ----------------
  // Drop an mp3 at public/assets/sounds/beer.mp3 to set the sound. If it's
  // missing or blocked, we synthesise a clink so there's always feedback.

  // Set from /api/config — whatever audio file the server found in
  // public/assets/sounds. Empty means "no file, use the synth".
  let beerSoundUrl = '';
  let beerAudio = null;
  let audioCtx = null;
  let soundEnabled = localStorage.getItem('beerSoundDisabled') !== 'true';

  function getBeerAudio() {
    if (!beerSoundUrl) return null;
    if (!beerAudio || beerAudio.dataset_src !== beerSoundUrl) {
      beerAudio = new Audio(beerSoundUrl);
      beerAudio.dataset_src = beerSoundUrl;
      beerAudio.preload = 'auto';
    }
    return beerAudio;
  }

  // Fallback: two short decaying tones, roughly a glass clink.
  function synthClink() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audioCtx) audioCtx = new Ctx();
      if (audioCtx.state === 'suspended') audioCtx.resume();

      [0, 0.09].forEach((offset, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        const t = audioCtx.currentTime + offset;
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(i === 0 ? 880 : 1320, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(t);
        osc.stop(t + 0.4);
      });
    } catch (e) {
      // No audio available — silent is fine, the confetti still fires.
    }
  }

  function playBeerSound() {
    if (!soundEnabled) return;
    const audio = getBeerAudio();
    if (!audio) { synthClink(); return; }
    try {
      audio.currentTime = 0;
      const played = audio.play();
      // play() rejects if the file is missing or autoplay is blocked.
      if (played && typeof played.catch === 'function') played.catch(() => synthClink());
    } catch (e) {
      synthClink();
    }
  }

  function buzz() {
    // Android honours this; iOS Safari ignores it entirely.
    if (navigator.vibrate) {
      try { navigator.vibrate([90, 50, 90]); } catch (e) { /* ignore */ }
    }
  }

  function beerAlert() {
    playBeerSound();
    buzz();
  }

  function renderBeerCounter(data) {
    const previous = lastRenderedBeerCount;
    renderMug(data.count);
    renderCounterLog(data.log);

    // Sound + buzz only when someone ELSE adds a beer. `triggeredBy` is absent
    // on the initial load, so a refresh never makes noise.
    const someoneElse = data.triggeredBy && me && data.triggeredBy !== me.username;
    const wentUp = previous === null || data.count > previous;
    if (someoneElse && wentUp) beerAlert();

    lastRenderedBeerCount = data.count;

    if (data.celebrate) celebrate();
    else if (data.milestone) celebrateMilestone(data.milestone);
  }

  async function loadBeerCounter() {
    const data = await api('/api/beercounter');
    // Goes through renderBeerCounter so the "last seen count" is primed on load.
    // No triggeredBy on this payload, so it stays silent.
    renderBeerCounter(data);
  }

  function remainingCooldownMs() {
    if (!cooldownEnabled) return 0;
    return Math.max(0, BEER_COOLDOWN_MS - (Date.now() - lastPlusClickAt));
  }

  function updatePlusButtonState() {
    const btn = $('#beer-plus-btn');
    if (!btn) return;
    const remaining = remainingCooldownMs();
    if (remaining > 0) {
      btn.disabled = true;
      btn.textContent = `Wait ${Math.ceil(remaining / 1000)}s`;
    } else {
      btn.disabled = false;
      btn.textContent = '+ beer';
      if (cooldownInterval) {
        clearInterval(cooldownInterval);
        cooldownInterval = null;
      }
    }
  }

  function startCooldownWatch() {
    updatePlusButtonState();
    if (remainingCooldownMs() > 0 && !cooldownInterval) {
      cooldownInterval = setInterval(updatePlusButtonState, 1000);
    }
  }

  function wireCounterButtons() {
    $('#beer-plus-btn').addEventListener('click', () => {
      if (remainingCooldownMs() > 0) return; // button should already be disabled; this is just a safety net
      lastPlusClickAt = Date.now();
      localStorage.setItem('beerLastPlusClickAt', String(lastPlusClickAt));
      sendBeerClick(1);
      startCooldownWatch();
    });
    $('#beer-minus-btn').addEventListener('click', () => {
      openConfirmModal('Are you sure? You worked so hard...', () => sendBeerClick(-1));
    });
  }

  // ---------------- confirm modal ----------------
  function openConfirmModal(message, onYes) {
    const overlay = $('#confirm-overlay');
    const text = $('#confirm-text');
    if (!overlay || !text) return;
    text.textContent = message;
    confirmYesHandler = onYes;
    overlay.classList.remove('hidden');
  }

  function closeConfirmModal() {
    const overlay = $('#confirm-overlay');
    if (overlay) overlay.classList.add('hidden');
    confirmYesHandler = null;
  }

  function wireConfirmModal() {
    $('#confirm-yes-btn').addEventListener('click', () => {
      const handler = confirmYesHandler;
      closeConfirmModal();
      if (handler) handler();
    });
    $('#confirm-no-btn').addEventListener('click', () => closeConfirmModal());
    $('#confirm-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'confirm-overlay') closeConfirmModal();
    });
  }

  // ---------------- settings ----------------
  function wireSettingsNav() {
    $('#settings-btn').addEventListener('click', () => {
      $('#dashboard-view').classList.add('hidden');
      $('#settings-view').classList.remove('hidden');
    });
    $('#settings-back-btn').addEventListener('click', () => {
      $('#settings-view').classList.add('hidden');
      $('#dashboard-view').classList.remove('hidden');
    });
  }

  function updateCooldownToggleLabel() {
    const btn = $('#toggle-cooldown-btn');
    if (!btn) return;
    btn.textContent = cooldownEnabled ? 'Disable 30s beer lock' : 'Enable 30s beer lock';
  }

  // ---------------- push notifications ----------------

  let pushRegistration = null;

  function pushSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent);
  }

  function isInstalled() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  }

  function showPushNote(html) {
    const note = $('#push-note');
    if (!note) return;
    if (!html) { note.classList.add('hidden'); return; }
    note.innerHTML = html;
    note.classList.remove('hidden');
  }

  // The VAPID public key travels as base64url; PushManager wants raw bytes.
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    const output = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
    return output;
  }

  async function currentSubscription() {
    if (!pushRegistration) return null;
    return pushRegistration.pushManager.getSubscription();
  }

  async function updatePushButton() {
    const btn = $('#toggle-push-btn');
    if (!btn) return;
    const sub = await currentSubscription();
    btn.textContent = sub ? 'Turn off beer alerts' : 'Turn on beer alerts';
    btn.dataset.on = sub ? 'true' : 'false';
  }

  async function enablePush() {
    const cfg = await getConfig();
    if (!cfg.vapidPublicKey) {
      showPushNote('Notifications are not configured on the server yet.');
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      showPushNote(
        permission === 'denied'
          ? 'Notifications are blocked for this site. Turn them back on in your browser settings, then try again.'
          : 'Notifications need permission to work.'
      );
      return;
    }

    const sub = await pushRegistration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
    });

    await api('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription: sub.toJSON() }),
    });

    showPushNote("You'll get a buzz every time someone else cracks one. 🍺");
    await updatePushButton();
  }

  async function disablePush() {
    const sub = await currentSubscription();
    if (sub) {
      await api('/api/push/unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {});
      await sub.unsubscribe();
    }
    showPushNote('Beer alerts are off.');
    await updatePushButton();
  }

  function updateSoundToggleLabel() {
    const btn = $('#toggle-sound-btn');
    if (btn) btn.textContent = soundEnabled ? 'Mute beer sound' : 'Unmute beer sound';
  }

  async function wireSoundControls() {
    updateSoundToggleLabel();

    const cfg = await getConfig();
    beerSoundUrl = cfg.beerSoundUrl || '';
    if (beerSoundUrl) getBeerAudio();  // warm the cache so the first beer is instant
    console.log('[sound] alert sound:', beerSoundUrl || '(synthesised clink)');

    const toggle = $('#toggle-sound-btn');
    if (toggle) {
      toggle.addEventListener('click', () => {
        soundEnabled = !soundEnabled;
        localStorage.setItem('beerSoundDisabled', soundEnabled ? 'false' : 'true');
        updateSoundToggleLabel();
        if (soundEnabled) beerAlert();
      });
    }

    const test = $('#test-alert-btn');
    if (test) {
      test.addEventListener('click', () => {
        // Ignores the mute setting on purpose — this button exists to check the file.
        const was = soundEnabled;
        soundEnabled = true;
        beerAlert();
        soundEnabled = was;
      });
    }
  }

  async function wirePushToggle() {
    const btn = $('#toggle-push-btn');
    if (!btn) return;

    if (!pushSupported()) {
      btn.classList.add('hidden');
      // On iPhone, push only exists once the site is added to the Home Screen.
      if (isIOS() && !isInstalled()) {
        showPushNote(
          'To get beer alerts on iPhone: tap <strong>Share</strong>, then ' +
          '<strong>Add to Home Screen</strong>, and open the app from that icon.'
        );
      } else {
        showPushNote('This browser does not support notifications.');
      }
      return;
    }

    try {
      pushRegistration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
    } catch (e) {
      btn.classList.add('hidden');
      showPushNote('Could not start notifications (service worker failed to register).');
      return;
    }

    await updatePushButton();

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        if (btn.dataset.on === 'true') await disablePush();
        else await enablePush();
      } catch (e) {
        showPushNote('Something went wrong turning alerts ' + (btn.dataset.on === 'true' ? 'off' : 'on') + '.');
      } finally {
        btn.disabled = false;
      }
    });
  }

  function wireSettingsToggle() {
    updateCooldownToggleLabel();
    $('#toggle-cooldown-btn').addEventListener('click', () => {
      cooldownEnabled = !cooldownEnabled;
      localStorage.setItem('beerCooldownDisabled', cooldownEnabled ? 'false' : 'true');
      updateCooldownToggleLabel();
      updatePlusButtonState();
    });
  }

  async function sendBeerClick(delta) {
    try {
      await api('/api/beercounter/click', { method: 'POST', body: JSON.stringify({ delta }) });
    } catch (err) {
      alert(err.message);
    }
  }

  function celebrate() {
    const overlay = $('#confetti-overlay');
    const banner = $('#congrats-banner');
    if (!overlay || !banner) return;

    const colors = ['#f0b94f', '#d99a3f', '#7a9d6b', '#e5b3a9', '#f1e6d2', '#b1503f'];
    const pieceCount = 90;
    for (let i = 0; i < pieceCount; i++) {
      const piece = el('div', 'confetti-piece');
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.animationDuration = 2.2 + Math.random() * 1.6 + 's';
      piece.style.animationDelay = Math.random() * 0.6 + 's';
      piece.style.transform = `rotate(${Math.random() * 360}deg)`;
      overlay.appendChild(piece);
    }

    banner.classList.add('show');
    setTimeout(() => {
      banner.classList.remove('show');
    }, 4000);
    setTimeout(() => {
      overlay.innerHTML = '';
    }, 4200);
  }

  const MILESTONE_MESSAGES = [
    'Just a Few More... 🍻',
    "Nice pace! 🍺",
    'Youre almost there... 🍻',
    'Lets get Sendy! 🍺',
    'Crew\'s thirsty! 🍺',
  ];

  function celebrateMilestone(count) {
    const overlay = $('#confetti-overlay');
    const banner = $('#milestone-banner');
    if (!overlay || !banner) return;

    const pieceCount = 36;
    for (let i = 0; i < pieceCount; i++) {
      const piece = el('div', 'emoji-piece');
      piece.textContent = '🍺';
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.fontSize = 18 + Math.random() * 16 + 'px';
      piece.style.animationDuration = 1.5 + Math.random() * 1.1 + 's';
      piece.style.animationDelay = Math.random() * 0.4 + 's';
      overlay.appendChild(piece);
    }

    const msg = MILESTONE_MESSAGES[Math.floor(Math.random() * MILESTONE_MESSAGES.length)];
    banner.textContent = `${count} beers in! ${msg}`;
    banner.classList.add('show');
    setTimeout(() => {
      banner.classList.remove('show');
    }, 8000);
    setTimeout(() => {
      overlay.innerHTML = '';
    }, 8000);
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
    socket.on('beercounter:update', (data) => renderBeerCounter(data));
    socket.on('chat:message', (msg) => appendChatMessage(msg));
  }

  // ---------------- boot ----------------
  async function boot() {
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
