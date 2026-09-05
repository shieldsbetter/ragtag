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
// Rock is managed over the whole area of interest rather than a small disc around the
// ship, so it comes and goes only where nobody can see it. What is preserved is the
// density, not the count -- the same rock per unit of space over an area twenty times
// larger, which is what it costs never to watch one appear.
const ROCK_DENSITY = ROCK_TARGET / (Math.PI * ACTIVE_R * ACTIVE_R);

// Ore drifts like rock and is kept stocked the same way, so it is found by going
// somewhere rather than by waiting. A ship reaches for the nearest grain inside
// TRACTOR_R and hauls it in; nothing is aimed and nothing is ordered, so collecting is
// a consequence of where you park, which is the same bargain the guns make.
// Half what it was: broken rock now supplies most of it, and free-floating grains are
// the seed rather than the crop. Grains disperse after ORE_LIFE, which is what bounds
// the field: without it the population settles wherever collection happens to balance a
// battle's worth of shattered rock, and a snapshot fills up with gravel.
const ORE_TARGET = 3, ORE_VALUE = 5, ORE_LIFE = 30;
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
const WALL_FORMAT = 5;                // chunks store units and nothing else
const MAX_BLOBS = 6;                  // per chunk, at density 1
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
const chunks = new Map();             // "cx,cy" -> { cx, cy, key, units: [{ ring, mat }, ...] }
const chunkKey = (cx, cy) => `${cx},${cy}`;
const chunkOf = v => Math.floor(v / CHUNK);

// ---- the cell mesh ----
//
// The world is partitioned by a Voronoi diagram over a set of sites: every point belongs
// to its nearest site, so the partition is total by construction. There are no gaps to
// heal and no regions to reconcile, and a cell's shape is simply a consequence of where
// its neighbours sit.
//
// A site is *potential* until it is loaded. Its position is already fixed -- a loaded
// neighbour is shaped by it, so moving it would reshape ground that is on disk -- but
// nothing has been decided about what it is. That is the seam where new content enters:
// a biome added to the registry later can be assigned to any site not yet loaded,
// without touching anything already generated.
//
// A cell loads only once it is bounded, which means a ring of sites exists around it.
// Loading is therefore local: place the next ring outward, assign a biome, done. None of
// this touches terrain, so unlike chunk loading it cannot start a cascade.
const CELL_R = 2400;                  // roughly how far apart sites sit: a cell is a few chunks
const CELL_JITTER = 0.38;             // how irregular the mesh is, as a fraction of CELL_R
const CELL_RING = 6;                  // sites placed around a cell to bound it
const CELL_FAR = CELL_R * 8;          // the box a cell is clipped out of; touching it means unbounded
// A cell is closed once nothing of it reaches further than this. Merely *bounded* is not
// enough: three neighbours can close a cell while leaving it sprawling, and its far
// corners then legitimately forbid every site the frontier wants to place next -- the
// mesh strangles itself a few cells out. Compact cells leave room for their successors.
const CELL_MAX = CELL_R * 1.35;

// The registry a `/biomes` folder will eventually populate. What a biome is, is the
// handful of numbers terrain generation asks it for.
const BIOMES = {
  open:  { density: 0.22, base: 50, spread: 90 },
  dense: { density: 0.95, base: 90, spread: 220 },
  town:  { density: 0 },              // a set piece owns this ground; generate nothing in it
};
// What the roll may choose. A set piece's biome is claimed, never rolled.
const BIOME_NAMES = ['open', 'dense'];

// ---- set pieces ----
//
// A set piece claims a convex cell and draws what is inside it. The claim is permanent
// and cannot grow; the contents are free to change with later versions.
//
// A cell is made to be a given shape by placing its neighbours: reflect the site across
// each edge and the perpendicular bisector of that pair *is* the edge. Six reflections,
// six edges, and the Voronoi cell comes out as exactly the authored polygon.
const SCREEN = 1732;                  // the unit content is drawn against; see CLAUDE.md
const TOWN_SIDE = 2.12 * SCREEN;      // a regular hexagon; area goes as the side squared,
                                      // so 2.12 screens is half the three-screen one it was
const TOWN_R = 2400;                  // the asteroid's mean radius. It has to clear the
                                      // cell's apothem, jitter and offset included, or the
                                      // rock crosses into a neighbour's ground
const TOWN_CAVE = 1730;               // the cavern hollowed out of it: about half its area
const TOWN_SHIFT = 350;               // how far the rock sits off the origin. The cavern is
                                      // centred on the spawn, the rock is not, which is what
                                      // makes one side thick enough to be worth tunnelling
const TOWN_TUNNEL = 380;              // clear width of the passage out
const TOWN_OUT = -Math.PI / 4;        // which way it runs: up and to the right

// A regular hexagon's edge normals -- where the neighbouring sites go -- fall at 30, 90,
// 150 ... which is what makes the town's cell come out as the hexagon it claims.
const APOTHEM = Math.cos(Math.PI / 6);          // of a regular hexagon, as a fraction of R

// An irregular ring of a given radius, which is all a rock has ever been here.
function wobbleRing(cx, cy, r, sides, wobble, rnd) {
  const ring = [];
  for (let k = 0; k < sides; k++) {
    const a = (k / sides) * Math.PI * 2;
    const d = r * (1 + (rnd() - 0.5) * wobble);
    ring.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d]);
  }
  return ring;
}

// The starting town: one big asteroid with a cavern hollowed out of it and a tunnel
// running up and to the right into open space. People built a settlement in a hole in a
// rock, and there is one way in and out.
//
// It is emitted as a single solid, worked out by subtracting the cavern and the tunnel
// from the rock. That is the whole reason a generator hands over shapes rather than units:
// the interesting geometry is a boolean between three polygons, and where the pieces of it
// end up filed is somebody else's problem.
//
// The tunnel is cut as one long slab that starts inside the cavern and ends well outside
// the rock, so the two cuts join into a single opening instead of leaving a plug standing
// at the cavern wall.
function townMatter() {
  const rnd = siteRng({ x: 0, y: 0 });
  const ux = Math.cos(TOWN_OUT), uy = Math.sin(TOWN_OUT);
  const rock = [wobbleRing(ux * TOWN_SHIFT, uy * TOWN_SHIFT, TOWN_R, 28, 0.22, rnd)];
  const cave = [wobbleRing(0, 0, TOWN_CAVE, 36, 0.1, rnd)];
  const L = TOWN_R * 2 + TOWN_SHIFT, w = TOWN_TUNNEL / 2, px = -uy, py = ux;
  const tunnel = [[
    [px * w, py * w], [ux * L + px * w, uy * L + py * w],
    [ux * L - px * w, uy * L - py * w], [-px * w, -py * w],
  ]];
  let solid;
  try { solid = polygonClipping.difference(rock, cave, tunnel); }
  catch { solid = [rock]; }           // degenerate input: better a solid rock than none
  return solid.map(poly => ({ ring: poly[0], mat: 'rock' }));
}

// The town is placed once, when the world is new, and holds the origin. Its six
// neighbours are the reflections of its site across its own edges, which is what makes
// its cell come out hexagonal; they are ordinary sites otherwise, and get biomes when
// somebody comes near them.
function seedTown() {
  if (sites.length) return;
  const home = addSite(0, 0);
  home.kind = 'town';                 // loaded from the first instant, so nothing may crowd it
  // The six reflections that make the cell a hexagon are also the town's neighbours, and
  // they are decreed open. A dense biome's blobs reach nearly 400 units past their own
  // cell, which is further than the asteroid stands back from the border -- one of them
  // landing across the tunnel mouth would seal the starting town for everybody, for good.
  // An open biome's reach about 175, which the standoff clears.
  const reach = 2 * TOWN_SIDE * APOTHEM;
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + k * Math.PI / 3;
    addSite(Math.cos(a) * reach, Math.sin(a) * reach, 'open');
  }
  meshDirty = true;
}

let sites = [];
let meshVersion = 0;                  // bumped whenever a site is added, to drop cached cells
let meshDirty = false;

const siteFile = () => path.join(WORLD_DIR, 'sites.json');

function loadSites() {
  try {
    const d = JSON.parse(fs.readFileSync(siteFile(), 'utf8'));
    if (Array.isArray(d.sites)) sites = d.sites;
  } catch { /* no mesh yet: the first demand seeds one */ }
}

// The mesh is the world's own state rather than a cache of the seed, so losing it loses
// the map. Written on a timer rather than per site: a burst of exploration places a
// dozen at once and they are worth nothing individually.
function saveSites() {
  if (!meshDirty) return;
  meshDirty = false;
  try {
    fs.mkdirSync(WORLD_DIR, { recursive: true });
    fs.writeFileSync(siteFile(), JSON.stringify({ v: 1, sites }));
  } catch { /* unwritable store: the world runs, it just will not survive a restart */ }
}

// `want` is a biome the site will take when it loads, rather than one it has: a set piece
// says what it wants around it, but the cell still has to be bound and loaded like any
// other. Assigning `kind` up front would mark an unbounded cell as loaded, and the
// admissibility test would then read its phantom corners as ground worth protecting and
// refuse every site near it -- sterilising the whole neighbourhood for good.
function addSite(x, y, want = null) {
  const s = { x: +x.toFixed(1), y: +y.toFixed(1), kind: null, want };
  sites.push(s);
  meshVersion++; meshDirty = true;
  return s;
}

function nearestSite(x, y) {
  let best = null, bd = Infinity;
  for (const s of sites) {
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d < bd) { bd = d; best = s; }
  }
  return best;
}

// Sutherland-Hodgman against the bisector of p and q, keeping the side nearer p.
function clipToBisector(poly, p, q) {
  const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2, dx = q.x - p.x, dy = q.y - p.y;
  const side = v => dx * (v[0] - mx) + dy * (v[1] - my);      // <= 0 is nearer p
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa <= 0) out.push(a);
    if ((sa > 0) !== (sb > 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

// A cell is the box around its site, cut back by the bisector with every neighbour. If
// the result still touches the box, no neighbour bounds it in that direction and the
// cell runs off to infinity -- which is what "beyond the frontier" is.
const cellCache = new Map();
function cellOf(s) {
  const hit = cellCache.get(s);
  if (hit && hit.v === meshVersion) return hit.poly;
  let poly = [[s.x - CELL_FAR, s.y - CELL_FAR], [s.x + CELL_FAR, s.y - CELL_FAR],
              [s.x + CELL_FAR, s.y + CELL_FAR], [s.x - CELL_FAR, s.y + CELL_FAR]];
  for (const q of sites) {
    if (q === s || Math.abs(q.x - s.x) > CELL_FAR * 2 || Math.abs(q.y - s.y) > CELL_FAR * 2) continue;
    poly = clipToBisector(poly, s, q);
    if (poly.length < 3) break;
  }
  cellCache.set(s, { v: meshVersion, poly });
  return poly;
}

const cellBounded = s => cellOf(s).every(v =>
  Math.abs(v[0] - s.x) < CELL_FAR - 1 && Math.abs(v[1] - s.y) < CELL_FAR - 1);

// How far a cell reaches from its own site. Cached with the cell, and the only safe basis
// for deciding a distant site cannot possibly affect it.
function cellRadius(s) {
  let r = 0;
  for (const v of cellOf(s)) r = Math.max(r, Math.hypot(v[0] - s.x, v[1] - s.y));
  return r;
}

// A new site may not take ground from a cell that is already loaded. Cells are convex, so
// it is enough to check the vertices: cutting any area off a convex polygon with a
// half-plane removes at least one corner with it.
//
// The cull is by the cell's own reach, not by a fixed distance. A site q can only take a
// corner v if |v-q| < |v-p|, and |v-q| >= |q-p| - |v-p|, so once q is twice the cell's
// radius away it cannot reach any corner. Culling on a fixed radius instead was a quiet
// hole: a sprawling cell's corners run further than its site suggests, and a site 25,000
// units away was found taking one while the test said it was fine.
function admissible(x, y) {
  for (const s of sites) {
    if (!s.kind) continue;                          // only a loaded cell is protected
    if (Math.hypot(s.x - x, s.y - y) >= 2 * cellRadius(s)) continue;
    for (const v of cellOf(s)) {
      const keep = (v[0] - s.x) ** 2 + (v[1] - s.y) ** 2;
      if ((v[0] - x) ** 2 + (v[1] - y) ** 2 < keep - 1) return false;
    }
  }
  return true;
}

// Close a cell by placing sites where it is actually open, rather than scattering a ring
// and hoping. A vertex still out on the far box means nothing bounds the cell in that
// direction, so that is exactly where the next site goes. Directed placement terminates;
// a blind ring leaves gaps that another blind ring is no more likely to fill.
function bindCell(s) {
  for (let pass = 0; pass < 40; pass++) {
    const poly = cellOf(s);
    const open = poly.filter(v => Math.hypot(v[0] - s.x, v[1] - s.y) > CELL_MAX);
    if (!open.length) return true;
    // Work on the worst corner first, so a long spur is closed before a marginal one.
    let v = open[0];
    for (const q of open)
      if (Math.hypot(q[0] - s.x, q[1] - s.y) > Math.hypot(v[0] - s.x, v[1] - s.y)) v = q;
    const a = Math.atan2(v[1] - s.y, v[0] - s.x) + rand(-0.35, 0.35);
    const d = CELL_R * (1 + rand(-CELL_JITTER, CELL_JITTER));
    const x = s.x + Math.cos(a) * d, y = s.y + Math.sin(a) * d;
    // Crowding is relaxed as the attempts wear on: a cell that will not close is worse
    // than a mesh with one short edge in it.
    const room = CELL_R * (0.5 - 0.4 * pass / 40);
    const near = nearestSite(x, y);
    if (near && Math.hypot(near.x - x, near.y - y) < room) continue;
    if (!admissible(x, y)) continue;
    addSite(x, y);
  }
  return cellBounded(s);
}

// Give it a shape, then give it a kind. The kind is chosen from whatever the registry
// holds at this moment, which is the whole of the evolving-world requirement.
//
// An unbounded cell must never be loaded. Its outline runs to the far box, so the
// admissibility test would then read those phantom corners as ground worth protecting and
// refuse every site placed anywhere near it -- one cell loaded early and open would
// sterilise its whole neighbourhood, and nothing could ever close it again.
function loadCell(s) {
  // Compactness is the goal; boundedness is the requirement. A cell that will not tidy up
  // any further is still fit to load, so long as it closes.
  bindCell(s);
  if (!cellBounded(s)) return null;
  s.kind = s.want || BIOME_NAMES[Math.floor(Math.random() * BIOME_NAMES.length)];
  meshDirty = true;
  return s;
}

// Which cell owns this point, loading whatever is needed to answer. Growing the mesh can
// put a new site nearer than the one just loaded, so this walks outward until the nearest
// site is a loaded one.
function siteFor(x, y) {
  for (let i = 0; i < 16; i++) {
    let s = nearestSite(x, y);
    if (!s) s = addSite(x + rand(-CELL_R / 3, CELL_R / 3), y + rand(-CELL_R / 3, CELL_R / 3));
    if (s.kind) return s;
    if (!loadCell(s)) break;                      // could not close it: leave it potential
  }
  const s = nearestSite(x, y);
  return s && s.kind ? s : { kind: 'open' };      // rather than stall terrain over a stubborn cell
}

loadSites();
seedTown();
setInterval(saveSites, 5000);


// ---- material units ----
//
// A unit is one lump of matter: a polygon and what it is made of. Units are the only thing
// the world stores. A chunk owns the units whose centre falls inside it, and a unit is
// free to hang over the seam -- which is what lets matter run continuously across one
// without anybody having to record that it does.
//
// "Wall" is not something the world holds. It is the answer to "what does the loaded
// matter look like from outside": touching units of the same material are unioned, and
// that union is what the client draws and what a hull collides against. It is rebuilt from
// whatever is loaded and never persisted -- so laying material down, cutting a vein out of
// rock, and blasting a hole in it are all only ever edits to units.
const UNIT_MAX = CHUNK;               // widest a unit may be, which is what makes touching
                                      // units always neighbours and never further apart

function siteRng(s) {
  let v = (WORLD_SEED ^ Math.imul(Math.round(s.x), 73856093) ^ Math.imul(Math.round(s.y), 19349663)) >>> 0;
  return () => { v = (Math.imul(v, 1664525) + 1013904223) >>> 0; return v / 4294967296; };
}

// Cut a generator's polygon down to units. Anything already small enough is left exactly
// as it is; anything larger is sliced on a fixed grid, so a town's curtain wall arrives as
// six slabs thousands of units long and leaves as a row of pieces that abut precisely.
// Holes are dropped: no generator makes one, and a lump of matter with a hole in it is
// something destruction produces rather than something anybody lays down.
function toUnits(ring, mat) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const [x, y] of ring) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
  }
  const round = r => r.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]);
  if (maxx - minx <= UNIT_MAX && maxy - miny <= UNIT_MAX) return [{ ring: round(ring), mat }];
  const out = [];
  for (let gx = Math.floor(minx / UNIT_MAX); gx <= Math.floor(maxx / UNIT_MAX); gx++)
    for (let gy = Math.floor(miny / UNIT_MAX); gy <= Math.floor(maxy / UNIT_MAX); gy++) {
      const x0 = gx * UNIT_MAX, y0 = gy * UNIT_MAX, x1 = x0 + UNIT_MAX, y1 = y0 + UNIT_MAX;
      let bits;
      try { bits = polygonClipping.intersection([ring], [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]); }
      catch { continue; }
      for (const poly of bits) if (poly[0] && poly[0].length >= 3) out.push({ ring: round(poly[0]), mat });
    }
  return out;
}

// A generator is handed a cell and returns matter anywhere inside it. It never sees a
// chunk or a unit, which is the point: a set piece draws its walls, a biome scatters its
// rock, and neither has to know how the world files things.
function generateCell(s) {
  if (s.kind === 'town') return townMatter();
  const b = BIOMES[s.kind] || BIOMES.open;
  if (!b.density) return [];
  const poly = cellOf(s);
  const rnd = siteRng(s);
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x, y] = poly[i], [nx, ny] = poly[(i + 1) % poly.length];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    area += x * ny - nx * y;
  }
  area = Math.abs(area) / 2;
  // Density is per chunk-sized patch of ground, which is how it was tuned; a cell simply
  // has however many of those it happens to cover.
  const n = Math.round(b.density * MAX_BLOBS * area / (CHUNK * CHUNK));
  const out = [];
  for (let i = 0; i < n; i++) {
    let ox = 0, oy = 0, tries = 0;
    do { ox = minx + rnd() * (maxx - minx); oy = miny + rnd() * (maxy - miny); }
    while (!pointInWall([poly], ox, oy) && ++tries < 24);
    if (tries >= 24) continue;
    // Blobs near the rim hang over into the neighbouring cell on purpose: that overlap is
    // what makes rock read as one field across a cell seam once the neighbour generates.
    const base = b.base + rnd() * b.spread, sides = 6 + Math.floor(rnd() * 5);
    const ring = [];
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2 + rnd() * 0.25;
      const r = base * (0.6 + rnd() * 0.65);
      ring.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]);
    }
    out.push({ ring, mat: 'rock' });
  }
  return out;
}

// Run a cell's generator and file what comes out. Each unit goes to the chunk holding its
// centre, and that chunk is written straight back: the deposit is the only record of it,
// so it has to survive the chunk being dropped a moment later.
function depositCell(s) {
  const touched = new Set();
  for (const m of generateCell(s))
    for (const u of toUnits(m.ring, m.mat)) {
      let sx = 0, sy = 0;
      for (const [x, y] of u.ring) { sx += x; sy += y; }
      const c = loadChunk(chunkOf(sx / u.ring.length), chunkOf(sy / u.ring.length));
      c.units.push(u);
      touched.add(c);
    }
  for (const c of touched) saveChunk(c);
  s.gen = true;
  meshDirty = true;
  wallsDirty = true;
}

function saveChunk(c) {
  try {
    fs.mkdirSync(WORLD_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORLD_DIR, `${c.cx}_${c.cy}.json`),
                     JSON.stringify({ v: WALL_FORMAT, cx: c.cx, cy: c.cy, units: c.units }));
  } catch { /* unwritable store: the world runs, it just will not survive a restart */ }
}

function loadChunk(cx, cy) {
  const key = chunkKey(cx, cy);
  const had = chunks.get(key);
  if (had) return had;
  let units = [];
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(WORLD_DIR, `${cx}_${cy}.json`), 'utf8'));
    if (saved.v === WALL_FORMAT && Array.isArray(saved.units)) units = saved.units;
  } catch { /* nothing filed here, which is the normal case for open space */ }
  const c = { cx, cy, key, units };
  chunks.set(key, c);
  wallsDirty = true;
  // Deferred: placing a ship needs blockedAt, which loads neighbouring chunks, which would
  // land back in here. The queue is drained once loading has settled.
  if (Math.random() < NEST_CHANCE) pendingNests.push([cx, cy]);
  return c;
}

// ---- walls, which are a view of the units and nothing more ----
let wallsDirty = true;
let wallsByKey = new Map();           // stable key -> { key, rings, js, x0, y0, x1, y1 }
let wallBins = new Map();             // chunk key -> the walls whose box touches that chunk
let mergedCache = new Map();          // which units were merged -> what they merged into

// A unit's bounds, worked out once. Kept beside the unit rather than on it, because a
// unit is written back to disk verbatim and a cached fact about it is not world state.
const unitBoxes = new WeakMap();
function unitBox(u) {
  const hit = unitBoxes.get(u);
  if (hit) return hit;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, sx = 0, sy = 0;
  for (const [x, y] of u.ring) {
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    sx += x; sy += y;
  }
  const cx = sx / u.ring.length, cy = sy / u.ring.length;
  let r = 0;
  for (const [x, y] of u.ring) r = Math.max(r, Math.hypot(x - cx, y - cy));
  const box = { minx, miny, maxx, maxy, cx, cy, r };
  unitBoxes.set(u, box);
  return box;
}

// Merge everything loaded, once, and bin the results by chunk so a lookup near a point is
// still cheap. Connectivity only ever needs the eight neighbouring chunks, because a unit
// is at most one chunk wide and sits in the chunk holding its centre.
//
// A wall's key is its lowest-ordered member, which keeps it stable while its membership
// is -- so a rebuild set off by a chunk loading three screens away does not make every
// wall on the client look new and get sent again.
function rebuildWalls() {
  wallsDirty = false;
  const ent = [];
  const byChunk = new Map();
  for (const c of chunks.values()) {
    const list = [];
    c.units.forEach((u, i) => {
      const e = { u, key: `${c.key}:${i}`, i: ent.length };
      ent.push(e); list.push(e);
    });
    byChunk.set(c.key, list);
  }
  const parent = ent.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const c of chunks.values())
    for (const e of byChunk.get(c.key)) {
      const a = unitBox(e.u);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
        for (const f of byChunk.get(chunkKey(c.cx + dx, c.cy + dy)) || []) {
          if (f.i <= e.i) continue;
          // Matter of different kinds never merges into one shape: a vein is not the rock
          // around it, however tightly it sits in it.
          if (f.u.mat !== e.u.mat) continue;
          const b = unitBox(f.u);
          if (Math.hypot(a.cx - b.cx, a.cy - b.cy) <= a.r + b.r) parent[find(e.i)] = find(f.i);
        }
    }
  const groups = new Map();
  for (const e of ent) {
    const k = find(e.i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const prev = wallsByKey, prevMerged = mergedCache;
  wallsByKey = new Map();
  wallBins = new Map();
  mergedCache = new Map();
  for (const comp of groups.values()) {
    // Working out the components again is linear and cheap; the booleans are not. A
    // component whose membership has not changed merged to the same thing it did last
    // time, and most of them have not: a chunk loading at the rim of the area of interest
    // says nothing about rock three screens the other way. Without this the whole area
    // was re-merged on every chunk load -- 85ms, against a 33ms tick.
    const sig = comp.map(e => e.key).sort().join('|');
    let merged = prevMerged.get(sig);
    if (!merged) {
      try { merged = polygonClipping.union(...comp.map(e => [e.u.ring])); }
      catch { merged = comp.map(e => [e.u.ring]); }   // degenerate input: leave it unmerged
    }
    mergedCache.set(sig, merged);
    let base = comp[0].key;
    for (const e of comp) if (e.key < base) base = e.key;
    merged.forEach((poly, n) => {
      const rings = poly.map(r => r.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]));
      const key = merged.length > 1 ? `${base}/${n}` : base;
      const js = JSON.stringify(rings);
      const old = prev.get(key);
      let w = old && old.js === js ? old : null;
      if (!w) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of rings[0]) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        w = { key, rings, js, x0, y0, x1, y1 };
      }
      wallsByKey.set(key, w);
      for (let cx = chunkOf(w.x0); cx <= chunkOf(w.x1); cx++)
        for (let cy = chunkOf(w.y0); cy <= chunkOf(w.y1); cy++) {
          const k = chunkKey(cx, cy);
          if (!wallBins.has(k)) wallBins.set(k, []);
          wallBins.get(k).push(w);
        }
    });
  }
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
// It builds when a ship is inside its own area, and holds until nobody could be looking:
// past MAX_VIEW of every ship *and* every camera, with room to spare. Unloading anywhere
// nearer means ships blinking out in front of you, which is what an area of interest is
// for in the first place. Spawning keys on ships alone, so panning the camera across an
// empty corner does not populate it.
const ENC_KEEP = MAX_VIEW + 500;
// If a script will not let go -- a guard wedged behind rock, say -- it is overruled
// eventually. A group that cannot finish tidying up is not a reason to hold a nest
// resident for the life of the process.
const ENC_PATIENCE = 25;

// Every hook is optional; this is what an encounter does if its script says nothing.
const ENCOUNTER = {
  spawn() {},                         // build your members
  pack() {},                          // remember what survived, before they are removed
  think() {},                         // group rules, once a tick -- and where orders are given
  ready: () => true,                  // may we pack up? nobody is watching, but you decide
};

function addEncounter(kind, x, y, r) {
  encounters.push({ ...ENCOUNTER, ...SCRIPTS[kind], kind, x, y, r,
                    members: new Set(), aggro: new Set(), live: false, alone: 0, state: {} });
}

// An encounter joins a member to itself, so a ship always knows which group it belongs to
// and a group can be taken apart in one place.
function encShip(e, at, hull) {
  const s = newShip(null, 'raiders', at, hull);
  s.enc = e;
  e.members.add(s);
  return s;
}

// How near the closest pair of eyes is: a crewed hull, or a camera looking.
function watched(e) {
  let d = Infinity;
  for (const s of ships) if (crewed(s)) d = Math.min(d, Math.hypot(s.x - e.x, s.y - e.y));
  for (const p of players.values())
    if (p.view && p.ws && p.ws.readyState === 1) d = Math.min(d, Math.hypot(p.view.x - e.x, p.view.y - e.y));
  return d;
}

function manageEncounters(dt) {
  for (const e of encounters) {
    if (!e.live) {
      let near = Infinity;
      for (const s of ships) if (crewed(s)) near = Math.min(near, Math.hypot(s.x - e.x, s.y - e.y));
      if (near <= e.r) { e.spawn(e); e.live = true; e.alone = 0; }
      continue;
    }
    e.think(e, dt);
    // Out of sight, and the group says it is done -- or has had long enough to say so.
    e.alone = watched(e) > ENC_KEEP ? e.alone + dt : 0;
    if (e.alone > 0 && (e.ready(e) || e.alone > ENC_PATIENCE)) {
      e.pack(e);
      for (const s of e.members) ships.delete(s);
      e.members.clear(); e.aggro.clear(); e.live = false; e.alone = 0;
    }
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
// And placed only out at the rim of what anyone can reach. A nest that appeared beside you
// would be a nest that was not there a moment ago; found at the edge, it was always there
// and you sailed up to it. Once placed, how long it stays is the encounter's own business
// -- nothing sweeps it up for being outside the boundary later.
const NEST_EDGE = 0.8;                // of AOI_R, from the nearest crewed ship
const NEST_NOTICE = 900, NEST_FORGET = 1700;
// No two nests within twice the leash, so their pursuits cannot overlap: there is always
// a direction that takes you out of one without carrying you into the next. Spacing is
// what governs density now, not the roll -- most rolls land too near something and are
// dropped.
const NEST_APART = NEST_FORGET * 2;
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

    // Not while the guard is still out. A nest that vanishes mid-chase is a nest that
    // was never really there; letting it finish standing down costs a few seconds of
    // nobody watching, which is exactly what we have.
    ready(e) {
      if (e.aggro.size) return false;
      const home = e.state.cacheShip;
      const hx = home ? home.x : e.x, hy = home ? home.y : e.y;
      return [...e.members].every(s => s.hull.ai !== 'fighter'
        || Math.hypot(s.x - hx, s.y - hy) < GUARD_ORBIT * 3);
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
    let far = true;
    for (const s of ships)
      if (crewed(s) && Math.hypot(s.x - x, s.y - y) < AOI_R * NEST_EDGE) { far = false; break; }
    if (!far) continue;
    // Against the other nests, not against their fighters. This used to test ships, which
    // worked only because a nest built itself the instant it was placed -- once placement
    // and building came apart, a dormant nest had no hulls to keep the next one away and
    // they packed in on top of each other.
    let clear = true;
    for (const e of encounters) if (Math.hypot(e.x - x, e.y - y) < NEST_APART) { clear = false; break; }
    if (clear) for (const s of ships) if (Math.hypot(s.x - x, s.y - y) < ENEMY_CLEAR) { clear = false; break; }
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

// Only a crewed hull makes world. A camera may hold what it is looking at, so nothing
// vanishes in front of you, but it may not call anything into being -- otherwise a player
// with a finger on the map could drag the world into existence for as far as they cared to
// scroll, generating terrain, growing the mesh and deciding biomes for ground nobody has
// been anywhere near.
//
// Three screens is deliberately generous: a screen at full zoom-out reaches MAX_VIEW, so
// the edge of what exists stays two screens beyond anything anyone can see.
const AOI_R = MAX_VIEW * 3;
const AOI_KEEP = AOI_R + 900;         // a chunk of hysteresis, so a hovering ship does not thrash

function shipAnchors() {
  const out = [];
  for (const s of ships) if (crewed(s)) out.push({ x: s.x, y: s.y });
  return out;
}

function watchAnchors() {
  const out = [];
  for (const p of players.values())
    if (p.view && p.ws && p.ws.readyState === 1) out.push({ x: p.view.x, y: p.view.y });
  return out;
}

// Cells are what generate; chunks only hold what cells have already put there. So the
// mesh has to be walked out ahead of the ships deliberately, rather than as a side effect
// of somebody asking what is at a point. Once a second is plenty: a cell is three and a
// half screens across and the area of interest is seven, so there is a long way to go
// before anybody reaches ground that has not been asked about.
const pendingCells = [];
const queuedCells = new Set();        // in memory only: a restart before generating must requeue
let cellTick = 0;
function manageCells() {
  if (cellTick++ % 30 === 0)
    for (const a of shipAnchors())
      for (let x = a.x - AOI_R; x <= a.x + AOI_R; x += CELL_R / 2)
        for (let y = a.y - AOI_R; y <= a.y + AOI_R; y += CELL_R / 2) {
          const s = siteFor(x, y);
          if (s.kind && !s.gen && !queuedCells.has(s)) { queuedCells.add(s); pendingCells.push(s); }
        }
  // One cell per tick. Generating is a boolean over a few hundred polygons and has no
  // business in the same frame as the physics; the queue is what keeps it out.
  const s = pendingCells.shift();
  if (s) depositCell(s);
}

function manageChunks() {
  manageCells();
  for (const a of shipAnchors())
    for (let cx = chunkOf(a.x - AOI_R); cx <= chunkOf(a.x + AOI_R); cx++)
      for (let cy = chunkOf(a.y - AOI_R); cy <= chunkOf(a.y + AOI_R); cy++)
        loadChunk(cx, cy);

  const keep = new Set();
  const hold = (a, r) => {
    for (let cx = chunkOf(a.x - r); cx <= chunkOf(a.x + r); cx++)
      for (let cy = chunkOf(a.y - r); cy <= chunkOf(a.y + r); cy++)
        keep.add(chunkKey(cx, cy));
  };
  for (const a of shipAnchors()) hold(a, AOI_KEEP);
  for (const a of watchAnchors()) hold(a, STREAM_R + 400);
  for (const key of [...chunks.keys()]) if (!keep.has(key)) { chunks.delete(key); wallsDirty = true; }
  if (wallsDirty) rebuildWalls();
}

// Walls in the 3x3 block of chunks around a point. `ensure` pulls the chunks off disk,
// which only spawn checks want -- the tick loop works from what is already resident. A
// wall wider than a chunk sits in several bins, so the same one can come back twice.
function nearbyWalls(x, y, ensure = false) {
  const cx0 = chunkOf(x), cy0 = chunkOf(y);
  if (ensure)
    for (let cx = cx0 - 1; cx <= cx0 + 1; cx++)
      for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) loadChunk(cx, cy);
  if (wallsDirty) rebuildWalls();
  const out = [], seen = new Set();
  for (let cx = cx0 - 1; cx <= cx0 + 1; cx++)
    for (let cy = cy0 - 1; cy <= cy0 + 1; cy++)
      for (const w of wallBins.get(chunkKey(cx, cy)) || [])
        if (!seen.has(w.key)) { seen.add(w.key); out.push(w.rings); }
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

// Some rock is worth breaking for its own sake. A rich asteroid wears its grains where
// you can see them and hands them over every time it comes apart, children included, so
// finding one is worth crossing the map for and worth working all the way down.
//
// The odds are pinned to what a screenful of rock actually is rather than picked. At full
// zoom-out the camera reaches MAX_VIEW from its centre, which at 16:9 is
// MAX_VIEW^2 * 576/337 of area; rock sits at ROCK_TARGET per ACTIVE_R disc. Multiply and
// a screen holds about two dozen rocks -- so "one +1 per screen" is one in two dozen,
// "one +2 per 5x5 screens" is one in twenty-five of those, and +3 one in a hundred.
const ROCKS_PER_SCREEN = (MAX_VIEW * MAX_VIEW * 576 / 337) * ROCK_DENSITY;
const RICH_SCREENS = [1, 25, 100];    // screens you cross, on average, per +1, +2, +3

function rollRich() {
  const r = Math.random();
  let edge = 0;
  for (let i = RICH_SCREENS.length - 1; i >= 0; i--) {
    edge += 1 / (RICH_SCREENS[i] * ROCKS_PER_SCREEN);
    if (r < edge) return i + 1;
  }
  return 0;
}

function spawnRock(size, x, y, grace = 0, rich = rollRich()) {
  rocks.push({
    id: nextId++, size, x, y,
    vx: rand(-70, 70), vy: rand(-70, 70),
    a: rand(0, Math.PI * 2), spin: rand(-1.2, 1.2),
    r: size * 16, seed: Math.floor(Math.random() * 1e6),
    grace,                    // seconds before this rock can hurt anything
    rich,                     // 0-3 grains showing, and that many handed over per break
  });
}

// What is left of a rock that came apart, wherever it was standing: two smaller rocks
// and a handful of ore shaken loose. The pieces cannot hurt anything for a moment, which
// is what stops a cascade landing all at once.
//
// Any rock coming apart may give up ore, and mostly does not: one grain a sixth of the
// time, and a second grain in a fifth of those. Five rocks in six leave nothing at all,
// which is what keeps a battle from carpeting the field in gravel.
const ORE_CHANCE = 1 / 6, ORE_SECOND = 1 / 5;
function shed(x, y) {
  if (Math.random() >= ORE_CHANCE) return;
  spawnOre(x, y);
  if (Math.random() < ORE_SECOND) spawnOre(x, y);
}

function shatter(r) {
  shed(r.x, r.y);
  // What it was showing, it hands over -- on top of the roll, and on every break rather
  // than only the last one. Its children carry the same seam, so a rich rock pays out
  // again for each piece you take the trouble to finish.
  for (let i = 0; i < r.rich; i++) spawnOre(r.x, r.y);
  if (r.size <= 1) return;
  spawnRock(r.size - 1, r.x, r.y, SPLIT_GRACE, r.rich);
  spawnRock(r.size - 1, r.x, r.y, SPLIT_GRACE, r.rich);
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
// Ore is allowed to come and go in plain sight, so it is scattered near the ship the way
// it always was.
const oreSpot = s => {
  const a = rand(0, Math.PI * 2), d = Math.sqrt(rand(SEED_MIN ** 2, ACTIVE_R ** 2));
  return [s.x + Math.cos(a) * d, s.y + Math.sin(a) * d];
};

// Rock is not. A new ship gets its field laid out across the whole area it will hold...
const rockSeedSpot = s => {
  const a = rand(0, Math.PI * 2), d = Math.sqrt(rand(SEED_MIN ** 2, AOI_KEEP ** 2));
  return [s.x + Math.cos(a) * d, s.y + Math.sin(a) * d];
};
// ...and everything after that arrives in the thin band just past the edge of interest,
// three screens out, where nobody can watch it happen. The band sits inside the cull
// radius on purpose: a rock spawned beyond what the stocking counts would never be
// counted, and the field would grow without bound.
const rockBandSpot = s => {
  const a = rand(0, Math.PI * 2), d = rand(AOI_R, AOI_R * 1.06);
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
// Outside every ship's area of interest, not just the one being stocked. A fleet spread
// out puts one ship's rim through another ship's neighbourhood, and a rock arriving at
// six thousand units from one hull can be three hundred from the next.
function outsideEveryone(at) {
  for (const q of ships)
    if (crewed(q) && Math.hypot(at[0] - q.x, at[1] - q.y) < AOI_R) return false;
  return true;
}

function stock(s, spot) {
  // Counted over the same disc it is culled at, so a rock placed in the band counts
  // toward the target that asked for it.
  const want = Math.round(ROCK_DENSITY * Math.PI * AOI_KEEP * AOI_KEEP);
  let near = 0;
  for (const r of rocks) if (Math.hypot(r.x - s.x, r.y - s.y) < AOI_KEEP) near++;
  for (; near < want; near++) {
    let at = null;
    for (let try_ = 0; try_ < 8 && !at; try_++) {
      const p = spot(s);
      if (outsideEveryone(p)) at = p;
    }
    if (!at) break;             // hemmed in this tick; the next one will place it
    spawnRock(3, ...at);
  }
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
  if (crewed(s)) { stock(s, rockSeedSpot); stockOre(s, oreSpot); }   // arrives in a populated neighbourhood, not a void
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
    for (const s of ships) if (crewed(s) && Math.hypot(r.x - s.x, r.y - s.y) < AOI_KEEP) { keep = true; break; }
    if (!keep) rocks.splice(i, 1);
  }
  for (const s of ships) if (crewed(s)) stock(s, rockBandSpot);
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
  // Anywhere in the neighbourhood rather than out at the rim. Ore does not drift in from
  // somewhere -- it is simply about -- and with a half-minute life it would mostly expire
  // before reaching anyone if it started three screens away.
  for (const s of ships) if (crewed(s)) stockOre(s, oreSpot);
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
    rocks: rocks.filter(near).map(r => ({ id: r.id, x: Math.round(r.x), y: Math.round(r.y),
      a: +r.a.toFixed(2), size: r.size, seed: r.seed, ...(r.rich ? { rich: r.rich } : {}) })),
    ore: ore.filter(near).map(o => ({ id: o.id, x: Math.round(o.x), y: Math.round(o.y), a: +o.a.toFixed(2) })),
    ...(kills.length ? { kills: kills.filter(near) } : {}),
  });
}

// Walls are static, so they are pushed once per player when a ship comes near and dropped
// when it leaves, rather than riding in every snapshot -- a dense biome would otherwise
// dominate the wire. They go by their own key rather than by chunk: a wall is merged out
// of whatever is loaded and can be far larger than any chunk, and keying delivery by the
// chunk holding its centre meant a long one vanished as soon as that chunk left the
// window, while its far end was still in plain sight.
function syncWalls(p) {
  const v = p.view;
  const need = new Map();
  for (let cx = chunkOf(v.x - STREAM_R); cx <= chunkOf(v.x + STREAM_R); cx++)
    for (let cy = chunkOf(v.y - STREAM_R); cy <= chunkOf(v.y + STREAM_R); cy++)
      for (const w of wallBins.get(chunkKey(cx, cy)) || []) need.set(w.key, w);
  const add = [], del = [];
  for (const [k, w] of need) if (p.walls.get(k) !== w) { p.walls.set(k, w); add.push([k, w.rings]); }
  for (const k of [...p.walls.keys()]) if (!need.has(k)) { p.walls.delete(k); del.push(k); }
  if (add.length || del.length) p.ws.send(JSON.stringify({ t: 'walls', add, del }));
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
      p = { id, ws, name: `ship-${id}`, score: 0, walls: new Map(), view: { x: 0, y: 0 } };
      players.set(id, p);
      sessions.set(session, id);
    }
    p.walls = new Map();                      // a new socket has been sent no terrain yet

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
    if (streamChunks) syncWalls(p);
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
