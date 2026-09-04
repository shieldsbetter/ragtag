const canvas = document.getElementById('c');
// Everything is drawn into an off-screen surface and blitted to the visible canvas in a
// single drawImage at the end of the frame. The browser is supposed to present a canvas
// atomically per frame and make this redundant -- but the visible layer now receives one
// operation instead of thousands, so there is no incremental rasterisation for the
// compositor to catch halfway through.
// alpha:false on both: each fills its own background, so there is nothing to blend.
// Software rasterisation by default. willReadFrequently nominally says "this canvas is
// read back often", but every engine implements it by backing the canvas on the CPU
// instead of the GPU, and that is the only control a page has over where rasterisation
// happens. It is here because the GPU tile rasteriser on at least one phone corrupts
// individual shapes for a frame -- one hull fragmented while the ship beside it drew
// perfectly -- which no amount of changing what we draw could avoid. ?gpu=1 opts back in
// for comparison.
const CPU = !new URLSearchParams(location.search).has('gpu');
const screen = canvas.getContext('2d', { alpha: false });
const back = document.createElement('canvas');
const ctx = back.getContext('2d', { alpha: false, willReadFrequently: CPU });
const hud = document.getElementById('hud');

let myId = null, mounts = [], arcHalf = 0, maxView = 2200, clientVersion = '???????';

// Diagnostic switches, set in the URL: ?off=labels,wallfill,walls,bars,arcs
// Each removes one class of drawing so a rendering fault can be bisected on the device
// that actually shows it, without a round trip through the editor.
const OFF = new Set((new URLSearchParams(location.search).get('off') || '').split(',').filter(Boolean));
// ?buzz makes every tap fire an unmistakable pulse, to separate "this device does not
// vibrate" from "my gesture code never asked it to".
const BUZZ_TEST = new URLSearchParams(location.search).has('buzz');

// The camera is free: it starts on your first ship and thereafter goes where you put it.
const cam = { x: 0, y: 0, zoom: 1, placed: false };

// Cap the backing store. A 3x phone screen means ~3 megapixels to rasterise every frame,
// and a large canvas layer is what the compositor re-rasterises in tiles -- which is what
// shows up as flicker. Past 2x there is very little visible gain on a phone, and the CSS
// size is untouched, so only the resolution the layer is drawn at changes.
const MAX_DPR = 2;
const dpr = () => Math.min(devicePixelRatio, MAX_DPR);
const PAN_KEY_SPEED = 700;      // world px/sec at zoom 1

// Flat vector linework, no glow: canvas shadowBlur is device-space rather than user
// space, mobile engines render it inconsistently or not at all, and drawing a halo by
// hand cost too many frames on a phone. Every platform now looks the same.
const MAX_ZOOM = 4;

// The server only streams what lies within maxView of the camera, so the camera must
// never be able to see further than that -- otherwise you would be looking at a ring
// of empty space that is populated but not sent. This is the floor on zoom, and it
// depends on the viewport, so it is recomputed rather than fixed.
const minZoom = () => Math.hypot(canvas.width / dpr(), canvas.height / dpr()) / 2 / maxView;
const clampZoom = z => Math.min(MAX_ZOOM, Math.max(minZoom(), z));

// Integer backing store: a fractional canvas.width is floored by the browser while the
// CSS size keeps the fraction, leaving the two slightly out of step and the surface
// resampled.
function resize() {
  const w = Math.round(innerWidth * dpr()), h = Math.round(innerHeight * dpr());
  canvas.width = w; canvas.height = h;
  back.width = w; back.height = h;
  canvas.style.width = innerWidth + 'px';
  canvas.style.height = innerHeight + 'px';
  cam.zoom = clampZoom(cam.zoom);
}

// Deliberately NOT wired to the resize event. Assigning canvas.width wipes the surface,
// and a resize handler runs outside the frame loop, so the compositor can present that
// blank canvas before anything redraws -- which on a phone, where browser chrome fires
// resize constantly, is a visible flicker every few seconds. Checked here instead, at the
// top of the frame that immediately repaints, leaving no window in which it can be seen.
// This also covers a devicePixelRatio change, which fires no resize event at all.
function ensureSize() {
  if (canvas.width !== Math.round(innerWidth * dpr()) ||
      canvas.height !== Math.round(innerHeight * dpr())) resize();
}
resize();

// ---- net ----
// Snapshots are stamped with local arrival time; we render RENDER_DELAY ms in the
// past so there are always two snapshots straddling the render clock to lerp between.
// No clock sync needed, and a late packet costs smoothness only, never a rubber-band.
const RENDER_DELAY = 120;
const buffer = [];              // [{ rt, snap }] oldest -> newest

// Snapshots are placed on the render timeline by the SERVER's send time, not by when
// this client processed them. A main-thread hitch makes several arrive back to back,
// and stamping those by arrival would replay a third of a second of game time in a
// millisecond -- interpolation never fails, it just plays the motion wrong.
// The offset is the least-delayed packet seen (the cleanest sample of the one-way trip),
// allowed to creep upward so a genuinely slower path is eventually tracked.
let clockOffset = null;
function renderStamp(serverTime, arrival) {
  const delay = arrival - serverTime;
  if (clockOffset === null || delay < clockOffset) clockOffset = delay;
  else clockOffset += 0.0005 * (delay - clockOffset);
  return serverTime + clockOffset;
}

let dev = false;
const wallChunks = new Map();   // chunk key -> polygons, pushed by the server as the camera moves

// Walls never move, so each polygon's bounds are worth computing once on arrival and
// keeping: culling against them is what stops a phone drawing a whole streamed region
// to fill a screen a fraction of its size.
// A wall arrives as a list of rings: outline first, then any holes. Bounds cover all of
// them, and both paths are built once -- walls never move.
function withBox(rings) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const ring of rings)
    for (const [x, y] of ring) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  const path = new Path2D();
  for (const ring of rings) {
    ring.forEach(([x, y], i) => i ? path.lineTo(x, y) : path.moveTo(x, y));
    path.closePath();
  }
  return { rings, x0, y0, x1, y1, path };
}

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

// Match the page's scheme: served over https (a tunnel, say) a plaintext ws:// is
// blocked as mixed content, so the socket has to be wss:// there.
// The session names this player to the server. Kept in localStorage so a refresh, a
// reconnect, or coming back tomorrow resumes the same ship rather than abandoning it.
// Nothing is answered until the server has it, so it is the first thing sent.
const SESSION_KEY = 'ships.session';
let session;
try { session = localStorage.getItem(SESSION_KEY); } catch {}
if (!session) {
  session = (crypto.randomUUID?.() ?? String(Math.random()).slice(2) + Date.now().toString(36));
  try { localStorage.setItem(SESSION_KEY, session); } catch {}   // private window: this session only
}

const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`);
ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', session }));
ws.onclose = reloadWhenUp;
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.t === 'welcome') {
    myId = m.id; dev = m.dev; mounts = m.mounts; arcHalf = m.arcHalf;
    maxView = m.maxView; clientVersion = m.cv || '???????'; cam.zoom = clampZoom(cam.zoom);
    if (m.prioStops) prioStops = m.prioStops;
    if (m.wreck) wreckDepth = m.wreck;
    return;
  }
  if (m.t === 'reload') { location.reload(); return; }
  if (m.t === 'chunk') { wallChunks.set(m.key, m.walls.map(withBox)); return; }
  if (m.t === 'drop') { for (const k of m.keys) wallChunks.delete(k); return; }
  if (m.t !== 's') return;
  buffer.push({ rt: m.st === undefined ? performance.now() : renderStamp(m.st, performance.now()), snap: m });
  while (buffer.length > 2 && buffer[1].rt < performance.now() - RENDER_DELAY - 500) buffer.shift();
};

// The server streams around the camera, so it has to know where the camera is. Only
// worth a message when it has actually moved.
let sentView = null;
setInterval(() => {
  if (ws.readyState !== 1 || !cam.placed) return;
  const x = Math.round(cam.x), y = Math.round(cam.y);
  if (sentView && sentView.x === x && sentView.y === y) return;
  sentView = { x, y };
  ws.send(JSON.stringify({ t: 'view', x, y }));
}, 200);

// Zoom survives a reload; position does not, because a reload gets you a new ship
// somewhere else and the camera should be looking at it.
const ZOOM_KEY = 'ships.zoom';
try { const z = parseFloat(sessionStorage.getItem(ZOOM_KEY)); if (z > 0) cam.zoom = clampZoom(z); } catch {}
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
    v: newer.v, stale: newer.stale,
    players: newer.players,
    ships: pair(newer.ships, byId(older.ships), (p, e) => ({
      a: lerpAngle(p.a, e.a, t),
      tu: e.tu.map((v, i) => p.tu?.[i] === undefined ? v : lerpAngle(p.tu[i], v, t)),
    })),
    rocks: pair(newer.rocks, byId(older.rocks), (p, e) => ({ a: lerpAngle(p.a, e.a, t) })),
    bullets: pair(newer.bullets, byId(older.bullets), () => ({})),
  };
}

let lastGood = null, stalls = 0;

function viewState() {
  if (!buffer.length) return null;
  const target = performance.now() - RENDER_DELAY;
  for (let i = buffer.length - 1; i > 0; i--) {
    const a = buffer[i - 1], b = buffer[i];
    if (a.rt <= target && target <= b.rt) {
      lastGood = blend(a.snap, b.snap, (target - a.rt) / (b.rt - a.rt));
      return lastGood;
    }
  }
  // No pair straddles the render clock: the feed stalled, or a main-thread hitch bunched
  // several arrivals together. Hold the last interpolated frame -- a frozen frame is
  // invisible, whereas snapping to the newest raw snapshot and back is a visible jump of
  // a whole render delay, in position and heading both.
  stalls++;
  return lastGood ?? buffer[buffer.length - 1].snap;
}

// ---- camera controls ----
const view = () => ({ cw: canvas.width / dpr(), ch: canvas.height / dpr() });

// Screen pixel -> world point under it.
function toWorld(sx, sy) {
  const { cw, ch } = view();
  return { x: cam.x + (sx - cw / 2) / cam.zoom, y: cam.y + (sy - ch / 2) / cam.zoom };
}

// Zoom about a screen point, keeping the world point under it pinned there.
function zoomAt(sx, sy, factor) {
  const { cw, ch } = view();
  const before = toWorld(sx, sy);
  cam.zoom = clampZoom(cam.zoom * factor);
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
    dragged = 0; pressedAt = performance.now(); longFired = false; pressedControl = null; cancelHold();
    const r = canvas.getBoundingClientRect();
    const w = toWorld(e.clientX - r.left, e.clientY - r.top);
    // Controls are checked before anything else could claim the press -- including the
    // hold, which would otherwise arm underneath one.
    const ctl = paneHit(w);
    if (ctl) {
      if (ctl.kind === 'rotate') { rotating = true; dragHeading = cmdShip.hd; }
      else pressedControl = ctl;
      return;
    }
    if (!rotating) {
      const s = shipAt(w);
      // A hold over open space is worth arming too -- that is how a selection is put
      // down -- but only when there is something to clear.
      if (s || selection.size) {
        holding = { ship: s ? s.id : null, x: w.x, y: w.y, start: performance.now() };
        // Scheduled here, inside the gesture, so the engine honours it. Cancelled below
        // if the press becomes a drag or lifts early.
        haptic(holdPulse(s ? !(selection.has(s.id) && selection.size > 1) : false));
        longTimer = setTimeout(() => {
          longFired = true; longTimer = null;
          if (holding.ship !== null) toggleInSelection(holding.ship);
          else clearSelection(holding.x, holding.y);
          holding = null;
        }, LONG_PRESS_MS);
      }
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
  if (dragged > LONG_PRESS_SLOP) cancelHold();      // a drag is a pan, not a hold

  if (rotating && cmdShip) {
    const r = canvas.getBoundingClientRect();
    const w = toWorld(e.clientX - r.left, e.clientY - r.top), c = anchorOf(cmdShip);
    dragHeading = Math.atan2(w.y - c.y, w.x - c.x);
    sendFace(dragHeading, false);
    return;                                         // rotating the ship must not also pan the camera
  }
  cam.x -= dx / cam.zoom;
  cam.y -= dy / cam.zoom;
});

// No ship is special: you own a fleet, some of it is selected, and one of the selected
// is designated -- the one wearing the heading ring.
//   tap a ship outside the selection : it becomes the selection
//   tap a ship inside the selection  : it becomes designated, group unchanged
//   long-press a ship (shift+click)  : add it, or drop it if already in
//   long-press open space            : clear the selection
//   tap open space                   : the whole selection moves, keeping formation
const selection = new Set();
let designated = null;          // id of the ship wearing the ring
let cmdShip = null;             // ...and its latest interpolated state
let fleet = [];                 // every ship you own, this frame
let allShips = [];              // ...and everyone else's that is close enough to see

// Mobile has three gestures and drag is already the map, so adding to a selection is a
// long press. Slop is generous: a thumb moves a little during a deliberate hold.
const LONG_PRESS_MS = 450, LONG_PRESS_SLOP = 10;
let holding = null;             // { ship, x, y, start } while a press is maturing
let hasSelected = false;        // one ship is picked on arrival; after that, empty is a choice
let longTimer = null, longFired = false, pressedControl = null;
// Haptics exist on Chrome/Android and nowhere else -- Firefox disabled vibration in 79
// and removed it in 129, iOS never had it -- so the visual confirmation has to carry the
// gesture on its own. A ring flies out on add and collapses in on drop.
let confirm = null;             // { x, y, start, adding }
// Screen pixels, not world units: these are feedback about a gesture, so they must clear
// the thumb making it whatever the zoom happens to be.
const CONFIRM_MS = 320, HOLD_R = 62, CONFIRM_R0 = 70, CONFIRM_GROW = 95;
// Nothing is drawn for the first fraction of a press. A tap is over in about a tenth of
// a second, and flashing a ring for every one of them turns ordinary tapping into
// visual noise. Past this the arc sweeps from empty to full, finishing exactly as the
// long press fires.
const HOLD_DELAY = 150;

function cancelHold() {
  if (longTimer) { clearTimeout(longTimer); longTimer = null; haptic(0); }   // 0 cancels
  holding = null;
}

// A short pulse confirms a gesture the screen cannot: during a long press your thumb is
// covering the ship. Android only -- iOS Safari has no Vibration API at all.
//
// vibrate() needs user activation, and firing it from the long-press timer happens
// outside the gesture that started it, which engines drop. So the pulse is SCHEDULED
// synchronously in pointerdown -- a pattern whose first entry is a zero-length buzz
// followed by the hold delay -- and cancelled if the press turns out to be a drag or a
// tap. The vibration then lands exactly when the selection changes, from inside the
// gesture that earned the right to it.
const vib = { ok: typeof navigator.vibrate === 'function', calls: 0, last: null };
function haptic(pattern) {
  if (!vib.ok) return;
  try { vib.last = navigator.vibrate(pattern); vib.calls++; } catch { vib.last = 'threw'; }
}
const PULSE_ADD = 25, PULSE_DROP = 12;           // one long tick to add, two short to remove
const holdPulse = adding => adding
  ? [0, LONG_PRESS_MS, PULSE_ADD]                             // pause, then one buzz
  : [0, LONG_PRESS_MS, PULSE_DROP, 60, PULSE_DROP];           // pause, then two

// Nothing selected is a legitimate state, not an empty one to be filled: it is how you
// put the fleet down without giving it an order by accident.
function clearSelection(x, y) {
  if (!selection.size) return;
  selection.clear();
  designated = null;
  confirm = { x, y, start: performance.now(), adding: false };
}

function toggleInSelection(id) {
  const ship = fleet.find(s => s.id === id);
  const adding = !(selection.has(id) && selection.size > 1);
  if (adding) {
    selection.add(id);
    designated = id;            // whatever you just added is what you are aiming
  } else {
    selection.delete(id);
    if (designated === id) designated = [...selection][0];
  }
  if (ship) confirm = { x: ship.x, y: ship.y, start: performance.now(), adding };
}

// A ship is tappable at its hull size, but never smaller than a thumb: zoomed out, the
// hull is a few pixels across and the generous radius is what makes selection possible.
const SHIP_PICK = 60, PICK_MIN_PX = 26;
function shipAt(world) {
  const r = Math.max(SHIP_PICK, PICK_MIN_PX / cam.zoom);
  let best = null, bestD = r;
  for (const s of fleet) {
    const d = Math.hypot(s.x - world.x, s.y - world.y);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// Same reach as your own ships, over everyone else's. Tapping one with a selection in
// hand is how focus fire is ordered, so it has to be as easy to hit as a friendly.
function otherShipAt(world) {
  const r = Math.max(SHIP_PICK, PICK_MIN_PX / cam.zoom);
  let best = null, bestD = r;
  for (const s of allShips) {
    if (s.owner === myId) continue;
    const d = Math.hypot(s.x - world.x, s.y - world.y);
    if (d < bestD) { bestD = d; best = s; }
  }
  return best;
}

// One target per ship, and the order goes to the whole selection at once: singling ships
// out is what the accordion is for.
function orderFocus(target, ships) {
  if (!ships.length || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ t: 'focus', ships, target }));
}

// The distinct ships the selection is currently firing at. Two halves of a fleet may be
// working on different targets, and both reticles are drawn.
function focusTargets() {
  const ids = new Set();
  for (const id of selection) {
    const s = fleet.find(q => q.id === id);
    if (s && s.fo !== undefined) ids.add(s.fo);
  }
  return [...ids].map(id => allShips.find(s => s.id === id)).filter(Boolean);
}

// The formation is taken from the first order given to a group and held until the group
// changes. Ships under way are strung out along their courses, so re-deriving the shape
// at every tap would bake in whatever disorder the fleet happened to be in mid-flight;
// a redirected fleet would arrive in a different shape than the one it set out in.
let formation = new Map(), formed = false, lastSelKey = '';

// The selection moves as a body: its centre goes where you tapped and every ship keeps
// the offset it had when the group was first sent somewhere, so a line abreast stays a
// line abreast however often the destination changes.
function orderMove(world) {
  const picked = [...selection].map(id => fleet.find(s => s.id === id)).filter(Boolean);
  if (!picked.length) return;
  if (!formed) {
    formed = true;
    formation = new Map();
    let cx = 0, cy = 0;
    for (const s of picked) { cx += s.x; cy += s.y; }
    cx /= picked.length; cy /= picked.length;
    for (const s of picked) formation.set(s.id, { dx: s.x - cx, dy: s.y - cy });
  }
  for (const s of picked) {
    const off = formation.get(s.id) ?? { dx: 0, dy: 0 };
    ws.send(JSON.stringify({ t: 'move', ship: s.id, x: world.x + off.dx, y: world.y + off.dy }));
  }
}


// The heading control keeps a constant on-screen size, so its radius in world units
// is whatever 64 screen pixels happens to be at the current zoom.
const CONTROL_R = 64, GRAB_R = 18;
// The selection as a whole gets a dotted ring, with a dismiss icon sitting on it. The
// long press clears too, but a gesture nobody can see is a gesture nobody finds.
const GROUP_PAD = 90, GROUP_MIN_R = 130, CLEAR_ANGLE = -Math.PI * 0.75;   // up and to the left

function groupCircle() {
  const picked = [...selection].map(id => fleet.find(s => s.id === id)).filter(Boolean);
  if (!picked.length) return null;
  let cx = 0, cy = 0;
  for (const s of picked) { cx += s.x; cy += s.y; }
  cx /= picked.length; cy /= picked.length;
  let far = 0;
  for (const s of picked) far = Math.max(far, Math.hypot(s.x - cx, s.y - cy));
  return { x: cx, y: cy, r: Math.max(far + GROUP_PAD, GROUP_MIN_R) };
}


let rotating = false, dragHeading = null, lastFaceSend = 0;

// The control surrounds the destination while one is outstanding: the heading applies
// on arrival, so it belongs where the ship will be, not where it is.
const anchorOf = s => s && s.dx !== undefined ? { x: s.dx, y: s.dy } : s;

// ---- the details drawer ----
// A place for controls that are lists and toggles rather than gestures -- target
// priorities first. The canvas is for things you point at; this is for things you read.
// It only exists while something is selected, since an empty selection is a real state
// and not a gap to fill.
const details = document.getElementById('details');
const detailsBody = document.getElementById('detailsBody');
const detailsToggle = document.getElementById('detailsToggle');

// Wide screens have room for the panel beside the game, so it opens by default and the
// button collapses it. Narrow screens do not, so the panel is a drawer over the board
// and the button is the handle that pulls it out.
const WIDE = matchMedia('(min-width: 900px)');
let detailsOpen = WIDE.matches;
WIDE.addEventListener('change', e => { detailsOpen = e.matches; syncDetails(true); });
detailsToggle.addEventListener('click', () => { detailsOpen = !detailsOpen; syncDetails(true); });

// The fleet is an accordion: every selected ship shows a one-line overview, and one of
// them at a time is open. Two ships' worth of envelope editors side by side would not
// fit a phone, and comparing them is not what the panel is for -- setting one is.
let openShip = null;
// Two sections, because the axis underneath differs even though the editor does not:
// targeting reads distance, repair reads health with the wreck debt on the low end.
const PANELS = [
  { title: 'TARGET PRIORITY', axis: ['near', 'far'],
    rows: [['rock', 'Asteroids'], ['turret', 'Turrets']] },
  { title: 'REPAIR PRIORITY', axis: ['wrecked', 'full'],
    rows: [['repair', 'Damaged guns']] },
];
let prioStops = 5, wreckDepth = 150;

const statusOf = s =>
  `${s.hp.filter(h => h > 0).length}/${s.hp.length} guns  ${s.th ? 'burn' : 'coast'}`
  + `  ${s.dx !== undefined ? 'move' : 'hold'}`;

let builtKey = '';
const statusEls = new Map();

function syncDetails() {
  document.body.classList.toggle('has-selection', selection.size > 0);
  document.body.classList.toggle('details-open', detailsOpen);
  detailsToggle.textContent = detailsOpen ? '\u2715' : '\u2630';
  if (!selection.size || !detailsOpen) return;
  const ships = [...selection].map(id => fleet.find(s => s.id === id)).filter(Boolean);
  if (!ships.some(s => s.id === openShip))
    openShip = ships.some(s => s.id === designated) ? designated : (ships[0]?.id ?? null);

  // Rebuilding blows away a half-dragged envelope, so it happens only when the shape of
  // the panel changes -- which ships, which one is open, which one wears the ring. The
  // live numbers are written into kept nodes every frame instead.
  const key = ships.map(s => s.id).join(',') + `|${openShip}|${designated}`;
  if (key !== builtKey) { builtKey = key; buildDetails(ships); }
  for (const s of ships) {
    const el = statusEls.get(s.id);
    if (el) el.textContent = statusOf(s);
  }
}

function buildDetails(ships) {
  statusEls.clear();
  detailsBody.textContent = '';
  for (const s of ships) {
    const row = document.createElement('div');
    row.className = 'ship';

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'shiphead' + (s.id === openShip ? ' open' : '');
    head.innerHTML = `<span class="tw">\u25b8</span> <b>${s.id === designated ? '\u25c9 ' : ''}`
      + `ship ${s.id}</b> <span class="st"></span>`;
    head.addEventListener('click', () => {
      openShip = openShip === s.id ? null : s.id;
      syncDetails();
    });
    statusEls.set(s.id, head.querySelector('.st'));
    row.append(head);

    if (s.id === openShip) {
      const body = document.createElement('div');
      body.className = 'shipbody';
      for (const panel of PANELS) {
        const h = document.createElement('div');
        h.className = 'sub';
        h.textContent = panel.title;
        body.append(h);
        for (const [kind, label] of panel.rows)
          body.append(envelope(s.id, kind, label, panel.axis, s.pr && s.pr[kind]));
      }
      row.append(body);
    }
    detailsBody.append(row);
  }
}

// One envelope: distance across, priority up. The stops are fixed in X and dragged in Y,
// which is a one-finger gesture and needs no way to add or delete a point.
const ENV_W = 240, ENV_H = 88, ENV_PAD = 9;
function envelope(shipId, kind, label, axis, initial) {
  const n = prioStops;
  const v = (initial && initial.length === n ? initial : [100, 80, 60, 40, 20]).slice();
  const X = i => ENV_PAD + i * (ENV_W - 2 * ENV_PAD) / (n - 1);
  const Y = p => ENV_PAD + (1 - p / 100) * (ENV_H - 2 * ENV_PAD);

  const el = document.createElement('div');
  el.className = 'env';
  el.innerHTML = `<div class="envhead">${label}<b></b></div>`
    + `<svg viewBox="0 0 ${ENV_W} ${ENV_H}">`
    +   `<rect class="frame" x="${ENV_PAD}" y="${ENV_PAD}" `
    +     `width="${ENV_W - 2 * ENV_PAD}" height="${ENV_H - 2 * ENV_PAD}"/>`
    +   `<polyline class="curve" points=""/>`
    +   v.map((_, i) => `<circle class="stop" r="4.5" cx="${X(i)}" cy="0"/>`).join('')
    + `</svg>`
    + `<div class="envaxis"><span>${axis[0]}</span><span>${axis[1]}</span></div>`;

  const svg = el.querySelector('svg');
  const curve = el.querySelector('.curve');
  const stops = [...el.querySelectorAll('.stop')];
  const readout = el.querySelector('.envhead b');
  const paint = () => {
    curve.setAttribute('points', v.map((p, i) => `${X(i)},${Y(p)}`).join(' '));
    stops.forEach((c, i) => {
      c.setAttribute('cy', Y(v[i]));
      // Zero is not a low priority, it is a refusal, so it is worth being able to see.
      c.classList.toggle('off', v[i] === 0);
    });
    readout.textContent = v.join('  ');
  };
  paint();

  let held = -1, lastSend = 0;
  const send = () => {
    lastSend = performance.now();
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'prio', ship: shipId, kind, points: v }));
  };
  const apply = e => {
    const r = svg.getBoundingClientRect(), sc = ENV_W / r.width;
    const x = (e.clientX - r.left) * sc, y = (e.clientY - r.top) * sc;
    // The stop is chosen once, on the press. After that the drag is vertical only, so a
    // thumb sliding sideways cannot rewrite the neighbours on its way past.
    if (held < 0) held = Math.max(0, Math.min(n - 1,
      Math.round((x - ENV_PAD) / ((ENV_W - 2 * ENV_PAD) / (n - 1)))));
    v[held] = Math.round(Math.max(0, Math.min(100,
      (1 - (y - ENV_PAD) / (ENV_H - 2 * ENV_PAD)) * 100)));
    paint();
    if (performance.now() - lastSend > 120) send();   // the ship answers while you drag
  };
  svg.addEventListener('pointerdown', e => {
    e.preventDefault(); svg.setPointerCapture(e.pointerId); held = -1; apply(e);
  });
  svg.addEventListener('pointermove', e => { if (svg.hasPointerCapture(e.pointerId)) apply(e); });
  svg.addEventListener('pointerup', () => { if (held >= 0) send(); held = -1; });
  return el;
}

// The screen region the pane may place controls in: everything the drawer is not
// covering. A control the panel has slid over is a control you cannot press.
function freeRect() {
  const { cw, ch } = view();
  const r = { x0: 0, y0: 0, x1: cw, y1: ch };
  if (!selection.size || !detailsOpen || !details.offsetWidth) return r;
  const b = details.getBoundingClientRect();
  // Full-height means it is docked to a side; otherwise it is the bottom drawer.
  if (b.height >= ch - 2) r.x1 = Math.max(0, b.left); else r.y1 = Math.max(0, b.top);
  return r;
}

// ---- the glass pane ----
// Every tappable affordance is registered here each frame, resolved against the others,
// then drawn and hit-tested from the same resolved position -- so what you can see and
// what you can press can never disagree.
//
// A control that means something by where it sits is pinned: the rotate handle's angle
// IS the heading, and moving it would report a heading the ship does not have. The rest
// slide along their own ring until they are clear. Sizes are screen pixels, since this
// is about what a thumb can tell apart.
const CONTROL_PAD = 12;
let pane = [];

function buildPane() {
  const list = [];
  if (cmdShip) {
    const a = anchorOf(cmdShip);
    list.push({ kind: 'rotate', cx: a.x, cy: a.y, track: CONTROL_R / cam.zoom,
                angle: dragHeading ?? cmdShip.hd, r: GRAB_R, pinned: true });
  }
  const g = groupCircle();
  if (g) list.push({ kind: 'clear', cx: g.x, cy: g.y, track: g.r,
                     angle: CLEAR_ANGLE, r: GRAB_R, pinned: false });
  for (const t of focusTargets())
    list.push({ kind: 'focus', target: t.id, cx: t.x, cy: t.y, track: RETICLE_R / cam.zoom,
                angle: FOCUS_ANGLE, r: GRAB_R, pinned: false });
  return list;
}

const paneSpot = c => ({ x: c.cx + Math.cos(c.angle) * c.track, y: c.cy + Math.sin(c.angle) * c.track });

function resolvePane(list) {
  const { cw, ch } = view();
  const free = freeRect();
  if (dev) window.__free = free;
  for (const c of list) c.pos = paneSpot(c);
  for (const c of list) {
    if (c.pinned) continue;
    const pad = c.r + CONTROL_PAD;
    // A spot is no good if it overlaps another control or lands outside the part of the
    // screen still showing the game. Both are screen-pixel judgements -- a thumb is the
    // same size at every zoom.
    const blocked = p => {
      const sx = cw / 2 + (p.x - cam.x) * cam.zoom, sy = ch / 2 + (p.y - cam.y) * cam.zoom;
      return sx < free.x0 + pad || sx > free.x1 - pad || sy < free.y0 + pad || sy > free.y1 - pad ||
        list.some(o => o !== c && o.pos &&
          Math.hypot(o.pos.x - p.x, o.pos.y - p.y) < (o.r + c.r + CONTROL_PAD) / cam.zoom);
    };
    if (!blocked(c.pos)) continue;
    // Walk around its own ring, alternating either way, and take the first clear spot.
    // The step is one control-width of arc, not a fixed angle: a group ring can be far
    // larger than the screen, and a fixed angle would stride straight past the sliver
    // of it that is actually visible.
    const dA = Math.min(0.16, (2 * c.r + CONTROL_PAD) / cam.zoom / c.track);
    const steps = Math.min(400, Math.ceil(Math.PI / dA));
    for (let step = 1; step <= steps && blocked(c.pos); step++)
      for (const dir of [1, -1]) {
        const angle = c.angle + dir * step * dA;
        const p = paneSpot({ ...c, angle });
        if (!blocked(p)) { c.angle = angle; c.pos = p; break; }
      }
  }
  return list;
}

// What the press landed on, if anything. Hit radii are screen pixels.
function paneHit(world) {
  for (const c of pane)
    if (Math.hypot(world.x - c.pos.x, world.y - c.pos.y) < c.r / cam.zoom) return c;
  return null;
}

function sendFace(a, force) {
  const now = performance.now();
  if (!force && now - lastFaceSend < 80) return;
  lastFaceSend = now;
  if (ws.readyState === 1 && designated !== null) ws.send(JSON.stringify({ t: 'face', ship: designated, a }));
}

function release(e) {
  if (!pointers.has(e.pointerId)) return;
  const wasSingle = pointers.size === 1;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (!wasSingle) return;
  cancelHold();
  if (BUZZ_TEST) haptic(200);
  if (pressedControl) {
    const ctl = pressedControl; pressedControl = null;
    if (dragged < 8 && ctl.kind === 'clear') {
      const g = groupCircle();
      haptic(PULSE_DROP);
      if (g) clearSelection(g.x, g.y);
    }
    if (dragged < 8 && ctl.kind === 'focus') {
      // One reticle stands for every selected ship shooting at that hull, so dismissing
      // it calls all of them off -- not just whichever one happens to be designated.
      haptic(PULSE_DROP);
      orderFocus(null, [...selection].filter(id => fleet.find(s => s.id === id)?.fo === ctl.target));
    }
    return;
  }
  if (rotating) { sendFace(dragHeading, true); rotating = false; dragHeading = null; return; }
  if (longFired) { longFired = false; return; }     // the hold already acted; the release is not a tap
  if (dragged < 5 && performance.now() - pressedAt < 400 && ws.readyState === 1) {
    const r = canvas.getBoundingClientRect();
    const p = toWorld(e.clientX - r.left, e.clientY - r.top);
    const hit = shipAt(p);
    if (e.shiftKey && hit) toggleInSelection(hit.id);          // desktop equivalent of the hold
    else if (e.shiftKey) clearSelection(p.x, p.y);
    else if (hit && selection.has(hit.id)) designated = hit.id;   // re-aim within the group
    else if (hit) { selection.clear(); selection.add(hit.id); designated = hit.id; }
    else {
      // Someone else's hull under the finger is an order about that ship, not a
      // destination on the far side of it.
      const foe = selection.size ? otherShipAt(p) : null;
      if (foe) {
        orderFocus(foe.id, [...selection]);
        haptic(PULSE_DROP);
        confirm = { x: foe.x, y: foe.y, start: performance.now(), adding: true };
      } else orderMove(p);
    }
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

// A ring rather than a bar, because a wreck is not a damaged gun -- it is a hole where
// one was, and climbing out of the debt is a different thing from losing health. It
// becomes the health bar at the moment the gun is standing again. Filled arc is progress
// out of the debt; it goes bright while the ship's one repair point is going into it.
const WRECK_R = 13;   // screen px: an empty mount has nothing else marking it
function wreckRing(x, y, frac, active) {
  const s = 1 / cam.zoom, r = WRECK_R * s;
  ctx.save();
  ctx.lineWidth = 2.5 * s;
  const back = new Path2D();
  back.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,107,138,.45)';
  ctx.stroke(back);
  if (frac > 0.001) {
    const arc = new Path2D();
    arc.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, frac));
    ctx.strokeStyle = active ? '#ffd76a' : '#ff9a6a';
    ctx.stroke(arc);
  }
  ctx.restore();
}

// Screen-oriented and screen-sized: a gauge, not part of the ship.
function healthBar(x, y, frac) {
  const s = 1 / cam.zoom, w = BAR_W * s, h = BAR_H * s;
  const bx = x - w / 2, by = y + BAR_DROP * s;
  ctx.save();
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
  const ink = hot ? '#c9ffe9' : '#5ff0b0';
  ctx.strokeStyle = ink; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.lineWidth = 1.7 / cam.zoom;
  const ring = new Path2D();
  ring.arc(0, 0, r, 0.7, end);
  ctx.stroke(ring);
  ctx.translate(Math.cos(end) * r, Math.sin(end) * r);
  ctx.rotate(end + Math.PI / 2);                    // arrowhead lies along the arc's tangent
  const head = new Path2D();
  head.moveTo(-4 * s, -3 * s); head.lineTo(0, 2 * s); head.lineTo(4 * s, -3 * s);
  ctx.stroke(head);
  ctx.restore();
}

let badFrames = 0;

// Corner brackets around the ship taking orders. The heading ring moves to the
// destination once a move is ordered, so it cannot also say which ship is selected.
// The selection's outline, and the icon that dismisses it.
function drawGroup() {
  const g = groupCircle();
  if (!g) return;
  const x = g.x - cam.x, y = g.y - cam.y, s = 1 / cam.zoom;
  ctx.save();
  const ring = new Path2D();
  ring.arc(x, y, g.r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(95,240,176,.30)';
  ctx.lineWidth = 1.2 * s;
  ctx.setLineDash([7 * s, 9 * s]);
  ctx.stroke(ring);
  ctx.setLineDash([]);

  ctx.restore();
}

// A cross in a circle: dismiss, in the same weight as the rotate handle.
// Red, screen-sized, four corner brackets: it reads as a gunsight at any zoom and does
// not compete with the green everything else is drawn in.
const FOCUS_COLOR = '#ff5a63';
const RETICLE_R = 40, FOCUS_ANGLE = -Math.PI * 0.25;
function reticle(x, y) {
  const s = 1 / cam.zoom, r = RETICLE_R * s, half = 0.36;
  const p = new Path2D();
  for (let k = 0; k < 4; k++) {
    const a = -Math.PI / 4 + k * Math.PI / 2;
    p.moveTo(x + Math.cos(a - half) * r, y + Math.sin(a - half) * r);
    p.arc(x, y, r, a - half, a + half);
  }
  const tick = 5 * s;
  p.moveTo(x - tick, y); p.lineTo(x + tick, y);
  p.moveTo(x, y - tick); p.lineTo(x, y + tick);
  ctx.save();
  ctx.strokeStyle = FOCUS_COLOR;
  ctx.lineWidth = 1.8 * s;
  ctx.stroke(p);
  ctx.restore();
}

function clearIcon(x, y, color) {
  const s = 1 / cam.zoom, r = 9 * s, arm = 4.5 * s;
  const icon = new Path2D();
  icon.arc(x, y, r, 0, Math.PI * 2);
  icon.moveTo(x - arm, y - arm); icon.lineTo(x + arm, y + arm);
  icon.moveTo(x + arm, y - arm); icon.lineTo(x - arm, y + arm);
  ctx.save();
  ctx.strokeStyle = color || '#5ff0b0';
  ctx.lineWidth = 1.7 * s;
  ctx.lineCap = 'round';
  ctx.stroke(icon);
  ctx.restore();
}

// Draw every control from the position it was resolved to, so the picture and the hit
// test are the same thing.
function drawPane() {
  for (const c of pane) {
    if (c.kind === 'rotate') rotateIcon(c.pos.x - cam.x, c.pos.y - cam.y, c.angle, rotating);
    else if (c.kind === 'clear') clearIcon(c.pos.x - cam.x, c.pos.y - cam.y);
    else if (c.kind === 'focus') clearIcon(c.pos.x - cam.x, c.pos.y - cam.y, FOCUS_COLOR);
  }
}

// Feedback while a long press matures: an arc closing around the ship, so a hold that
// has registered looks different from one the screen ignored.
function drawHold(s, held) {
  if (!s) return;
  const t = (held - HOLD_DELAY) / (LONG_PRESS_MS - HOLD_DELAY);
  if (t <= 0) return;                               // still short enough to be a tap
  const p = new Path2D();
  p.arc(s.x - cam.x, s.y - cam.y, HOLD_R / cam.zoom, -Math.PI / 2,
        -Math.PI / 2 + Math.PI * 2 * Math.min(1, t));
  ctx.save();
  ctx.strokeStyle = `rgba(95,240,176,${Math.min(1, t * 4) * 0.7})`;   // fades in, no pop
  ctx.lineWidth = 2.5 / cam.zoom;
  ctx.lineCap = 'round';
  ctx.stroke(p);
  ctx.restore();
}

// The answer to "did that register?" on every platform: a ring thrown outward when a
// ship joins the selection, drawn inward when it leaves.
function drawConfirm(now) {
  const t = (now - confirm.start) / CONFIRM_MS;
  if (t >= 1) { confirm = null; return; }
  const e = confirm.adding ? t : 1 - t;             // outward to add, inward to drop
  const p = new Path2D();
  p.arc(confirm.x - cam.x, confirm.y - cam.y, (CONFIRM_R0 + e * CONFIRM_GROW) / cam.zoom, 0, Math.PI * 2);
  ctx.save();
  ctx.strokeStyle = `rgba(150,255,205,${(1 - t) * 0.8})`;
  ctx.lineWidth = (2.5 * (1 - t) + 0.6) / cam.zoom;
  ctx.stroke(p);
  ctx.restore();
}

function drawSelection(s, isDesignated) {
  const x = s.x - cam.x, y = s.y - cam.y, hx = 58, hy = 24, arm = 16;
  const p = new Path2D();
  for (const sx of [-1, 1])
    for (const sy of [-1, 1]) {
      p.moveTo(x + sx * hx - sx * arm, y + sy * hy);
      p.lineTo(x + sx * hx, y + sy * hy);
      p.lineTo(x + sx * hx, y + sy * hy - sy * arm);
    }
  ctx.save();
  ctx.strokeStyle = isDesignated ? 'rgba(150,255,205,.9)' : 'rgba(95,240,176,.4)';
  ctx.lineWidth = (isDesignated ? 1.8 : 1.2) / cam.zoom;
  ctx.lineCap = 'round';
  ctx.stroke(p);
  ctx.restore();
}

function drawControl(s) {
  const c = anchorOf(s), h = dragHeading ?? s.hd;
  const R = CONTROL_R / cam.zoom, cx = c.x - cam.x, cy = c.y - cam.y;
  // A single wrong number here paints a huge bright shape rather than a small ring:
  // the arc radius and every stroke width are divided by zoom, so a zoom near zero, or
  // a NaN heading, turns this affordance into a screenful of green. Refuse to draw it
  // rather than find out, and count it so we know whether this ever actually happens.
  if (!Number.isFinite(h) || !Number.isFinite(R) || !Number.isFinite(cx) || !Number.isFinite(cy)
      || R > 4000 || cam.zoom <= 0.001) { badFrames++; return; }
  ctx.save();
  ctx.strokeStyle = rotating ? 'rgba(95,240,176,.45)' : 'rgba(95,240,176,.20)';
  ctx.lineWidth = 1 / cam.zoom;
  const ring = new Path2D();
  ring.arc(cx, cy, R, 0, Math.PI * 2);
  ring.moveTo(cx + Math.cos(h) * R * 0.25, cy + Math.sin(h) * R * 0.25);
  ring.lineTo(cx + Math.cos(h) * R * 0.82, cy + Math.sin(h) * R * 0.82);
  ctx.stroke(ring);
  ctx.restore();
}

// Terrain: solid inside, outlined to keep the vector look.
//
// The interior is filled as a fan of triangles rather than as one polygon path. Half of
// these blobs are concave, and an anti-aliased concave fill has no GPU implementation in
// either engine's canvas backend -- it gets rasterised on the CPU and cached as a
// texture, and when that cache is evicted the fill silently does not appear for a frame.
// That is the wall flicker. Every fan triangle is convex, so all of this stays on the
// ordinary GPU path. Each triangle is stroked as well as filled, in the same colour, to
// close the hairline seams anti-aliasing leaves between adjacent triangles.
const WALL_FILL = '#171f2b', WALL_EDGE = 'rgba(132,156,190,.85)';

function drawWalls(vis) {
  const visible = [];
  for (const walls of wallChunks.values())
    for (const w of walls) {
      if (w.x1 < vis.x0 || w.x0 > vis.x1 || w.y1 < vis.y0 || w.y0 > vis.y1) continue;
      visible.push(w);
    }
  if (!visible.length) return;

  ctx.save();
  ctx.translate(-cam.x, -cam.y);
  ctx.lineJoin = 'round';

  // Overlapping walls were merged server-side, so there are no seams to hide any more:
  // one fill, one outline, each wall a single shape. evenodd is what makes the holes in
  // a merged wall read as open space rather than being painted over.
  if (!OFF.has('wallfill')) {
    ctx.fillStyle = WALL_FILL;
    for (const w of visible) ctx.fill(w.path, 'evenodd');
  }
  ctx.strokeStyle = WALL_EDGE;
  ctx.lineWidth = 1.4 / cam.zoom;
  for (const w of visible) ctx.stroke(w.path);
  ctx.restore();
}

// One crisp pass. Widths are screen pixels divided by zoom, so linework keeps its
// weight at every magnification instead of turning into hairlines or slabs.
function stroke(color, width) {
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.lineWidth = width / cam.zoom;
  ctx.stroke();
}

// Shapes are built as Path2D objects and handed to stroke()/fill() explicitly, rather
// than accumulated in the context's current path. A dropped beginPath() on the device
// leaves the next shape appended to the previous one -- canvas then draws a connecting
// line into each new subpath, and the lot is stroked under whatever transform is current.
// A Path2D cannot be polluted that way, and constant geometry is built once and reused.
const pathCache = new Map();
function pathOf(pts, close) {
  let p = pathCache.get(pts);
  if (!p) {
    p = new Path2D();
    pts.forEach(([px, py], i) => i ? p.lineTo(px, py) : p.moveTo(px, py));
    if (close) p.closePath();
    if (pathCache.size > 2000) pathCache.clear();
    pathCache.set(pts, p);
  }
  return p;
}

function poly(pts, x, y, a, color, close = true, width = 1.6) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(a);
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.lineWidth = width / cam.zoom;
  ctx.stroke(pathOf(pts, close));
  ctx.restore();
}

let lastFrame = performance.now(), fps = 0;

function draw() {
  requestAnimationFrame(draw);
  const state = viewState();
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  if (dt > 0) fps += ((1 / dt) - fps) * 0.05;       // smoothed, so it is readable at a glance
  lastFrame = now;
  if (!state) return;

  allShips = state.ships;
  fleet = state.ships.filter(s => s.owner === myId);
  if (dev) window.__fleet = fleet;
  if (dev) window.__all = allShips;
  if (dev) window.__cam = cam;
  if (dev) window.__sel = [...selection];
  // Forget ships that no longer exist, and keep a designated one while anything is held.
  for (const id of [...selection]) if (!fleet.some(s => s.id === id)) selection.delete(id);
  if (!hasSelected && fleet.length) {          // pick one on arrival, then leave it alone
    selection.add(fleet[0].id); designated = fleet[0].id; hasSelected = true;
  }
  if (!selection.has(designated)) designated = [...selection][0] ?? null;
  // Any change to the group drops the formation, so the next order takes a fresh one.
  // Comparing against the last *used* group instead would make re-picking the same two
  // ships keep their old shape, leaving no way to re-form short of adding a ship you
  // did not want.
  const selKey = [...selection].sort((a, b) => a - b).join(',');
  if (selKey !== lastSelKey) { lastSelKey = selKey; formed = false; }
  cmdShip = fleet.find(s => s.id === designated) ?? null;
  if (!cam.placed && fleet.length) { cam.x = fleet[0].x; cam.y = fleet[0].y; cam.placed = true; }

  let px = 0, py = 0;
  for (const code in PAN_KEYS) if (keys[code]) { px += PAN_KEYS[code][0]; py += PAN_KEYS[code][1]; }
  if (px || py) {
    const n = Math.hypot(px, py);
    cam.x += (px / n) * PAN_KEY_SPEED * dt / cam.zoom;
    cam.y += (py / n) * PAN_KEY_SPEED * dt / cam.zoom;
  }

  ensureSize();
  const { cw, ch } = view();
  // Clear in device pixels with no transform, so the whole surface is covered whatever
  // the dpr is doing. Clearing through the scaled transform covers only what that
  // transform believes the canvas to be.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#05070d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(dpr(), 0, 0, dpr(), 0, 0);
  ctx.translate(cw / 2, ch / 2);
  ctx.scale(cam.zoom, cam.zoom);

  // What the screen actually covers, in world units, with a margin so shapes straddling
  // the edge still draw. Everything below culls against this.
  const halfW = cw / 2 / cam.zoom + 120, halfH = ch / 2 / cam.zoom + 120;
  const vis = { x0: cam.x - halfW, x1: cam.x + halfW, y0: cam.y - halfH, y1: cam.y + halfH };
  const onScreen = (x, y, r = 0) =>
    x + r > vis.x0 && x - r < vis.x1 && y + r > vis.y0 && y - r < vis.y1;

  drawStars(cw, ch);
  if (!OFF.has('walls')) drawWalls(vis);

  const at = o => [o.x - cam.x, o.y - cam.y];

  for (const r of state.rocks) {
    if (!onScreen(r.x, r.y, r.size * 26)) continue;
    const [x, y] = at(r);
    poly(getRock(r.seed, r.size), x, y, r.a, '#8fa6c8');
  }

  const bs = 3 / cam.zoom;
  ctx.fillStyle = '#ffd76a';
  for (const b of state.bullets) {
    if (!onScreen(b.x, b.y, 4)) continue;
    const [x, y] = at(b);
    ctx.fillRect(x - bs / 2, y - bs / 2, bs, bs);
  }

  for (const s of fleet) {
    if (s.dx === undefined) continue;
    const [mx, my] = at({ x: s.dx, y: s.dy });
    const [sx, sy] = at(s);
    ctx.save();
    ctx.strokeStyle = 'rgba(95,240,176,.22)'; ctx.lineWidth = 1 / cam.zoom;
    ctx.setLineDash([6 / cam.zoom, 8 / cam.zoom]);
    const tether = new Path2D(); tether.moveTo(sx, sy); tether.lineTo(mx, my);
    ctx.stroke(tether);
    ctx.restore();
    const pulse = 1 + 0.18 * Math.sin(now / 220);
    poly(MARKER.map(([x, y]) => [x * pulse, y * pulse]), mx, my, now / 1400, '#5ff0b0', true, 1.2);
  }

  drawGroup();
  for (const s of fleet) if (selection.has(s.id)) drawSelection(s, s.id === designated);
  for (const t of focusTargets()) reticle(t.x - cam.x, t.y - cam.y);
  if (holding) {
    const on = holding.ship !== null ? fleet.find(s => s.id === holding.ship) : holding;
    drawHold(on, now - holding.start);
  }
  if (confirm) drawConfirm(now);
  if (cmdShip) drawControl(cmdShip);
  pane = resolvePane(buildPane());
  if (dev) window.__pane = pane;                    // inspectable: module scope is not
  drawPane();

  const nameOf = id => (state.players.find(p => p.id === id) || {}).name || '?';

  for (const s of state.ships) {
    if (!onScreen(s.x, s.y, 90)) continue;            // hull half-length plus turret reach
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
      const gx = x + mt.at[0] * cos - mt.at[1] * sin, gy = y + mt.at[0] * sin + mt.at[1] * cos;
      if (hp <= 0) {                                      // silenced: a mount, not a gun
        if (!OFF.has('bars')) wreckRing(gx, gy, (hp + wreckDepth) / wreckDepth, s.rp === i);
        return;
      }
      if (own && !OFF.has('arcs')) {                      // show each mount's traverse limits
        ctx.save();
        ctx.strokeStyle = 'rgba(95,240,176,.10)'; ctx.lineWidth = 1 / cam.zoom;
        const arc = new Path2D();
        arc.arc(gx, gy, 40, s.a + mt.facing - arcHalf, s.a + mt.facing + arcHalf);
        ctx.stroke(arc);
        ctx.restore();
      }
      poly(TURRET, gx, gy, s.tu[i], '#cfe6ff', true, 1.2);
      if (hp < TURRET_HP && !OFF.has('bars')) healthBar(gx, gy, hp / TURRET_HP);
    });
    if (!own && !OFF.has('labels')) {
      ctx.save(); ctx.translate(x, y);
      ctx.fillStyle = 'rgba(255,107,138,.7)';
      ctx.font = `${11 / cam.zoom}px ui-monospace, monospace`; ctx.textAlign = 'center';
      ctx.fillText(nameOf(s.owner), 0, 34);
      ctx.restore();
    }
  }

  const board = [...state.players].sort((a, b) => b.score - a.score).slice(0, 6)
    .map(p => `${p.id === myId ? '>' : ' '} ${p.name.padEnd(8)} ${String(p.score).padStart(5)}`).join('\n');
  // One operation onto the visible layer, once the frame is complete.
  screen.setTransform(1, 0, 0, 1, 0, 0);
  screen.drawImage(back, 0, 0);

  syncDetails();
  hud.style.color = state.stale ? '#ffb347' : '';
  hud.textContent = `TAP select  HOLD add/clear  TAP space to move   DRAG ring to turn   WASD pan   WHEEL zoom  (${cam.zoom.toFixed(2)}x)\n`
    + `${Math.round(cam.x)}, ${Math.round(cam.y)}   ${dev ? '[dev] ' : ''}v${state.v || '???????'}`
    + `  c${clientVersion}`
    + (dev ? `  buf=${buffer.length} stalls=${stalls} chunks=${wallChunks.size}` : '')
    + (OFF.size ? `  off:${[...OFF].join(',')}` : '')
    + `  ${CPU ? 'cpu' : 'gpu'} ${fps.toFixed(0)}fps`
    + (dev ? `  vib:${vib.ok ? 'api' : 'none'}/${vib.calls}/${vib.last}` : '') + `\n`
    + (state.stale ? `** STALE: server.js changed on disk -- restart the server **\n` : '')
    + `\n${board}`;
}
draw();
