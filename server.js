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
import polygonClipping from 'polygon-clipping';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

const TICK = 1000 / 30;
const DEV = !!process.env.DEV;
// A public tunnel is opt-in. It is metered, and this game pushes ~22KB/s per client
// continuously, which eats a free ngrok allowance quickly. By default the
// server advertises its address on the local network, which costs nothing.
const argv = new Set(process.argv.slice(2));
const NGROK = argv.has('--ngrok') || process.env.NGROK === '1';

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

// Ore drifts like rock and is kept stocked the same way, so it is found by going
// somewhere rather than by waiting. A ship reaches for the nearest grain inside
// TRACTOR_R and hauls it in; nothing is aimed and nothing is ordered, so collecting is
// a consequence of where you park, which is the same bargain the guns make.
// Half what it was: broken rock now supplies most of it, and free-floating grains are
// the seed rather than the crop. Grains disperse after ORE_LIFE, which is what bounds
// the field: without it the population settles wherever collection happens to balance a
// battle's worth of shattered rock, and a snapshot fills up with gravel.
const ORE_TARGET = 7, ORE_VALUE = 5, ORE_LIFE = 30;
const TRACTOR_R = 260, TRACTOR_PULL = 110, ORE_GRAB = 26;

// Opposition is scattered through the world rather than spawned at anyone: each chunk
// gets one roll the first time it is loaded, so exploring is what finds a fight. The
// roll is per process, not per chunk file -- ships do not survive a restart, so a
// restarted world repopulates the ground you have already walked over.
// One roll per newly loaded chunk, and what it rolls for is a nest: a cache with three
// fighters standing over it. Opposition and reward are the same thing to find, so there
// is a reason to take the fight rather than to avoid it. At even odds they were on top
// of each other -- a chunk is only 900 units across.
const NEST_CHANCE = 0.15;
const NEST_GUARDS = 3, NEST_RING = 95;
const ENEMY_CLEAR = 900;              // never spawn this close to any existing ship

// How far a camera may see from its own centre. The client will not zoom out past
// this, so it bounds what any one client can ask to be sent -- which is what keeps a
// snapshot small no matter how crowded the world gets.
const FLEET_SIZE = 2;                 // what a new commander starts with
const MAX_VIEW = 2200, VIEW_BUFFER = 500;
const STREAM_R = MAX_VIEW + VIEW_BUFFER;

// A hull is plain data. Nothing about navigation is derived by hand from these
// numbers -- the autopilot finds out how this ship stops by simulating it -- so a
// new hull is a new entry here and nothing else.
// The default a mount is built with, and what a shell takes off it. A hull may say
// otherwise -- these are declared above the hulls because the hulls quote them.
const TURRET_HP = 100, BULLET_DAMAGE = 20;   // five hits to silence a carrier's gun

const CARRIER = {
  accel: 70, turn: 0.6, maxSpeed: 150,
  arriveR: 30, arriveV: 10,             // close enough, slow enough
  // Each mount faces outboard and can only traverse arcHalf either side of that,
  // so a gun cannot swing inboard and shoot through its own hull.
  mounts: [
    { at: [32, -11], facing: -Math.PI / 2 }, { at: [0, -11], facing: -Math.PI / 2 }, { at: [-32, -11], facing: -Math.PI / 2 },
    { at: [32, 11], facing: Math.PI / 2 }, { at: [0, 11], facing: Math.PI / 2 }, { at: [-32, 11], facing: Math.PI / 2 },
  ],
  turret: { turn: 2.2, range: 520, cooldown: 1.1, arcHalf: 1.4, hitR: 9, hp: TURRET_HP },
  // Four discs down the spine rather than one circle around the whole hull: a bloated
  // collider is what would jam in a narrow fissure.
  collide: [[-40, 0, 14], [-13, 0, 14], [13, 0, 14], [40, 0, 14]],
};

// ---- target priority ----
// A turret used to shoot whatever was nearest. Instead each ship carries, per kind of
// target, a curve from "how far out is it, as a fraction of gun range" to "how much do
// I want it, 0-100"; the gun fires at the best-scoring thing it can see.
//
// Five stops with straight lines between them. That is enough to say "close in", "stand
// off" or "only in the middle band", it is editable with a thumb, and it is small enough
// to ride in every snapshot. Zero means do not engage at all -- not "engage last" --
// which is the hook the eventual fair-game flag hangs on.
const PRIO_MAX = 8;      // points, not stops: more than this is not thumb-editable
// 'rock', 'turret', 'fighter' and 'cache' say what to shoot; 'repair' says what to mend.
// Same curve, same order on the wire, same editor -- only the axis underneath differs,
// which is distance for the first four and health for the last.
const PRIO_KINDS = ['rock', 'turret', 'fighter', 'cache', 'repair'];
// The default falls away with distance and never reaches zero, so an untouched ship
// behaves exactly as it did before this existed: nearest first, nothing excluded.
// Two bands that do not overlap, split at a quarter health. Below the split priority
// *rises*, which is self-reinforcing -- working on a gun moves it right and only
// strengthens its claim -- so the crew carries one gun up to a quarter and no further
// before the next one below the line preempts it. Above the split priority *falls*,
// which is self-defeating in the same way, so the rest come up together rather than one
// at a time. Nothing above the split can outrank anything below it, and nothing reaches
// zero: zero means "never touch this", which would strand a gun just short of full.
const defaultPrio = () => {
  const span = WRECK_DEPTH + TURRET_HP;
  const quarter = (WRECK_DEPTH + TURRET_HP * 0.25) / span;   // a quarter of positive health
  return {
    rock: [[0, 100], [1, 20]], turret: [[0, 100], [1, 20]],
    fighter: [[0, 100], [1, 20]], cache: [[0, 100], [1, 20]],
    repair: [[0, 50], [quarter, 100], [quarter, 49], [1, 1]],
  };
};

// Where a gun sits on the repair axis: 0 is a fresh wreck at the bottom of the debt,
// 1 is a gun at full health. The debt is part of the axis, so a half-rebuilt wreck
// really is further along than an untouched one. Full health is the hull's, not a
// constant: a fighter's one gun is tougher than a carrier's six.
const maxHp = s => s.hull.turret.hp ?? TURRET_HP;
const repairFrac = (hp, max) => (hp + WRECK_DEPTH) / (max + WRECK_DEPTH);

// An ordered sequence of points, straight lines between them, x never going backwards.
// Two points sharing an x are a vertical segment -- an instantaneous jump, up or down --
// which is what lets one curve hold bands that do not overlap. The arriving line wins the
// sample exactly on the boundary; which way the jump goes is the order of the pair, not
// which value is larger, so a step up is as expressible as a step down.
function prioAt(pts, f) {
  const x = Math.max(0, Math.min(1, f));
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
    if (x1 <= x0) continue;                       // a jump spans no distance
    if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}

// A fighter is one gun bolted to an engine. The gun does not traverse -- arcHalf is a
// sliver, so it fires only when the nose is on the solution -- which is what makes the
// thing fly at you rather than sit off your beam. It has no separate turret to shoot at:
// its one "mount" sits at the centre of the hull with a hit radius the size of the hull,
// so the fighter itself is the target, and `frail` says the hull dies with its gun.
const FIGHTER = {
  accel: 260, turn: 3.4, maxSpeed: 340,
  arriveR: 30, arriveV: 10,
  mounts: [{ at: [0, 0], facing: 0 }],
  turret: { turn: 6, range: 420, cooldown: 0.9, arcHalf: 0.04, hitR: 15, hp: 200 },
  collide: [[0, 0, 9]],
  frail: true,
  targetKind: 'fighter',
  // Rock goes through it. A fighter that can be swatted by gravel dies to the battlefield
  // rather than to anyone, and the thing worth watching is whether your guns can lead it.
  rockProof: true,
  ai: 'fighter',
};

// A cache is a thing to shoot, not a thing that shoots: one mount at its centre with a
// hull-sized hit radius and no reach at all, so it is a target and never a shooter. Rock
// goes through it -- a static object in an asteroid field would otherwise be ground down
// by drifting gravel without anyone deciding anything.
const CACHE = {
  accel: 0, turn: 0, maxSpeed: 0,
  arriveR: 30, arriveV: 10,
  mounts: [{ at: [0, 0], facing: 0 }],
  turret: { turn: 0, range: 0, cooldown: 1, arcHalf: 0, hitR: 26, hp: 600 },
  collide: [[0, 0, 20]],
  frail: true, rockProof: true, ai: 'static',
  targetKind: 'cache',
  spills: 50,           // grains it lets go of when it breaks
};

const HULLS = { carrier: CARRIER, fighter: FIGHTER, cache: CACHE };
const hullKey = h => (h === FIGHTER ? 'fighter' : h === CACHE ? 'cache' : 'carrier');

const PREDICT_DT = 0.1, PREDICT_STEPS = 400;   // the rollout answers a yes/no question;
                                               // it does not need the sim's fidelity
const BULLET_SPEED = 560, BULLET_LIFE = 1.2;

// A silenced gun does not sit at zero, it falls into debt: the hit that kills it drops
// it to -WRECK_DEPTH, and repair climbs back up the same axis. Keeping the cliff on the
// health axis means "destroyed" stays `hp <= 0` everywhere it already was, with no
// second pool and no rebuild state to keep in step -- and the depth is one number.
// At one point a second that is 2.5 minutes to stand a wreck up, 100s to top a gun off.
const WRECK_DEPTH = 150, REPAIR_RATE = 1;
// A rock that reaches a gun takes half of it. Splitting on impact means one big rock can
// walk a whole battery down in a cascade, so the children are given a moment before they
// count: without it every fragment of a split is born inside the turret that caused it
// and the whole chain resolves in a single tick, on one gun, for no skill either way.
const ROCK_DAMAGE = 50, SPLIT_GRACE = 1;
// Once the crew starts on a gun it stays there for this long -- three seconds, so three
// whole points -- before looking again. A tick is a thirtieth of a point, so re-deciding
// every tick makes the crew strobe between guns the moment two of them rate the same,
// and one second still reads as flitting.
const REPAIR_DWELL = 3;

// Terrain. The plane is cut into fixed chunks; each chunk's walls are a pure function
// of its coordinates, so the same patch of space is always the same walls. Chunks are
// written to disk on first visit and read back after: determinism alone would give
// consistency, but the files are what will let later edits survive.
const CHUNK = 900;
const WORLD_SEED = 20260903;
const WALL_FORMAT = 2;                // stored geometry is merged; older files regenerate
const BLOB_MAX_R = 280;               // the generator's widest blob, used to bound merging
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
const ore = [];

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

// The seed layer: irregular blobs, a pure function of the chunk's coordinates. These are
// never stored -- they are the input to merging, and merging is what gets kept.
function rawBlobs(cx, cy) {
  const rnd = chunkRng(cx, cy);
  rnd(); rnd();                                       // shake off the seed
  const expected = WALL_DENSITY * MAX_BLOBS;
  let n = Math.floor(expected);
  if (rnd() < expected - n) n++;
  const out = [];
  for (let i = 0; i < n; i++) {
    const ox = cx * CHUNK + rnd() * CHUNK, oy = cy * CHUNK + rnd() * CHUNK;
    const base = 60 + rnd() * 160, sides = 6 + Math.floor(rnd() * 5);
    const ring = [];
    let far = 0;
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2 + rnd() * 0.25;
      const r = base * (0.6 + rnd() * 0.65);
      if (r > far) far = r;
      ring.push([+(ox + Math.cos(a) * r).toFixed(1), +(oy + Math.sin(a) * r).toFixed(1)]);
    }
    out.push({ ring, x: ox, y: oy, r: far, cx, cy });
  }
  return out;
}

// Blobs that touch each other have to become one wall, or destroying part of one would
// leave the other's edge hanging inside solid rock. Connectivity is by overlapping
// bounding circles -- conservative, and a false positive merely unions two shapes that
// turn out to be disjoint, which polygon-clipping returns unchanged.
function componentsAround(cx, cy) {
  for (let ring = 1; ; ring++) {
    const blobs = [];
    for (let x = cx - ring; x <= cx + ring; x++)
      for (let y = cy - ring; y <= cy + ring; y++)
        blobs.push(...rawBlobs(x, y));

    const parent = blobs.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < blobs.length; i++)
      for (let j = i + 1; j < blobs.length; j++) {
        const a = blobs[i], b = blobs[j];
        if (Math.hypot(a.x - b.x, a.y - b.y) <= a.r + b.r) parent[find(i)] = find(j);
      }
    const groups = new Map();
    blobs.forEach((b, i) => {
      const k = find(i);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(b);
    });

    // A component that reaches the edge of what we generated might continue past it, so
    // widen and start again -- but only if it could plausibly own geometry near us.
    const comps = [...groups.values()];
    const near = c => c.some(b => Math.abs(b.cx - cx) <= 1 && Math.abs(b.cy - cy) <= 1);
    const openEnded = comps.some(c => near(c) &&
      c.some(b => Math.abs(b.cx - cx) === ring || Math.abs(b.cy - cy) === ring));
    if (!openEnded || ring >= 4) return comps.filter(near);
  }
}

// Walls for one chunk: merge each connected component, then keep the merged shapes whose
// centroid falls in this chunk. Every chunk computes the same components from the same
// blobs, so exactly one of them claims each shape however the world is explored.
function generateChunk(cx, cy) {
  const walls = [];
  for (const comp of componentsAround(cx, cy)) {
    let merged;
    try {
      merged = polygonClipping.union(...comp.map(b => [b.ring]));
    } catch {
      merged = comp.map(b => [b.ring]);               // degenerate input: leave it unmerged
    }
    for (const poly of merged) {
      const outer = poly[0];
      let sx = 0, sy = 0;
      for (const [x, y] of outer) { sx += x; sy += y; }
      const mx = sx / outer.length, my = sy / outer.length;
      if (chunkOf(mx) !== cx || chunkOf(my) !== cy) continue;
      walls.push(poly.map(r => r.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)])));
    }
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
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.v !== WALL_FORMAT) throw new Error('old format');
    walls = saved.walls;
  } catch {
    walls = generateChunk(cx, cy);
    try {
      fs.mkdirSync(WORLD_DIR, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ v: WALL_FORMAT, cx, cy, walls }));
    } catch { /* unwritable store: the world is still consistent, just not persisted */ }
  }
  const c = { cx, cy, key, walls };
  chunks.set(key, c);
  // Deferred: placing a ship needs blockedAt, which loads neighbouring chunks, which
  // would land back in here. The queue is drained once loading has settled.
  if (Math.random() < NEST_CHANCE) pendingNests.push([cx, cy]);
  return c;
}

const pendingNests = [];

// ---- encounters ----
// A hull says how a thing flies and what it will shoot. An encounter says what a group of
// them is doing here: where they stand, what they are guarding, and who they have decided
// to fight. Splitting the two means a fighter's steering knows nothing about nests, and a
// nest knows nothing about how to fly -- the encounter names a point to circle and how
// closely, and the hull works out the rest.
//
// The world only decides "there is a nest at X,Y". The encounter builds itself when
// somebody comes near and packs itself away when they leave, so an unvisited corner of
// the map costs one record and no ships.
const encounters = [];
const ENC_HYSTERESIS = 1.5;           // leave wider than you arrive, or it thrashes on the edge

// Every hook is optional; this is what an encounter does if its script says nothing.
const ENCOUNTER = {
  spawn() {},                         // build your members
  pack() {},                          // remember what survived, before they are removed
  think() {},                         // group rules, once a tick -- and where orders are given
};

function addEncounter(kind, x, y, r) {
  encounters.push({ ...ENCOUNTER, ...SCRIPTS[kind], kind, x, y, r,
                    members: new Set(), aggro: new Set(), live: false, state: {} });
}

// An encounter joins a member to itself, so a ship always knows which group it belongs to
// and a group can be taken apart in one place.
function encShip(e, at, hull) {
  const s = newShip(null, 'raiders', at, hull);
  s.enc = e;
  e.members.add(s);
  return s;
}

function manageEncounters(dt) {
  for (const e of encounters) {
    let near = Infinity;
    for (const s of ships) if (crewed(s)) near = Math.min(near, Math.hypot(s.x - e.x, s.y - e.y));
    if (!e.live && near <= e.r) { e.spawn(e); e.live = true; }
    else if (e.live && near > e.r * ENC_HYSTERESIS) {
      e.pack(e);
      for (const s of e.members) ships.delete(s);
      e.members.clear(); e.aggro.clear(); e.live = false;
    }
    if (e.live) e.think(e, dt);
  }
}

// A nest: a cache with a guard standing over it.
//   * unbothered, the guard circles what it is guarding
//   * what one of them notices, all of them notice
//   * and anything that gets far enough from the nest is forgotten again
// The pool belongs to the encounter rather than to any fighter, which is the whole of
// rule two: there is nowhere for one fighter to hold a private opinion about who it is
// fighting.
const NEST_R = 1200;                  // how close you have to be for it to exist at all
const NEST_NOTICE = 900, NEST_FORGET = 1700;
const GUARD_ORBIT = 120;              // how tightly the guard circles its cache

const SCRIPTS = {
  nest: {
    spawn(e) {
      if (e.state.guards === undefined) { e.state.guards = NEST_GUARDS; e.state.cache = true; }
      if (e.state.cache) e.state.cacheShip = encShip(e, { x: e.x, y: e.y, a: 0 }, CACHE);
      // The guard stands off at even bearings from a random start. A berth in rock is
      // skipped rather than shuffled: two fighters is a thinner guard, not a broken nest.
      const phase = rand(0, Math.PI * 2);
      for (let k = 0; k < e.state.guards; k++) {
        const a = phase + k * Math.PI * 2 / NEST_GUARDS;
        const gx = e.x + Math.cos(a) * NEST_RING, gy = e.y + Math.sin(a) * NEST_RING;
        if (blockedAt(gx, gy, 24, false)) continue;
        encShip(e, { x: gx, y: gy, a }, FIGHTER);
      }
    },

    // What is carried across an unload is what is left, not what state it was in: a
    // fighter that comes back has its dents back too, and would have repaired them in
    // the time you were away anyway.
    pack(e) {
      e.state.cache = [...e.members].some(s => s.hull === CACHE);
      e.state.guards = [...e.members].filter(s => s.hull === FIGHTER).length;
      e.state.cacheShip = null;
    },

    think(e) {
      // Rule two lives here: the pool belongs to the encounter, so there is nowhere for
      // one fighter to hold a private opinion about who it is fighting. What one of them
      // notices, all of them are already fighting.
      for (const s of e.members) {
        for (const o of ships) {
          if (!crewed(o) || o.team === s.team) continue;
          if (Math.hypot(o.x - s.x, o.y - s.y) < NEST_NOTICE) e.aggro.add(o.id);
        }
      }
      // Rule three, measured from the nest rather than from whoever is chasing, so a
      // pursuit has a leash: run far enough from what they are guarding and they let go.
      for (const id of [...e.aggro]) {
        const o = [...ships].find(q => q.id === id);
        if (!o || Math.hypot(o.x - e.x, o.y - e.y) > NEST_FORGET) e.aggro.delete(id);
      }

      // ...and then it gives orders, the same way a player would.
      const home = e.state.cacheShip;
      for (const s of e.members) {
        if (s.hull.ai !== 'fighter') continue;
        let prey = null, best = Infinity;
        for (const id of e.aggro) {
          const o = [...ships].find(q => q.id === id);
          if (!o) continue;
          const d = Math.hypot(o.x - s.x, o.y - s.y);
          if (d < best) { best = d; prey = o; }
        }
        // Rule one: with nobody to fight, the guard circles what it is guarding.
        s.order = prey ? { kind: 'engage', id: prey.id }
                       : { kind: 'guard', x: home ? home.x : e.x, y: home ? home.y : e.y, r: GUARD_ORBIT };
      }
    },
  },
};

// Somewhere clear inside the chunk, and never on top of anyone. The world places the
// nest and stops there -- what a nest is made of is the encounter's business.
function trySpawnNest(cx, cy) {
  for (let i = 0; i < 10; i++) {
    const x = cx * CHUNK + rand(80, CHUNK - 80), y = cy * CHUNK + rand(80, CHUNK - 80);
    if (blockedAt(x, y, HULL_CLEAR, false)) continue;
    let clear = true;
    for (const s of ships) if (Math.hypot(s.x - x, s.y - y) < ENEMY_CLEAR) { clear = false; break; }
    if (!clear) continue;
    addEncounter('nest', x, y, NEST_R);
    return;
  }
}

// Chunks come in at ACTIVE_R and only go out past KEEP_R, so a ship loitering on a
// boundary does not thrash them.
// Terrain stays resident for two different reasons: ships need it to collide against,
// cameras need it to draw. Both are anchors, with their own radii.
// Raiders are deliberately not anchors. A ship left in every chunk you have ever
// visited would each hold terrain resident and keep an asteroid field stocked, and the
// world would grow without bound as you explore. Space exists where players are.
const crewed = s => s.owner !== null;

function chunkAnchors() {
  const out = [];
  for (const s of ships) if (crewed(s)) out.push({ x: s.x, y: s.y, load: ACTIVE_R, keep: KEEP_R });
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
      if (c) for (const wall of c.walls) out.push(wall);
    }
  return out;
}

// A wall is a list of rings: the first is its outline, any others are holes punched
// through it. Crossing-count over every ring at once gives the even-odd answer, which
// puts a point inside a hole correctly outside the wall.
function pointInWall(wall, x, y) {
  let inside = false;
  for (const ring of wall)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
  return inside;
}

// Nearest point on any edge of any ring: a hole's rim is a surface to be pushed off
// exactly as the outline is.
function closestOnWall(wall, x, y) {
  let px = 0, py = 0, best = Infinity;
  for (const ring of wall)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, ay] = ring[j], [bx, by] = ring[i];
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
function segmentBlocked(ax, ay, bx, by, walls) {
  for (const wall of walls) {
    if (pointInWall(wall, ax, ay) || pointInWall(wall, bx, by)) return true;
    for (const ring of wall)
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
        if (segsCross(ax, ay, bx, by, ring[j][0], ring[j][1], ring[i][0], ring[i][1])) return true;
  }
  return false;
}

// Slide a point out of any wall it has landed in. A tap on solid rock should put the
// ship against that rock, not send it grinding at a destination it can never reach.
function pushOutOfWalls(x, y, r) {
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const wall of nearbyWalls(x, y, true)) {
      const inside = pointInWall(wall, x, y);
      const near = closestOnWall(wall, x, y);
      if (!inside && near.d >= r) continue;
      const dx = inside ? near.x - x : x - near.x;
      const dy = inside ? near.y - y : y - near.y;
      const len = Math.hypot(dx, dy) || 1;
      const push = inside ? near.d + r : r - near.d;
      x += (dx / len) * push; y += (dy / len) * push;
      moved = true;
    }
    if (!moved) break;
  }
  return { x, y };
}

// Is a disc of radius r at (x,y) touching a wall? Used to keep spawns out of rock.
// `ensure` generates the terrain it looks at. That is right when placing a player, and
// catastrophic when placing something *because* a chunk loaded: each check would pull in
// nine more chunks, each of those rolling for its own spawn, and the frontier walks
// outward forever. Callers inside chunk loading pass false and settle for the walls that
// already exist.
function blockedAt(x, y, r, ensure = true) {
  for (const wall of nearbyWalls(x, y, ensure)) {
    if (pointInWall(wall, x, y)) return true;
    if (closestOnWall(wall, x, y).d < r) return true;
  }
  return false;
}

function spawnRock(size, x, y, grace = 0) {
  rocks.push({
    id: nextId++, size, x, y,
    vx: rand(-70, 70), vy: rand(-70, 70),
    a: rand(0, Math.PI * 2), spin: rand(-1.2, 1.2),
    r: size * 16, seed: Math.floor(Math.random() * 1e6),
    grace,                    // seconds before this rock can hurt anything
  });
}

// What is left of a rock that came apart, wherever it was standing: two smaller rocks
// and a handful of ore shaken loose. The pieces cannot hurt anything for a moment, which
// is what stops a cascade landing all at once.
//
// Any rock coming apart may give up ore, and mostly does not: one grain a third of the
// time, and a second grain in a fifth of those. Two thirds of the rock you break leaves
// nothing at all, which is what keeps a battle from carpeting the field in gravel.
const ORE_CHANCE = 1 / 3, ORE_SECOND = 1 / 5;
function shed(x, y) {
  if (Math.random() >= ORE_CHANCE) return;
  spawnOre(x, y);
  if (Math.random() < ORE_SECOND) spawnOre(x, y);
}

function shatter(r) {
  shed(r.x, r.y);
  if (r.size <= 1) return;
  spawnRock(r.size - 1, r.x, r.y, SPLIT_GRACE);
  spawnRock(r.size - 1, r.x, r.y, SPLIT_GRACE);
}

// Ships persist after their player leaves, so the neighbourhood fills up over a
// session. Start looking near the origin and widen until there is room, which keeps
// early spawns close together and only spreads out once it has to.
const SPAWN_SEP = 260;
// Around an anchor -- the origin for a new arrival, or the rest of your fleet for a
// ship joining it -- widening until there is room.
function spawnPoint(ax = 0, ay = 0, reach0 = 300) {
  for (let i = 0; i < 60; i++) {
    const reach = reach0 + i * 45;
    const a = rand(0, Math.PI * 2), d = Math.sqrt(Math.random()) * reach;
    const x = ax + Math.cos(a) * d, y = ay + Math.sin(a) * d;
    let clear = !blockedAt(x, y, 70);
    if (clear) for (const s of ships) if (Math.hypot(s.x - x, s.y - y) < SPAWN_SEP) { clear = false; break; }
    if (clear) return { x, y };
  }
  return { x: ax + rand(-3000, 3000), y: ay + rand(-3000, 3000) };   // pathologically crowded
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

function spawnOre(x, y) {
  ore.push({
    id: nextId++, x, y,
    vx: rand(-40, 40), vy: rand(-40, 40),
    a: rand(0, Math.PI * 2), spin: rand(-2, 2), r: 5,
    life: ORE_LIFE,         // seconds before it disperses
    held: null,             // the one ship whose beam has it
  });
}

// Top a ship's neighbourhood back up to ROCK_TARGET, placing new rocks where `spot` says.
function stock(s, spot) {
  let near = 0;
  for (const r of rocks) if (Math.hypot(r.x - s.x, r.y - s.y) < ACTIVE_R) near++;
  for (; near < ROCK_TARGET; near++) spawnRock(3, ...spot(s));
}

function newShip(owner, team, at = {}, hull = CARRIER) {
  const facing = at.a ?? rand(0, Math.PI * 2);
  const spot = at.x === undefined ? spawnPoint(at.nearX ?? 0, at.nearY ?? 0, at.reach) : at;
  const s = {
    id: nextId++, owner, team, hull,
    x: spot.x, y: spot.y, vx: 0, vy: 0, a: facing,
    heading: facing,                      // where it wants to point once it is done travelling
    th: 0, dest: null, braking: false, detourSide: 0, stuckFor: 0,
    turrets: hull.mounts.map(() => ({ a: 0, cool: rand(0, hull.turret.cooldown),
                                      hp: hull.turret.hp ?? TURRET_HP, wx: 0, wy: 0 })),
    side: Math.random() < 0.5 ? 1 : -1,   // which way this one likes to break
    sideFor: rand(1.2, 3.5),
    wander: 0,
    order: null,          // what it has been told to do, by whoever is in charge of it
    ore: 0,               // what its hold has picked up
    beam: null,           // the grain its tractor has hold of, for anyone watching
    prio: defaultPrio(),
    repairing: null,      // index of the one gun the repair point is going into
    repairHold: 0,        // seconds left before the crew may look elsewhere
    repairFocus: [],      // guns named by hand, which outrank the curve entirely
    focus: null,          // one ship this one shoots at in preference to anything else
  };
  ships.add(s);
  if (crewed(s)) { stock(s, seedSpot); stockOre(s, seedSpot); }   // arrives in a populated neighbourhood, not a void
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

// Not a path-finder. It looks at the one wall standing between here and the
// destination, and aims just past whichever of its edges costs less to round. That
// clears an isolated obstacle, which is most of them; it will sit in the mouth of a
// concave pocket, which is the price of not searching.
const DETOUR_CLEAR = 90;              // how far outside the silhouette to aim
const HULL_CLEAR = 70;                // room a carrier needs to sit somewhere
const STUCK_SECONDS = 2.5;            // pressed against rock this long: the order is over

function detourAim(s) {
  const walls = nearbyWalls(s.x, s.y);
  if (!walls.length || !segmentBlocked(s.x, s.y, s.dest.x, s.dest.y, walls)) {
    s.detourSide = 0;                 // the way is open; forget which way we were going
    return null;
  }
  let blocking = null;
  for (const wall of walls)
    if (segmentBlocked(s.x, s.y, s.dest.x, s.dest.y, [wall])) { blocking = wall; break; }
  if (!blocking) { s.detourSide = 0; return null; }

  // The silhouette: the two vertices furthest to either side of the straight line.
  const toDest = Math.atan2(s.dest.y - s.y, s.dest.x - s.x);
  let left = -Infinity, right = Infinity, lv = null, rv = null;
  for (const ring of blocking)
    for (const [x, y] of ring) {
      const off = angleDiff(Math.atan2(y - s.y, x - s.x), toDest);
      if (off > left) { left = off; lv = [x, y]; }
      if (off < right) { right = off; rv = [x, y]; }
    }
  if (!lv || !rv) return null;

  // Aiming past a corner is worthless if the corner itself is behind more rock, so each
  // candidate is only accepted when we can actually get to it in a straight line.
  const candidate = side => {
    const v = side > 0 ? lv : rv;
    const d = Math.hypot(v[0] - s.x, v[1] - s.y) || 1;
    const bearing = Math.atan2(v[1] - s.y, v[0] - s.x) + side * (DETOUR_CLEAR / d);
    const aim = { x: s.x + Math.cos(bearing) * d, y: s.y + Math.sin(bearing) * d };
    return segmentBlocked(s.x, s.y, aim.x, aim.y, walls) ? null : aim;
  };

  // Commit to a side for the duration -- re-deciding every tick makes a ship dither
  // along the middle of an obstacle instead of rounding either end -- but take the other
  // way round rather than steering into rock.
  if (!s.detourSide) s.detourSide = Math.abs(left) <= Math.abs(right) ? 1 : -1;
  return candidate(s.detourSide) ?? candidate(-s.detourSide) ?? null;
}

// Two states, and the boundary between them is measured rather than derived:
// run at full throttle while there is still room to stop, then stop.
function autopilot(s, dt) {
  const hull = s.hull;
  const dx = s.dest.x - s.x, dy = s.dest.y - s.y;
  const dist = Math.hypot(dx, dy);
  if (dist < hull.arriveR && Math.hypot(s.vx, s.vy) < hull.arriveV) {
    s.dest = null; s.vx = 0; s.vy = 0;   // last few px/s of drift, killed rather than coasted forever
    s.detourSide = 0;
    return { turn: 0, thrust: 0 };
  }

  // Held against rock while trying to move: the destination cannot be reached from
  // here, and no amount of steering is going to change that. Give up rather than shove.
  // Only while actually burning -- a carrier spends its first several seconds turning,
  // motionless and perfectly healthy.
  if (s.th && Math.hypot(s.vx, s.vy) < 8) {
    s.stuckFor = (s.stuckFor || 0) + dt;
    if (s.stuckFor > STUCK_SECONDS) {
      s.dest = null; s.vx = 0; s.vy = 0; s.stuckFor = 0; s.detourSide = 0;
      return { turn: 0, thrust: 0 };
    }
  } else s.stuckFor = 0;

  // Rock in the way: steer for the edge of it instead, at speed. Braking is for the
  // destination, and the destination is not where we are currently pointed.
  const aim = detourAim(s);
  if (aim) {
    s.braking = false;
    const ax = aim.x - s.x, ay = aim.y - s.y, ad = Math.hypot(ax, ay) || 1;
    return chaseCmd(s, ax / ad, ay / ad, hull, dt);
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

// Over the cliff in one step: there is no such thing as a gun sitting at zero. A frail
// hull is its gun, so silencing it is killing it and the wreck does not linger -- a sky
// full of drifting hulks is worse than a sky the fight has left.
// Deaths worth watching are announced once and then forgotten. The server keeps no
// wreck, runs no animation and has nothing to tick down: it says where a hull came apart
// and in which direction it was pointing, and every client near enough gets that with
// the next snapshot and takes it from there.
const kills = [];

// A cache that has been broken, still letting go. Nothing but a countdown and a place.
const spills = [];
const SPILL_RATE = 5;                 // grains a second

function bleed(dt) {
  for (let i = spills.length - 1; i >= 0; i--) {
    const s = spills[i];
    s.due -= dt;
    while (s.due <= 0 && s.left > 0) {
      spawnOre(s.x + rand(-18, 18), s.y + rand(-18, 18));
      s.left--; s.due += 1 / SPILL_RATE;
    }
    if (s.left <= 0) spills.splice(i, 1);
  }
}

function wound(s, t, amount) {
  t.hp = t.hp - amount <= 0 ? -WRECK_DEPTH : t.hp - amount;
  if (t.hp <= 0 && s.hull.frail) {
    ships.delete(s);
    if (s.enc) s.enc.members.delete(s);
    // A broken cache does not vanish: it lets its ore go over the same ten seconds the
    // client spends drawing it coming apart, so what you see and what you can collect
    // are the same event.
    if (s.hull.spills) spills.push({ x: s.x, y: s.y, left: s.hull.spills, due: 0 });
    kills.push({ x: Math.round(s.x), y: Math.round(s.y), a: +s.a.toFixed(2), h: hullKey(s.hull) });
  }
}

// What a given side is willing to shoot: every rock, plus the live guns of anyone
// on another team. A silenced turret is no longer worth a shell.
// Every candidate names the ship it belongs to, so an order given against a ship
// reaches the guns bolted to it. A rock belongs to nobody, which is what null means.
function targetsFor(team) {
  const list = rocks.map(r => ({ kind: 'rock', ship: null, x: r.x, y: r.y, vx: r.vx, vy: r.vy, r: r.r }));
  for (const s of ships) {
    if (s.team === team) continue;
    for (const t of s.turrets)
      // What kind of thing a mount counts as is the hull's business: a fighter is one
      // mount, and asking a gun to rank it against a carrier's battery is a different
      // question from ranking one battery against another.
      if (t.hp > 0) list.push({ kind: s.hull.targetKind || 'turret', ship: s.id,
                                x: t.wx, y: t.wy, vx: s.vx, vy: s.vy, r: s.hull.turret.hitR });
  }
  return list;
}

// ---- orders ----
// What a ship has been told to do, as data. An encounter writes this; a player will
// write the same field when fighters become something you can own, and the flying code
// will not be able to tell the difference -- which is the point. A carrier's dest and
// heading are the same idea under older names, and want folding in here when that day
// comes.
//
//   { kind: 'engage', id }        fly at that ship and cut past it
//   { kind: 'guard', x, y, r }    circle that point at that radius
//
// Engage keeps the id rather than a position, so the order stays good while the thing it
// names moves; a target that is gone is an order that has quietly expired.
function orderMark(s) {
  const o = s.order;
  if (!o) return null;
  if (o.kind === 'guard') return { x: o.x, y: o.y, orbit: o.r };
  const target = [...ships].find(q => q.id === o.id);
  return target ? { x: target.x, y: target.y, orbit: ORBIT_R } : null;
}

// A fighter picks the nearest crewed ship it can see and works it: it aims off to one
// side of its quarry by an angle that opens up as it closes, which is a straight run at
// long range and a turn across the bows at short, so it makes passes rather than sitting
// still to be shot. The side it favours flips at odd intervals and its aim wanders, so a
// gun leading it has to lead something that is not on rails.
const ORBIT_R = 200;                  // how close it tries to cut past what it is fighting
const WANDER = 0.9, SIDE_MIN = 1.2, SIDE_MAX = 3.5;
// How far ahead it looks, and a feeler either side of the nose to say which way is open.
// The horizon has to beat the turn: flat out it needs about maxSpeed/turn = 100 units to
// come round, so looking half a second (170) ahead left it committing too late to matter.
// Nearly a second gives it room to have turned before it arrives.
const FEEL_MIN = 110, FEEL_TIME = 0.9, FEEL_SPREAD = 0.6;

function fighterCmd(s, dt) {
  // Somebody else decided what to fly at; this only knows how to fly at something.
  const mark = orderMark(s);
  if (!mark) return { turn: 0, thrust: 0 };            // nothing to do: drift
  const best = Math.hypot(mark.x - s.x, mark.y - s.y);

  s.sideFor -= dt;
  if (s.sideFor <= 0) { s.side = -s.side; s.sideFor = rand(SIDE_MIN, SIDE_MAX); }
  // A slow random walk on the aim, bounded, so it weaves instead of tracking cleanly.
  s.wander = clamp(s.wander + rand(-WANDER, WANDER) * dt, 0.5);

  const polys = nearbyWalls(s.x, s.y);
  const bearing = Math.atan2(mark.y - s.y, mark.x - s.x);
  // With rock in between there is nothing to circle: come straight on and let the
  // feelers below work out how to get round. Circling something you cannot see is how a
  // fighter ends up grinding along the far side of a wall.
  const sighted = !polys.length || !segmentBlocked(s.x, s.y, mark.x, mark.y, polys);
  // Tangent to a circle of ORBIT_R about the quarry: zero far out, a quarter turn at the
  // circle itself. Newton does the rest -- it overshoots, and coming back round is the
  // orbit.
  const lead = sighted ? Math.asin(Math.min(1, mark.orbit / Math.max(best, mark.orbit))) : 0;
  let want = bearing + s.side * lead + s.wander;
  let hold = false;                                    // cut thrust rather than pile in

  // Feelers. Nothing here plans a route: it looks a moment ahead along its own nose, and
  // if that moment ends in rock it takes whichever way round is open. A fighter carries
  // its speed into whatever it hits, so the useful question is not "where is the wall"
  // but "will I still be flying in half a second".
  if (polys.length) {
    const reach = Math.max(FEEL_MIN, Math.hypot(s.vx, s.vy) * FEEL_TIME);
    const clear = a => !segmentBlocked(s.x, s.y, s.x + Math.cos(a) * reach,
                                       s.y + Math.sin(a) * reach, polys);
    if (!clear(s.a)) {
      const port = clear(s.a - FEEL_SPREAD), star = clear(s.a + FEEL_SPREAD);
      // Keep breaking the way it was already breaking when both are open, so avoiding a
      // wall does not undo the weave.
      if (port || star) want = s.a + (star && (!port || s.side > 0) ? FEEL_SPREAD : -FEEL_SPREAD);
      else { want = s.a + Math.PI; hold = true; }      // boxed in: come about, off the gas
    }
  }

  const err = angleDiff(want, s.a);
  // Burn whenever it is roughly pointed where it wants to go; a fighter is never coasting
  // for long, which is what keeps it hard to lead.
  return { turn: clamp(err, s.hull.turn * dt), thrust: !hold && Math.abs(err) < 0.9 ? 1 : 0 };
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

    // Everything this gun could shoot, best first, then take the best one it can
    // actually see. Picking the best and then rejecting it would leave the gun idle
    // while a clear target stood behind it.
    const shots = [];
    for (const g of targets) {
      const dx = g.x - t.wx, dy = g.y - t.wy;
      const range = Math.hypot(dx, dy) - g.r;
      if (range >= T.range) continue;
      const score = prioAt(s.prio[g.kind], range / T.range);
      if (score <= 0) continue;                        // zero priority is "do not engage"
      // Focus fire outranks the envelope but does not overrule it: it decides which of
      // the targets this ship is willing to engage comes first, and a refusal stands.
      //
      // The first pass is the focused ship AND everything belonging to nobody. Being
      // told to concentrate on a hull is not a reason to ignore the rock about to hit
      // you; it is a reason to ignore the other hull. Within the pass the envelope
      // decides, so a rock close enough to matter still outranks a distant target.
      // With no focus set there is only one pass, which is the behaviour this replaced.
      const tier = s.focus === null || g.ship === null || g.ship === s.focus ? 0 : 1;

      const ux = g.vx - s.vx, uy = g.vy - s.vy;       // bullets inherit the hull's velocity
      const ti = intercept(dx, dy, ux, uy, BULLET_SPEED);
      if (ti === null || ti > BULLET_LIFE) continue;  // shell would expire before arrival
      const bearing = Math.atan2(dy + uy * ti, dx + ux * ti);
      if (Math.abs(angleDiff(bearing, rest)) > T.arcHalf) continue;   // outside this mount's arc
      shots.push({ tier, score, range, bearing, ax: g.x + ux * ti, ay: g.y + uy * ti });
    }
    // Nearest breaks a tie, which is what makes a flat envelope behave exactly like the
    // nearest-first rule this replaced.
    shots.sort((p, q) => p.tier - q.tier || q.score - p.score || p.range - q.range);

    // The sight budget is spent per pass, not across the whole list. A focused ship
    // contributes exactly as many candidates as it has guns, so a single flat budget let
    // one hull behind a wall consume the lot and leave the turret idle with a target in
    // plain view. Refusing to shoot is the envelope's job -- zero priority -- so focus
    // decides what comes first and nothing more.
    let want = null;
    for (const group of [shots.filter(x => x.tier === 0), shots.filter(x => x.tier === 1)]) {
      for (let k = 0; k < group.length && k < LOS_TRIES; k++) {
        if (polys.length && segmentBlocked(t.wx, t.wy, group[k].ax, group[k].ay, polys)) continue;
        want = group[k].bearing; break;
      }
      if (want !== null) break;
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
  const walls = nearbyWalls(s.x, s.y);
  if (!walls.length) return;
  const cos = Math.cos(s.a), sin = Math.sin(s.a);
  for (const [ox, oy, r] of s.hull.collide) {
    let px = s.x + ox * cos - oy * sin, py = s.y + ox * sin + oy * cos;
    for (const wall of walls) {
      const inside = pointInWall(wall, px, py);
      const near = closestOnWall(wall, px, py);
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

// One point a second, into whichever gun the curve rates highest. There is no rule here
// making it stick: a band that rises with health is self-reinforcing, so the curve says
// whether repair finishes what it starts. Draw a falling band and it will genuinely
// interleave, because that is what "always work on the worst one" means. Zero priority
// is how you call the crew off a gun entirely.
function repairShip(s, dt) {
  const T = s.turrets, full = maxHp(s);
  const wants = i => i !== null && T[i].hp < full
    && prioAt(s.prio.repair, repairFrac(T[i].hp, full)) > 0;
  s.repairHold -= dt;

  // Guns named by hand are not a stronger opinion about priority, they replace it: the
  // crew works round the named ones in turn, a dwell each, and the curve does not get a
  // say. Naming a gun the curve refuses is a legitimate order, which is the point of
  // being able to name one. When they are all whole the curve takes over again rather
  // than leaving the crew idle beside a damaged gun.
  const named = s.repairFocus.filter(i => T[i] && T[i].hp < full);
  if (named.length) {
    if (s.repairHold <= 0 || !named.includes(s.repairing)) {
      s.repairing = named[(named.indexOf(s.repairing) + 1) % named.length];
      s.repairHold = REPAIR_DWELL;
    }
    T[s.repairing].hp = Math.min(full, T[s.repairing].hp + REPAIR_RATE * dt);
    return;
  }

  // Re-decide when the dwell is up, or the moment the gun in hand stops wanting the
  // point at all -- finished, or the band it sits in taken to zero.
  if (s.repairHold <= 0 || !wants(s.repairing)) {
    let best = null, bestScore = 0;
    for (let i = 0; i < T.length; i++) {
      if (!wants(i)) continue;
      const score = prioAt(s.prio.repair, repairFrac(T[i].hp, full));
      // Ties go to the gun nearest to being finished, so even a flat band completes one
      // before starting the next.
      if (score > bestScore || (score === bestScore && best !== null && T[i].hp > T[best].hp)) {
        best = i; bestScore = score;
      }
    }
    s.repairing = best;
    s.repairHold = best === null ? 0 : REPAIR_DWELL;
  }
  if (s.repairing === null) return;
  T[s.repairing].hp = Math.min(full, T[s.repairing].hp + REPAIR_RATE * dt);
}

// Rocks exist near ships and nowhere else. New ones arrive in the band just short of
// ACTIVE_R -- out past anything anyone is looking at -- and drift inward from there.
function manageRocks() {
  for (let i = rocks.length - 1; i >= 0; i--) {
    const r = rocks[i];
    let keep = false;
    for (const s of ships) if (crewed(s) && Math.hypot(r.x - s.x, r.y - s.y) < KEEP_R) { keep = true; break; }
    if (!keep) rocks.splice(i, 1);
  }
  for (const s of ships) if (crewed(s)) stock(s, bandSpot);
}

// Top a ship's neighbourhood back up, same shape as stock() for rocks.
function stockOre(s, spot) {
  let near = 0;
  for (const o of ore) if (Math.hypot(o.x - s.x, o.y - s.y) < ACTIVE_R) near++;
  for (; near < ORE_TARGET; near++) spawnOre(...spot(s));
}

// The same bargain as rocks: it exists where players are, and goes when they leave.
function manageOre() {
  for (let i = ore.length - 1; i >= 0; i--) {
    let keep = false;
    for (const s of ships) if (crewed(s) && Math.hypot(ore[i].x - s.x, ore[i].y - s.y) < KEEP_R) { keep = true; break; }
    if (!keep) ore.splice(i, 1);
  }
  // Anywhere in the neighbourhood rather than out at the edge, which is where rocks
  // arrive from. Ore does not drift in from somewhere -- it is simply about, and with a
  // half-minute life it would mostly expire before reaching anyone if it started at the
  // rim. seedSpot still holds it off the hull itself.
  for (const s of ships) if (crewed(s)) stockOre(s, seedSpot);
}

// One grain at a time, the nearest one in reach that the ship can actually see and that
// nobody else has hold of. Raiders have no hold to put it in, so they do not reach for
// it: the map is not quietly emptied behind you.
function tractor(s, dt) {
  const had = s.beam;
  s.beam = null;
  const release = () => {
    if (had === null) return;
    const prev = ore.find(o => o.id === had);
    if (prev && prev.held === s.id) prev.held = null;
  };
  if (!crewed(s)) return release();
  const polys = nearbyWalls(s.x, s.y);
  let best = null, bestD = TRACTOR_R;
  for (const o of ore) {
    // Spoken for: two beams on one grain would fight over its velocity and neither
    // would land it.
    if (o.held !== null && o.held !== s.id) continue;
    const d = Math.hypot(o.x - s.x, o.y - s.y);
    if (d >= bestD) continue;
    // Rock stops a beam the way it stops a shell. Checked only for grains that would
    // actually win, so the sight test runs a handful of times rather than once per grain.
    if (polys.length && segmentBlocked(s.x, s.y, o.x, o.y, polys)) continue;
    bestD = d; best = o;
  }
  if (!best || best.id !== had) release();
  if (!best) return;
  if (bestD <= ORE_GRAB) {
    ore.splice(ore.indexOf(best), 1);
    s.ore += ORE_VALUE;
    return;
  }
  best.held = s.id;
  s.beam = best.id;
  // Straight at the ship, overriding whatever drift it had: a beam that merely nudged
  // would lose grains to their own momentum and look broken doing it.
  best.vx = (s.x - best.x) / bestD * TRACTOR_PULL;
  best.vy = (s.y - best.y) / bestD * TRACTOR_PULL;
}

function step(dt) {
  manageChunks();
  // Take a snapshot: a spawn can load more chunks and queue more rolls, which wait for
  // the next tick rather than extending this one.
  for (const [cx, cy] of pendingNests.splice(0)) trySpawnNest(cx, cy);
  manageEncounters(dt);
  bleed(dt);
  for (const s of ships) {
    const cmd = s.hull.ai === 'static' ? { turn: 0, thrust: 0 }
      : s.hull.ai === 'fighter' ? fighterCmd(s, dt)
      : s.dest ? autopilot(s, dt) : faceCmd(s, dt);
    s.th = cmd.thrust ? 1 : 0;
    advance(s, cmd, dt, s.hull);
    resolveWalls(s);
  }
  for (const s of ships) repairShip(s, dt);
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

  for (const r of rocks) {
    r.x += r.vx * dt; r.y += r.vy * dt; r.a += r.spin * dt;
    if (r.grace > 0) r.grace -= dt;
  }
  for (let i = ore.length - 1; i >= 0; i--) {
    const o = ore[i];
    o.x += o.vx * dt; o.y += o.vy * dt; o.a += o.spin * dt;
    o.life -= dt;
    if (o.life <= 0) ore.splice(i, 1);
  }
  for (const s of ships) tractor(s, dt);

  // Rocks against guns. The hull is not a target -- same as for shells -- so a rock that
  // misses a turret sails over the ship it is mounted on.
  for (let k = rocks.length - 1; k >= 0; k--) {
    const r = rocks[k];
    if (r.grace > 0) continue;
    let struck = false;
    for (const s of ships) {
      if (s.hull.rockProof) continue;
      for (const t of s.turrets) {
        if (t.hp <= 0) continue;                      // nothing left there to hit
        const dx = r.x - t.wx, dy = r.y - t.wy, rr = r.r + s.hull.turret.hitR;
        if (dx * dx + dy * dy >= rr * rr) continue;
        wound(s, t, ROCK_DAMAGE);
        struck = true;
        break;
      }
      if (struck) break;
    }
    if (!struck) continue;
    rocks.splice(k, 1);
    shatter(r);
  }

  // Shells strike enemy guns. The hull itself is not a target, so a shot that misses
  // a turret sails past the ship it is mounted on.
  for (let b = bullets.length - 1; b >= 0; b--) {
    const o = bullets[b];
    let struck = false;
    for (const s of ships) {
      if (s.team === o.team) continue;
      for (const t of s.turrets) {
        if (t.hp <= 0) continue;
        const dx = o.x - t.wx, dy = o.y - t.wy, rr = s.hull.turret.hitR + o.r;
        if (dx * dx + dy * dy >= rr * rr) continue;
        wound(s, t, BULLET_DAMAGE);
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
      shatter(r);
      break;
    }
  }

  manageRocks();
  manageOre();
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
      id: s.id, owner: s.owner, h: hullKey(s.hull),
      // Ships keep sub-pixel position -- they are what the eye follows -- but angles do
      // not need three decimals: 0.01rad is a pixel at the tip of a hull.
      x: +s.x.toFixed(1), y: +s.y.toFixed(1), a: +s.a.toFixed(2), th: s.th, hd: +s.heading.toFixed(2),
      tu: s.turrets.map(t => +t.a.toFixed(2)),
      // Rounded: repair moves in thirtieths of a point and nobody can see that, while
      // the digits would ride in every snapshot.
      //
      // A wreck on somebody else's ship is only ever a wreck. How deep the debt still is
      // -- and so how close their crew is to standing that gun back up -- is theirs to
      // know. Zero says it plainly and says nothing more: a gun never sits at zero alive,
      // it goes straight over the cliff, so nothing is lost by clamping there. Damage
      // above zero stays public, which is what makes a battered enemy worth reading.
      hp: s.turrets.map(t => Math.round(s.owner === p.id ? t.hp : Math.max(0, t.hp))),
      ...(s.dest ? { dx: Math.round(s.dest.x), dy: Math.round(s.dest.y) } : {}),
      // The beam is a thing in the world, so everyone near enough sees it.
      ...(s.beam !== null ? { bm: s.beam } : {}),
      // Only to the ship's owner, and only because it is what the editor reads back on
      // reconnect. It is identical frame to frame, so the shared deflate context sends
      // almost nothing for it.
      ...(s.owner === p.id
        ? { pr: s.prio, ...(s.focus !== null ? { fo: s.focus } : {}),
            ...(s.repairing !== null ? { rp: s.repairing } : {}),
            ...(s.repairFocus.length ? { rf: s.repairFocus } : {}), or: s.ore }
        : {}),
    })),
    // Rocks and shells round to whole units: interpolation smooths the half-unit of
    // error, and nobody is inspecting a shell's sub-pixel position.
    bullets: bullets.filter(near).map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y) })),
    rocks: rocks.filter(near).map(r => ({ id: r.id, x: Math.round(r.x), y: Math.round(r.y), a: +r.a.toFixed(2), size: r.size, seed: r.seed })),
    ore: ore.filter(near).map(o => ({ id: o.id, x: Math.round(o.x), y: Math.round(o.y), a: +o.a.toFixed(2) })),
    ...(kills.length ? { kills: kills.filter(near) } : {}),
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

// Snapshots are repetitive JSON, which deflate eats: measured 5.7KB -> 0.9KB per
// message, and better still with the compression context kept between messages, which
// is the default. Small messages are not worth the round trip.
const wss = new WebSocketServer({
  server,
  perMessageDeflate: { zlibDeflateOptions: { level: 6 }, threshold: 256 },
});
// A client's session names its player. Reconnecting with the same one gets the same
// ships, score and name back, so a refresh -- or a phone that dropped wifi -- resumes
// rather than abandoning a carrier and starting over. It is a bearer token and nothing
// more: anyone presenting a session id is treated as its owner, which is the right
// weight for a game with no accounts.
const sessions = new Map();   // session id -> player id

wss.on('connection', ws => {
  let p = null;

  function join(session) {
    p = players.get(sessions.get(session));
    if (p) {
      if (p.ws !== ws && p.ws.readyState === 1) p.ws.close();   // one socket per session
      p.ws = ws;
    } else {
      const id = nextId++;
      p = { id, ws, name: `ship-${id}`, score: 0, chunks: new Set(), view: { x: 0, y: 0 } };
      players.set(id, p);
      sessions.set(session, id);
    }
    p.chunks = new Set();                     // a new socket has been sent no terrain yet

    // Returning players keep the fleet they left; a new commander is issued one. No ship
    // is special -- they are simply the ships this player owns.
    let fleet = [...ships].filter(s => s.owner === p.id);
    if (!fleet.length)
      for (let i = 0; i < FLEET_SIZE; i++) {
        // The rest of the fleet forms up on the first ship rather than being scattered
        // across the map: a squadron you cannot see together is not a squadron.
        const lead = fleet[0];
        fleet.push(newShip(p.id, 'players',
          lead ? { nearX: lead.x, nearY: lead.y, reach: SPAWN_SEP } : {}));
      }
    p.view = { x: fleet[0].x, y: fleet[0].y };  // until the client says where it is looking

    ws.send(JSON.stringify({ t: 'welcome', id: p.id, dev: DEV, cv: clientHash(),
      maxView: MAX_VIEW, mounts: CARRIER.mounts, arcHalf: CARRIER.turret.arcHalf,
      hulls: Object.fromEntries(Object.entries(HULLS).map(([k, h]) =>
        [k, { mounts: h.mounts, arcHalf: h.turret.arcHalf, hp: h.turret.hp ?? TURRET_HP }])),
      prioMax: PRIO_MAX, turretHp: TURRET_HP, wreck: WRECK_DEPTH }));
  }

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hello' && typeof m.session === 'string' && m.session.length <= 64) {
      if (!p) join(m.session);
      return;
    }
    if (!p) return;                            // nothing is answered before a session arrives

    if (m.t === 'move' && Number.isFinite(m.x) && Number.isFinite(m.y)) {
      for (const s of ships) {
        if (s.owner !== p.id || s.id !== m.ship) continue;    // you may only order your own
        const goal = pushOutOfWalls(m.x, m.y, HULL_CLEAR);
        const dx = goal.x - s.x, dy = goal.y - s.y;
        s.dest = goal; s.braking = false; s.detourSide = 0; s.stuckFor = 0;
        // Face the way you travelled, unless the order was a nudge too small to have a
        // direction worth adopting. Dragging the ring afterwards still overrides it.
        if (Math.hypot(dx, dy) > s.hull.arriveR) s.heading = Math.atan2(dy, dx);
      }
    }
    else if (m.t === 'face' && Number.isFinite(m.a)) {
      for (const s of ships) if (s.owner === p.id && s.id === m.ship) s.heading = m.a;
    }
    else if (m.t === 'focus' && Array.isArray(m.ships)) {
      // null clears. Only another player's ship can be focused -- pointing your own
      // guns at your own hull is not an order anyone means to give.
      const target = m.target === null ? null
        : [...ships].find(s => s.id === m.target && s.owner !== p.id)?.id ?? null;
      for (const s of ships)
        if (s.owner === p.id && m.ships.includes(s.id)) s.focus = target;
    }
    else if (m.t === 'repfocus' && Array.isArray(m.guns) && m.guns.every(Number.isInteger)) {
      for (const s of ships) {
        if (s.owner !== p.id || s.id !== m.ship) continue;
        s.repairFocus = [...new Set(m.guns)].filter(i => i >= 0 && i < s.turrets.length);
      }
    }
    else if (m.t === 'prio' && PRIO_KINDS.includes(m.kind) && Array.isArray(m.points)
             && m.points.length >= 2 && m.points.length <= PRIO_MAX
             && m.points.every(q => Array.isArray(q) && q.length === 2 && q.every(Number.isFinite))) {
      const pts = m.points.map(([x, y]) => [Math.max(0, Math.min(1, x)),
                                            Math.max(0, Math.min(100, Math.round(y)))]);
      // The ends anchor the axis and x never runs backwards. A curve that breaks either
      // cannot be evaluated, so it is dropped rather than repaired into something the
      // player did not draw.
      let ok = pts[0][0] === 0 && pts[pts.length - 1][0] === 1;
      for (let i = 1; ok && i < pts.length; i++) if (pts[i][0] < pts[i - 1][0]) ok = false;
      if (ok) for (const s of ships) if (s.owner === p.id && s.id === m.ship) s.prio[m.kind] = pts;
    }
    else if (m.t === 'view' && Number.isFinite(m.x) && Number.isFinite(m.y)) p.view = { x: m.x, y: m.y };
    else if (m.t === 'name' && typeof m.name === 'string') p.name = m.name.slice(0, 16);
  });
  // Nothing happens on disconnect. The world outlives its players -- ships stay where
  // they were, scores stand, and only restarting the process clears any of it.
});

let last = Date.now(), frame = 0;
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  step(dt);
  const streamChunks = ++frame % 10 === 0;
  for (const p of players.values()) {
    if (!p.ws || p.ws.readyState !== 1) continue;
    if (streamChunks) syncChunks(p);
    p.ws.send(snapshotFor(p));
  }
  kills.length = 0;                 // said once, to whoever was near enough to see it
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
      if (!NGROK) console.log('          (--ngrok for a public URL, at the cost of metered bandwidth)');
      qrcode.generate(`http://${lan}:${PORT}`, { small: true });
    } else {
      console.log('  (no network interface found -- localhost only)');
    }
  }
});
