import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import qrcode from 'qrcode-terminal';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const TICK = 1000 / 30;
const DEV = !!process.env.DEV;
const NGROK = process.env.NGROK !== '0';   // a public tunnel every start; NGROK=0 opts out

// A running process can outlive the file it was started from -- a watcher dies, a
// restart is missed -- and a stale server is indistinguishable from a working one
// until you notice the new feature missing. So it publishes what it is running and
// checks, while running, whether that still matches the disk. Only server.js counts:
// client files are hot-reloaded, so their changing does not make this process stale.
const sourceHash = () => {
  try { return crypto.createHash('sha1').update(fs.readFileSync(new URL(import.meta.url))).digest('hex').slice(0, 7); }
  catch { return '???????'; }
};
const VERSION = sourceHash();

// The client's own version, so a phone can prove what it is running rather than being
// reasoned about. Recomputed per connection, which is when a refresh would pick it up.
const clientHash = () => {
  try {
    const h = crypto.createHash('sha1');
    for (const f of ['public/game.js', 'public/index.html'])
      h.update(fs.readFileSync(path.join(__dirname, f)));
    return h.digest('hex').slice(0, 7);
  } catch { return '???????'; }
};
let stale = false;
if (DEV) setInterval(() => { stale = sourceHash() !== VERSION; }, 2000);

// The world is an unbounded plane. What exists is decided by where the ships are:
// rocks are kept stocked within ACTIVE_R of every ship and culled past KEEP_R, so
// space is populated where anyone is and empty everywhere else.
const ACTIVE_R = 1400, KEEP_R = 2000, ROCK_TARGET = 18;

// How far a camera may see from its own centre. The client will not zoom out past
// this, so it bounds what any one client can ask to be sent -- which is what keeps a
// snapshot small no matter how crowded the world gets.
const MAX_VIEW = 2200, VIEW_BUFFER = 500;
const STREAM_R = MAX_VIEW + VIEW_BUFFER;

// A hull is plain data. Nothing about navigation is derived by hand from these
// numbers -- the autopilot finds out how this ship stops by simulating it -- so a
// new hull is a new entry here and nothing else.
const CARRIER = {
  accel: 70, turn: 0.6, maxSpeed: 150,
  arriveR: 30, arriveV: 10,             // close enough, slow enough
  // Each mount faces outboard and can only traverse arcHalf either side of that,
  // so a gun cannot swing inboard and shoot through its own hull.
  mounts: [
    { at: [32, -11], facing: -Math.PI / 2 }, { at: [0, -11], facing: -Math.PI / 2 }, { at: [-32, -11], facing: -Math.PI / 2 },
    { at: [32, 11], facing: Math.PI / 2 }, { at: [0, 11], facing: Math.PI / 2 }, { at: [-32, 11], facing: Math.PI / 2 },
  ],
  turret: { turn: 2.2, range: 520, cooldown: 1.1, arcHalf: 1.4 },
  // Four discs down the spine rather than one circle around the whole hull: a bloated
  // collider is what would jam in a narrow fissure.
  collide: [[-40, 0, 14], [-13, 0, 14], [13, 0, 14], [40, 0, 14]],
};

const PREDICT_DT = 0.1, PREDICT_STEPS = 400;   // the rollout answers a yes/no question;
                                               // it does not need the sim's fidelity
const BULLET_SPEED = 560, BULLET_LIFE = 1.2;
const TURRET_HP = 100, TURRET_R = 9, BULLET_DAMAGE = 20;   // five hits to silence a gun
const ENEMY_RANGE = 900;                                   // how far off an enemy carrier arrives

// Terrain. The plane is cut into fixed chunks; each chunk's walls are a pure function
// of its coordinates, so the same patch of space is always the same walls. Chunks are
// written to disk on first visit and read back after: determinism alone would give
// consistency, but the files are what will let later edits survive.
const CHUNK = 900;
const WORLD_SEED = 20260903;
const MAX_BLOBS = 6;                  // per chunk, at density 1
const WALL_DENSITY = 0.5;             // deliberately mid-scale: neither extreme is the design target
const WORLD_DIR = process.env.WORLD_DIR || path.join(__dirname, 'world');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  // Strip the query BEFORE deciding what the path means, or "/?x=1" is not "/" and
  // ends up trying to read the directory.
  const requested = req.url.split('?')[0];
  const file = requested === '/' ? '/index.html' : requested;
  const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

let nextId = 1;
const players = new Map();   // playerId -> { id, ws, name, score }
const ships = new Set();     // every ship in play; each knows its owner
const bullets = [];
const rocks = [];

const rand = (a, b) => a + Math.random() * (b - a);
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const clamp = (v, m) => Math.max(-m, Math.min(m, v));

// ---- terrain ----
const chunks = new Map();             // "cx,cy" -> { cx, cy, key, walls: [[[x,y],...], ...] }
const chunkKey = (cx, cy) => `${cx},${cy}`;
const chunkOf = v => Math.floor(v / CHUNK);

function chunkRng(cx, cy) {
  let v = (WORLD_SEED ^ Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0;
  return () => { v = (Math.imul(v, 1664525) + 1013904223) >>> 0; return v / 4294967296; };
}

// Irregular blobs. Their centres are inside the chunk but their edges may spill over
// it, which is why anything asking about walls looks at a 3x3 block of chunks.
function generateChunk(cx, cy) {
  const rnd = chunkRng(cx, cy);
  rnd(); rnd();                                       // shake off the seed
  const expected = WALL_DENSITY * MAX_BLOBS;
  let n = Math.floor(expected);
  if (rnd() < expected - n) n++;
  const walls = [];
  for (let i = 0; i < n; i++) {
    const ox = cx * CHUNK + rnd() * CHUNK, oy = cy * CHUNK + rnd() * CHUNK;
    const base = 60 + rnd() * 160, sides = 6 + Math.floor(rnd() * 5);
    const poly = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2 + rnd() * 0.25;
      const r = base * (0.6 + rnd() * 0.65);
      poly.push([+(ox + Math.cos(a) * r).toFixed(1), +(oy + Math.sin(a) * r).toFixed(1)]);
    }
    walls.push(poly);
  }
  return walls;
}

function loadChunk(cx, cy) {
  const key = chunkKey(cx, cy);
  const had = chunks.get(key);
  if (had) return had;
  const file = path.join(WORLD_DIR, `${cx}_${cy}.json`);
  let walls;
  try {
    walls = JSON.parse(fs.readFileSync(file, 'utf8')).walls;
  } catch {
    walls = generateChunk(cx, cy);
    try {
      fs.mkdirSync(WORLD_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ cx, cy, walls }));
    } catch { /* unwritable store: the world is still consistent, just not persisted */ }
  }
  const c = { cx, cy, key, walls };
  chunks.set(key, c);
  return c;
}

// Chunks come in at ACTIVE_R and only go out past KEEP_R, so a ship loitering on a
// boundary does not thrash them.
// Terrain stays resident for two different reasons: ships need it to collide against,
// cameras need it to draw. Both are anchors, with their own radii.
function chunkAnchors() {
  const out = [];
  for (const s of ships) out.push({ x: s.x, y: s.y, load: ACTIVE_R, keep: KEEP_R });
  for (const p of players.values())
    if (p.view && p.ws.readyState === 1)
      out.push({ x: p.view.x, y: p.view.y, load: STREAM_R, keep: STREAM_R + 400 });
  return out;
}

function manageChunks() {
  const anchors = chunkAnchors();
  for (const a of anchors)
    for (let cx = chunkOf(a.x - a.load); cx <= chunkOf(a.x + a.load); cx++)
      for (let cy = chunkOf(a.y - a.load); cy <= chunkOf(a.y + a.load); cy++)
        loadChunk(cx, cy);

  const keep = new Set();
  for (const a of anchors)
    for (let cx = chunkOf(a.x - a.keep); cx <= chunkOf(a.x + a.keep); cx++)
      for (let cy = chunkOf(a.y - a.keep); cy <= chunkOf(a.y + a.keep); cy++)
        keep.add(chunkKey(cx, cy));
  for (const key of [...chunks.keys()]) if (!keep.has(key)) chunks.delete(key);
}

// Walls in the 3x3 block of chunks around a point. `ensure` pulls them off disk, which
// only spawn checks want -- the tick loop works from what is already resident.
function nearbyWalls(x, y, ensure = false) {
  const out = [];
  const cx0 = chunkOf(x), cy0 = chunkOf(y);
  for (let cx = cx0 - 1; cx <= cx0 + 1; cx++)
    for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) {
      const c = ensure ? loadChunk(cx, cy) : chunks.get(chunkKey(cx, cy));
      if (c) for (const poly of c.walls) out.push(poly);
    }
  return out;
}

function pointInPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function closestOnPoly(poly, x, y) {
  let px = 0, py = 0, best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j], [bx, by] = poly[i];
    const ex = bx - ax, ey = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1)));
    const qx = ax + ex * t, qy = ay + ey * t;
    const d = Math.hypot(x - qx, y - qy);
    if (d < best) { best = d; px = qx; py = qy; }
  }
  return { x: px, y: py, d: best };
}

function segsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const r1 = bx - ax, r2 = by - ay, s1 = dx - cx, s2 = dy - cy;
  const den = r1 * s2 - r2 * s1;
  if (Math.abs(den) < 1e-12) return false;            // parallel
  const t = ((cx - ax) * s2 - (cy - ay) * s1) / den;
  const u = ((cx - ax) * r2 - (cy - ay) * r1) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

// Does a straight line from A to B meet rock? Shared by shells in flight and by guns
// deciding whether a shot is worth taking, so the two can never disagree.
function segmentBlocked(ax, ay, bx, by, polys) {
  for (const poly of polys) {
    if (pointInPoly(poly, ax, ay) || pointInPoly(poly, bx, by)) return true;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
      if (segsCross(ax, ay, bx, by, poly[j][0], poly[j][1], poly[i][0], poly[i][1])) return true;
  }
  return false;
}

// Is a disc of radius r at (x,y) touching a wall? Used to keep spawns out of rock.
function blockedAt(x, y, r) {
  for (const poly of nearbyWalls(x, y, true)) {
    if (pointInPoly(poly, x, y)) return true;
    if (closestOnPoly(poly, x, y).d < r) return true;
  }
  return false;
}

function spawnRock(size, x, y) {
  rocks.push({
    id: nextId++, size, x, y,
    vx: rand(-70, 70), vy: rand(-70, 70),
    a: rand(0, Math.PI * 2), spin: rand(-1.2, 1.2),
    r: size * 16, seed: Math.floor(Math.random() * 1e6),
  });
}

// Ships persist after their player leaves, so the neighbourhood fills up over a
// session. Start looking near the origin and widen until there is room, which keeps
// early spawns close together and only spreads out once it has to.
const SPAWN_SEP = 260;
function spawnPoint() {
  for (let i = 0; i < 60; i++) {
    const reach = 300 + i * 45;
    const a = rand(0, Math.PI * 2), d = Math.sqrt(Math.random()) * reach;
    const x = Math.cos(a) * d, y = Math.sin(a) * d;
    let clear = !blockedAt(x, y, 70);
    if (clear) for (const s of ships) if (Math.hypot(s.x - x, s.y - y) < SPAWN_SEP) { clear = false; break; }
    if (clear) return { x, y };
  }
  return { x: rand(-3000, 3000), y: rand(-3000, 3000) };   // pathologically crowded: just go somewhere
}

// A spot at a fixed range from somewhere, on whichever bearing is least crowded.
// Stops as soon as it finds one that is clear, so it is usually a single try.
function ringPoint(cx, cy, radius) {
  let best = null, bestGap = -1;
  for (let i = 0; i < 24; i++) {
    const a = rand(0, Math.PI * 2);
    const x = cx + Math.cos(a) * radius, y = cy + Math.sin(a) * radius;
    let gap = blockedAt(x, y, 70) ? -1 : Infinity;
    for (const s of ships) gap = Math.min(gap, Math.hypot(s.x - x, s.y - y));
    if (gap > bestGap) { bestGap = gap; best = { x, y, a }; }
    if (bestGap >= SPAWN_SEP) break;
  }
  return best;
}

// Uniform over the disc (hence the sqrt -- sampling the radius directly would pile
// rocks up around the ship), holding them off the hull itself.
const SEED_MIN = 150;
const seedSpot = s => {
  const a = rand(0, Math.PI * 2), d = Math.sqrt(rand(SEED_MIN ** 2, ACTIVE_R ** 2));
  return [s.x + Math.cos(a) * d, s.y + Math.sin(a) * d];
};
// Out at the edge of the active area, past anything anyone is looking at.
const bandSpot = s => {
  const a = rand(0, Math.PI * 2), d = rand(ACTIVE_R * 0.8, ACTIVE_R);
  return [s.x + Math.cos(a) * d, s.y + Math.sin(a) * d];
};

// Top a ship's neighbourhood back up to ROCK_TARGET, placing new rocks where `spot` says.
function stock(s, spot) {
  let near = 0;
  for (const r of rocks) if (Math.hypot(r.x - s.x, r.y - s.y) < ACTIVE_R) near++;
  for (; near < ROCK_TARGET; near++) spawnRock(3, ...spot(s));
}

function newShip(owner, team, at = {}, hull = CARRIER) {
  const facing = at.a ?? rand(0, Math.PI * 2);
  const spot = at.x === undefined ? spawnPoint() : at;
  const s = {
    id: nextId++, owner, team, hull,
    x: spot.x, y: spot.y, vx: 0, vy: 0, a: facing,
    heading: facing,                      // where it wants to point once it is done travelling
    th: 0, dest: null, braking: false,
    turrets: hull.mounts.map(() => ({ a: 0, cool: rand(0, hull.turret.cooldown), hp: TURRET_HP, wx: 0, wy: 0 })),
  };
  ships.add(s);
  stock(s, seedSpot);   // a new ship arrives in a populated neighbourhood, not a void
  return s;
}

function hit(o1, o2) {
  const dx = o1.x - o2.x, dy = o1.y - o2.y, rr = o1.r + o2.r;
  return dx * dx + dy * dy < rr * rr;
}

// The only integrator. The live sim and the autopilot's rollout both run this, so a
// prediction cannot drift from what actually happens.
function advance(st, cmd, dt, hull) {
  st.a += cmd.turn;
  if (cmd.thrust) { st.vx += Math.cos(st.a) * hull.accel * dt; st.vy += Math.sin(st.a) * hull.accel * dt; }
  const sp = Math.hypot(st.vx, st.vy);
  if (sp > hull.maxSpeed) { st.vx = st.vx / sp * hull.maxSpeed; st.vy = st.vy / sp * hull.maxSpeed; }
  st.x += st.vx * dt; st.y += st.vy * dt;
}

// Kill velocity: swing to retrograde, burn once roughly aligned.
function brakeCmd(st, hull, dt) {
  const speed = Math.hypot(st.vx, st.vy);
  if (speed < 1e-3) return { turn: 0, thrust: 0 };
  const err = angleDiff(Math.atan2(-st.vy, -st.vx), st.a);
  return { turn: clamp(err, hull.turn * dt), thrust: Math.abs(err) < 0.4 };
}

// Run toward the target at full speed, aiming at (desired - current) so lateral
// drift is corrected on the way rather than at the end.
function chaseCmd(st, ux, uy, hull, dt) {
  const bx = ux * hull.maxSpeed - st.vx, by = uy * hull.maxSpeed - st.vy;
  if (Math.hypot(bx, by) < 1) return { turn: 0, thrust: 0 };   // already at cruise: coast
  const err = angleDiff(Math.atan2(by, bx), st.a);
  return { turn: clamp(err, hull.turn * dt), thrust: Math.abs(err) < 0.4 };
}

// How far this ship travels if it starts stopping right now -- flip time, thrust,
// speed cap and all, because it is the real integrator being asked.
function stopDistance(s, hull) {
  const st = { x: 0, y: 0, vx: s.vx, vy: s.vy, a: s.a };
  let n = 0;
  while (Math.hypot(st.vx, st.vy) > hull.arriveV && n++ < PREDICT_STEPS)
    advance(st, brakeCmd(st, hull, PREDICT_DT), PREDICT_DT, hull);
  return Math.hypot(st.x, st.y);
}

// Two states, and the boundary between them is measured rather than derived:
// run at full throttle while there is still room to stop, then stop.
function autopilot(s, dt) {
  const hull = s.hull;
  const dx = s.dest.x - s.x, dy = s.dest.y - s.y;
  const dist = Math.hypot(dx, dy);
  if (dist < hull.arriveR && Math.hypot(s.vx, s.vy) < hull.arriveV) {
    s.dest = null; s.vx = 0; s.vy = 0;   // last few px/s of drift, killed rather than coasted forever
    return { turn: 0, thrust: 0 };
  }
  // Committing matters: chase and brake are both full-throttle, so re-deciding every
  // tick makes the ship dither on the boundary instead of crossing it. Once the stop
  // starts it runs to completion, then the next chase begins from a standstill.
  if (!s.braking && dist <= stopDistance(s, hull)) s.braking = true;
  if (s.braking && Math.hypot(s.vx, s.vy) <= hull.arriveV) s.braking = false;
  return s.braking ? brakeCmd(s, hull, dt) : chaseCmd(s, dx / dist, dy / dist, hull, dt);
}

// Mounts ride the hull, so their world positions move every tick. Everything that
// aims at or shoots a turret needs these, so they are computed once for all ships
// rather than re-derived per shooter.
function placeTurrets() {
  for (const s of ships) {
    const cos = Math.cos(s.a), sin = Math.sin(s.a);
    for (let i = 0; i < s.turrets.length; i++) {
      const t = s.turrets[i], m = s.hull.mounts[i];
      t.wx = s.x + m.at[0] * cos - m.at[1] * sin;
      t.wy = s.y + m.at[0] * sin + m.at[1] * cos;
    }
  }
}

// What a given side is willing to shoot: every rock, plus the live guns of anyone
// on another team. A silenced turret is no longer worth a shell.
function targetsFor(team) {
  const list = rocks.map(r => ({ x: r.x, y: r.y, vx: r.vx, vy: r.vy, r: r.r }));
  for (const s of ships) {
    if (s.team === team) continue;
    for (const t of s.turrets)
      if (t.hp > 0) list.push({ x: t.wx, y: t.wy, vx: s.vx, vy: s.vy, r: TURRET_R });
  }
  return list;
}

// With no move order the ship holds station and simply comes round to its heading.
// Travelling overrides this: the autopilot needs the nose for burns, so a heading set
// while under way only takes effect once the ship has arrived and stopped.
function faceCmd(s, dt) {
  return { turn: clamp(angleDiff(s.heading, s.a), s.hull.turn * dt), thrust: 0 };
}

// Time until a shot fired now meets a target moving at constant velocity:
// |D + U t| = B t, i.e. (|U|^2 - B^2) t^2 + 2 D.U t + |D|^2 = 0. Null if the
// target outruns the shell or the solution lies in the past.
function intercept(dx, dy, ux, uy, B) {
  const a = ux * ux + uy * uy - B * B;
  const b = 2 * (dx * ux + dy * uy);
  const c = dx * dx + dy * dy;
  if (Math.abs(a) < 1e-9) return Math.abs(b) < 1e-9 ? null : (-c / b > 0 ? -c / b : null);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const rt = Math.sqrt(disc);
  const roots = [(-b - rt) / (2 * a), (-b + rt) / (2 * a)].filter(v => v > 0);
  return roots.length ? Math.min(...roots) : null;
}

// Turret bearings are world-space: the mount rides the hull, the gun holds its own
// bearing. A gun fires only on the tick its slew lands exactly on the firing
// solution, so the shot leaves along the solved bearing rather than near it.
const LOS_TRIES = 6;      // give up on a turret rather than sight-check a whole battlefield

function aimTurrets(s, targets, dt) {
  const hull = s.hull, T = hull.turret;
  const polys = nearbyWalls(s.x, s.y);                // once per ship, not per gun
  for (let i = 0; i < s.turrets.length; i++) {
    const t = s.turrets[i];
    if (t.hp <= 0) continue;                          // a dead gun neither tracks nor fires
    const m = hull.mounts[i];
    const rest = s.a + m.facing;

    // Everything this gun could shoot, nearest first, then take the closest one it can
    // actually see. Picking the nearest and then rejecting it would leave the gun idle
    // while a clear target stood behind it.
    const shots = [];
    for (const g of targets) {
      const dx = g.x - t.wx, dy = g.y - t.wy;
      const range = Math.hypot(dx, dy) - g.r;
      if (range >= T.range) continue;
      const ux = g.vx - s.vx, uy = g.vy - s.vy;       // bullets inherit the hull's velocity
      const ti = intercept(dx, dy, ux, uy, BULLET_SPEED);
      if (ti === null || ti > BULLET_LIFE) continue;  // shell would expire before arrival
      const bearing = Math.atan2(dy + uy * ti, dx + ux * ti);
      if (Math.abs(angleDiff(bearing, rest)) > T.arcHalf) continue;   // outside this mount's arc
      shots.push({ range, bearing, ax: g.x + ux * ti, ay: g.y + uy * ti });
    }
    shots.sort((p, q) => p.range - q.range);

    let want = null;
    for (let k = 0; k < shots.length && k < LOS_TRIES; k++) {
      if (polys.length && segmentBlocked(t.wx, t.wy, shots[k].ax, shots[k].ay, polys)) continue;
      want = shots[k].bearing; break;
    }

    t.cool -= dt;
    const step = T.turn * dt;
    const err = angleDiff(want === null ? rest : want, t.a);
    t.a += clamp(err, step);
    t.a = rest + clamp(angleDiff(t.a, rest), T.arcHalf);   // hull turning under the gun cannot push it out of arc

    if (want !== null && Math.abs(err) <= step && t.cool <= 0) {
      t.cool = T.cooldown;
      bullets.push({
        id: nextId++, owner: s.owner, team: s.team, life: BULLET_LIFE, r: 2,
        x: t.wx, y: t.wy,
        vx: s.vx + Math.cos(t.a) * BULLET_SPEED, vy: s.vy + Math.sin(t.a) * BULLET_SPEED,
      });
    }
  }
}

// Push a hull out of any wall it has entered and drop the velocity that carried it in,
// which is what makes a ship slide along a face instead of sticking to it. Positional
// correction, run after the move: cheap, and stable because walls never move.
function resolveWalls(s) {
  const polys = nearbyWalls(s.x, s.y);
  if (!polys.length) return;
  const cos = Math.cos(s.a), sin = Math.sin(s.a);
  for (const [ox, oy, r] of s.hull.collide) {
    let px = s.x + ox * cos - oy * sin, py = s.y + ox * sin + oy * cos;
    for (const poly of polys) {
      const inside = pointInPoly(poly, px, py);
      const near = closestOnPoly(poly, px, py);
      if (!inside && near.d >= r) continue;
      let dx, dy, push;
      if (inside) { dx = near.x - px; dy = near.y - py; push = near.d + r; }
      else { dx = px - near.x; dy = py - near.y; push = r - near.d; }
      const len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;                       // exactly on an edge: no usable normal
      dx /= len; dy /= len;
      s.x += dx * push; s.y += dy * push;
      const into = s.vx * dx + s.vy * dy;             // velocity along the outward normal
      if (into < 0) { s.vx -= into * dx; s.vy -= into * dy; }
      px = s.x + ox * cos - oy * sin; py = s.y + ox * sin + oy * cos;
    }
  }
}

// Rocks exist near ships and nowhere else. New ones arrive in the band just short of
// ACTIVE_R -- out past anything anyone is looking at -- and drift inward from there.
function manageRocks() {
  for (let i = rocks.length - 1; i >= 0; i--) {
    const r = rocks[i];
    let keep = false;
    for (const s of ships) if (Math.hypot(r.x - s.x, r.y - s.y) < KEEP_R) { keep = true; break; }
    if (!keep) rocks.splice(i, 1);
  }
  for (const s of ships) stock(s, bandSpot);
}

function step(dt) {
  manageChunks();
  for (const s of ships) {
    const cmd = s.dest ? autopilot(s, dt) : faceCmd(s, dt);
    s.th = cmd.thrust ? 1 : 0;
    advance(s, cmd, dt, s.hull);
    resolveWalls(s);
  }
  placeTurrets();
  const byTeam = new Map();
  for (const s of ships) {
    if (!byTeam.has(s.team)) byTeam.set(s.team, targetsFor(s.team));
    aimTurrets(s, byTeam.get(s.team), dt);
  }

  for (let b = bullets.length - 1; b >= 0; b--) {
    const o = bullets[b];
    const px = o.x, py = o.y;
    o.x += o.vx * dt; o.y += o.vy * dt;
    o.life -= dt;
    if (o.life <= 0) { bullets.splice(b, 1); continue; }
    // Test the whole step, not just where it landed: a shell covers ~19px a tick and
    // would otherwise skip through a thin corner of rock.
    const polys = nearbyWalls(o.x, o.y);
    if (polys.length && segmentBlocked(px, py, o.x, o.y, polys)) bullets.splice(b, 1);
  }

  for (const r of rocks) { r.x += r.vx * dt; r.y += r.vy * dt; r.a += r.spin * dt; }

  // Shells strike enemy guns. The hull itself is not a target, so a shot that misses
  // a turret sails past the ship it is mounted on.
  for (let b = bullets.length - 1; b >= 0; b--) {
    const o = bullets[b];
    let struck = false;
    for (const s of ships) {
      if (s.team === o.team) continue;
      for (const t of s.turrets) {
        if (t.hp <= 0) continue;
        const dx = o.x - t.wx, dy = o.y - t.wy, rr = TURRET_R + o.r;
        if (dx * dx + dy * dy >= rr * rr) continue;
        t.hp = Math.max(0, t.hp - BULLET_DAMAGE);
        bullets.splice(b, 1); struck = true;
        break;
      }
      if (struck) break;
    }
    if (struck) continue;
  }

  for (let b = bullets.length - 1; b >= 0; b--) {
    const o = bullets[b];
    for (let k = rocks.length - 1; k >= 0; k--) {
      if (!hit(o, rocks[k])) continue;
      const r = rocks[k];
      rocks.splice(k, 1); bullets.splice(b, 1);
      const shooter = players.get(o.owner);
      if (shooter) shooter.score += (4 - r.size) * 10;
      if (r.size > 1) { spawnRock(r.size - 1, r.x, r.y); spawnRock(r.size - 1, r.x, r.y); }
      break;
    }
  }

  manageRocks();
}

// One snapshot per client, holding only what that client's camera can reach. Your own
// ships are always included however far you have panned, or you would lose the ability
// to give them orders. The player list stays whole: it is small and drives the board.
function snapshotFor(p) {
  const v = p.view, R2 = STREAM_R * STREAM_R;
  const near = o => { const dx = o.x - v.x, dy = o.y - v.y; return dx * dx + dy * dy < R2; };
  return JSON.stringify({
    // The send time, so a client can space snapshots by when they were produced rather
    // than by when it got round to reading them.
    t: 's', st: +performance.now().toFixed(1), v: VERSION, ...(stale ? { stale: 1 } : {}),
    players: [...players.values()].map(q => ({ id: q.id, name: q.name, score: q.score })),
    ships: [...ships].filter(s => s.owner === p.id || near(s)).map(s => ({
      id: s.id, owner: s.owner,
      x: +s.x.toFixed(1), y: +s.y.toFixed(1), a: +s.a.toFixed(3), th: s.th, hd: +s.heading.toFixed(3),
      tu: s.turrets.map(t => +t.a.toFixed(3)),
      hp: s.turrets.map(t => t.hp),
      ...(s.dest ? { dx: +s.dest.x.toFixed(1), dy: +s.dest.y.toFixed(1) } : {}),
    })),
    bullets: bullets.filter(near).map(b => ({ id: b.id, x: +b.x.toFixed(1), y: +b.y.toFixed(1) })),
    rocks: rocks.filter(near).map(r => ({ id: r.id, x: +r.x.toFixed(1), y: +r.y.toFixed(1), a: +r.a.toFixed(3), size: r.size, seed: r.seed })),
  });
}

// Walls are static, so they are pushed once per player when a ship comes near and
// dropped when it leaves, rather than riding in every snapshot -- a dense biome would
// otherwise dominate the wire.
function syncChunks(p) {
  const need = new Set();
  const v = p.view;
  for (let cx = chunkOf(v.x - STREAM_R); cx <= chunkOf(v.x + STREAM_R); cx++)
    for (let cy = chunkOf(v.y - STREAM_R); cy <= chunkOf(v.y + STREAM_R); cy++)
      need.add(chunkKey(cx, cy));
  const drop = [];
  for (const key of p.chunks) if (!need.has(key)) drop.push(key);
  for (const key of drop) p.chunks.delete(key);
  if (drop.length) p.ws.send(JSON.stringify({ t: 'drop', keys: drop }));

  for (const key of need) {
    if (p.chunks.has(key)) continue;
    const c = chunks.get(key);
    if (!c) continue;
    p.chunks.add(key);
    p.ws.send(JSON.stringify({ t: 'chunk', key, walls: c.walls }));
  }
}

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  const id = nextId++;
  const p = { id, ws, name: `ship-${id}`, score: 0, chunks: new Set(), view: { x: 0, y: 0 } };
  players.set(id, p);
  // Every human is on the same side; the opposition is the 'enemy' team. Give players
  // per-player teams instead and this becomes PvP.
  const mine = newShip(id, 'players');
  p.view = { x: mine.x, y: mine.y };                  // until the client says otherwise
  const spot = ringPoint(mine.x, mine.y, ENEMY_RANGE);   // an opponent arrives with every player
  newShip(null, 'enemy', { x: spot.x, y: spot.y, a: spot.a + Math.PI });   // facing the ship it came for
  ws.send(JSON.stringify({ t: 'welcome', id, dev: DEV, cv: clientHash(), maxView: MAX_VIEW, mounts: CARRIER.mounts, arcHalf: CARRIER.turret.arcHalf }));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'move' && Number.isFinite(m.x) && Number.isFinite(m.y)) {
      for (const s of ships) {
        if (s.owner !== id || s.id !== m.ship) continue;      // you may only order your own
        const dx = m.x - s.x, dy = m.y - s.y;
        s.dest = { x: m.x, y: m.y }; s.braking = false;
        // Face the way you travelled, unless the order was a nudge too small to have a
        // direction worth adopting. Dragging the ring afterwards still overrides it.
        if (Math.hypot(dx, dy) > s.hull.arriveR) s.heading = Math.atan2(dy, dx);
      }
    }
    else if (m.t === 'face' && Number.isFinite(m.a)) {
      for (const s of ships) if (s.owner === id && s.id === m.ship) s.heading = m.a;
    }
    else if (m.t === 'view' && Number.isFinite(m.x) && Number.isFinite(m.y)) p.view = { x: m.x, y: m.y };
    else if (m.t === 'name' && typeof m.name === 'string') p.name = m.name.slice(0, 16);
  });
  // Nothing happens on disconnect. The world outlives its players -- ships stay where
  // they were, scores stand, and only restarting the process clears any of it. A
  // refresh is therefore just another arrival.
});

let last = Date.now(), frame = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  step(dt);
  const streamChunks = ++frame % 10 === 0;
  for (const p of players.values()) {
    if (p.ws.readyState !== 1) continue;
    if (streamChunks) syncChunks(p);
    p.ws.send(snapshotFor(p));
  }
}, TICK);

// Dev mode. `node --watch` restarts this process when server.js changes, which drops
// every socket -- and the client treats a dropped socket as "reload once I'm back".
// Client files are not in this process's module graph, so they get the same treatment
// by hand: watch public/, tell everyone to reload. One recovery path for both.
if (DEV) {
  let pending = null;
  fs.watch(path.join(__dirname, 'public'), (_, file) => {
    clearTimeout(pending);                       // editors touch a file several times per save
    pending = setTimeout(() => {
      console.log(`reload: ${file}`);
      for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'reload' }));
    }, 120);
  });
}

// Whatever address a phone on the same network can actually reach; only used when
// there is no tunnel, since a QR of localhost would point the phone at itself.
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const a of list) if (a.family === 'IPv4' && !a.internal) return a.address;
  return null;
}

// An agent already tunnelling THIS port is worth adopting -- that is the --watch
// restart case. One pointed at another port belongs to someone else's server, and
// printing its URL would send people somewhere else entirely.
async function existingTunnel(port) {
  try {
    const r = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(800) });
    const j = await r.json();
    const mine = j.tunnels?.filter(t => (t.config?.addr ?? '').endsWith(`:${port}`)) ?? [];
    return mine.find(t => t.public_url?.startsWith('https'))?.public_url ?? null;
  } catch { return null; }
}

// Read the URL from the agent's own log rather than the shared local API: a second
// agent cannot bind that API's port, so asking it would answer for the wrong tunnel.
let ngrokProc = null;
async function openTunnel(port) {
  const already = await existingTunnel(port);
  if (already) return already;
  ngrokProc = spawn('ngrok', ['http', String(port), '--log', 'stdout', '--log-format', 'json'],
                    { stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise(resolve => {
    let buf = '', settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    ngrokProc.stdout.on('data', d => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        try {
          const o = JSON.parse(line);
          if (typeof o.url === 'string' && o.url.startsWith('https')) finish(o.url);
        } catch { /* not a json log line */ }
      }
    });
    ngrokProc.on('error', () => finish(null));
    ngrokProc.on('exit', () => finish(null));
    setTimeout(() => finish(null), 12000);
  });
  if (!url) console.log('  (ngrok did not start -- is it installed and authenticated?)');
  return url;
}

const stopTunnel = () => { if (ngrokProc && ngrokProc.exitCode === null) ngrokProc.kill(); };
process.on('exit', stopTunnel);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopTunnel(); process.exit(0); });

server.listen(PORT, async () => {
  console.log(`\nships ${VERSION}${DEV ? '  [dev: auto-restart + client hot-reload]' : ''}`);
  console.log(`  local   http://localhost:${PORT}`);
  const url = NGROK ? await openTunnel(PORT) : null;
  if (url) {
    console.log(`  public  ${url}`);
    qrcode.generate(url, { small: true });
  } else {
    const lan = lanAddress();
    if (lan) {
      console.log(`  lan     http://${lan}:${PORT}`);
      qrcode.generate(`http://${lan}:${PORT}`, { small: true });
    } else {
      console.log('  (no network interface found -- localhost only)');
    }
  }
});
