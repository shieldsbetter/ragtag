const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const hud = document.getElementById('hud');

let myId = null, mounts = [], arcHalf = 0;

// The camera is free: it starts on your first ship and thereafter goes where you put it.
const cam = { x: 0, y: 0, zoom: 1, placed: false };
const PAN_KEY_SPEED = 700;      // world px/sec at zoom 1
const MIN_ZOOM = 0.15, MAX_ZOOM = 4;

function resize() {
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
}
addEventListener('resize', resize); resize();

// ---- net ----
// Snapshots are stamped with local arrival time; we render RENDER_DELAY ms in the
// past so there are always two snapshots straddling the render clock to lerp between.
// No clock sync needed, and a late packet costs smoothness only, never a rubber-band.
const RENDER_DELAY = 120;
const buffer = [];              // [{ rt, snap }] oldest -> newest

let dev = false;

// Losing the socket already costs you your ship, so the simplest recovery is to
// reload once the server answers again. That covers a dev restart and a hot-reload
// ping with the same path.
let reloading = false;
function reloadWhenUp() {
  if (reloading) return;
  reloading = true;
  const attempt = () => fetch('/', { cache: 'no-store' })
    .then(() => location.reload())
    .catch(() => setTimeout(attempt, 400));
  setTimeout(attempt, 250);
}

const ws = new WebSocket(`ws://${location.host}`);
ws.onclose = reloadWhenUp;
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.t === 'welcome') { myId = m.id; dev = m.dev; mounts = m.mounts; arcHalf = m.arcHalf; return; }
  if (m.t === 'reload') { location.reload(); return; }
  if (m.t !== 's') return;
  buffer.push({ rt: performance.now(), snap: m });
  while (buffer.length > 2 && buffer[1].rt < performance.now() - RENDER_DELAY - 500) buffer.shift();
};

// Zoom survives a reload; position does not, because a reload gets you a new ship
// somewhere else and the camera should be looking at it.
const ZOOM_KEY = 'ships.zoom';
try { const z = parseFloat(sessionStorage.getItem(ZOOM_KEY)); if (z > 0) cam.zoom = z; } catch {}
addEventListener('pagehide', () => { try { sessionStorage.setItem(ZOOM_KEY, String(cam.zoom)); } catch {} });

// ---- interpolation ----
const lerp = (a, b, t) => a + (b - a) * t;
const lerpAngle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

// Newest snapshot is the source of truth for *existence*: entities gone from it are
// gone. The older one only supplies a "where was this a moment ago" to lerp from.
function blend(older, newer, t) {
  const pair = (list, prevById, extra) => list.map(e => {
    const p = prevById.get(e.id);
    if (!p) return e;
    return { ...e, ...extra(p, e), x: lerp(p.x, e.x, t), y: lerp(p.y, e.y, t) };
  });
  const byId = l => new Map(l.map(e => [e.id, e]));
  return {
    players: newer.players,
    ships: pair(newer.ships, byId(older.ships), (p, e) => ({
      a: lerpAngle(p.a, e.a, t),
      tu: e.tu.map((v, i) => p.tu?.[i] === undefined ? v : lerpAngle(p.tu[i], v, t)),
    })),
    rocks: pair(newer.rocks, byId(older.rocks), (p, e) => ({ a: lerpAngle(p.a, e.a, t) })),
    bullets: pair(newer.bullets, byId(older.bullets), () => ({})),
  };
}

function viewState() {
  if (!buffer.length) return null;
  const target = performance.now() - RENDER_DELAY;
  for (let i = buffer.length - 1; i > 0; i--) {
    const a = buffer[i - 1], b = buffer[i];
    if (a.rt <= target && target <= b.rt) {
      return blend(a.snap, b.snap, (target - a.rt) / (b.rt - a.rt));
    }
  }
  // Ahead of the buffer (stalled feed) or behind it (just connected): hold an endpoint.
  return target > buffer[buffer.length - 1].rt ? buffer[buffer.length - 1].snap : buffer[0].snap;
}

// ---- camera controls ----
const view = () => ({ cw: canvas.width / devicePixelRatio, ch: canvas.height / devicePixelRatio });

// Screen pixel -> world point under it.
function toWorld(sx, sy) {
  const { cw, ch } = view();
  return { x: cam.x + (sx - cw / 2) / cam.zoom, y: cam.y + (sy - ch / 2) / cam.zoom };
}

// Zoom about a screen point, keeping the world point under it pinned there.
function zoomAt(sx, sy, factor) {
  const { cw, ch } = view();
  const before = toWorld(sx, sy);
  cam.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
  cam.x = before.x - (sx - cw / 2) / cam.zoom;
  cam.y = before.y - (sy - ch / 2) / cam.zoom;
}

const keys = {};
const PAN_KEYS = { KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0],
                   ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
addEventListener('keydown', e => { if (PAN_KEYS[e.code]) { keys[e.code] = 1; e.preventDefault(); } });
addEventListener('keyup', e => { if (PAN_KEYS[e.code]) { keys[e.code] = 0; e.preventDefault(); } });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

// One pointer pans, two pinch. A press that neither moves far nor lasts long is a click.
const pointers = new Map();
let dragged = 0, pressedAt = 0, pinch = null;

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) {
    dragged = 0; pressedAt = performance.now();
    if (cmdShip) {                                  // grabbing the handle is not a pan or a click
      const r = canvas.getBoundingClientRect();
      const w = toWorld(e.clientX - r.left, e.clientY - r.top), i = iconPos(cmdShip);
      if (Math.hypot(w.x - i.x, w.y - i.y) < GRAB_R / cam.zoom) { rotating = true; dragHeading = cmdShip.hd; }
    }
  }
  if (pointers.size === 2) pinch = spread();
});

function spread() {
  const [a, b] = [...pointers.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
}

canvas.addEventListener('pointermove', e => {
  const prev = pointers.get(e.pointerId);
  if (!prev) return;
  const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

  if (pointers.size >= 2) {
    const now = spread();
    if (pinch && now.d > 0 && pinch.d > 0) {
      const r = canvas.getBoundingClientRect();
      zoomAt(now.mx - r.left, now.my - r.top, now.d / pinch.d);
    }
    pinch = now;
    return;
  }
  dragged += Math.hypot(dx, dy);

  if (rotating && cmdShip) {
    const r = canvas.getBoundingClientRect();
    const w = toWorld(e.clientX - r.left, e.clientY - r.top), c = controlAt(cmdShip);
    dragHeading = Math.atan2(w.y - c.y, w.x - c.x);
    sendFace(dragHeading, false);
    return;                                         // rotating the ship must not also pan the camera
  }
  cam.x -= dx / cam.zoom;
  cam.y -= dy / cam.zoom;
});

let commanded = null;           // the ship a click orders; the first of yours, for now
let cmdShip = null;             // ...and its latest interpolated state, for hit-testing the control

// The heading control keeps a constant on-screen size, so its radius in world units
// is whatever 64 screen pixels happens to be at the current zoom.
const CONTROL_R = 64, GRAB_R = 18;
let rotating = false, dragHeading = null, lastFaceSend = 0;

// The control surrounds the destination while one is outstanding: the heading applies
// on arrival, so it belongs where the ship will be, not where it is.
const controlAt = s => s && s.dx !== undefined ? { x: s.dx, y: s.dy } : s;

function iconPos(s) {
  const c = controlAt(s), h = dragHeading ?? s.hd;
  const R = CONTROL_R / cam.zoom;
  return { x: c.x + Math.cos(h) * R, y: c.y + Math.sin(h) * R };
}

function sendFace(a, force) {
  const now = performance.now();
  if (!force && now - lastFaceSend < 80) return;
  lastFaceSend = now;
  if (ws.readyState === 1 && commanded !== null) ws.send(JSON.stringify({ t: 'face', ship: commanded, a }));
}

function release(e) {
  if (!pointers.has(e.pointerId)) return;
  const wasSingle = pointers.size === 1;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!wasSingle) return;
  if (rotating) { sendFace(dragHeading, true); rotating = false; dragHeading = null; return; }
  if (dragged < 5 && performance.now() - pressedAt < 400 && ws.readyState === 1 && commanded !== null) {
    const r = canvas.getBoundingClientRect();
    const p = toWorld(e.clientX - r.left, e.clientY - r.top);
    ws.send(JSON.stringify({ t: 'move', ship: commanded, x: p.x, y: p.y }));
  }
}
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('contextmenu', e => e.preventDefault());

// ---- shapes ----
const HULL = [[52, 0], [40, -12], [-42, -12], [-50, -6], [-50, 6], [-42, 12], [40, 12]];
const DECK = [[36, 0], [-40, 0]];                       // spine
const RIBS = [[[18, -12], [18, 12]], [[-14, -12], [-14, 12]]];
const TURRET = [[-5, -4], [3, -4], [3, -1.5], [14, -1.5], [14, 1.5], [3, 1.5], [3, 4], [-5, 4]];
const FLAME = [[-50, 0], [-62, 6], [-70, 0], [-62, -6]];
const MARKER = [[0, -9], [9, 0], [0, 9], [-9, 0]];
const TURRET_HP = 100, BAR_W = 22, BAR_H = 3, BAR_DROP = 13;   // bar sizes are screen px

// Green at full, yellow at half, red at nothing -- interpolated through yellow so the
// colour keeps changing across the whole range rather than only at the ends.
function healthColor(f) {
  const [r, g_, b] = f > 0.5
    ? [Math.round(510 * (1 - f)), 220, 90]
    : [235, Math.round(440 * f), 70];
  return `rgb(${r},${g_},${b})`;
}

// Screen-oriented and screen-sized: a gauge, not part of the ship.
function healthBar(x, y, frac) {
  const s = 1 / cam.zoom, w = BAR_W * s, h = BAR_H * s;
  const bx = x - w / 2, by = y + BAR_DROP * s;
  ctx.save();
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(8,14,22,.85)';
  ctx.fillRect(bx, by, w, h);
  ctx.fillStyle = healthColor(frac);
  ctx.fillRect(bx, by, w * frac, h);
  ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 0.5 * s;
  ctx.strokeRect(bx, by, w, h);
  ctx.restore();
}

function rockShape(seed, size) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const n = 8 + size, base = size * 16, pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = base * (0.72 + rnd() * 0.5);
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return pts;
}
const rockCache = new Map();
const getRock = (seed, size) => {
  const k = seed + ':' + size;
  if (!rockCache.has(k)) rockCache.set(k, rockShape(seed, size));
  return rockCache.get(k);
};

// ---- starfield ----
// Space has no edges to wrap, so stars are generated per tile from the tile's own
// coordinates: pan anywhere and the same patch of sky comes back identical, without
// storing any of it.
const STAR_LAYERS = [
  { z: 0.35, tile: 900, per: 22, alpha: 0.30, size: 1.2 },
  { z: 0.60, tile: 1100, per: 16, alpha: 0.45, size: 1.5 },
  { z: 0.90, tile: 1300, per: 11, alpha: 0.65, size: 1.9 },
];
const starCache = new Map();
function tileStars(layer, li, tx, ty) {
  const key = `${li}:${tx}:${ty}`;
  let pts = starCache.get(key);
  if (!pts) {
    let s = ((tx * 73856093) ^ (ty * 19349663) ^ (li * 83492791)) >>> 0;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    rnd(); rnd();
    pts = Array.from({ length: layer.per }, () => [rnd() * layer.tile, rnd() * layer.tile]);
    if (starCache.size > 3000) starCache.clear();   // panning forever must not leak
    starCache.set(key, pts);
  }
  return pts;
}

function drawStars(cw, ch) {
  ctx.shadowBlur = 0;
  const halfW = cw / 2 / cam.zoom, halfH = ch / 2 / cam.zoom;
  STAR_LAYERS.forEach((layer, li) => {
    const ox = cam.x * layer.z, oy = cam.y * layer.z;   // parallax: nearer layers slide faster
    const size = layer.size / cam.zoom;
    ctx.fillStyle = `rgba(180,215,255,${layer.alpha})`;
    for (let tx = Math.floor((ox - halfW) / layer.tile); tx <= Math.floor((ox + halfW) / layer.tile); tx++)
      for (let ty = Math.floor((oy - halfH) / layer.tile); ty <= Math.floor((oy + halfH) / layer.tile); ty++)
        for (const [px, py] of tileStars(layer, li, tx, ty))
          ctx.fillRect(tx * layer.tile + px - ox, ty * layer.tile + py - oy, size, size);
  });
}

// A circular arrow, drawn at whatever size keeps it constant on screen.
function rotateIcon(x, y, a, hot) {
  const s = 1 / cam.zoom, r = 7 * s, end = Math.PI * 2 - 0.7;
  ctx.save();
  ctx.translate(x, y); ctx.rotate(a);
  ctx.strokeStyle = hot ? '#c9ffe9' : '#5ff0b0';
  ctx.lineWidth = 1.7 * s;
  ctx.shadowColor = '#5ff0b0'; ctx.shadowBlur = 8;
  ctx.beginPath(); ctx.arc(0, 0, r, 0.7, end); ctx.stroke();
  ctx.translate(Math.cos(end) * r, Math.sin(end) * r);
  ctx.rotate(end + Math.PI / 2);                    // arrowhead lies along the arc's tangent
  ctx.beginPath();
  ctx.moveTo(-4 * s, -3 * s); ctx.lineTo(0, 2 * s); ctx.lineTo(4 * s, -3 * s);
  ctx.stroke();
  ctx.restore();
}

function drawControl(s) {
  const c = controlAt(s), h = dragHeading ?? s.hd;
  const R = CONTROL_R / cam.zoom, cx = c.x - cam.x, cy = c.y - cam.y;
  ctx.save();
  ctx.strokeStyle = rotating ? 'rgba(95,240,176,.45)' : 'rgba(95,240,176,.20)';
  ctx.lineWidth = 1 / cam.zoom; ctx.shadowBlur = 0;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath();                                  // spoke to the handle: the set-point
  ctx.moveTo(cx + Math.cos(h) * R * 0.25, cy + Math.sin(h) * R * 0.25);
  ctx.lineTo(cx + Math.cos(h) * R * 0.82, cy + Math.sin(h) * R * 0.82);
  ctx.stroke();
  ctx.restore();
  rotateIcon(cx + Math.cos(h) * R, cy + Math.sin(h) * R, h, rotating);
}

// Strokes are specified in screen pixels and divided by zoom, so the linework keeps
// its weight at every magnification instead of turning into hairlines or slabs.
function poly(pts, x, y, a, color, close = true, width = 1.6) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(a);
  ctx.beginPath();
  pts.forEach(([px, py], i) => i ? ctx.lineTo(px, py) : ctx.moveTo(px, py));
  if (close) ctx.closePath();
  ctx.strokeStyle = color; ctx.lineWidth = width / cam.zoom;
  ctx.shadowColor = color; ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.restore();
}

let lastFrame = performance.now();

function draw() {
  requestAnimationFrame(draw);
  const state = viewState();
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  if (!state) return;

  const mine = state.ships.filter(s => s.owner === myId);
  commanded = mine.length ? mine[0].id : null;
  cmdShip = mine.length ? mine[0] : null;
  if (!cam.placed && mine.length) { cam.x = mine[0].x; cam.y = mine[0].y; cam.placed = true; }

  let px = 0, py = 0;
  for (const code in PAN_KEYS) if (keys[code]) { px += PAN_KEYS[code][0]; py += PAN_KEYS[code][1]; }
  if (px || py) {
    const n = Math.hypot(px, py);
    cam.x += (px / n) * PAN_KEY_SPEED * dt / cam.zoom;
    cam.y += (py / n) * PAN_KEY_SPEED * dt / cam.zoom;
  }

  const { cw, ch } = view();
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, cw, ch);
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(cam.zoom, cam.zoom);

  drawStars(cw, ch);

  const at = o => [o.x - cam.x, o.y - cam.y];

  for (const r of state.rocks) {
    const [x, y] = at(r);
    poly(getRock(r.seed, r.size), x, y, r.a, '#8fa6c8');
  }

  ctx.shadowBlur = 8; ctx.shadowColor = '#ffd76a'; ctx.fillStyle = '#ffd76a';
  const bs = 3 / cam.zoom;
  for (const b of state.bullets) {
    const [x, y] = at(b);
    ctx.fillRect(x - bs / 2, y - bs / 2, bs, bs);
  }
  ctx.shadowBlur = 0;

  for (const s of mine) {
    if (s.dx === undefined) continue;
    const [mx, my] = at({ x: s.dx, y: s.dy });
    const [sx, sy] = at(s);
    ctx.save();
    ctx.strokeStyle = 'rgba(95,240,176,.22)'; ctx.lineWidth = 1 / cam.zoom;
    ctx.setLineDash([6 / cam.zoom, 8 / cam.zoom]);
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(mx, my); ctx.stroke();
    ctx.restore();
    const pulse = 1 + 0.18 * Math.sin(now / 220);
    poly(MARKER.map(([x, y]) => [x * pulse, y * pulse]), mx, my, now / 1400, '#5ff0b0', true, 1.2);
  }

  if (cmdShip) drawControl(cmdShip);

  const nameOf = id => (state.players.find(p => p.id === id) || {}).name || '?';

  for (const s of state.ships) {
    const [x, y] = at(s);
    const own = s.owner === myId;
    const color = own ? '#5ff0b0' : '#ff6b8a';
    poly(HULL, x, y, s.a, color);
    poly(DECK, x, y, s.a, color, false, 1);
    for (const rib of RIBS) poly(rib, x, y, s.a, color, false, 1);
    if (s.th) poly(FLAME, x, y, s.a, '#ffb347', false);
    // mounts ride the hull; each gun keeps its own world bearing
    const cos = Math.cos(s.a), sin = Math.sin(s.a);
    mounts.forEach((mt, i) => {
      const hp = s.hp ? s.hp[i] : TURRET_HP;
      if (hp <= 0) return;                                // silenced guns are gone
      const gx = x + mt.at[0] * cos - mt.at[1] * sin, gy = y + mt.at[0] * sin + mt.at[1] * cos;
      if (own) {                                          // show each mount's traverse limits
        ctx.save();
        ctx.strokeStyle = 'rgba(95,240,176,.10)'; ctx.lineWidth = 1 / cam.zoom;
        ctx.beginPath();
        ctx.arc(gx, gy, 40, s.a + mt.facing - arcHalf, s.a + mt.facing + arcHalf);
        ctx.stroke();
        ctx.restore();
      }
      poly(TURRET, gx, gy, s.tu[i], '#cfe6ff', true, 1.2);
      if (hp < TURRET_HP) healthBar(gx, gy, hp / TURRET_HP);
    });
    if (!own) {
      ctx.save(); ctx.translate(x, y);
      ctx.fillStyle = 'rgba(255,107,138,.7)';
      ctx.font = `${11 / cam.zoom}px ui-monospace, monospace`; ctx.textAlign = 'center';
      ctx.fillText(nameOf(s.owner), 0, 34);
      ctx.restore();
    }
  }

  const board = [...state.players].sort((a, b) => b.score - a.score).slice(0, 6)
    .map(p => `${p.id === myId ? '>' : ' '} ${p.name.padEnd(8)} ${String(p.score).padStart(5)}`).join('\n');
  hud.textContent = `CLICK move   DRAG ring to turn   WASD pan   WHEEL zoom  (${cam.zoom.toFixed(2)}x)${dev ? '   [dev]' : ''}\n`
    + `${Math.round(cam.x)}, ${Math.round(cam.y)}\n\n${board}`;
}
draw();
