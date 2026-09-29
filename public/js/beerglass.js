// beerglass.js — 3D spinning beer mug for the beer counter card.
//
// Loaded as an ES module (Three.js comes from the CDN via the import map in
// index.html). If WebGL or the CDN is unavailable this file never adds the
// .glass-3d class, so the original CSS mug stays visible as the fallback.
//
// app.js talks to it through window.beerGlass:
//   setFill(pct, count, goal)  — liquid level, 0..100
//   kick(speed)                — spin it (used for milestones / the big 50)

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const wrap = document.getElementById('mug-wrap');
const canvas = document.getElementById('glass-canvas');

// ---- glass dimensions (scene units) ----
const BASE_Y = 0.25;        // top of the thick glass base = bottom of the liquid
const RIM_Y = 3.0;
const INNER_R_BOTTOM = 0.76;
const INNER_R_TOP = 0.96;
const FOAM_H = 0.2;

// inner wall radius at a given height (the mug tapers outward)
function innerRadius(y) {
  const t = (y - BASE_Y) / (RIM_Y - BASE_Y);
  return INNER_R_BOTTOM + t * (INNER_R_TOP - INNER_R_BOTTOM);
}

// ---- spin tuning ----
const DRAG_SENSITIVITY = 0.012;  // radians per pixel dragged
const FRICTION = 0.2;            // fraction of excess speed left after 1s
const MAX_SPEED = 40;            // rad/s
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const idleSpeed = () => (reducedMotion.matches ? 0 : 0.35);

function init() {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (err) {
    console.warn('beerglass: WebGL unavailable, keeping the CSS mug', err);
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.localClippingEnabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);

  scene.add(new THREE.HemisphereLight(0xfff1d6, 0x3a2412, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 5, 4);
  scene.add(key);

  // Everything that spins lives in this group.
  const mug = new THREE.Group();
  scene.add(mug);

  // ---- glass: one closed lathe profile (outer wall, rim, inner wall, base) ----
  const profile = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(0.78, 0),
    new THREE.Vector2(0.8, 0.05),
    new THREE.Vector2(1.0, RIM_Y),
    new THREE.Vector2(INNER_R_TOP, RIM_Y),
    new THREE.Vector2(INNER_R_BOTTOM, BASE_Y),
    new THREE.Vector2(0, BASE_Y),
  ];
  const glassMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.05,
    metalness: 0,
    clearcoat: 1,
    transparent: true,
    opacity: 0.22,
    envMapIntensity: 1.4,
    depthWrite: false,
  });
  const glass = new THREE.Mesh(new THREE.LatheGeometry(profile, 64), glassMat);
  glass.renderOrder = 2;   // draw after the beer so the beer shows through
  mug.add(glass);

  // handle: half a torus bulging out on +x
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.11, 16, 48, Math.PI), glassMat);
  handle.rotation.z = -Math.PI / 2;
  handle.position.set(0.9, 1.55, 0);
  handle.renderOrder = 2;
  mug.add(handle);

  // ---- beer: a full-height lathe clipped at the fill line ----
  // The clip plane is horizontal and the mug only rotates about Y, so the
  // plane stays valid however much it spins.
  const clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), BASE_Y);
  const beerMat = new THREE.MeshStandardMaterial({
    color: 0xe8a33a,
    emissive: 0x5a2a00,
    emissiveIntensity: 0.35,
    roughness: 0.25,
    transparent: true,
    opacity: 0.9,
    clippingPlanes: [clip],
  });
  const beerProfile = [
    new THREE.Vector2(0, BASE_Y + 0.005),
    new THREE.Vector2(INNER_R_BOTTOM - 0.015, BASE_Y + 0.005),
    new THREE.Vector2(INNER_R_TOP - 0.015, RIM_Y - 0.02),
  ];
  const beer = new THREE.Mesh(new THREE.LatheGeometry(beerProfile, 64), beerMat);
  mug.add(beer);

  // surface + foam ride the fill line and tilt a little when it spins
  const top = new THREE.Group();
  mug.add(top);
  const surface = new THREE.Mesh(
    new THREE.CircleGeometry(1, 64).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0xf0b94f, roughness: 0.3, emissive: 0x5a2a00, emissiveIntensity: 0.3 })
  );
  top.add(surface);
  const foam = new THREE.Mesh(
    new THREE.CylinderGeometry(1, 1, 1, 64).translate(0, 0.5, 0),
    new THREE.MeshStandardMaterial({ color: 0xf6ecd8, roughness: 0.95 })
  );
  top.add(foam);

  // ---- bubbles ----
  const BUBBLES = 60;
  const bubblePos = new Float32Array(BUBBLES * 3);
  const bubbleSpeed = new Float32Array(BUBBLES);
  const bubbleGeo = new THREE.BufferGeometry();
  bubbleGeo.setAttribute('position', new THREE.BufferAttribute(bubblePos, 3));
  const bubbles = new THREE.Points(bubbleGeo, new THREE.PointsMaterial({
    size: 0.05,
    map: dotTexture(),
    color: 0xfff4d8,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
  }));
  mug.add(bubbles);

  function resetBubble(i, y) {
    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * innerRadius(y) * 0.85;
    bubblePos[i * 3] = Math.cos(angle) * r;
    bubblePos[i * 3 + 1] = y;
    bubblePos[i * 3 + 2] = Math.sin(angle) * r;
    bubbleSpeed[i] = 0.25 + Math.random() * 0.45;
  }

  // ---- fill level ----
  let targetFill = (window.__beerFillPct || 0) / 100;
  let fill = targetFill;

  function applyFill(f, tilt) {
    const visible = f > 0.005;
    beer.visible = top.visible = bubbles.visible = visible;
    if (!visible) return;
    const y = BASE_Y + f * (RIM_Y - FOAM_H - BASE_Y);
    const r = innerRadius(y) - 0.015;
    clip.constant = y;
    top.position.y = y;
    top.rotation.z = tilt;
    surface.scale.set(r, 1, r);
    foam.scale.set(r, FOAM_H, r);
  }

  for (let i = 0; i < BUBBLES; i++) {
    resetBubble(i, BASE_Y + Math.random() * fill * (RIM_Y - FOAM_H - BASE_Y));
  }

  // ---- swipe to spin (pointer events cover mouse + touch) ----
  let rotation = 0;
  let velocity = idleSpeed();
  let dragging = false;
  let lastX = 0;
  let lastT = 0;

  canvas.addEventListener('pointerdown', (e) => {
    dragging = true;
    lastX = e.clientX;
    lastT = performance.now();
    velocity = 0;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('grabbing');
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const now = performance.now();
    const d = (e.clientX - lastX) * DRAG_SENSITIVITY;
    const dt = Math.max((now - lastT) / 1000, 0.001);
    rotation += d;
    // smooth the measured speed so one jittery sample doesn't define the flick
    velocity = velocity * 0.6 + (d / dt) * 0.4;
    lastX = e.clientX;
    lastT = now;
  });

  function release() {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('grabbing');
    // finger held still before letting go → no flick
    if (performance.now() - lastT > 80) velocity = 0;
    velocity = THREE.MathUtils.clamp(velocity, -MAX_SPEED, MAX_SPEED);
  }
  canvas.addEventListener('pointerup', release);
  // fires when the browser takes over for a vertical page scroll
  canvas.addEventListener('pointercancel', release);

  canvas.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') kick(-8);
    else if (e.key === 'ArrowRight') kick(8);
    else return;
    e.preventDefault();
  });

  function kick(speed) {
    velocity = THREE.MathUtils.clamp(velocity + speed, -MAX_SPEED, MAX_SPEED);
  }

  // ---- sizing ----
  function resize() {
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // back the camera off far enough to fit the mug in both directions
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const fitH = 3.9 / 2 / tanHalf;
    const fitW = 3.4 / 2 / (tanHalf * camera.aspect);
    const dist = Math.max(fitH, fitW);
    camera.position.set(0, 1.5 + dist * 0.18, dist);
    camera.lookAt(0, 1.45, 0);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(wrap);
  resize();

  // ---- render loop (paused when off-screen or tab hidden) ----
  const clock = new THREE.Clock();
  function frame() {
    const dt = Math.min(clock.getDelta(), 0.05);

    if (!dragging) {
      // excess speed decays toward the gentle idle spin
      const idle = idleSpeed();
      velocity = idle + (velocity - idle) * Math.pow(FRICTION, dt);
      rotation += velocity * dt;
    }
    mug.rotation.y = rotation;

    fill += (targetFill - fill) * (1 - Math.pow(0.02, dt));
    const tilt = THREE.MathUtils.clamp(velocity * 0.004, -0.08, 0.08);
    applyFill(fill, tilt);

    if (bubbles.visible && !reducedMotion.matches) {
      const surfaceY = BASE_Y + fill * (RIM_Y - FOAM_H - BASE_Y);
      for (let i = 0; i < BUBBLES; i++) {
        bubblePos[i * 3 + 1] += bubbleSpeed[i] * dt;
        if (bubblePos[i * 3 + 1] > surfaceY) resetBubble(i, BASE_Y + 0.02);
      }
      bubbleGeo.attributes.position.needsUpdate = true;
    }

    renderer.render(scene, camera);
  }

  let onScreen = true;
  function updateLoop() {
    const run = onScreen && !document.hidden;
    if (run) clock.getDelta(); // don't count the paused time as one huge frame
    renderer.setAnimationLoop(run ? frame : null);
  }
  new IntersectionObserver((entries) => {
    onScreen = entries[0].isIntersecting;
    updateLoop();
  }).observe(wrap);
  document.addEventListener('visibilitychange', updateLoop);
  updateLoop();

  // ---- public API ----
  window.beerGlass = {
    setFill(pct, count, goal) {
      targetFill = THREE.MathUtils.clamp(pct / 100, 0, 1);
      if (count != null) canvas.setAttribute('aria-label', `Beer mug: ${count} of ${goal} beers. Use arrow keys to spin.`);
    },
    kick,
  };

  wrap.classList.add('glass-3d');
}

// soft round sprite so bubbles aren't square
function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 2, 16, 16, 15);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

if (wrap && canvas) init();
