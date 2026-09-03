import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const TICK = 1000 / 30;
const DEV = !!process.env.DEV;

// The world is an unbounded plane. What exists is decided by where the ships are:
// rocks are kept stocked within ACTIVE_R of every ship and culled past KEEP_R, so
// space is populated where anyone is and empty everywhere else.
const ACTIVE_R = 1400, KEEP_R = 2000, ROCK_TARGET = 18;

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
};

const PREDICT_DT = 0.1, PREDICT_STEPS = 400;   // the rollout answers a yes/no question;
                                               // it does not need the sim's fidelity
const BULLET_SPEED = 560, BULLET_LIFE = 1.2;
const TURRET_HP = 100, TURRET_R = 9, BULLET_DAMAGE = 20;   // five hits to silence a gun
const ENEMY_RANGE = 900;                                   // how far off an enemy carrier arrives

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  const file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
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
    let clear = true;
    for (const s of ships) if (Math.hypot(s.x - x, s.y - y) < SPAWN_SEP) { clear = false; break; }
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
    let gap = Infinity;
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
function aimTurrets(s, targets, dt) {
  const hull = s.hull, T = hull.turret;
  for (let i = 0; i < s.turrets.length; i++) {
    const t = s.turrets[i];
    if (t.hp <= 0) continue;                          // a dead gun neither tracks nor fires
    const m = hull.mounts[i];
    const rest = s.a + m.facing;

    let bestD = T.range, want = null;
    for (const g of targets) {
      const dx = g.x - t.wx, dy = g.y - t.wy;
      const range = Math.hypot(dx, dy) - g.r;
      if (range >= bestD) continue;
      const ux = g.vx - s.vx, uy = g.vy - s.vy;       // bullets inherit the hull's velocity
      const ti = intercept(dx, dy, ux, uy, BULLET_SPEED);
      if (ti === null || ti > BULLET_LIFE) continue;  // shell would expire before arrival
      const bearing = Math.atan2(dy + uy * ti, dx + ux * ti);
      if (Math.abs(angleDiff(bearing, rest)) > T.arcHalf) continue;   // outside this mount's arc
      bestD = range; want = bearing;
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
  for (const s of ships) {
    const cmd = s.dest ? autopilot(s, dt) : faceCmd(s, dt);
    s.th = cmd.thrust ? 1 : 0;
    advance(s, cmd, dt, s.hull);
  }
  placeTurrets();
  const byTeam = new Map();
  for (const s of ships) {
    if (!byTeam.has(s.team)) byTeam.set(s.team, targetsFor(s.team));
    aimTurrets(s, byTeam.get(s.team), dt);
  }

  for (let b = bullets.length - 1; b >= 0; b--) {
    const o = bullets[b];
    o.x += o.vx * dt; o.y += o.vy * dt;
    o.life -= dt;
    if (o.life <= 0) bullets.splice(b, 1);
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

function snapshot() {
  return JSON.stringify({
    t: 's',
    players: [...players.values()].map(p => ({ id: p.id, name: p.name, score: p.score })),
    ships: [...ships].map(s => ({
      id: s.id, owner: s.owner,
      x: +s.x.toFixed(1), y: +s.y.toFixed(1), a: +s.a.toFixed(3), th: s.th, hd: +s.heading.toFixed(3),
      tu: s.turrets.map(t => +t.a.toFixed(3)),
      hp: s.turrets.map(t => t.hp),
      ...(s.dest ? { dx: +s.dest.x.toFixed(1), dy: +s.dest.y.toFixed(1) } : {}),
    })),
    bullets: bullets.map(b => ({ id: b.id, x: +b.x.toFixed(1), y: +b.y.toFixed(1) })),
    rocks: rocks.map(r => ({ id: r.id, x: +r.x.toFixed(1), y: +r.y.toFixed(1), a: +r.a.toFixed(3), size: r.size, seed: r.seed })),
  });
}

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  const id = nextId++;
  const p = { id, ws, name: `ship-${id}`, score: 0 };
  players.set(id, p);
  // Every human is on the same side; the opposition is the 'enemy' team. Give players
  // per-player teams instead and this becomes PvP.
  const mine = newShip(id, 'players');
  const spot = ringPoint(mine.x, mine.y, ENEMY_RANGE);   // an opponent arrives with every player
  newShip(null, 'enemy', { x: spot.x, y: spot.y, a: spot.a + Math.PI });   // facing the ship it came for
  ws.send(JSON.stringify({ t: 'welcome', id, dev: DEV, mounts: CARRIER.mounts, arcHalf: CARRIER.turret.arcHalf }));

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
    else if (m.t === 'name' && typeof m.name === 'string') p.name = m.name.slice(0, 16);
  });
  // Nothing happens on disconnect. The world outlives its players -- ships stay where
  // they were, scores stand, and only restarting the process clears any of it. A
  // refresh is therefore just another arrival.
});

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  step(dt);
  const msg = snapshot();
  for (const p of players.values()) if (p.ws.readyState === 1) p.ws.send(msg);
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

server.listen(PORT, () =>
  console.log(`ships on http://localhost:${PORT}${DEV ? '  [dev: auto-restart + client hot-reload]' : ''}`));
