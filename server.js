#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { WebSocketServer } from 'ws';
import { spawn } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { command } from '@shieldsbetter/sbopts';
import { stack, stringWidth, text } from '@shieldsbetter/termiflo';
import { produce } from 'immer';
import polygonClipping from 'polygon-clipping';
import {
    CLOSED_EYES,
    FANTASY_PARTS,
    portrait,
} from '@shieldsbetter/pixel-portraits';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parsed rather than run: the server is the module body, not a handler, so help and
// usage errors are dealt with here and everything below reads plain constants.
const cli = command('ragtag', {
    summary: 'Mobile-friendly multiplayer naval-tactics roguelike.',
    description:
        'Serves the game and simulates it. The world is written to ./ragtag in the ' +
        'directory the command is run from, unless --datadir says otherwise.',
    flags: {
        port: {
            short: 'p',
            type: 'number',
            summary: 'Port to listen on. Defaults to 3000, or $PORT.',
        },
        // A public tunnel is opt-in. It is metered, and this game pushes ~22KB/s per
        // client continuously, which eats a free ngrok allowance quickly. By default the
        // server advertises its address on the local network, which costs nothing.
        ngrok: { type: 'boolean', summary: 'Also open a public ngrok tunnel.' },
        datadir: {
            short: 'd',
            type: 'string',
            summary:
                'Where the world is kept. Defaults to ./ragtag, or $RAGTAG_DATADIR.',
        },
        // Set pieces are cut at build time and shipped. The server cuts anything stale on
        // its way up anyway, so this is the same work done deliberately.
        bake: {
            type: 'boolean',
            summary: 'Cut any out-of-date set pieces and exit without serving.',
        },
    },
});
let cmdline;
try {
    cmdline = cli.parse(process.argv.slice(2));
} catch (e) {
    console.error(e.message);
    process.exit(1);
}
if (cmdline.help) {
    console.log(cli.help());
    process.exit(0);
}
// A flag said out loud beats the environment, which beats the default.
const PORT =
    cmdline.flags.port ?? (process.env.PORT ? Number(process.env.PORT) : 3000);
const NGROK = cmdline.flags.ngrok || process.env.NGROK === '1';

const TICK = 1000 / 30;
const DEV = !!process.env.DEV;

// A running process can outlive the file it was started from -- a watcher dies, a
// restart is missed -- and a stale server is indistinguishable from a working one
// until you notice the new feature missing. So it publishes what it is running and
// checks, while running, whether that still matches the disk. Only server.js counts:
// client files are hot-reloaded, so their changing does not make this process stale.
const sourceHash = () => {
    try {
        return crypto
            .createHash('sha1')
            .update(fs.readFileSync(new URL(import.meta.url)))
            .digest('hex')
            .slice(0, 7);
    } catch {
        return '???????';
    }
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
    } catch {
        return '???????';
    }
};
let stale = false;
if (DEV)
    setInterval(() => {
        stale = sourceHash() !== VERSION;
    }, 2000);

// ---- the tick budget ----
//
// A tick has 33ms, and overrunning it does not read as the server being slow. The
// integrator's dt is clamped (DT_MAX), so work a long tick spent is world time the
// simulation never advanced through -- while every client carried on extrapolating at
// real speed, and the correction that follows hauls it backwards. On screen that is
// things changing their mind and rewinding, which looks nothing like a busy process,
// which is why this is measured on every tick rather than reasoned about afterwards.
//
// Everything here is counted always, never switched on: an intermittent fault that needs
// a flag set before it can be seen is a fault you have to reproduce twice. It is
// cumulative since boot and never reset, which is what a counter is -- rates and windows
// are the scraper's business. Read it at /metrics.
const DT_MAX = 0.1; // seconds of world a single tick may advance
const OVERRUN = 50; // ms: a tick worth naming in the log, half again over budget
// Where a tick's time lands. The interesting boundary is 0.033: over it, the tick is not
// keeping up with the clock it is driven by.
const TICK_BUCKETS = [0.005, 0.01, 0.02, 0.033, 0.05, 0.1, 0.2, 0.5, 1];

const spent = Object.create(null); // this tick only, by phase
const timed = (name, fn) => {
    const t = performance.now();
    try {
        return fn();
    } finally {
        spent[name] = (spent[name] || 0) + (performance.now() - t);
    }
};

const metric = {
    ticks: 0,
    tickSeconds: 0,
    overruns: 0,
    gaps: 0,
    gapSeconds: 0,
    // World time the clamp threw away: the total amount of rewinding the clients have been
    // asked to do since boot. It only counts what went past DT_MAX, so it understates --
    // a 90ms tick loses no world time and still shows on screen as a correction.
    debt: 0,
    sendSeconds: 0,
    phase: Object.create(null), // phase -> seconds
    calls: Object.create(null), // phase -> times entered
    bucket: new Array(TICK_BUCKETS.length + 1).fill(0),
};

// Name what a long tick was doing, in the log as well as in the counters: a line in the
// terminal is what gets read while something is going wrong in front of you.
const naming = () =>
    Object.entries(spent)
        .filter(([, ms]) => ms >= 1)
        .sort((a, b) => b[1] - a[1])
        .map(([k, ms]) => `${k} ${ms.toFixed(0)}`)
        .join(' ');

// Fold what this tick spent into the counters, and empty it for the next one.
function sweepSpent() {
    for (const k in spent) {
        metric.phase[k] = (metric.phase[k] || 0) + spent[k] / 1000;
        metric.calls[k] = (metric.calls[k] || 0) + 1;
        delete spent[k];
    }
}

// `lost` is the world time the clamp took off THIS tick -- not the running total, which is
// what the line used to end with. A cumulative figure sitting beside per-tick ones, with
// nothing saying which was which, read as every long tick having cost a rewind when most of
// them cost nothing at all. A tick is only worth mentioning as lost time if it lost some.
function endTick(total, sim, lost) {
    const named = naming();
    metric.ticks++;
    metric.tickSeconds += total / 1000;
    metric.sendSeconds += (total - sim) / 1000;
    let b = TICK_BUCKETS.findIndex((le) => total / 1000 <= le);
    metric.bucket[b < 0 ? TICK_BUCKETS.length : b]++;
    if (total > OVERRUN) {
        metric.overruns++;
        console.log(
            `tick ${total.toFixed(0)}ms (sim ${sim.toFixed(0)}, send ${(total - sim).toFixed(0)})` +
                (named ? `  of which ${named}` : '') +
                (lost > 0 ?
                    `  LOST ${(lost * 1000).toFixed(0)}ms of world`
                :   ''),
        );
    }
    sweepSpent();
}

// The loop was held up by something that was not a tick -- a save, a socket, a pause. It
// costs the same rewind a long tick does, because it is the next tick's dt that gets
// clamped either way, and it appears in the tick's own total nowhere at all.
function offTick(gap) {
    const named = naming();
    metric.gaps++;
    metric.gapSeconds += gap / 1000;
    console.log(
        `gap ${gap.toFixed(0)}ms between ticks` +
            (named ? `  of which ${named}` : '  unattributed'),
    );
    sweepSpent();
}

// ---- /metrics ----
//
// Prometheus text format, which is worth following exactly rather than approximately: it
// costs nothing here and it means anything that speaks it can read this, including a
// person with curl.
const esc = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
function metricsText() {
    const out = [];
    const say = (name, type, help, rows) => {
        out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
        for (const [labels, v] of rows) out.push(`${name}${labels} ${v}`);
    };
    const one = (name, type, help, v) => say(name, type, help, [['', v]]);
    const lbl = (k, v) => `{${k}="${esc(v)}"}`;

    // A histogram's buckets are cumulative and are named with the _bucket suffix, which is
    // the format and not a decoration: a reader that sees the bare name reads the whole
    // series as something else.
    let run = 0;
    out.push(
        '# HELP ragtag_tick_seconds Wall time spent inside one simulation tick.',
        '# TYPE ragtag_tick_seconds histogram',
        ...TICK_BUCKETS.map(
            (le, i) =>
                `ragtag_tick_seconds_bucket${lbl('le', le)} ${(run += metric.bucket[i])}`,
        ),
        `ragtag_tick_seconds_bucket${lbl('le', '+Inf')} ${run + metric.bucket[TICK_BUCKETS.length]}`,
        `ragtag_tick_seconds_sum ${metric.tickSeconds}`,
        `ragtag_tick_seconds_count ${metric.ticks}`,
    );
    one(
        'ragtag_tick_overruns_total',
        'counter',
        `Ticks that ran longer than ${OVERRUN}ms.`,
        metric.overruns,
    );
    one(
        'ragtag_tick_send_seconds_total',
        'counter',
        'Of the tick, time spent building and writing messages to sockets.',
        metric.sendSeconds,
    );
    one(
        'ragtag_gap_seconds_total',
        'counter',
        'Wall time the loop spent held up between ticks, by anything that is not a tick.',
        metric.gapSeconds,
    );
    one(
        'ragtag_gaps_total',
        'counter',
        'Times the loop was held up between ticks for longer than a tick plus the overrun budget.',
        metric.gaps,
    );
    one(
        'ragtag_sim_debt_seconds_total',
        'counter',
        'World time discarded by the dt clamp: what clients extrapolated through and were corrected back from.',
        metric.debt,
    );
    say(
        'ragtag_phase_seconds_total',
        'counter',
        'Wall time by phase. Phases nest -- generation loads chunks, a load merges walls -- so these do not sum to the tick.',
        Object.entries(metric.phase).map(([k, v]) => [lbl('phase', k), v]),
    );
    say(
        'ragtag_phase_ticks_total',
        'counter',
        'Ticks (or gaps) in which a phase was entered at all.',
        Object.entries(metric.calls).map(([k, v]) => [lbl('phase', k), v]),
    );

    // What the tick has to get through. A phase costing more is usually a count growing.
    const counts = {
        players: players.size,
        ships: ships.size,
        rocks: rocks.length,
        ore: ore.length,
        bullets: bullets.length,
        chunks: chunks.size,
        walls: wallsByKey.size,
        sites: sites.length,
        cells_pending: pendingCells.length,
        quests: quests.size,
        tiles: tiles.size,
    };
    say(
        'ragtag_world',
        'gauge',
        'How much of each kind of thing the world is currently holding.',
        Object.entries(counts).map(([k, v]) => [lbl('of', k), v]),
    );
    one(
        'ragtag_merge_cuts_total',
        'counter',
        'Differences the cut cache did not cover, where higher-ranked matter is taken out of lower.',
        mergeCuts,
    );
    one(
        'ragtag_merge_cutters_total',
        'counter',
        'Cutting walls handed to those differences, summed.',
        mergeCutters,
    );
    one(
        'ragtag_merge_unions_total',
        'counter',
        'Components the merge cache did not cover, each one a polygon-clipping union.',
        mergeMisses,
    );
    say(
        'ragtag_merge',
        'gauge',
        'What the last wall rebuild had to get through.',
        [
            [lbl('of', 'units'), mergeUnits],
            [lbl('of', 'components'), mergeComps],
        ],
    );
    one(
        'ragtag_uptime_seconds',
        'gauge',
        'Seconds this process has been running.',
        process.uptime(),
    );
    const mem = process.memoryUsage();
    say(
        'ragtag_memory_bytes',
        'gauge',
        'Process memory.',
        Object.entries({ rss: mem.rss, heap: mem.heapUsed }).map(([k, v]) => [
            lbl('of', k),
            v,
        ]),
    );
    return out.join('\n') + '\n';
}

// The world is an unbounded plane. What exists is decided by where the ships are:
// rocks are kept stocked within ACTIVE_R of every ship and culled past KEEP_R, so
// space is populated where anyone is and empty everywhere else.
const ACTIVE_R = 1400,
    KEEP_R = 2000,
    ROCK_TARGET = 9; // rock per active disc
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
const ORE_TARGET = 3,
    ORE_VALUE = 5,
    ORE_LIFE = 30;
const TRACTOR_R = 260,
    TRACTOR_PULL = 110,
    ORE_GRAB = 26;

// Opposition is scattered through the world rather than spawned at anyone: each chunk
// gets a roll the first time it is loaded, so exploring is what finds a fight. The
// roll is per process, not per chunk file -- ships do not survive a restart, so a
// restarted world repopulates the ground you have already walked over. How often, and how
// far apart, is declared by each kind of encounter in `SCRIPTS`; nothing else about
// placement is any of their business.
const NEST_GUARDS = 3,
    NEST_RING = 95;
const ENEMY_CLEAR = 900; // never spawn this close to any existing ship

// How far a camera may see from its own centre. The client will not zoom out past
// this, so it bounds what any one client can ask to be sent -- which is what keeps a
// snapshot small no matter how crowded the world gets.
const FLEET_SIZE = 2; // what a new commander starts with
const MAX_VIEW = 2200,
    VIEW_BUFFER = 500;
const STREAM_R = MAX_VIEW + VIEW_BUFFER;

// A hull is plain data. Nothing about navigation is derived by hand from these
// numbers -- the autopilot finds out how this ship stops by simulating it -- so a
// new hull is a new entry here and nothing else.
// The default a mount is built with, and what a shell takes off it. A hull may say
// otherwise -- these are declared above the hulls because the hulls quote them.
const TURRET_HP = 100,
    BULLET_DAMAGE = 20; // five hits to silence a carrier's gun

const CARRIER = {
    accel: 70,
    turn: 0.6,
    maxSpeed: 150,
    arriveR: 30,
    arriveV: 10, // close enough, slow enough
    // Where things may be installed, and nothing about what is installed there. A fit is a
    // mapping from these to modules, and not every mapping is valid: modules have a size, and
    // two of them have to be at least the sum of their radii apart. The closest pair of
    // points here is 22 apart, across the beam, which is what decides how big a module can be
    // before it starts blocking its opposite number.
    // Five down each side, 16 apart. A gun has a radius of 10, so two of them will not go in
    // neighbouring points -- the extra points buy where a battery sits rather than how many
    // guns it has, and a smaller module could use them all.
    // Five down each side 16 apart, and six on the centreline: one in the bows, one aft, and
    // four interleaved between the side pairs. A gun has a radius of 10, so it will not go
    // beside another gun on its own row, and one amidships blocks the four side points
    // nearest it -- a centreline battery is paid for in broadside. Smaller modules fit where
    // guns cannot.
    installs: [
        { id: 'p1', at: [32, -11] },
        { id: 'p2', at: [16, -11] },
        { id: 'p3', at: [0, -11] },
        { id: 'p4', at: [-16, -11] },
        { id: 'p5', at: [-32, -11] },
        { id: 's1', at: [32, 11] },
        { id: 's2', at: [16, 11] },
        { id: 's3', at: [0, 11] },
        { id: 's4', at: [-16, 11] },
        { id: 's5', at: [-32, 11] },
        { id: 'cf', at: [44, 0] },
        { id: 'c1', at: [24, 0] },
        { id: 'c2', at: [8, 0] },
        { id: 'c3', at: [-8, 0] },
        { id: 'c4', at: [-24, 0] },
        { id: 'ca', at: [-44, 0] },
    ],
    // What a hull comes out of the yard carrying: every point filled, guns pointing outboard
    // so none of them has to traverse across its own deck.
    fit: [
        { install: 'p1', type: 'gun', rot: -Math.PI / 2 },
        { install: 'p3', type: 'gun', rot: -Math.PI / 2 },
        { install: 'p5', type: 'gun', rot: -Math.PI / 2 },
        { install: 's1', type: 'gun', rot: Math.PI / 2 },
        { install: 's3', type: 'gun', rot: Math.PI / 2 },
        { install: 's5', type: 'gun', rot: Math.PI / 2 },
        { install: 'c2', type: 'tractor', rot: 0 },
    ],
    // Four discs down the spine rather than one circle around the whole hull: a bloated
    // collider is what would jam in a narrow fissure.
    collide: [
        [-40, 0, 14],
        [-13, 0, 14],
        [13, 0, 14],
        [40, 0, 14],
    ],
};

// ---- modules ----
//
// What can be installed. `size` is the radius it takes up on the hull, which is what makes
// some fits invalid; `install` is what it costs in ore to put one in. A module has no
// identity and no state of its own -- a module is a module -- so a hold is a count per
// type, and the wear on an installed one belongs to the installation rather than travelling
// with it. Pulling a gun and putting it back does mend it, and is priced so that is a silly
// way to do repairs rather than an impossible one.
const MODULES = {
    // `price` is what the market asks for one. It is well over an uninstall plus an install,
    // so shuffling what you have is always cheaper than buying your way out of a layout.
    gun: {
        turn: 2.2,
        range: 520,
        cooldown: 1.1,
        arcHalf: 1.4,
        hitR: 9,
        hp: TURRET_HP,
        size: 10,
        install: 40,
        price: 140,
    },
    // Not a weapon: no reach, so gunnery never picks a target for it. What it does is give
    // the hull a tractor beam, and a second gives a second beam -- the beams come out of the
    // ship rather than out of the module, so where it sits decides nothing except what else
    // will fit beside it. Small enough to go between the guns amidships, which is the point
    // of it: a radius of 3 clears the 13.6 to a neighbouring gun.
    tractor: {
        turn: 0,
        range: 0,
        cooldown: 1,
        arcHalf: 0,
        hitR: 7,
        hp: 60,
        size: 3,
        install: 60,
        price: 220,
    },
    // Fixed to their hulls and never in anybody's hold, but they are what sits in an install
    // point, so they are modules like any other.
    fighterGun: {
        turn: 6,
        range: 420,
        cooldown: 0.9,
        arcHalf: 0.04,
        hitR: 15,
        hp: 200,
        size: 10,
        install: 0,
        fixed: true,
    },
    // Anti-fighter. It fires far too fast to be modelling shells in flight and does not
    // try: the shot is resolved the moment it leaves, hits or misses on a roll, and what
    // the client draws is a line that is gone again before anybody could follow it.
    //
    // `only` is what makes it anti-fighter rather than a fast gun: it will not consider
    // anything else, whatever the envelope says. That is a property of the mount rather
    // than a preference, which is why it is here and not in the priorities.
    flak: {
        turn: 5,
        range: 360,
        cooldown: 0.1,
        arcHalf: 1.6,
        hitR: 8,
        hp: TURRET_HP,
        size: 8,
        install: 60,
        price: 260,
        only: 'fighter',
        // Point blank it rarely misses; at the edge of its reach it mostly does. Ten shots
        // a second at 7 a hit is about 40 a second in the middle of its band, against a
        // fighter's 200 -- twice what a gun manages, and nothing at all against a hull.
        hitscan: { damage: 7, near: 0.9, far: 0.35 },
    },
    core: {
        turn: 0,
        range: 0,
        cooldown: 1,
        arcHalf: 0,
        hitR: 26,
        hp: 600,
        size: 10,
        install: 0,
        fixed: true,
    },
    emplacement: {
        turn: 1.8,
        range: 600,
        cooldown: 1.3,
        arcHalf: Math.PI,
        hitR: 14,
        hp: 400,
        size: 10,
        install: 0,
        fixed: true,
    },
};

// Taking a module out is half of putting one in, and turning one where it stands is a
// quarter. A module moved is an uninstall and an install, deliberately: pricing a move as
// its own thing needs a rule for which module became which across the diff, and there is no
// such rule that is obviously fair. Buying a new module will cost more than 1.5 installs,
// so relocating is still the cheap way to rearrange.
const REFIT_REMOVE = 0.5,
    REFIT_ROTATE = 0.25;
// What the market gives you for one, as a fraction of what it asks. The spread is the
// reason to fit what you find rather than sell it and buy the thing you wanted.
const RESALE = 0.45;

// A module points at one of 32 stops around the circle, 11.25 degrees apart. Fine enough
// to aim an arc where you want it, coarse enough that two guns set the same way are
// actually the same way, and it makes a rotation something you can land on with a thumb.
const ROT_STOPS = 32;
const snapRot = (r) =>
    Math.round(r / ((Math.PI * 2) / ROT_STOPS)) * ((Math.PI * 2) / ROT_STOPS);

// ---- target priority ----
// A turret used to shoot whatever was nearest. Instead each ship carries, per kind of
// target, a curve from "how far out is it, as a fraction of gun range" to "how much do
// I want it, 0-100"; the gun fires at the best-scoring thing it can see.
//
// Five stops with straight lines between them. That is enough to say "close in", "stand
// off" or "only in the middle band", it is editable with a thumb, and it is small enough
// to ride in every snapshot. Zero means do not engage at all -- not "engage last" --
// which is the hook the eventual fair-game flag hangs on.
const PRIO_MAX = 8; // points, not stops: more than this is not thumb-editable
// 'rock', 'turret', 'fighter' and 'cache' say what to shoot; 'repair' says what to mend.
// Same curve, same order on the wire, same editor -- only the axis underneath differs,
// which is distance for the first four and health for the last.
// Repair curves are per module type, under `repair:<type>`, and `repair` is what anything
// without its own falls back to. A crew told to leave guns alone until they are nearly
// wrecked should not thereby be told the same about the winch.
const PRIO_KINDS = [
    'rock',
    'turret',
    'fighter',
    'cache',
    'ore',
    'module',
    'repair',
    'repair:tractor',
];
const repairCurve = (s, t) => s.prio['repair:' + t.type] || s.prio.repair;
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
    const quarter = (WRECK_DEPTH + TURRET_HP * 0.25) / span; // a quarter of positive health
    return {
        rock: [
            [0, 100],
            [1, 20],
        ],
        turret: [
            [0, 100],
            [1, 20],
        ],
        fighter: [
            [0, 100],
            [1, 20],
        ],
        cache: [
            [0, 100],
            [1, 20],
        ],
        // A beam chooses the same way a gun does. Modules start above ore, because a grain is
        // five ore and a module is a thing you cannot buy.
        ore: [
            [0, 100],
            [1, 20],
        ],
        module: [
            [0, 100],
            [1, 60],
        ],
        repair: [
            [0, 50],
            [quarter, 100],
            [quarter, 49],
            [1, 1],
        ],
        'repair:tractor': [
            [0, 50],
            [quarter, 100],
            [quarter, 49],
            [1, 1],
        ],
    };
};

// Where a gun sits on the repair axis: 0 is a fresh wreck at the bottom of the debt,
// 1 is a gun at full health. The debt is part of the axis, so a half-rebuilt wreck
// really is further along than an untouched one. Full health is the hull's, not a
// constant: a fighter's one gun is tougher than a carrier's six.
const maxHp = (t) => MODULES[t.type].hp ?? TURRET_HP;
const repairFrac = (hp, max) => (hp + WRECK_DEPTH) / (max + WRECK_DEPTH);

// An ordered sequence of points, straight lines between them, x never going backwards.
// Two points sharing an x are a vertical segment -- an instantaneous jump, up or down --
// which is what lets one curve hold bands that do not overlap. The arriving line wins the
// sample exactly on the boundary; which way the jump goes is the order of the pair, not
// which value is larger, so a step up is as expressible as a step down.
function prioAt(pts, f) {
    const x = Math.max(0, Math.min(1, f));
    for (let i = 0; i < pts.length - 1; i++) {
        const [x0, y0] = pts[i],
            [x1, y1] = pts[i + 1];
        if (x1 <= x0) continue; // a jump spans no distance
        if (x <= x1) return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
    return pts[pts.length - 1][1];
}

// A fighter is one gun bolted to an engine. The gun does not traverse -- arcHalf is a
// sliver, so it fires only when the nose is on the solution -- which is what makes the
// thing fly at you rather than sit off your beam. It has no separate turret to shoot at:
// its one "mount" sits at the centre of the hull with a hit radius the size of the hull,
// so the fighter itself is the target, and `frail` says the hull dies with its gun.
const FIGHTER = {
    accel: 260,
    turn: 3.4,
    maxSpeed: 340,
    arriveR: 30,
    arriveV: 10,
    installs: [{ id: 'gun', at: [0, 0] }],
    fit: [{ install: 'gun', type: 'fighterGun', rot: 0 }],
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
    accel: 0,
    turn: 0,
    maxSpeed: 0,
    arriveR: 30,
    arriveV: 10,
    installs: [{ id: 'core', at: [0, 0] }],
    fit: [{ install: 'core', type: 'core', rot: 0 }],
    collide: [[0, 0, 20]],
    frail: true,
    rockProof: true,
    ai: 'static',
    targetKind: 'cache',
    spills: 50, // grains it lets go of when it breaks
};

// A gun set into the settlement's rock, covering the tunnel. It is `embedded`, and every
// odd thing about it follows from that one fact: the wall does not push it out, the wall
// does not stop its shells, and nothing takes aim at it -- not because it is invulnerable
// by decree but because nothing anybody has can reach a thing inside a rock. It traverses
// all the way round, having no hull in its own way.
const BASTION = {
    accel: 0,
    turn: 0,
    maxSpeed: 0,
    arriveR: 30,
    arriveV: 10,
    installs: [{ id: 'gun', at: [0, 0] }],
    // Reach is capped by the shell, not by the gun: 560 a second for 1.2 seconds is 672
    // units, and a range past that rejects every target as one the shot cannot reach in time.
    fit: [{ install: 'gun', type: 'emplacement', rot: 0 }],
    collide: [[0, 0, 16]],
    frail: true,
    rockProof: true,
    ai: 'static',
    targetKind: 'turret',
    embedded: true,
};

const HULLS = {
    carrier: CARRIER,
    fighter: FIGHTER,
    cache: CACHE,
    bastion: BASTION,
};
const hullKey = (h) =>
    h === FIGHTER ? 'fighter'
    : h === CACHE ? 'cache'
    : h === BASTION ? 'bastion'
    : 'carrier';

const PREDICT_DT = 0.1,
    PREDICT_STEPS = 400; // the rollout answers a yes/no question;
// it does not need the sim's fidelity
const BULLET_SPEED = 560,
    BULLET_LIFE = 1.2;

// A silenced gun does not sit at zero, it falls into debt: the hit that kills it drops
// it to -WRECK_DEPTH, and repair climbs back up the same axis. Keeping the cliff on the
// health axis means "destroyed" stays `hp <= 0` everywhere it already was, with no
// second pool and no rebuild state to keep in step -- and the depth is one number.
// At one point a second that is 2.5 minutes to stand a wreck up, 100s to top a gun off.
const WRECK_DEPTH = 150,
    REPAIR_RATE = 1;
// A rock that reaches a gun takes half of it. Splitting on impact means one big rock can
// walk a whole battery down in a cascade, so the children are given a moment before they
// count: without it every fragment of a split is born inside the turret that caused it
// and the whole chain resolves in a single tick, on one gun, for no skill either way.
const ROCK_DAMAGE = 50,
    SPLIT_GRACE = 1;
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
// The oldest chunk file still worth reading. Fields added since are optional and default
// to empty, so adding one does not throw away a world: bumping this discards every chunk
// on disk, and only set-piece cells ever lay themselves out again -- a biome's rock would
// be gone for good, on ground somebody has already explored.
const WALL_FORMAT = 7; // what is written
const WALL_OLDEST = 5; // ...and the oldest that can still be read
const MAX_BLOBS = 6; // per chunk, at density 1
// Beside wherever it was started, not beside the code: installed globally, the code
// lives in a directory shared by every world and often not writable. Run it where you
// want the world, which in a checkout is the checkout. Named for the program rather than
// for what it holds, because it is made in whatever directory somebody happened to be in.
// $PORT is a convention worth inheriting -- everything that hosts a server sets it. A
// bare $DATADIR is nobody's convention, so an ambient one would be a surprise rather than
// a service; this one says whose it is.
const WORLD_DIR =
    cmdline.flags.datadir ||
    process.env.RAGTAG_DATADIR ||
    path.join(process.cwd(), 'ragtag');

const MIME = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
};

const server = http.createServer((req, res) => {
    // Strip the query BEFORE deciding what the path means, or "/?x=1" is not "/" and
    // ends up trying to read the directory.
    const requested = req.url.split('?')[0];
    // Always served, in every mode. What it costs is a string built on demand, and the
    // alternative -- a flag to turn it on -- means the fault has to happen twice.
    if (requested === '/metrics') {
        res.writeHead(200, {
            'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        });
        res.end(metricsText());
        return;
    }
    const file = requested === '/' ? '/index.html' : requested;
    const full = path.join(
        __dirname,
        'public',
        path.normalize(file).replace(/^(\.\.[/\\])+/, ''),
    );
    fs.readFile(full, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type':
                MIME[path.extname(full)] || 'application/octet-stream',
        });
        res.end(data);
    });
});

let nextId = 1;
const players = new Map(); // playerId -> { id, ws, name, score }
const ships = new Set(); // every ship in play; each knows its owner
const bullets = [];
const rocks = [];
const ore = [];

const rand = (a, b) => a + Math.random() * (b - a);
const angleDiff = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const clamp = (v, m) => Math.max(-m, Math.min(m, v));

// ---- terrain ----
const chunks = new Map(); // "cx,cy" -> { cx, cy, key, units: [{ ring, mat }, ...] }
const chunkKey = (cx, cy) => `${cx},${cy}`;
const chunkOf = (v) => Math.floor(v / CHUNK);

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
const CELL_R = 2400; // roughly how far apart sites sit: a cell is a few chunks
const CELL_JITTER = 0.38; // how irregular the mesh is, as a fraction of CELL_R
const CELL_FAR = CELL_R * 8; // the box a cell is clipped out of; touching it means unbounded
// A cell is closed once nothing of it reaches further than this. Merely *bounded* is not
// enough: three neighbours can close a cell while leaving it sprawling, and its far
// corners then legitimately forbid every site the frontier wants to place next -- the
// mesh strangles itself a few cells out. Compact cells leave room for their successors.
const CELL_MAX = CELL_R * 1.35;

// The registry a `/biomes` folder will eventually populate. What a biome is, is the
// handful of numbers terrain generation asks it for.
const BIOMES = {
    open: { density: 0.22, base: 50, spread: 90 },
    // Wide lanes rather than a sieve: at 0.95/90/220 half the cells had no route across at
    // all that a 28-wide hull could take, and the ones that did threaded 30-unit gaps a ship
    // steering by local avoidance cannot find. Smaller blobs at nearly the same density keep
    // it reading as a rock field -- 46% of the ground is still rock -- while opening it up.
    // Measured over 60 cells at the median 3,672 width: a 200-wide lane crosses 92% of them,
    // against 0% before.
    dense: { density: 0.8, base: 60, spread: 120 },
    // A biome may bring its own generator instead of a density: scattering blobs is one way
    // to fill a cell, not the only one, and the warren is not a field of anything. It may
    // also decline a cell outright -- see `rollBiome`.
    warren: { make: warrenMatter, takes: warrenTakes },
    town: { density: 0 }, // a set piece owns this ground; generate nothing in it
};
// What the roll may choose, and how often: a name listed twice comes up twice as much. A
// set piece's biome is claimed, never rolled.
const BIOME_NAMES = ['open', 'open', 'dense', 'dense', 'warren'];

// A biome may say no. Some ground does not suit some of them -- a warren is bored rather
// than scattered and boring is superlinear in how much of it there is -- and the honest way
// to say so is to decline the cell rather than to quietly hand back somebody else's
// terrain: what the cell is called would stop matching what is standing in it. Declining
// takes one name out of the hat and the roll goes on over the rest, so it does not hand the
// ground to any particular biome either. If every one of them declines, the cell is open:
// there is always somewhere for nothing in particular to go.
function rollBiome(s) {
    const willing = BIOME_NAMES.filter(
        (n) => !BIOMES[n].takes || BIOMES[n].takes(s),
    );
    const from = willing.length ? willing : ['open'];
    return from[Math.floor(Math.random() * from.length)];
}

// ---- set pieces ----
//
// A set piece claims a convex cell and draws what is inside it. The claim is permanent
// and cannot grow; the contents are free to change with later versions.
//
// A cell is made to be a given shape by placing its neighbours: reflect the site across
// each edge and the perpendicular bisector of that pair *is* the edge. Six reflections,
// six edges, and the Voronoi cell comes out as exactly the authored polygon.
const SCREEN = 1732; // the unit content is drawn against; see CLAUDE.md
const TOWN_SIDE = 2.12 * SCREEN; // a regular hexagon; area goes as the side squared,
// so 2.12 screens is half the three-screen one it was
const TOWN_CAVE = 1730; // the cavern: a bit over two screens across
const TOWN_SHIFT = 350; // how far the cavern sits back from the origin, away
// from the tunnel, so there is rock worth tunnelling
// through on the way out and a thick back wall behind
const TOWN_TUNNEL = 380; // clear width of the passage out
const TOWN_OUT = -Math.PI / 4; // which way it runs: up and to the right
const TOWN_DOOR = 0.45; // half-width of the wedge the rock stands back in
const TOWN_STAND = 2400; // ...and how far out it stands there. The mouth has to
// stay clear of the border by more than a blob's reach
const TOWN_LAP = 1.05; // everywhere else it laps over the border instead, so
// a neighbour's rock merges into it rather than
// leaving the town sitting in a moat

// A regular hexagon's edge normals -- where the neighbouring sites go -- fall at 30, 90,
// 150 ... which is what makes the town's cell come out as the hexagon it claims.
const APOTHEM = Math.cos(Math.PI / 6); // of a regular hexagon, as a fraction of R

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

// Line art, which is scenery and nothing else: no collision, no matter, not merged with
// anything. A set piece draws whatever it likes and the lines go over the wire when the
// chunk holding them loads, so a station needs no matching artwork built into the client
// and a new set piece can look like whatever it wants without one being shipped.
//
// Anything built against the cavern wall is drawn in a frame where x runs along the wall
// and y points inward, so a bearing is the only thing that decides where it stands.
function faceFrame(ox, oy, A) {
    const nx = Math.cos(A),
        ny = Math.sin(A); // out towards the rock
    const px = -ny,
        py = nx; // along the face
    const at = (u, v) => [
        +(ox + px * u - nx * v).toFixed(1),
        +(oy + py * u - ny * v).toFixed(1),
    ];
    return {
        at,
        line: (...pts) => pts.map(([u, v]) => at(u, v)),
        inward: (u, v) => [ox + px * u - nx * v, oy + py * u - ny * v],
    };
}

// The town's own cavern wall, at a bearing round it.
function wallFrame(A, back = 20) {
    const cx = -Math.cos(TOWN_OUT) * TOWN_SHIFT,
        cy = -Math.sin(TOWN_OUT) * TOWN_SHIFT;
    return faceFrame(
        cx + Math.cos(A) * (TOWN_CAVE - back),
        cy + Math.sin(A) * (TOWN_CAVE - back),
        A,
    );
}

// ---- naming ----
//
// A place is named the way a person is -- two tables and a roll -- so the same set piece
// stamped somewhere else is not stamping the same name. Offered to set piece generators:
// hand it the cell's own stream (`siteRng`) and the name comes out the same on every world
// that has that cell in it, without anybody storing a seed. The people tables are down with
// the conversations, beside the code that draws faces.
const pick = (xs, rng) => xs[Math.floor(rng() * xs.length)];
const PLACE_HEAD = [
    'Cold',
    'Long',
    'Iron',
    'Quiet',
    'Black',
    'Far',
    'Low',
    'Broken',
    'Still',
    'Old',
    'Grey',
    'Salt',
    'Deep',
    'Thin',
    'Bitter',
    'Last',
];
const PLACE_TAIL = [
    'Harbour',
    'Reach',
    'Drift',
    'Anchorage',
    'Roads',
    'Hold',
    'Landing',
    'Berth',
    'Quay',
    'Shoal',
    'Narrows',
    'Mooring',
    'Haven',
    'Watch',
    'Basin',
    'Crossing',
];
// 256 of them, which is more than anybody will sail to, and each reads as a place rather
// than as a generator.
const placeName = (rng) => `${pick(PLACE_HEAD, rng)} ${pick(PLACE_TAIL, rng)}`;

// ---- the second city ----
//
// Low Berth is a cavern with one way in. This is the other kind of settlement: a slab of
// rock with a warren dug through it, a way out through every edge of its cell, and
// clearings here and there where there was room to build something. Same hexagon, same
// claim, and nothing about it is special-cased anywhere -- it is a second `kind` in
// `generateCell` and a second entry in `SET_VERSION`, which is the whole of what a new set
// piece costs.
const CITY_SIDE = 2.12 * SCREEN; // the same hexagon the town claims
const CITY_HUB = 340; // the clearing the trunks are dug from
const WARREN_BORE = 250; // clear width of a trunk, at its widest
const WARREN_STEP = 170; // how far a tunnel runs before it bends
const WARREN_BEND = 0.5; // ...and how far it may bend there, in radians
const CITY_SPURS = 40; // side passages driven off whatever is already dug
const CITY_ROOM = 300; // a clearing, at its widest
// ...and a clearing with a station in it, which has to hold one: a station's floor is 600
// units across, and the chord of one laid inside a 440 circle stands its middle 102 off the
// rock, which is arithmetic and not a placement to be improved on.
const CITY_HALL = 440;
const CITY_ROOMS = 10; // how many of them, the market and the yard among them
const WARREN_PILLAR = 150; // thinnest rib of rock allowed to stand between two tunnels
const WARREN_SEAM = 2; // ...and how many steps one may run inside that before it stops
const CITY_DOOR = 0.17; // half-width of the wedge the rock stands back in, at each mouth
const CITY_STAND = 0.9; // ...and how far out it stands there, of its full reach. Every
// mouth keeps a moat for the reason the town's one does: a
// neighbour's blob landing across it would seal that way in,
// and "a way out through every edge" is the whole idea.
const CITY_LAP = 1.05; // everywhere else it laps over, so neighbouring rock merges in
const CITY_AWAY = 35 * SCREEN; // how far from Low Berth it is founded

// Where the hexagon reaches in a direction, which is the town's own maths with this side.
const cityReach = (a) => {
    let best = Infinity;
    for (let k = 0; k < 6; k++) {
        const c = Math.cos(angleDiff(a, Math.PI / 6 + (k * Math.PI) / 3));
        if (c > 0.01) best = Math.min(best, (CITY_SIDE * APOTHEM) / c);
    }
    return best;
};

// The six bearings a trunk sets out on: the edge normals, which is what makes each one come
// out through the middle of an edge rather than at a corner.
const CITY_WAYS = Array.from(
    { length: 6 },
    (_, k) => Math.PI / 6 + (k * Math.PI) / 3,
);

// Where a walk has eaten into another tunnel's rib of rock, and the point on that tunnel it
// is too close to -- which is what a walk turns away from. Segments near where the walk set
// out are skipped: a spur starts on the tunnel it branches from and a trunk starts in the
// hub with five others, so without that exemption every walk is a seam from its first step.
function ribbed(x, y, seam, x0, y0) {
    for (const g of seam.segs) {
        const mx = (g.ax + g.bx) / 2,
            my = (g.ay + g.by) / 2;
        if (Math.hypot(mx - x0, my - y0) < WARREN_STEP * 1.5) continue;
        const dx = g.bx - g.ax,
            dy = g.by - g.ay;
        const d2 = dx * dx + dy * dy || 1;
        const t = Math.max(
            0,
            Math.min(1, ((x - g.ax) * dx + (y - g.ay) * dy) / d2),
        );
        const px = g.ax + dx * t,
            py = g.ay + dy * t;
        if (Math.hypot(px - x, py - y) < seam.half + g.half + WARREN_PILLAR)
            return [px, py];
    }
    return null;
}

// A tunnel is a walk, not a line: it takes a step, bends, and takes another. Given
// somewhere to be it is steered as well -- each bend pulled part of the way back toward the
// target -- so a trunk arrives at its mouth without ever having run straight at it. Given
// nothing, it wanders off and ends wherever it ends.
function dig(x, y, a, steps, rnd, aim, seam) {
    const pts = [[x, y]];
    const x0 = x,
        y0 = y;
    let along = 0;
    for (let i = 0; i < steps; i++) {
        a += (rnd() - 0.5) * 2 * WARREN_BEND;
        if (aim) {
            a += angleDiff(Math.atan2(aim[1] - y, aim[0] - x), a) * 0.4;
            if (Math.hypot(aim[0] - x, aim[1] - y) < WARREN_STEP) break;
        }
        let nx = x + Math.cos(a) * WARREN_STEP,
            ny = y + Math.sin(a) * WARREN_STEP;
        // Two tunnels running side by side with nothing standing between them are not two
        // tunnels, they are open space -- and enough of that and the place reads as more
        // tunnel than wall. So a step that would eat the rib turns away from whatever it
        // came too near and tries once more; a walk that cannot get clear that way is
        // running alongside rather than crossing, and it ends. The budget is in steps and
        // there is no angle to measure: a crossing is in and out again whatever angle it
        // comes in at, and the shallow crossing, which is the worst kind of seam, is the
        // one that cannot get clear.
        if (seam) {
            const rib = ribbed(nx, ny, seam, x0, y0);
            if (rib) {
                a = Math.atan2(ny - rib[1], nx - rib[0]);
                nx = x + Math.cos(a) * WARREN_STEP;
                ny = y + Math.sin(a) * WARREN_STEP;
                along = ribbed(nx, ny, seam, x0, y0) ? along + 1 : 0;
                if (along > WARREN_SEAM) break;
            } else along = 0;
        }
        x = nx;
        y = ny;
        pts.push([x, y]);
    }
    // A walk covers less ground than it travels, so a trunk given a step budget for the
    // straight-line distance stops short -- and a trunk that stops short leaves a plug
    // standing in its mouth, which is that edge of the cell with no way out. The budget is
    // generous and the last point is the mouth regardless: arriving is the invariant, and
    // bending prettily on the way there is not.
    if (aim) pts.push(aim);
    return pts;
}

// A station's baseline is the line its own drawing stands on: the lowest points of the art,
// from the outermost on one side to the outermost on the other. Read off the drawing rather
// than written down beside it, so a hand moving the market's dish moves what the market
// stands on and cannot leave the two disagreeing.
const FOOT_FRAME = { line: (...pts) => pts, at: (u, v) => [u, v] };
function footOf(lines) {
    const pts = lines.flat();
    const sole = Math.min(...pts.map((q) => q[1]));
    const on = pts.filter((q) => q[1] <= sole + 1).map((q) => q[0]);
    return [Math.min(...on), Math.max(...on)];
}

// A property of the two drawings and of nothing else, so they are read once: what each
// stands on, and every point it occupies.
const CITY_SOLE = {
    market: () => footOf(marketLines(FOOT_FRAME)),
    yard: () => footOf(yardLines(FOOT_FRAME)),
};
const CITY_SHAPE = {
    market: () => marketLines(FOOT_FRAME).flat(),
    yard: () => yardLines(FOOT_FRAME).flat(),
};

// Put two points on the wall. The inputs are the wall, the length of the station's baseline,
// and a point to look from -- nothing else, and no shape query standing in for the rock, so a
// stretch of a clearing's ring that a tunnel has opened is not wall here and nothing has to be
// told so.
//
//   1. Cast ten rays from the query point and take where each first meets the wall.
//   2. Throw away the outliers -- a ray that went out through a tunnel comes back much
//      further than the rest -- and take one of what is left. That is the first point.
//   3. Cast a segment of the baseline's length off it and bisect on the angle until the far
//      end lands on the wall too. That is the second point.
//   4. Sweep ten more rays between those two points. One that runs well past the baseline
//      before it meets the wall means a tunnel mouth under the station, so the whole landing
//      is thrown away and done again from the top.
//
// Rolled again if the placement it gives is unusable: the station has to stand in the open,
// which is a property of the answer and not something to search for.
const CITY_CAST = 10; // rays cast to find somewhere to stand
const CITY_WIDE = 1.4; // ...and how far past the median of them is a tunnel, not a wall
const CITY_ARC = Math.PI / 180; // the swing is bracketed this finely before it is bisected
const CITY_BISECT = 32; // halvings, which puts the far end on the wall to a millionth
const CITY_TRIES = 200; // rolls before giving up
const CITY_SPAN = 10; // rays swept between the two points, looking for a tunnel under them
const CITY_OVER = 0.5; // ...and how much of the art's own height one may overshoot by
const CITY_LANDS = 10; // landings tried before the last one is allowed through regardless
const CITY_SET = 3; // how far clear of the wall the drawing is laid, so that whether a
// baseline vertex counts as inside the rock is not left to rounding
const CITY_SEAT = 20; // ...and how far it is then pushed back into the wall, once the
// placement is settled on, so that it sits in the rock rather than touching it

function cityStand(rock, room, foot, shape, rnd) {
    const [uL, uR] = foot;
    const span = uR - uL;
    const near = (x, y) => Math.hypot(x - room.x, y - room.y) < room.r * 1.6;

    // Only the rock hereabouts, each with a box round it. A city carves into thirty rings and
    // asking every one of them whether it holds a point -- millions of times -- was once the
    // whole cost of this: 85 million point-in-ring tests for an answer that is one ring's
    // business.
    const local = rock
        .map((ring) => {
            const xs = ring.map((q) => q[0]),
                ys = ring.map((q) => q[1]);
            return {
                ring,
                x0: Math.min(...xs),
                x1: Math.max(...xs),
                y0: Math.min(...ys),
                y1: Math.max(...ys),
            };
        })
        .filter(
            (b) =>
                b.x1 > room.x - room.r * 2 &&
                b.x0 < room.x + room.r * 2 &&
                b.y1 > room.y - room.r * 2 &&
                b.y0 < room.y + room.r * 2,
        );

    const inRock = (x, y) =>
        local.some(
            (b) =>
                x >= b.x0 &&
                x <= b.x1 &&
                y >= b.y0 &&
                y <= b.y1 &&
                pointInWall([b.ring], x, y),
        );

    const edges = [];
    for (const { ring } of local)
        for (let i = 0; i < ring.length; i++) {
            const P = ring[i],
                Q = ring[(i + 1) % ring.length];
            if (near(P[0], P[1]) || near(Q[0], Q[1])) edges.push([P, Q]);
        }

    // 1. Where a ray from the query point first meets the wall. First, and not merely
    // somewhere: that is what makes the hit a piece of wall the clearing can see.
    const ray = (dx, dy) => {
        let best = Infinity,
            hit = null;
        for (const [[ax, ay], [bx, by]] of edges) {
            const sx = bx - ax,
                sy = by - ay;
            const den = dx * sy - dy * sx;
            if (den === 0) continue;
            const t = ((ax - room.x) * sy - (ay - room.y) * sx) / den;
            const u = ((ax - room.x) * dy - (ay - room.y) * dx) / den;
            if (t > 0 && u >= 0 && u <= 1 && t < best) {
                best = t;
                hit = [room.x + dx * t, room.y + dy * t];
            }
        }
        return hit && { at: hit, d: best };
    };

    // 2. Ten of them, the far ones dropped, one of the rest taken.
    const first = () => {
        const hits = [];
        for (let i = 0; i < CITY_CAST; i++) {
            const a = rnd() * Math.PI * 2;
            const h = ray(Math.cos(a), Math.sin(a));
            if (h) hits.push(h);
        }
        if (!hits.length) return null;
        const mid = hits.map((h) => h.d).sort((p, q) => p - q)[
            hits.length >> 1
        ];
        const kept = hits.filter((h) => h.d <= mid * CITY_WIDE);
        return kept[Math.floor(rnd() * kept.length)].at;
    };

    // 3. Swing the far end of the segment about it and bisect where it crosses the wall. A
    // crossing is where the far end goes from standing in rock to standing in the open, so
    // bracketing on that and halving lands it on the wall as exactly as asked. The sweep
    // starts wherever the roll says, so it is not always the same crossing that is found.
    const second = ([cx, cy]) => {
        const far = (t) => [cx + Math.cos(t) * span, cy + Math.sin(t) * span];
        const solid = (t) => {
            const [x, y] = far(t);
            return inRock(x, y);
        };
        const n = Math.ceil((Math.PI * 2) / CITY_ARC);
        const from = rnd() * Math.PI * 2;
        let was = solid(from);
        for (let k = 1; k <= n; k++) {
            const t = from + (k / n) * Math.PI * 2;
            if (solid(t) !== was) {
                let lo = from + ((k - 1) / n) * Math.PI * 2,
                    hi = t;
                for (let i = 0; i < CITY_BISECT; i++) {
                    const m = (lo + hi) / 2;
                    if (solid(m) === was) lo = m;
                    else hi = m;
                }
                return far((lo + hi) / 2);
            }
        }
        return null; // the segment never reaches the wall from here
    };

    // Which way the station faces is settled at the two ends, not at the middle: the ends are
    // on the wall, so a step off one of them is rock one way and open the other, while the
    // middle of a chord is nowhere near the wall it is a chord of.
    const place = (A, C) => {
        let px = (C[0] - A[0]) / span,
            py = (C[1] - A[1]) / span;
        let nx = py,
            ny = -px;
        const backing = (sx, sy) =>
            [A, C].filter((P) =>
                inRock(P[0] + sx * CITY_SET, P[1] + sy * CITY_SET),
            ).length;
        const front = backing(nx, ny),
            behind = backing(-nx, -ny);
        if (Math.max(front, behind) < 2) return null; // not both ends against rock
        if (behind > front) {
            [A, C] = [C, A];
            ((px = -px), (py = -py), (nx = -nx), (ny = -ny));
        }

        // The station stands in the open or it does not stand: the baseline along its length,
        // and every point of the drawing. The flattest wall in a warren is as likely to be the
        // side of a tunnel as the side of a clearing, and a market laid on one ran its dome
        // into the far wall a hundred units behind it.
        for (let k = 0; k <= 24; k++) {
            const x = A[0] + (C[0] - A[0]) * (k / 24) - nx * CITY_SET,
                y = A[1] + (C[1] - A[1]) * (k / 24) - ny * CITY_SET;
            if (inRock(x, y)) return null;
        }
        // The frame's own origin is the baseline's zero, which is not its middle: the market's
        // plinth reaches 250 one way and its dish 326 the other.
        const ox = A[0] + px * -uL - nx * CITY_SET,
            oy = A[1] + py * -uL - ny * CITY_SET;
        for (const [u, v] of shape)
            if (inRock(ox + px * u - nx * v, oy + py * u - ny * v)) return null;

        // Seated: once the placement is settled on, the whole thing is nudged straight into
        // the wall, perpendicular to its own baseline. Everything above is checked against
        // where it truly lands and this is applied after, so what it buries is deliberate --
        // a station drawn to rest on a flat and standing on a curve otherwise meets it at one
        // point and reads as balanced on it.
        return {
            ox: ox + nx * CITY_SEAT,
            oy: oy + ny * CITY_SEAT,
            a: Math.atan2(ny, nx),
        };
    };

    // Two points on the wall say nothing about what is between them. A baseline can land with
    // its ends on either side of a tunnel mouth, and the station then stands across the mouth
    // with the passage running away underneath it. So sweep ten rays from the query point
    // between the two landing points: each should meet the wall at about the baseline, and one
    // that carries on well past it has gone down a tunnel.
    const height = Math.max(...shape.map((q) => q[1]));
    const spans = (A, C) => {
        const from = Math.atan2(A[1] - room.y, A[0] - room.x);
        const sweep = angleDiff(Math.atan2(C[1] - room.y, C[0] - room.x), from);
        const sx = C[0] - A[0],
            sy = C[1] - A[1];
        for (let i = 0; i <= CITY_SPAN; i++) {
            const a = from + (sweep * i) / CITY_SPAN;
            const dx = Math.cos(a),
                dy = Math.sin(a);
            // A ray that finds no wall at all has gone straight out of the neighbourhood,
            // which is a tunnel and not a near miss: reading it as "nothing to report" is what
            // let a yard through standing across a mouth with its three middle rays blind.
            const hit = ray(dx, dy);
            if (!hit) return true;
            // How far along this ray the baseline itself is.
            const den = dx * sy - dy * sx;
            if (den === 0) continue;
            const t = ((A[0] - room.x) * sy - (A[1] - room.y) * sx) / den;
            const u = ((A[0] - room.x) * dy - (A[1] - room.y) * dx) / den;
            if (t <= 0 || u < 0 || u > 1) continue;
            if (hit.d - t > height * CITY_OVER) return true;
        }
        return false;
    };

    const land = () => {
        for (let t = 0; t < CITY_TRIES; t++) {
            const A = first();
            const C = A && second(A);
            const got = C && place(A, C);
            if (got) return { stand: got, A, C };
        }
        return null;
    };

    // Landed again from the top, with a fresh set of rays, if it came down over a tunnel.
    let last = null;
    for (let t = 0; t < CITY_LANDS; t++) {
        const got = land();
        if (!got) continue;
        last = got.stand;
        if (!spans(got.A, got.C)) return got.stand;
    }
    return last || { ox: room.x, oy: room.y, a: 0 };
}

// The whole layout, cut at the origin from one fixed stream. A set piece is one place, not a
// family of them: the same warren stands wherever the cell landed, and where it landed is an
// offset applied to the finished vertices. That is what lets it be cut at build time.
const CITY_SEED = 0x5b3d21; // the stream Still Basin is dug from, and the whole of what
// makes it the place it is. Change it and it is a different city.
//
// Held on to, because it now carves: matter, art and marks each ask for the layout and there
// is only ever one of it, so carving it three times is three times the only slow thing here.
let cityHeld = null;
function cityPlan() {
    return (cityHeld ??= cityCut());
}
function cityCut() {
    const s = { x: 0, y: 0 };
    let v = CITY_SEED;
    const rnd = () => {
        v = (Math.imul(v, 1664525) + 1013904223) >>> 0;
        return v / 4294967296;
    };

    // The slab. It laps over its own cell except in a wedge at each mouth, where it stands
    // back far enough that nothing a neighbour grows can reach across the opening.
    const ring = [];
    for (let k = 0; k < 60; k++) {
        const a = (k / 60) * Math.PI * 2;
        let off = Math.PI;
        for (const w of CITY_WAYS)
            off = Math.min(off, Math.abs(angleDiff(a, w)));
        const t = Math.min(1, Math.max(0, (off - CITY_DOOR) / CITY_DOOR));
        const full = cityReach(a);
        const r =
            (full * CITY_STAND + (full * CITY_LAP - full * CITY_STAND) * t) *
            (1 + (rnd() - 0.5) * 0.12 * t);
        ring.push([s.x + Math.cos(a) * r, s.y + Math.sin(a) * r]);
    }

    // Somewhere inside the rock, with room to stand back from the surface. Spurs are dug
    // from these and clearings opened at them; a point out in the mouth of a trunk is
    // neither, which is what this keeps out.
    const inside = ([x, y]) => {
        const dx = x - s.x,
            dy = y - s.y;
        return Math.hypot(dx, dy) < cityReach(Math.atan2(dy, dx)) * 0.82;
    };

    const paths = [];
    const nodes = [];
    const trunkNodes = [];
    const segs = [];
    const drive = (pts, bore, trunk) => {
        paths.push({ pts, bore });
        for (let i = 1; i < pts.length; i++)
            segs.push({
                ax: pts[i - 1][0],
                ay: pts[i - 1][1],
                bx: pts[i][0],
                by: pts[i][1],
                half: bore / 2,
            });
        for (const p of pts)
            if (inside(p)) {
                nodes.push(p);
                if (trunk) trunkNodes.push({ x: p[0], y: p[1] });
            }
    };

    // A trunk out through the middle of every edge, cut long so it opens past the rock
    // rather than leaving a plug standing in the mouth.
    for (const a of CITY_WAYS) {
        const out = cityReach(a) * CITY_LAP + 900;
        drive(
            dig(s.x, s.y, a, Math.ceil(out / WARREN_STEP) * 2 + 8, rnd, [
                s.x + Math.cos(a) * out,
                s.y + Math.sin(a) * out,
            ]),
            WARREN_BORE * (0.88 + rnd() * 0.12),
            true,
        );
    }

    // ...and spurs off whatever is already dug, with nothing steering them. They wander,
    // they run across trunks and across each other, and a crossing is a junction because
    // the warren is all one cut -- so the place reads as a network without anything having
    // laid a network out.
    for (let i = 0; i < CITY_SPURS; i++) {
        // Each spur sets out from a different quarter of the compass, taken in turn. Left to
        // pick freely, spurs clump: every spur adds its own points to the pool, so wherever
        // the last one went is where the next one is likeliest to start, and the warren came
        // out packed down one side with plates of untouched rock down the other. And within
        // the sector, the outer of two picks -- every trunk passes through the middle, so an
        // even pick is a pick near the hub.
        const want = (i / CITY_SPURS) * Math.PI * 2 + rnd() * 0.5;
        const sector = nodes.filter(
            (p) =>
                Math.abs(angleDiff(Math.atan2(p[1] - s.y, p[0] - s.x), want)) <
                Math.PI / 5,
        );
        const from = sector.length ? sector : nodes;
        const a = from[Math.floor(rnd() * from.length)];
        const b = from[Math.floor(rnd() * from.length)];
        const [x, y] =
            (
                Math.hypot(a[0] - s.x, a[1] - s.y) >
                Math.hypot(b[0] - s.x, b[1] - s.y)
            ) ?
                a
            :   b;
        // A spur is stopped where it starts running alongside something already dug; a
        // trunk never is, because a trunk that stops leaves a plug in its mouth and that
        // edge of the cell has no way out. Six trunks radiating from one hub hardly run
        // alongside anything anyway -- it is the spurs, which set out from a point on
        // something else, that seam.
        const bore = WARREN_BORE * (0.62 + rnd() * 0.28);
        drive(
            dig(
                x,
                y,
                rnd() * Math.PI * 2,
                10 + Math.floor(rnd() * 31),
                rnd,
                null,
                { segs, half: bore / 2 },
            ),
            bore,
        );
    }

    // Clearings, at whichever of those points are furthest from each other: a warren of
    // even bore is a maze, and the places wide enough to put something down are what make
    // it somewhere rather than a way through. Spread rather than scattered, so two of them
    // can be the market and the yard without those ending up side by side.
    // Kept to a band: out of the hub, which is busy enough, and well inside the mouths,
    // because a market standing in a doorway is a market anyone sails past rather than into.
    // Off a trunk, never off a spur: a trunk runs from the hub to a mouth at full bore, so
    // anything standing on one has a way in wide enough to bring a hull down. A spur may be
    // half that and may dead-end, and a market at the end of one is a market nobody can
    // reach -- which is not a thing a player can see to be wrong, only fail at.
    const rooms = [];
    const far = trunkNodes.filter((p) => {
        const d = Math.hypot(p.x - s.x, p.y - s.y);
        const full = cityReach(Math.atan2(p.y - s.y, p.x - s.x));
        return d > CITY_HUB * 1.6 && d < full * 0.62;
    });
    while (rooms.length < CITY_ROOMS && far.length) {
        // The first two are halls, and a hall is wide enough to break the outside of the
        // slab from a point an ordinary clearing sits at quite safely -- which would open a
        // hole in the city's own surface, somewhere nobody dug.
        const room = rooms.length < 2 ? CITY_HALL : CITY_ROOM;
        let best = -1,
            score = -1;
        for (const [i, p] of far.entries()) {
            const dx = p.x - s.x,
                dy = p.y - s.y;
            if (
                Math.hypot(dx, dy) + room >
                cityReach(Math.atan2(dy, dx)) * CITY_STAND
            )
                continue;
            const d =
                rooms.length ?
                    Math.min(
                        ...rooms.map((q) => Math.hypot(p.x - q.x, p.y - q.y)),
                    )
                :   Math.hypot(dx, dy);
            if (d > score) ((score = d), (best = i));
        }
        if (best < 0) break; // nowhere left this one fits
        const p = far.splice(best, 1)[0];
        // The first two are the market and the yard -- furthest apart, so arriving at one
        // does not mean arriving at both. A hall has to hold a station drawn for the town's
        // cavern, so it is bigger and rounder than an ordinary clearing: the art is built
        // off the face and a face that wanders is a station half inside the rock.
        const hall = rooms.length < 2;
        rooms.push({
            x: p.x,
            y: p.y,
            r: hall ? CITY_HALL : CITY_ROOM * (0.7 + rnd() * 0.5),
            w: hall ? 0.06 : 0.22,
        });
    }

    // The rings the clearings are actually cut as, rolled here rather than where the cut is
    // made, so no half-spent random stream has to leave this function -- which is what lets
    // the layout be worked out once and remembered.
    const hub = wobbleRing(s.x, s.y, CITY_HUB, 28, 0.12, rnd);
    for (const r of rooms) r.ring = wobbleRing(r.x, r.y, r.r, 24, r.w, rnd);

    const plan = {
        at: [s.x, s.y],
        ring,
        paths,
        segs,
        hub,
        rooms,
        market: rooms[0],
        yard: rooms[1],
    };
    // Carve here, so that what a station is stood against is the rock as it will actually
    // be: a clearing with a tunnel opening into it has no wall there, and nothing has to be
    // told so.
    plan.rock = carveWarren(
        plan.ring,
        [plan.hub, ...plan.rooms.map((r) => r.ring)],
        plan.paths,
    );
    for (const [r, nm] of [
        [plan.market, 'market'],
        [plan.yard, 'yard'],
    ])
        if (r)
            r.stand = cityStand(
                plan.rock,
                r,
                CITY_SOLE[nm](),
                CITY_SHAPE[nm](),
                rnd,
            );

    return plan;
}

// Cut a warren out of a slab: the walks, plus any clearings already drawn as rings, taken
// out of one outer ring, and what is left standing handed back. Shared, because a warren is
// a warren whether a settlement dug it or the ground came that way.
function carveWarren(outer, holes, paths) {
    const cuts = holes.map((h) => [h]);

    // A run of tunnel is a quad between two points, overrun by half its own width at each
    // end so consecutive runs lap over each other -- otherwise every bend leaves a notch of
    // rock standing in the corner of its own turn.
    const slab = (ax, ay, bx, by, half) => {
        const dx = bx - ax,
            dy = by - ay,
            d = Math.hypot(dx, dy) || 1;
        const ux = (dx / d) * half,
            uy = (dy / d) * half;
        const px = (-dy / d) * half,
            py = (dx / d) * half;
        return [
            [
                [ax - ux + px, ay - uy + py],
                [bx + ux + px, by + uy + py],
                [bx + ux - px, by + uy - py],
                [ax - ux - px, ay - uy - py],
            ],
        ];
    };
    for (const path of paths) {
        const half = path.bore / 2;
        for (let i = 1; i < path.pts.length; i++) {
            const [ax, ay] = path.pts[i - 1],
                [bx, by] = path.pts[i];
            cuts.push(slab(ax, ay, bx, by, half));
        }
    }

    // Snapped to whole units, and rings that collapse to nothing dropped. `polygon-clipping`
    // falls over on a segment whose ends differ in the twelfth decimal -- "unable to find
    // segment in SweepLine tree" -- and a warren is hundreds of overlapping quads, which is
    // exactly the input that produces those. Measured: 4 of 30 cells threw before snapping,
    // and a throw means the whole warren is lost and the cell comes back as solid rock.
    const snap = (rings) =>
        rings
            .map((r) => r.map(([x, y]) => [Math.round(x), Math.round(y)]))
            .map((r) =>
                r.filter(
                    (p, i) =>
                        i === 0 || p[0] !== r[i - 1][0] || p[1] !== r[i - 1][1],
                ),
            )
            .filter((r) => r.length > 2);

    // Cut in batches, each on its own. `polygon-clipping` still falls over on maybe one
    // warren in thirty even snapped, and a single difference of everything at once means
    // that one throw is the whole warren: the cell comes back as a solid slab with no way
    // in. A batch that throws costs the runs of tunnel in it and nothing else.
    let solid = snap([outer]).length ? [snap([outer])] : [[outer]];
    const ready = cuts.map(snap).filter((c) => c.length);
    // 128 a batch. Measured over 30 warrens, median 99ms against 127 at 64 and 234 at 32 --
    // each batch re-walks the whole slab, so small batches pay for that many more times. A
    // batch that throws costs the four or five runs of tunnel that were in it.
    for (let i = 0; i < ready.length; i += 128) {
        try {
            solid = polygonClipping.difference(
                solid,
                ...ready.slice(i, i + 128),
            );
        } catch {
            /* this batch of tunnel is not cut; the rest of the warren still is */
        }
    }
    return solid.map((poly) => poly[0]);
}

function cityMatter() {
    return cityPlan().rock.map((ring) => ({ ring, mat: 'block' }));
}

// ---- the warren biome ----
//
// The same tunnels, without a settlement to dig them: ground that came out this way. A
// biome cell is whatever shape the mesh made it, not an authored hexagon, so there is no
// hub, no station and no count that can be written down -- the cell is filled with rock and
// then bored through in proportion to how much ground it turned out to have.
const WARREN_LAP = 1.04; // how far the slab laps over its own cell, so a neighbour's
// rock merges into it instead of stopping at the seam
const WARREN_OUT = 700; // how far past the border a trunk is cut, so it opens into
// the neighbour rather than leaving a plug in the edge
const WARREN_PER = 3.2; // spurs per square screen of ground...
const WARREN_MOST = 56; // ...and never more than this. Cells run wildly over target --
// a median of 3,672 across against a worst of 16,841 -- and the
// cut is superlinear in how much of it there is, so an honest
// per-area count would make one cell in fifty a multi-second
// stall. A big cell comes out sparser instead: tunnels with
// plates of rock between them, which is what a big one should
// look like anyway.
const WARREN_CLEAR = 0.45; // clearings per square screen, on the same terms
const WARREN_BIG = 4200; // a cell reaching further than this is somebody else's

// Boring is superlinear in how much ground there is: measured, a cell 16,841 across costs
// 481ms against 37ms for a median one, and half a second is a stall the whole server feels.
// Cells run wildly over target and nothing in the mesh can be bent to stop that, so the
// warren declines the ground instead. It is the better world anyway -- a labyrinth five
// screens across is something to cross, not something to be lost in.
// A declaration, not a `const`: `BIOMES` names it, and `BIOMES` is built when the module
// loads, long before this line would have run.
function warrenTakes(s) {
    return cellRadius(s) <= WARREN_BIG;
}

function warrenMatter(s) {
    return warrenFrom(cellOf(s), s).map((ring) => ({ ring, mat: 'rock' }));
}

function warrenFrom(poly, s) {
    const rnd = siteRng(s);
    const about = (k) =>
        poly.map(([x, y]) => [s.x + (x - s.x) * k, s.y + (y - s.y) * k]);
    const outer = about(WARREN_LAP);
    const inner = about(0.84); // where a spur may start and a clearing may open

    let area = 0;
    for (let i = 0; i < poly.length; i++) {
        const [x, y] = poly[i],
            [nx, ny] = poly[(i + 1) % poly.length];
        area += x * ny - nx * y;
    }
    area = Math.abs(area) / 2;
    const per = (k) =>
        Math.min(WARREN_MOST, Math.round((k * area) / (SCREEN * SCREEN)));

    const paths = [],
        nodes = [],
        segs = [];
    const drive = (pts, bore) => {
        paths.push({ pts, bore });
        for (let i = 1; i < pts.length; i++)
            segs.push({
                ax: pts[i - 1][0],
                ay: pts[i - 1][1],
                bx: pts[i][0],
                by: pts[i][1],
                half: bore / 2,
            });
        for (const p of pts)
            if (pointInWall([inner], p[0], p[1])) nodes.push(p);
    };

    // A trunk out through the middle of every edge. Two warrens that share an edge both make
    // for the middle of that edge, from opposite sides, so their tunnels meet there -- the
    // seam is a junction without either cell having to know the other exists, or what biome
    // it turned out to be. Cut past the border for the same reason the city's are: a trunk
    // that stops at the edge leaves a plug standing in its own mouth.
    for (let i = 0; i < poly.length; i++) {
        const [ax, ay] = poly[i],
            [bx, by] = poly[(i + 1) % poly.length];
        const mx = (ax + bx) / 2,
            my = (ay + by) / 2;
        const d = Math.hypot(mx - s.x, my - s.y) || 1;
        const aim = [
            mx + ((mx - s.x) / d) * WARREN_OUT,
            my + ((my - s.y) / d) * WARREN_OUT,
        ];
        drive(
            dig(
                s.x,
                s.y,
                Math.atan2(my - s.y, mx - s.x),
                Math.ceil((d + WARREN_OUT) / WARREN_STEP) * 2 + 8,
                rnd,
                aim,
            ),
            WARREN_BORE * (0.88 + rnd() * 0.12),
        );
    }

    // Spurs, on the same terms as the city's: taken in turn round the compass so they do not
    // clump where the last one went, and stopped where they start running alongside rather
    // than crossing, so a rib of rock stands between any two tunnels.
    const spurs = per(WARREN_PER);
    for (let i = 0; i < spurs && nodes.length; i++) {
        const want = (i / Math.max(1, spurs)) * Math.PI * 2 + rnd() * 0.5;
        const sector = nodes.filter(
            (p) =>
                Math.abs(angleDiff(Math.atan2(p[1] - s.y, p[0] - s.x), want)) <
                Math.PI / 5,
        );
        const from = sector.length ? sector : nodes;
        const a = from[Math.floor(rnd() * from.length)];
        const b = from[Math.floor(rnd() * from.length)];
        const [x, y] =
            (
                Math.hypot(a[0] - s.x, a[1] - s.y) >
                Math.hypot(b[0] - s.x, b[1] - s.y)
            ) ?
                a
            :   b;
        const bore = WARREN_BORE * (0.62 + rnd() * 0.28);
        drive(
            dig(
                x,
                y,
                rnd() * Math.PI * 2,
                10 + Math.floor(rnd() * 31),
                rnd,
                null,
                { segs, half: bore / 2 },
            ),
            bore,
        );
    }

    // Clearings, kept apart from each other but otherwise wherever they land -- there is
    // nothing to stand in them here, so there is nothing to choose them for.
    const holes = [];
    const want = per(WARREN_CLEAR);
    for (let i = 0; i < want * 8 && holes.length < want && nodes.length; i++) {
        const [x, y] = nodes[Math.floor(rnd() * nodes.length)];
        if (holes.some((h) => Math.hypot(x - h.x, y - h.y) < CITY_ROOM * 2.5))
            continue;
        holes.push({
            x,
            y,
            ring: wobbleRing(
                x,
                y,
                CITY_ROOM * (0.7 + rnd() * 0.5),
                24,
                0.22,
                rnd,
            ),
        });
    }

    return carveWarren(
        outer,
        holes.map((h) => h.ring),
        paths,
    );
}

// The same two stations the town has, stood up on a rock face in a clearing instead of on
// the cavern wall. Nothing is redrawn: `yardLines` and `marketLines` are handed a frame and
// have no idea which settlement they are being built in.
// The station's frame sits a little inside the wall that was found for it, the way the
// town's sits a little inside its cavern wall.
const cityFace = (r) => faceFrame(r.stand.ox, r.stand.oy, r.stand.a);

function cityArt() {
    const plan = cityPlan();
    return [
        { key: 'art:yard', lines: yardLines(cityFace(plan.yard)) },
        { key: 'art:market', lines: marketLines(cityFace(plan.market)) },
    ];
}

// The same two things to do that Low Berth offers, and the same two modules behind them:
// a conversation names no mark, so one foreman module serves every yard there will ever be.
// Each stands off its own face by what it does in the town, so the marker is where the
// station is rather than where the clearing happens to be centred.
function cityMarks() {
    const plan = cityPlan();
    const yard = cityFace(plan.yard).inward(0, 280);
    const market = cityFace(plan.market).inward(0, 300);
    return [
        {
            key: 'market',
            kind: 'market',
            who: 'trader',
            talk: ['market', {}],
            x: +market[0].toFixed(1),
            y: +market[1].toFixed(1),
            r: 260,
            icon: [
                'M12 3v18M7 21h10',
                'M12 6l-7 2 7-2 7 2-7-2',
                'M5 8l-3 7a3 3 0 0 0 6 0z',
                'M19 8l-3 7a3 3 0 0 0 6 0z',
            ],
        },
        {
            key: 'yard',
            kind: 'refit',
            who: 'foreman',
            talk: ['yard', {}],
            x: +yard[0].toFixed(1),
            y: +yard[1].toFixed(1),
            r: 260,
            icon: [
                'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94' +
                    'l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
            ],
        },
    ];
}

// What a cell of each kind currently lays out. Bump one and every cell of that kind lays
// itself out again in place, on worlds that already exist: a set piece's claim is permanent
// but its contents are not, and a biome's numbers are the same bargain -- ground already
// explored is rescattered rather than left at whatever the old figures made of it. A kind
// not named here is version 1; add it the day you want to move it. What this takes back is
// everything the cell deposited, which will need an `edited` flag before walls can be blown
// open -- the same debt chunk regeneration already owes.
const SET_VERSION = { town: 9, city: 33, dense: 2 };

// ---- baked set pieces ----
//
// Cutting Still Basin takes six seconds: 180 bearings of pushing a station's floor against
// the rock to find somewhere it sits, twice, and a warren's worth of polygon booleans under
// that. None of it depends on anything a running world knows, so none of it belongs in a
// tick. It is cut once into `setpieces/`, checked in, and shipped -- somebody hosting a
// server stamps the vertices and never pays for the search.
//
// Beside the code and not beside the world: it is part of the program, the same as the
// drawing it was cut from, and every world made by this build wants the same one.
const BAKE_DIR = path.join(__dirname, 'setpieces');
const BAKED = {
    city: {
        file: 'city.json',
        version: () => SET_VERSION.city,
        cut: () => ({
            matter: cityMatter(),
            art: cityArt(),
            marks: cityMarks(),
        }),
    },
};

// Cut what is stale and leave the rest. A set piece whose version has not moved is read
// back as it stands, which is the whole point of having cut it.
function bakeSetPieces({ say = () => {} } = {}) {
    fs.mkdirSync(BAKE_DIR, { recursive: true });
    const out = {};
    for (const [kind, set] of Object.entries(BAKED)) {
        const at = path.join(BAKE_DIR, set.file);
        const want = set.version();
        let have = null;
        try {
            have = JSON.parse(fs.readFileSync(at, 'utf8'));
        } catch {
            have = null; // missing, or written by something that fell over mid-write
        }
        if (have && have.version === want) {
            out[kind] = have;
            continue;
        }
        say(
            have ?
                `${kind}: baked at version ${have.version}, this build wants ${want} -- cutting it again`
            :   `${kind}: nothing baked -- cutting it`,
        );
        const t = Date.now();
        const cut = { version: want, ...set.cut() };
        fs.writeFileSync(at, JSON.stringify(cut));
        say(`${kind}: cut in ${((Date.now() - t) / 1000).toFixed(1)}s`);
        out[kind] = cut;
    }
    return out;
}

// Where the cell landed is an offset and nothing else, which is what makes one cut warren
// serve every world. Keys are made here rather than baked, because a key names the instance
// and the baked piece does not know which one it is about to become.
function stampSetPiece(kind, s) {
    const cut = SET_PIECES[kind];
    const at = siteKey(s);
    return {
        matter: cut.matter.map((m) => ({
            ...m,
            ring: m.ring.map(([x, y]) => [
                +(x + s.x).toFixed(1),
                +(y + s.y).toFixed(1),
            ]),
        })),
        art: cut.art.map((a) => ({
            key: `${at}:${a.key}`,
            lines: a.lines.map((l) =>
                l.map(([x, y]) => [
                    +(x + s.x).toFixed(1),
                    +(y + s.y).toFixed(1),
                ]),
            ),
        })),
        marks: cut.marks.map((m) => ({
            ...m,
            key: `${at}:${m.key}`,
            x: +(m.x + s.x).toFixed(1),
            y: +(m.y + s.y).toFixed(1),
        })),
    };
}

// Cut before serving. In development the drawing changes under you and a stale set piece is
// worse than a slow start; shipped, everything is already at version and this reads a file.
const SET_PIECES = bakeSetPieces({ say: (m) => console.log(`bake: ${m}`) });
if (cmdline.flags.bake) process.exit(0);

const YARD_A = (-Math.PI * 3) / 4; // the yard, up and to the left
const MARKET_A = -Math.PI / 2; // the market, on the north wall

// The yard: staging built out from the rock face with two cranes over it. It is authored
// in a face frame and knows nothing else, which is what lets the same yard stand in the
// town's cavern and in a clearing in the second city's warren -- like stations look alike
// because they are one drawing, not two that resemble each other.
function yardLines({ line }) {
    const lines = [];

    // The staging: a deck off the wall, uprights, and two galleries above it.
    lines.push(line([-300, 0], [300, 0]));
    for (const v of [46, 96, 150]) lines.push(line([-270, v], [270, v]));
    for (const u of [-270, -180, -90, 0, 90, 180, 270])
        lines.push(line([u, 0], [u, 150]));
    // Cross-bracing, alternating, so it reads as built rather than drawn.
    for (let i = 0; i < 6; i++) {
        const a = -270 + i * 90,
            b = a + 90;
        lines.push(i % 2 ? line([a, 0], [b, 46]) : line([b, 0], [a, 46]));
        lines.push(i % 2 ? line([b, 96], [a, 150]) : line([a, 96], [b, 150]));
    }
    // Two cranes leaning out over the cavern, each with a hook on a cable.
    for (const [foot, tip, hook] of [
        [-180, [-320, 330], 250],
        [150, [300, 300], 225],
    ]) {
        lines.push(line([foot, 150], tip)); // jib
        lines.push(line([foot + (tip[0] > foot ? 60 : -60), 150], tip)); // and its stay
        lines.push(line(tip, [tip[0], hook])); // cable
        lines.push(
            line(
                [tip[0] - 14, hook],
                [tip[0] + 14, hook],
                [tip[0], hook - 22],
                [tip[0] - 14, hook],
            ),
        );
    }
    // A hull in the stocks, which is what the yard is for.
    lines.push(
        line(
            [-90, 200],
            [60, 200],
            [96, 224],
            [60, 248],
            [-90, 248],
            [-110, 224],
            [-90, 200],
        ),
    );
    lines.push(line([-60, 200], [-60, 248]), line([10, 200], [10, 248]));
    for (const u of [-70, 40]) lines.push(line([u, 150], [u, 200])); // props down to the deck
    return lines;
}

// The market: a faceted dome on a plinth with a dish beside it, because a place that talks
// to other places is a place that has an antenna.
function marketLines({ line }) {
    const lines = [];
    const R = 190,
        cy = R + 40; // dome centre, out from the wall
    const ring = (r, n, phase = 0) => {
        const pts = [];
        for (let i = 0; i <= n; i++) {
            const a = phase + (i / n) * Math.PI * 2;
            pts.push([Math.cos(a) * r, cy + Math.sin(a) * r]);
        }
        return line(...pts);
    };
    // Three rings of facets, each turned half a step against the last, and struts between
    // them that alternate -- which is what makes it read as triangles rather than a wheel.
    const rs = [R, R * 0.66, R * 0.33];
    rs.forEach((r, k) => lines.push(ring(r, 12, k % 2 ? Math.PI / 12 : 0)));
    for (let k = 0; k < 2; k++) {
        const [r0, r1] = [rs[k], rs[k + 1]];
        const [p0, p1] = [
            k % 2 ? Math.PI / 12 : 0,
            (k + 1) % 2 ? Math.PI / 12 : 0,
        ];
        for (let i = 0; i < 12; i++) {
            const a0 = p0 + (i / 12) * Math.PI * 2,
                a1 = p1 + (i / 12) * Math.PI * 2;
            lines.push(
                line(
                    [Math.cos(a0) * r0, cy + Math.sin(a0) * r0],
                    [Math.cos(a1) * r1, cy + Math.sin(a1) * r1],
                ),
            );
            lines.push(
                line(
                    [Math.cos(a1) * r1, cy + Math.sin(a1) * r1],
                    [
                        Math.cos(a0 + Math.PI / 6) * r0,
                        cy + Math.sin(a0 + Math.PI / 6) * r0,
                    ],
                ),
            );
        }
    }
    // The plinth it stands on, and legs down to the rock.
    lines.push(line([-250, 0], [250, 0]));
    lines.push(line([-215, 34], [215, 34]));
    for (const u of [-215, -120, 0, 120, 215])
        lines.push(line([u, 0], [u, 34]));
    for (const u of [-150, -60, 60, 150])
        lines.push(line([u, 34], [u * 0.55, cy - R + 10]));
    // The dish: a mast, a bowl on it, and a feed on arms at the focus.
    const mx = 300,
        my = 60;
    lines.push(line([mx, 0], [mx, my]));
    lines.push(line([mx - 26, 0], [mx, 30]), line([mx + 26, 0], [mx, 30]));
    const bowl = [];
    for (let i = 0; i <= 14; i++) {
        const a = -Math.PI * 0.86 + (i / 14) * Math.PI * 1.12;
        bowl.push([mx + Math.cos(a) * 78, my + 78 + Math.sin(a) * 78]);
    }
    lines.push(line(...bowl));
    lines.push(line(bowl[0], bowl[bowl.length - 1]));
    const focus = [
        mx + Math.cos(-Math.PI * 0.3) * 40,
        my + 78 + Math.sin(-Math.PI * 0.3) * 40,
    ];
    lines.push(line(bowl[2], focus), line(bowl[bowl.length - 3], focus));
    lines.push(
        line(
            [focus[0] - 9, focus[1] - 9],
            [focus[0] + 9, focus[1] - 9],
            [focus[0] + 9, focus[1] + 9],
            [focus[0] - 9, focus[1] + 9],
            [focus[0] - 9, focus[1] - 9],
        ),
    );
    return lines;
}

function townArt() {
    return [
        { key: 'town:yard', lines: yardLines(wallFrame(YARD_A)) },
        { key: 'town:market', lines: marketLines(wallFrame(MARKET_A)) },
    ];
}

// Somewhere you can do something. A marker is a point, a reach, and an icon it carries
// itself -- the client is told what to draw rather than looking it up, the same bargain as
// the art, so a new set piece can offer a new thing to do without the client learning
// about it first. What the interaction *is* stays on the server.

// What the town knows about itself, shared by the foreman and whoever is minding the stall.
// Declared here rather than written by whoever speaks first, because it is true of the place
// before anybody has walked up to it.
// Only keys the place does not already have are filled in, so a later version of the town
// can add a fact without unlearning what has happened here -- and so a town that has
// already been named keeps the name it has.
const townPlace = (rng) => ({ name: placeName(rng), lanesOpen: false });

function townMarks() {
    const yard = wallFrame(YARD_A).inward(0, 280);
    const market = wallFrame(MARKET_A).inward(0, 300);
    return [
        {
            key: 'town:yard',
            kind: 'refit',
            // A mark with a conversation on it opens with the conversation; the kind is
            // still what it hands over to, so `open` on this same mark is the way through
            // to the sheet.
            who: 'foreman',
            talk: ['yard', {}],
            x: +yard[0].toFixed(1),
            y: +yard[1].toFixed(1),
            r: 260,
            // A spanner, drawn on the same 24-unit grid the module marks use.
            icon: [
                'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94' +
                    'l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
            ],
        },
        {
            key: 'town:market',
            kind: 'market',
            who: 'trader',
            talk: ['market', {}],
            x: +market[0].toFixed(1),
            y: +market[1].toFixed(1),
            r: 260,
            // Scales.
            icon: [
                'M12 3v18M7 21h10',
                'M12 6l-7 2 7-2 7 2-7-2',
                'M5 8l-3 7a3 3 0 0 0 6 0z',
                'M19 8l-3 7a3 3 0 0 0 6 0z',
            ],
        },
    ];
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
// How far the cell reaches in a direction. The town's cell is the authored hexagon, whose
// edge normals are at 30, 90, 150 ... so the support distance is the apothem over the
// cosine to the nearest of them -- no polygon needed.
function townReach(a) {
    let best = Infinity;
    for (let k = 0; k < 6; k++) {
        const c = Math.cos(angleDiff(a, Math.PI / 6 + (k * Math.PI) / 3));
        if (c > 0.01) best = Math.min(best, (TOWN_SIDE * APOTHEM) / c);
    }
    return best;
}

function townMatter() {
    const rnd = siteRng({ x: 0, y: 0 });
    const ux = Math.cos(TOWN_OUT),
        uy = Math.sin(TOWN_OUT);
    // The rock laps over its own cell everywhere except a wedge around the tunnel, where it
    // stands well back. Overhang is how matter merges across a seam, so the town reads as
    // part of the rock around it rather than an island in a clearing -- but a blob landing
    // across the mouth would seal the starting town for good, so the doorway keeps its moat.
    const ring = [];
    for (let k = 0; k < 40; k++) {
        const a = (k / 40) * Math.PI * 2;
        const off = Math.abs(angleDiff(a, TOWN_OUT));
        const t = Math.min(1, Math.max(0, (off - TOWN_DOOR) / TOWN_DOOR));
        // The wobble fades out with the standoff, so the face around the doorway is flat and
        // exactly TOWN_STAND out. The settlement's guns are set into that face at a known
        // depth, and a wobbling surface would have them sticking out of it or buried too deep
        // to reach anything.
        const r =
            (TOWN_STAND + (townReach(a) * TOWN_LAP - TOWN_STAND) * t) *
            (1 + (rnd() - 0.5) * 0.16 * t);
        ring.push([Math.cos(a) * r, Math.sin(a) * r]);
    }
    const rock = [ring];
    const cave = [
        wobbleRing(-ux * TOWN_SHIFT, -uy * TOWN_SHIFT, TOWN_CAVE, 36, 0.1, rnd),
    ];
    const L = 5000,
        w = TOWN_TUNNEL / 2,
        px = -uy,
        py = ux;
    const tunnel = [
        [
            [px * w, py * w],
            [ux * L + px * w, uy * L + py * w],
            [ux * L - px * w, uy * L - py * w],
            [-px * w, -py * w],
        ],
    ];
    let solid;
    try {
        solid = polygonClipping.difference(rock, cave, tunnel);
    } catch {
        solid = [rock];
    } // degenerate input: better a solid rock than none
    return solid.map((poly) => ({ ring: poly[0], mat: 'block' }));
}

// The town is placed once, when the world is new, and holds the origin. Its six
// neighbours are the reflections of its site across its own edges, which is what makes
// its cell come out hexagonal; they are ordinary sites otherwise, and get biomes when
// somebody comes near them.
function seedTown() {
    if (sites.length) return;
    const home = addSite(0, 0);
    home.kind = 'town'; // loaded from the first instant, so nothing may crowd it
    // The six reflections that make the cell a hexagon are also the town's neighbours. Only
    // the one the tunnel points at is decreed, and only because of the tunnel: a dense
    // biome's blobs reach nearly 400 units past their own cell, further than the asteroid
    // stands back from the border, and one landing across the mouth would seal the starting
    // town for everybody, for good. An open biome's reach about 175, which the standoff
    // clears. The other five are ordinary ground and get whatever they get -- a settlement
    // with dense rock at its back is a better place than one in a clearing.
    const reach = 2 * TOWN_SIDE * APOTHEM;
    let door = 0,
        near = Infinity;
    for (let k = 0; k < 6; k++) {
        const off = Math.abs(
            angleDiff(Math.PI / 6 + (k * Math.PI) / 3, TOWN_OUT),
        );
        if (off < near) {
            near = off;
            door = k;
        }
    }
    for (let k = 0; k < 6; k++) {
        const a = Math.PI / 6 + (k * Math.PI) / 3;
        addSite(
            Math.cos(a) * reach,
            Math.sin(a) * reach,
            k === door ? 'open' : null,
        );
    }
    meshDirty = true;
}

// The second city, founded once and then simply there. Thirty-five screens out at a
// bearing nobody chose, which is far enough that finding it is a voyage and near enough
// that it is the obvious one to make. Idempotent: a world that already has a city keeps the
// one it has, wherever that turned out to be.
function seedCity() {
    if (sites.some((q) => q.kind === 'city')) return;
    const a = Math.random() * Math.PI * 2;
    const cx = Math.cos(a) * CITY_AWAY,
        cy = Math.sin(a) * CITY_AWAY;
    addSite(cx, cy).kind = 'city';
    // Its six neighbours are the reflections of its site across its own edges, which is
    // what makes the cell come out as the hexagon it claims. Ordinary ground otherwise.
    const reach = 2 * CITY_SIDE * APOTHEM;
    for (let k = 0; k < 6; k++) {
        const b = Math.PI / 6 + (k * Math.PI) / 3;
        addSite(cx + Math.cos(b) * reach, cy + Math.sin(b) * reach);
    }
    meshDirty = true;
}

let sites = [];
let meshVersion = 0; // bumped whenever a site is added, to drop cached cells
let meshDirty = false;

const siteFile = () => path.join(WORLD_DIR, 'sites.json');

function loadSites() {
    try {
        const d = JSON.parse(fs.readFileSync(siteFile(), 'utf8'));
        if (Array.isArray(d.sites)) sites = d.sites;
    } catch {
        /* no mesh yet: the first demand seeds one */
    }
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
    } catch {
        /* unwritable store: the world runs, it just will not survive a restart */
    }
}

// `want` is a biome the site will take when it loads, rather than one it has: a set piece
// says what it wants around it, but the cell still has to be bound and loaded like any
// other. Assigning `kind` up front would mark an unbounded cell as loaded, and the
// admissibility test would then read its phantom corners as ground worth protecting and
// refuse every site near it -- sterilising the whole neighbourhood for good.
function addSite(x, y, want = null) {
    const s = { x: +x.toFixed(1), y: +y.toFixed(1), kind: null, want };
    sites.push(s);
    meshVersion++;
    meshDirty = true;
    return s;
}

function nearestSite(x, y) {
    let best = null,
        bd = Infinity;
    for (const s of sites) {
        const d = (s.x - x) ** 2 + (s.y - y) ** 2;
        if (d < bd) {
            bd = d;
            best = s;
        }
    }
    return best;
}

// Sutherland-Hodgman against the bisector of p and q, keeping the side nearer p.
function clipToBisector(poly, p, q) {
    const mx = (p.x + q.x) / 2,
        my = (p.y + q.y) / 2,
        dx = q.x - p.x,
        dy = q.y - p.y;
    const side = (v) => dx * (v[0] - mx) + dy * (v[1] - my); // <= 0 is nearer p
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i],
            b = poly[(i + 1) % poly.length];
        const sa = side(a),
            sb = side(b);
        if (sa <= 0) out.push(a);
        if (sa > 0 !== sb > 0) {
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
    let poly = [
        [s.x - CELL_FAR, s.y - CELL_FAR],
        [s.x + CELL_FAR, s.y - CELL_FAR],
        [s.x + CELL_FAR, s.y + CELL_FAR],
        [s.x - CELL_FAR, s.y + CELL_FAR],
    ];
    for (const q of sites) {
        if (
            q === s ||
            Math.abs(q.x - s.x) > CELL_FAR * 2 ||
            Math.abs(q.y - s.y) > CELL_FAR * 2
        )
            continue;
        poly = clipToBisector(poly, s, q);
        if (poly.length < 3) break;
    }
    cellCache.set(s, { v: meshVersion, poly });
    return poly;
}

const cellBounded = (s) =>
    cellOf(s).every(
        (v) =>
            Math.abs(v[0] - s.x) < CELL_FAR - 1 &&
            Math.abs(v[1] - s.y) < CELL_FAR - 1,
    );

// How far a cell reaches from its own site. Cached with the cell, and the only safe basis
// for deciding a distant site cannot possibly affect it.
function cellRadius(s) {
    let r = 0;
    for (const v of cellOf(s))
        r = Math.max(r, Math.hypot(v[0] - s.x, v[1] - s.y));
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
        if (!s.kind) continue; // only a loaded cell is protected
        if (Math.hypot(s.x - x, s.y - y) >= 2 * cellRadius(s)) continue;
        for (const v of cellOf(s)) {
            const keep = (v[0] - s.x) ** 2 + (v[1] - s.y) ** 2;
            if ((v[0] - x) ** 2 + (v[1] - y) ** 2 < keep - 1) return false;
        }
    }
    return true;
}

// Bind a cell by going at whichever corner reaches further than a cell ought to, over and
// over. Closing and subdividing are the same move: a corner still out on the far clipping
// box means nothing bounds the cell that way, a corner at 9,000 means the cell is merely
// too big, and either way the answer is a site between here and there. A placement at
// CELL_R cuts that direction to about half, so every accepted site is real progress.
//
// No cell has to be any particular size. This is about what they average: too big and we
// subdivide, too small is fine and left alone. So this stops when there is nothing further
// it is *allowed* to do, not when the cell is a particular shape -- some corners cannot be
// cut at all. The town's six neighbours each have one sitting on a vertex of the town's
// authored hexagon, 3,672 from their own site: cutting it would take ground from a cell
// already loaded, so it stands, and holding out for a tidier cell than that means the ring
// around the town never loads and a new player looks out at nothing.
function bindCell(s) {
    for (let pass = 0; pass < 60; pass++) {
        const over = cellOf(s)
            .map((q) => ({ q, d: Math.hypot(q[0] - s.x, q[1] - s.y) }))
            .filter((c) => c.d > CELL_MAX)
            .sort((a, b) => b.d - a.d);
        if (!over.length) return true;
        // Worst corner first, but every one of them is tried: being unable to cut the worst
        // says nothing about the rest.
        for (const c of over) {
            const a =
                Math.atan2(c.q[1] - s.y, c.q[0] - s.x) + rand(-0.35, 0.35);
            // Never past the corner being cut: for a cell that is merely too big the site belongs
            // inside it, where the only ground it takes is that cell's own.
            const d = Math.min(
                c.d * 0.9,
                CELL_R * (1 + rand(-CELL_JITTER, CELL_JITTER)),
            );
            const x = s.x + Math.cos(a) * d,
                y = s.y + Math.sin(a) * d;
            // Crowding is relaxed as the attempts wear on: a cell that will not close is worse
            // than a mesh with one short edge in it.
            const room = CELL_R * (0.5 - (0.4 * pass) / 60);
            const near = nearestSite(x, y);
            if (near && Math.hypot(near.x - x, near.y - y) < room) continue;
            if (!admissible(x, y)) continue;
            addSite(x, y);
            break;
        }
    }
    return true;
}

// Give it a shape, then give it a kind. The kind is chosen from whatever the registry
// holds at this moment, which is the whole of the evolving-world requirement.
//
// An unbounded cell must never be loaded. Its outline runs to the far box, so the
// admissibility test would then read those phantom corners as ground worth protecting and
// refuse every site placed anywhere near it -- one cell loaded early and open would
// sterilise its whole neighbourhood, and nothing could ever close it again.
function loadCell(s) {
    // Add sites until it is bounded, subdividing it as far as we are allowed to, and then
    // load whatever that came out as. Size is something we steer, not something a cell has
    // to satisfy. Being finite is the one hard requirement: an unbounded cell's outline runs
    // to the far box, and loading it would have the admissibility test read those phantom
    // corners as ground worth protecting.
    bindCell(s);
    if (!cellBounded(s)) return null;
    s.kind = s.want || rollBiome(s);
    meshDirty = true;
    return s;
}

// Which cell owns this point, loading whatever is needed to answer. Growing the mesh can
// put a new site nearer than the one just loaded, so this walks outward until the nearest
// site is a loaded one.
function siteFor(x, y) {
    for (let i = 0; i < 16; i++) {
        let s = nearestSite(x, y);
        if (!s)
            s = addSite(
                x + rand(-CELL_R / 3, CELL_R / 3),
                y + rand(-CELL_R / 3, CELL_R / 3),
            );
        if (s.kind) return s;
        if (!loadCell(s)) break; // could not close it: leave it potential
    }
    const s = nearestSite(x, y);
    return s && s.kind ? s : { kind: 'open' }; // rather than stall terrain over a stubborn cell
}

loadSites();
seedTown();
seedCity();
// The settlement's guns, set into the rock either side of the tunnel. Ships live only in
// memory, so these go up on every boot rather than being part of what the cell generated
// once: the set piece's furniture, not its matter.
function seedBastions() {
    const ux = Math.cos(TOWN_OUT),
        uy = Math.sin(TOWN_OUT),
        px = -uy,
        py = ux;
    const d = TOWN_STAND - 180; // set into the flat face beside the mouth
    const off = TOWN_TUNNEL / 2 + 130; // and clear of the corridor either side
    for (const sgn of [1, -1])
        newShip(
            null,
            PLAYER_TEAM,
            {
                x: ux * d + px * off * sgn,
                y: uy * d + py * off * sgn,
                a: TOWN_OUT,
            },
            BASTION,
        );
}
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
const UNIT_MAX = CHUNK; // widest a unit may be, which is what makes touching
// units always neighbours and never further apart

function siteRng(s) {
    let v =
        (WORLD_SEED ^
            Math.imul(Math.round(s.x), 73856093) ^
            Math.imul(Math.round(s.y), 19349663)) >>>
        0;
    return () => {
        v = (Math.imul(v, 1664525) + 1013904223) >>> 0;
        return v / 4294967296;
    };
}

// Cut a generator's polygon down to units. Anything already small enough is left exactly
// as it is; anything larger is sliced on a fixed grid, so a town's curtain wall arrives as
// six slabs thousands of units long and leaves as a row of pieces that abut precisely.
// Holes are dropped: no generator makes one, and a lump of matter with a hole in it is
// something destruction produces rather than something anybody lays down.
function toUnits(ring, mat) {
    let minx = Infinity,
        miny = Infinity,
        maxx = -Infinity,
        maxy = -Infinity;
    for (const [x, y] of ring) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
    }
    const round = (r) => r.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]);
    if (maxx - minx <= UNIT_MAX && maxy - miny <= UNIT_MAX)
        return [{ ring: round(ring), mat }];
    const out = [];
    for (
        let gx = Math.floor(minx / UNIT_MAX);
        gx <= Math.floor(maxx / UNIT_MAX);
        gx++
    )
        for (
            let gy = Math.floor(miny / UNIT_MAX);
            gy <= Math.floor(maxy / UNIT_MAX);
            gy++
        ) {
            const x0 = gx * UNIT_MAX,
                y0 = gy * UNIT_MAX,
                x1 = x0 + UNIT_MAX,
                y1 = y0 + UNIT_MAX;
            let bits;
            try {
                bits = polygonClipping.intersection(
                    [ring],
                    [
                        [
                            [x0, y0],
                            [x1, y0],
                            [x1, y1],
                            [x0, y1],
                        ],
                    ],
                );
            } catch {
                continue;
            }
            for (const poly of bits)
                if (poly[0] && poly[0].length >= 3)
                    out.push({ ring: round(poly[0]), mat });
        }
    return out;
}

// A generator is handed a cell and returns matter anywhere inside it. It never sees a
// chunk or a unit, which is the point: a set piece draws its walls, a biome scatters its
// rock, and neither has to know how the world files things.
function generateCell(s) {
    if (s.kind === 'city')
        return {
            ...stampSetPiece('city', s),
            // Not baked: the warren is the same place everywhere, but what it is called is
            // this world's to decide, the same as the town's is.
            place: { name: placeName(siteRng(s)) },
        };
    if (s.kind === 'town')
        return {
            matter: townMatter(),
            art: townArt(),
            marks: townMarks(),
            // What this town starts out knowing, shared by everybody it puts in the world.
            place: townPlace(siteRng(s)),
        };
    const b = BIOMES[s.kind] || BIOMES.open;
    if (b.make) return { matter: b.make(s), art: [], marks: [] };
    if (!b.density) return { matter: [], art: [], marks: [] };
    const poly = cellOf(s);
    const rnd = siteRng(s);
    let minx = Infinity,
        miny = Infinity,
        maxx = -Infinity,
        maxy = -Infinity,
        area = 0;
    for (let i = 0; i < poly.length; i++) {
        const [x, y] = poly[i],
            [nx, ny] = poly[(i + 1) % poly.length];
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
        area += x * ny - nx * y;
    }
    area = Math.abs(area) / 2;
    // Density is per chunk-sized patch of ground, which is how it was tuned; a cell simply
    // has however many of those it happens to cover.
    const n = Math.round((b.density * MAX_BLOBS * area) / (CHUNK * CHUNK));
    const out = [];
    for (let i = 0; i < n; i++) {
        let ox = 0,
            oy = 0,
            tries = 0;
        do {
            ox = minx + rnd() * (maxx - minx);
            oy = miny + rnd() * (maxy - miny);
        } while (!pointInWall([poly], ox, oy) && ++tries < 24);
        if (tries >= 24) continue;
        // Blobs near the rim hang over into the neighbouring cell on purpose: that overlap is
        // what makes rock read as one field across a cell seam once the neighbour generates.
        const base = b.base + rnd() * b.spread,
            sides = 6 + Math.floor(rnd() * 5);
        const ring = [];
        for (let k = 0; k < sides; k++) {
            const a = (k / sides) * Math.PI * 2 + rnd() * 0.25;
            const r = base * (0.6 + rnd() * 0.65);
            ring.push([ox + Math.cos(a) * r, oy + Math.sin(a) * r]);
        }
        out.push({ ring, mat: 'rock' });
    }
    return { matter: out, art: [], marks: [] };
}

// Run a cell's generator and file what comes out. Each unit goes to the chunk holding its
// centre, and that chunk is written straight back: the deposit is the only record of it,
// so it has to survive the chunk being dropped a moment later.
// A site never moves once placed, so where it is names it.
const siteKey = (s) => `${s.x},${s.y}`;

// Take back everything this cell put down, so a set piece can be laid out again without
// its old walls standing next to its new ones. Everything deposited carries the cell it
// came from, which is the only way to tell one cell's rock from a neighbour's after both
// have overhung the same chunk.
function clearCell(s) {
    const src = siteKey(s);
    const poly = cellOf(s);
    let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
    for (const [x, y] of poly) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
    }
    const pad = UNIT_MAX; // matter is allowed to hang over the rim
    for (let cx = chunkOf(x0 - pad); cx <= chunkOf(x1 + pad); cx++)
        for (let cy = chunkOf(y0 - pad); cy <= chunkOf(y1 + pad); cy++) {
            const c = loadChunk(cx, cy);
            const had = c.units.length + c.art.length + c.marks.length;
            // Anything this cell put down, and anything inside its claim that predates cells
            // saying where their content came from. Without the second clause a set piece laid
            // out on a world older than that stands next to its own previous self forever.
            const ours = (o, x, y) =>
                o.src === src || (!o.src && pointInWall([poly], x, y));
            c.units = c.units.filter((u) => {
                const b = unitBox(u);
                return !ours(u, b.cx, b.cy);
            });
            c.art = c.art.filter(
                (a) => !ours(a, a.lines[0][0][0], a.lines[0][0][1]),
            );
            c.marks = c.marks.filter((m) => !ours(m, m.x, m.y));
            if (c.units.length + c.art.length + c.marks.length !== had)
                saveChunk(c);
        }
    wallsDirty = true;
}

function depositCell(s) {
    const touched = new Set();
    const src = siteKey(s);
    if (s.gen) clearCell(s); // laying it out again, not for the first time
    const made = generateCell(s);
    // Art is filed by where it starts and never split: a set piece draws pieces small enough
    // to belong somewhere, the way it emits walls small enough to belong to a chunk.
    for (const piece of made.art || []) {
        const [x, y] = piece.lines[0][0];
        const c = loadChunk(chunkOf(x), chunkOf(y));
        c.art.push({ ...piece, src });
        touched.add(c);
    }
    for (const mark of made.marks || []) {
        const c = loadChunk(chunkOf(mark.x), chunkOf(mark.y));
        c.marks.push({ ...mark, src });
        touched.add(c);
    }
    for (const m of made.matter)
        for (const u of toUnits(m.ring, m.mat)) {
            let sx = 0,
                sy = 0;
            for (const [x, y] of u.ring) {
                sx += x;
                sy += y;
            }
            const c = loadChunk(
                chunkOf(sx / u.ring.length),
                chunkOf(sy / u.ring.length),
            );
            c.units.push({ ...u, src });
            touched.add(c);
        }
    for (const c of touched) saveChunk(c);
    // What the set piece declares its place starts out knowing. Only keys it does not
    // already have are filled in: laying a cell out again for a new version replaces what
    // is standing there, but it must not unlearn what has happened there since. Held to the
    // same rules as anything a conversation writes -- a generator is author code too, and a
    // declaration nobody checked is the one that puts a paragraph in the mesh.
    if (made.place) {
        const was = s.bag ?? {};
        const bag = { ...was };
        for (const [k, v] of Object.entries(made.place))
            if (!(k in bag)) bag[k] = v;
        if (bagOk(`set piece ${src}`, bag, PLACE_KEYS)) s.bag = bag;
    }
    s.gen = SET_VERSION[s.kind] || 1;
    meshDirty = true;
    wallsDirty = true;
}

function saveChunk(c) {
    try {
        fs.mkdirSync(WORLD_DIR, { recursive: true });
        fs.writeFileSync(
            path.join(WORLD_DIR, `${c.cx}_${c.cy}.json`),
            JSON.stringify({
                v: WALL_FORMAT,
                cx: c.cx,
                cy: c.cy,
                units: c.units,
                ...(c.art.length ? { art: c.art } : {}),
                ...(c.marks.length ? { marks: c.marks } : {}),
            }),
        );
    } catch {
        /* unwritable store: the world runs, it just will not survive a restart */
    }
}

function loadChunk(cx, cy) {
    const key = chunkKey(cx, cy);
    const had = chunks.get(key);
    if (had) return had;
    let units = [],
        art = [],
        marks = [];
    try {
        const saved = JSON.parse(
            fs.readFileSync(path.join(WORLD_DIR, `${cx}_${cy}.json`), 'utf8'),
        );
        if (saved.v >= WALL_OLDEST && saved.v <= WALL_FORMAT) {
            if (Array.isArray(saved.units)) units = saved.units;
            if (Array.isArray(saved.art)) art = saved.art;
            if (Array.isArray(saved.marks)) marks = saved.marks;
        }
    } catch {
        /* nothing filed here, which is the normal case for open space */
    }
    const c = { cx, cy, key, units, art, marks };
    chunks.set(key, c);
    wallsDirty = true;
    // Deferred: placing a ship needs blockedAt, which loads neighbouring chunks, which would
    // land back in here. The queue is drained once loading has settled.
    // Ground nobody has seen before. What it is worth is decided in the tick rather than
    // here: terrain generation is re-entrant, and what an encounter wants is declared in
    // `SCRIPTS`, which this file has not reached the first time a chunk is loaded.
    freshChunks.push([cx, cy]);
    return c;
}

// ---- walls, which are a view of the units and nothing more ----
let wallsDirty = true;
let wallsByKey = new Map(); // stable key -> { key, rings, js, x0, y0, x1, y1 }
let wallBins = new Map(); // chunk key -> the walls whose box touches that chunk
let mergedCache = new Map(); // which units were merged -> what they merged into
// ...and which merged shape was cut by which, for the truncation pass. A second cache
// rather than a wider key on the first: a cutter is a relationship between two components
// of different material, which is exactly what the union-find refuses to join, and folding
// it into a component's own identity would make a clump of rock depend on the block beside it.
let cutCache = new Map();
// What the last merge had to get through, and how much of it the cache did not cover.
// A rebuild that misses is paying polygon-clipping again, which is the dear half.
let mergeUnits = 0,
    mergeComps = 0,
    mergeMisses = 0,
    mergeCuts = 0, // differences actually run in the truncation pass
    mergeCutters = 0; // ...and how many cutting walls they were handed
let artByKey = new Map(); // set-piece scenery, keyed the way walls are
let artBins = new Map(); // chunk key -> the art whose box touches that chunk
let marks = new Map(); // key -> an interaction offered somewhere in the world

// Matter of different kinds never merges, so where two kinds meet something has to give or
// their outlines cross in mid-air. They are ranked instead, and the higher one keeps the
// ground: the lower is truncated at the boundary, so the two abut exactly and neither is
// drawn inside the other. Blocking rock is the town's, and the biome's ordinary rock stops
// where it starts.
const MAT_RANK = { rock: 1, block: 2 };

// A unit's bounds, worked out once. Kept beside the unit rather than on it, because a
// unit is written back to disk verbatim and a cached fact about it is not world state.
const unitBoxes = new WeakMap();
function unitBox(u) {
    const hit = unitBoxes.get(u);
    if (hit) return hit;
    let minx = Infinity,
        miny = Infinity,
        maxx = -Infinity,
        maxy = -Infinity,
        sx = 0,
        sy = 0;
    for (const [x, y] of u.ring) {
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (y < miny) miny = y;
        if (y > maxy) maxy = y;
        sx += x;
        sy += y;
    }
    const cx = sx / u.ring.length,
        cy = sy / u.ring.length;
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
    // Scenery is rebuilt in the same pass, though there is nothing to merge: it is keyed and
    // binned exactly as walls are, so it arrives and leaves by the same machinery.
    artByKey = new Map();
    artBins = new Map();
    marks = new Map();
    timed('merge:art', () => {
        for (const c of chunks.values())
            for (const m of c.marks || []) marks.set(m.key, m);
        for (const c of chunks.values())
            for (const piece of c.art || []) {
                let x0 = Infinity,
                    y0 = Infinity,
                    x1 = -Infinity,
                    y1 = -Infinity;
                for (const l of piece.lines)
                    for (const [x, y] of l) {
                        if (x < x0) x0 = x;
                        if (x > x1) x1 = x;
                        if (y < y0) y0 = y;
                        if (y > y1) y1 = y;
                    }
                const a = {
                    key: piece.key,
                    lines: piece.lines,
                    x0,
                    y0,
                    x1,
                    y1,
                };
                artByKey.set(a.key, a);
                for (let ax = chunkOf(x0); ax <= chunkOf(x1); ax++)
                    for (let ay = chunkOf(y0); ay <= chunkOf(y1); ay++) {
                        const k = chunkKey(ax, ay);
                        if (!artBins.has(k)) artBins.set(k, []);
                        artBins.get(k).push(a);
                    }
            }
    });
    const ent = [];
    const byChunk = new Map();
    for (const c of chunks.values()) {
        const list = [];
        c.units.forEach((u, i) => {
            const e = { u, key: `${c.key}:${i}`, i: ent.length };
            ent.push(e);
            list.push(e);
        });
        byChunk.set(c.key, list);
    }
    const parent = ent.map((_, i) => i);
    const find = (i) => {
        while (parent[i] !== i) {
            parent[i] = parent[parent[i]];
            i = parent[i];
        }
        return i;
    };
    timed('merge:comp', () => {
        for (const c of chunks.values())
            for (const e of byChunk.get(c.key)) {
                const a = unitBox(e.u);
                for (let dx = -1; dx <= 1; dx++)
                    for (let dy = -1; dy <= 1; dy++)
                        for (const f of byChunk.get(
                            chunkKey(c.cx + dx, c.cy + dy),
                        ) || []) {
                            if (f.i <= e.i) continue;
                            // Matter of different kinds never merges into one shape: a vein is not the rock
                            // around it, however tightly it sits in it.
                            if (f.u.mat !== e.u.mat) continue;
                            const b = unitBox(f.u);
                            if (
                                Math.hypot(a.cx - b.cx, a.cy - b.cy) <=
                                a.r + b.r
                            )
                                parent[find(e.i)] = find(f.i);
                        }
            }
    });
    const groups = new Map();
    for (const e of ent) {
        const k = find(e.i);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e);
    }
    const prev = wallsByKey,
        prevMerged = mergedCache,
        prevCut = cutCache;
    wallsByKey = new Map();
    wallBins = new Map();
    mergedCache = new Map();
    cutCache = new Map();
    const built = [];
    for (const comp of groups.values()) {
        // Working out the components again is linear and cheap; the booleans are not. A
        // component whose membership has not changed merged to the same thing it did last
        // time, and most of them have not: a chunk loading at the rim of the area of interest
        // says nothing about rock three screens the other way. Without this the whole area
        // was re-merged on every chunk load -- 85ms, against a 33ms tick.
        const sig = timed('merge:sig', () =>
            comp
                .map((e) => e.key)
                .sort()
                .join('|'),
        );
        let merged = prevMerged.get(sig);
        if (!merged) {
            mergeMisses++;
            merged = timed('merge:union', () => {
                try {
                    return polygonClipping.union(
                        ...comp.map((e) => [e.u.ring]),
                    );
                } catch {
                    return comp.map((e) => [e.u.ring]);
                } // degenerate input: leave it unmerged
            });
        }
        mergedCache.set(sig, merged);
        let base = comp[0].key;
        for (const e of comp) if (e.key < base) base = e.key;
        let x0 = Infinity,
            y0 = Infinity,
            x1 = -Infinity,
            y1 = -Infinity;
        for (const poly of merged)
            for (const [x, y] of poly[0]) {
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        built.push({ base, sig, mat: comp[0].u.mat, merged, x0, y0, x1, y1 });
    }

    // Take the higher-ranked matter out of the lower wherever the two overlap. Only pairs
    // whose boxes meet are considered.
    //
    // Cached exactly as the union is, and for the same reason: the shapes going in decide
    // the shape coming out, and a rebuild triggered by a chunk loading three screens away
    // changes neither. Uncached it was the whole of the cost of merging -- measured on a
    // live server, 38 differences a rebuild with one cutter each, every one of them working
    // out an answer it already had, 4.9s of the 5.4s spent merging and a tick past the dt
    // clamp every 4.4 seconds. What that looks like on a phone is ships rewinding.
    timed('merge:cut', () => {
        // Only matter that outranks something else can cut, and there is very little of it:
        // two settlements' worth of `block` against a whole area of interest of `rock`.
        // Gathering it once makes the pass every wall against a handful rather than every
        // wall against every wall -- which, measured at 1,153 walls, was 17ms a rebuild
        // spent finding nothing, and grows with the square of how far anyone has flown.
        // Reduced rather than spread: `built` is one entry a component, which is unbounded.
        const lowest = built.reduce(
            (m, b) => Math.min(m, MAT_RANK[b.mat]),
            Infinity,
        );
        const sharp = built.filter((b) => MAT_RANK[b.mat] > lowest);
        for (const b of built) {
            const cutters = sharp.filter(
                (h) =>
                    MAT_RANK[h.mat] > MAT_RANK[b.mat] &&
                    h.x0 <= b.x1 &&
                    b.x0 <= h.x1 &&
                    h.y0 <= b.y1 &&
                    b.y0 <= h.y1,
            );
            if (!cutters.length) continue;
            // Which shape, cut by which -- the cutters sorted, since the box filter says
            // nothing about the order they come back in.
            const key = `${b.sig}>${cutters
                .map((c) => c.sig)
                .sort()
                .join('|')}`;
            let cut = prevCut.get(key);
            if (!cut) {
                mergeCuts++;
                mergeCutters += cutters.length;
                try {
                    cut = polygonClipping.difference(
                        b.merged,
                        ...cutters.map((c) => c.merged),
                    );
                } catch {
                    // Degenerate input: leave the overlap rather than lose the wall. Cached
                    // like any other answer, so a pair that throws does not throw every
                    // rebuild for as long as both shapes stand.
                    cut = b.merged;
                }
            }
            cutCache.set(key, cut);
            // The union cache keeps the uncut shape under its own signature, which is what
            // it is: what these units merge to, before anything is taken out of them.
            b.merged = cut;
        }
    });

    timed('merge:bin', () => {
        for (const b of built) {
            const { merged, base } = b;
            merged.forEach((poly, n) => {
                const rings = poly.map((r) =>
                    r.map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]),
                );
                const key = merged.length > 1 ? `${base}/${n}` : base;
                const js = JSON.stringify(rings);
                const old = prev.get(key);
                let w = old && old.js === js ? old : null;
                if (!w) {
                    let x0 = Infinity,
                        y0 = Infinity,
                        x1 = -Infinity,
                        y1 = -Infinity;
                    for (const [x, y] of rings[0]) {
                        if (x < x0) x0 = x;
                        if (x > x1) x1 = x;
                        if (y < y0) y0 = y;
                        if (y > y1) y1 = y;
                    }
                    w = { key, rings, js, mat: b.mat, x0, y0, x1, y1 };
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
    });
    mergeUnits = ent.length;
    mergeComps = groups.size;
}

const pendingPlaces = [];
const freshChunks = []; // loaded for the first time, and not yet rolled for opposition

// A ship sent to a marker carries the arming with it, and keeps it until it arrives or is
// told to do something else. Arriving fires it, once, and clears it -- but a session shows
// one sheet at a time, so firing into a session that already has one up does nothing.
// Nothing is queued and closing the first does not let the second in: a sheet that opens by
// itself, minutes later, because of a tap you have forgotten making, is worse than one that
// never opens.
function armedArrivals() {
    for (const s of ships) {
        if (!s.arm) continue;
        const m = marks.get(s.arm);
        if (!m) {
            s.arm = null;
            continue;
        }
        if (Math.hypot(s.x - m.x, s.y - m.y) > m.r) continue;
        const p = players.get(s.owner);
        if (!p || p.ws?.readyState !== 1) {
            s.arm = null;
            continue;
        }
        // Touching anything a settlement offers is what makes it home, whether or not the
        // touch opens a sheet: arriving is the act, and a session that already has one open
        // has still put in here.
        if (m.src && p.respawnSite !== m.src) {
            p.respawnSite = m.src;
            playersDirty = true;
        }
        // Arriving is what fires the armed action, and it fires exactly once whatever
        // comes of it. Opening the sheet is the part that can do nothing: a session shows
        // one at a time, so a second ship that gets here while one is up has fired into a
        // session that has no room for it.
        s.arm = null;
        if (p.busy) continue;
        p.busy = m.key;
        // Somebody to talk to first, if this mark has anybody -- and it is the frame that
        // says so rather than the kind, so a yard or a market can put a word in front of
        // its sheet without becoming a different sort of thing.
        if (m.talk) {
            startTalk(p, s.id, m);
            continue;
        }
        p.ws.send(
            JSON.stringify({
                t: 'interact',
                kind: m.kind,
                ship: s.id,
                mark: m.key,
            }),
        );
    }
}

// Everything about a ship that does not change every tick: what it is, what is bolted to
// it, how hurt it is, what its crew have been told. Sent when it changes and not otherwise.
//
// It was riding in every snapshot, and measuring said it cost more of the wire than the
// positions did -- 57% of a ship record's bytes, and 38% of the stream -- because deflate
// does not collapse a kilobyte of repeated envelopes as completely as it looks like it
// should.
function shipInfo(s, own) {
    return {
        owner: s.owner,
        h: hullKey(s.hull),
        // Where it is pointed, and where it was told to go. Both change when an order is given
        // rather than every tick, so they belong with the rest of what a ship *is*.
        hd: +s.heading.toFixed(2),
        ...(s.dest ?
            { dx: Math.round(s.dest.x), dy: Math.round(s.dest.y) }
        :   {}),
        // The beam is a thing in the world, so everyone near enough sees it.
        ...(s.beams.length ? { bm: s.beams } : {}),
        // Whose side it is on, which is not the same question as whose it is. Without this the
        // client can only ask "is it mine", so another player's ships -- and the settlement's
        // own guns -- were drawn in the colour reserved for the enemy.
        ...(s.team === PLAYER_TEAM ? { f: 1 } : {}),
        // What is installed and where. Per ship now rather than per hull class, so the client
        // cannot work it out from the hull any more.
        ft: s.turrets.map((t) => [t.install, t.type, +t.rot.toFixed(2)]),
        // Rounded: repair moves in thirtieths of a point and nobody can see that. Kept here
        // rather than in the per-tick half because it holds still for long stretches, and
        // measuring both ways said so: 1.61 KB/s against 1.72.
        //
        // A wreck on somebody else's ship is only ever a wreck. How deep the debt still is --
        // and so how close their crew is to standing that gun back up -- is theirs to know.
        // Zero says it plainly and says nothing more: a gun never sits at zero alive, it goes
        // straight over the cliff, so nothing is lost by clamping there. Damage above zero
        // stays public, which is what makes a battered enemy worth reading.
        hp: s.turrets.map((t) => Math.round(own ? t.hp : Math.max(0, t.hp))),
        ...(own ?
            {
                pr: s.prio,
                ...(s.focus !== null ? { fo: s.focus } : {}),
                ...(s.repairing !== null ? { rp: s.repairing } : {}),
                ...(s.repairFocus.length ? { rf: s.repairFocus } : {}),
                hold: s.hold,
                or: s.ore,
            }
        :   {}),
    };
}

function syncShips(p) {
    const v = p.view,
        R2 = STREAM_R * STREAM_R;
    const set = [],
        del = [];
    const seen = new Set();
    for (const s of ships) {
        const own = s.owner === p.id;
        const dx = s.x - v.x,
            dy = s.y - v.y;
        if (!own && dx * dx + dy * dy >= R2) continue;
        seen.add(s.id);
        // Compared as text: cheap at this many ships, and it cannot disagree with what was
        // actually sent the way a hand-kept dirty flag eventually does.
        const info = JSON.stringify(shipInfo(s, own));
        if (p.ships.get(s.id) === info) continue;
        p.ships.set(s.id, info);
        set.push([s.id, JSON.parse(info)]);
    }
    for (const id of p.ships.keys())
        if (!seen.has(id)) {
            p.ships.delete(id);
            del.push(id);
        }
    if (set.length || del.length)
        p.ws.send(JSON.stringify({ t: 'ships', set, del }));
}

// ---- refit ----
//
// A ship may be reconfigured while it is inside the settlement's cavern. There is no
// station object yet; being in the one place in the world that is enclosed and safe stands
// in for docking, and swapping it for a real station later changes only this function.
// Where a hull may be worked on: inside the reach of something offering to work on it.
// Not "somewhere in the cavern" any more -- the yard is the place, the marker is the way
// in, and the rule the order is checked against is the same one that opened the sheet.
function canRefit(s) {
    if (s.hull !== CARRIER || !crewed(s)) return false;
    for (const m of marks.values())
        if (m.kind === 'refit' && Math.hypot(s.x - m.x, s.y - m.y) <= m.r)
            return true;
    return false;
}

// What a layout costs, recovered from the difference between what the ship has and what it
// asked for. Every install point is priced on its own -- there is no matching of modules
// across the diff, so moving one is an uninstall and an install, which is deliberate: a
// move price needs a rule for which module became which, and no such rule is obviously
// fair. The client is never asked what it thinks the total is.
// Rotations arrive rounded to the two decimals the wire carries, so a gun nobody touched
// comes back as -1.57 against a stored -1.5707963. Compared exactly, that reads as a
// deliberate turn and bills a quarter of an install for every gun on the ship.
const sameRot = (a, b) => Math.abs(angleDiff(a, b)) < 0.02;

function refitPrice(before, after) {
    let ore = 0;
    const ids = new Set([...before.keys(), ...after.keys()]);
    for (const id of ids) {
        const was = before.get(id),
            now = after.get(id);
        if (was)
            ore +=
                now && now.type === was.type ?
                    0
                :   MODULES[was.type].install * REFIT_REMOVE;
        if (now && (!was || was.type !== now.type))
            ore += MODULES[now.type].install;
        // A module with no reach does not point anywhere, so turning it is not a thing that can
        // be charged for.
        else if (
            now &&
            was &&
            MODULES[now.type].range > 0 &&
            !sameRot(was.rot, now.rot)
        )
            ore += MODULES[now.type].install * REFIT_ROTATE;
    }
    return Math.round(ore);
}

// Whether a layout physically fits: every point is real, every module is one that may be
// installed by hand, and no two modules overlap. Size is a radius, so rotation cannot make
// a fit invalid -- it only decides where the arc points.
function refitFits(hull, fit) {
    const where = new Map(hull.installs.map((p) => [p.id, p.at]));
    const seen = new Set();
    for (const f of fit) {
        const mod = MODULES[f.type];
        if (!where.has(f.install) || !mod || mod.fixed) return false;
        if (seen.has(f.install)) return false;
        seen.add(f.install);
    }
    for (let i = 0; i < fit.length; i++)
        for (let j = i + 1; j < fit.length; j++) {
            const a = where.get(fit[i].install),
                b = where.get(fit[j].install);
            if (
                Math.hypot(a[0] - b[0], a[1] - b[1]) <
                MODULES[fit[i].type].size + MODULES[fit[j].type].size
            )
                return false;
        }
    return true;
}

// Apply a layout, or refuse it and say why. An installation's wear belongs to the point
// rather than to the module, so a gun left alone keeps its damage and one that is put in
// -- even the same type, moved one point over -- starts whole.
function refit(s, want) {
    if (!canRefit(s)) return 'not docked';
    if (!Array.isArray(want) || want.length > s.hull.installs.length)
        return 'bad fit';
    const fit = want.map((f) => ({
        install: String(f.install),
        type: String(f.type),
        rot: snapRot(Number(f.rot) || 0),
    }));
    if (fit.some((f) => !Number.isFinite(f.rot))) return 'bad fit';
    if (!refitFits(s.hull, fit)) return 'will not fit';

    const before = new Map(s.turrets.map((t) => [t.install, t]));
    const after = new Map(fit.map((f) => [f.install, f]));

    // Stock is what is in the hold plus what is coming off the hull in this same refit.
    const stock = { ...s.hold };
    for (const t of s.turrets) {
        const now = after.get(t.install);
        if (!now || now.type !== t.type)
            stock[t.type] = (stock[t.type] || 0) + 1;
    }
    for (const f of fit) {
        const was = before.get(f.install);
        if (was && was.type === f.type) continue;
        if (!stock[f.type]) return `no ${f.type} in the hold`;
        stock[f.type]--;
    }

    const price = refitPrice(before, after);
    if (s.ore < price) return `needs ${price} ore`;

    s.ore -= price;
    s.hold = stock;
    s.turrets = fitTurrets(s.hull, fit);
    for (const t of s.turrets) {
        const was = before.get(t.install);
        if (!was || was.type !== t.type) continue;
        t.hp = was.hp;
        t.a = was.a;
        t.cool = was.cool;
        if (sameRot(was.rot, t.rot)) t.rot = was.rot; // rounding is not a turn
    }
    // Indices into the gun list no longer mean what they meant, and the crew's standing
    // orders were written in them.
    s.repairing = null;
    s.repairFocus = [];
    return null;
}

// What still goes out on a clock: nothing that moves. The world's shape, whose ships
// these are, who is playing, and the fact that something just died -- said once each,
// when it happens.
function worldFor(p, now, motion) {
    const roster = JSON.stringify({
        v: VERSION,
        stale,
        players: [...players.values()].map((q) => ({
            id: q.id,
            name: q.name,
            score: q.score,
        })),
    });
    const saw = kills.filter((k) => near(p, k.x, k.y));
    const lines = tracers.filter((r) => near(p, r.x, r.y));
    const has = Object.keys(motion.a).length || Object.keys(motion.d).length;
    if (!has && !saw.length && !lines.length && p.told === roster) return null;
    const first = p.told !== roster;
    p.told = roster;
    return JSON.stringify({
        t: 'm',
        st: now,
        ...(first ? JSON.parse(roster) : {}),
        ...(Object.keys(motion.a).length ? { a: motion.a } : {}),
        ...(Object.keys(motion.d).length ? { d: motion.d } : {}),
        ...(saw.length ? { kills: saw } : {}),
        ...(lines.length ? { fire: lines } : {}),
    });
}

// ---- motion on the wire ----
//
// Nothing is sent on a clock. A thing that moves is described once -- where it was at a
// moment, and how fast -- and the client carries it on from there in a straight line. It is
// described again only when that straight line has drifted far enough from the truth to be
// worth a correction, and never more than MOTION_HZ times a second.
//
// So a rock, which really does travel in a straight line, is described once and never
// mentioned again. A ship under power drifts off its line as it accelerates and turns, and
// gets a correction four times a second. A ship sitting still gets nothing at all. The
// linear case is not a special case: it is what happens when the error never grows.
//
// The curve lives on the client. It is given a position and a velocity, it has a position
// and a velocity of its own, and it eases from one to the other rather than jumping -- so a
// correction is a nudge rather than a snap, and being slightly wrong costs smoothness
// instead of teleporting anything.
const near = (p, x, y) => {
    const dx = x - p.view.x,
        dy = y - p.view.y;
    return dx * dx + dy * dy < STREAM_R * STREAM_R;
};

const MOTION_HZ = 4;
const MOTION_GAP = 1000 / MOTION_HZ;
const MOVE_TOL = 3; // world units of drift worth correcting
const TURN_TOL = 0.05; // ...and radians, about a pixel at a hull's tip

// What a client would think, given what it was last told.
function predict(sent, now) {
    const dt = (now - sent.t) / 1000;
    return {
        x: sent.x + sent.vx * dt,
        y: sent.y + sent.vy * dt,
        a: sent.a + sent.va * dt,
    };
}

// Everything that moves, and how to read its motion. Turrets ride with their ship: they are
// cosmetic, and a gun's bearing is not worth a message of its own.
const MOVERS = [
    {
        kind: 'ship',
        all: () => ships,
        id: (s) => s.id,
        sees: (p, s) => s.owner === p.id || near(p, s.x, s.y),
        read: (s) => ({
            x: s.x,
            y: s.y,
            a: s.a,
            vx: s.vx,
            vy: s.vy,
            va: s.va || 0,
            tu: s.turrets.map((t) => [
                +t.a.toFixed(2),
                +(t.va || 0).toFixed(2),
            ]),
            // Burning or not. It rides with the motion because it is about the
            // motion; on the standing record every flicker of the throttle would
            // resend the loadout with it.
            of: [s.th ? 1 : 0],
        }),
    },
    {
        kind: 'rock',
        all: () => rocks,
        id: (r) => r.id,
        sees: (p, r) => near(p, r.x, r.y),
        read: (r) => ({
            x: r.x,
            y: r.y,
            a: r.a,
            vx: r.vx,
            vy: r.vy,
            va: r.spin,
            of: [r.size, r.seed, r.rich | 0],
        }),
    },
    {
        kind: 'ore',
        all: () => ore,
        id: (o) => o.id,
        sees: (p, o) => near(p, o.x, o.y),
        read: (o) => ({
            x: o.x,
            y: o.y,
            a: o.a,
            vx: o.vx,
            vy: o.vy,
            va: o.spin,
            of: [o.mod || 0],
        }),
    },
    {
        kind: 'shot',
        all: () => bullets,
        id: (b) => b.id,
        sees: (p, b) => near(p, b.x, b.y),
        read: (b) => ({
            x: b.x,
            y: b.y,
            a: 0,
            vx: b.vx,
            vy: b.vy,
            va: 0,
            of: [],
        }),
    },
];

function syncMotion(p, now) {
    const a = {},
        d = {};
    for (const m of MOVERS) {
        const known = p.moving[m.kind];
        const rows = [],
            gone = [];
        const seen = new Set();
        for (const e of m.all()) {
            if (!m.sees(p, e)) continue;
            const id = m.id(e);
            seen.add(id);
            const sent = known.get(id);
            const truth = m.read(e);
            if (sent) {
                if (now - sent.t < MOTION_GAP) continue; // said recently enough
                const gu = predict(sent, now);
                const off = Math.hypot(truth.x - gu.x, truth.y - gu.y);
                const turn = Math.abs(angleDiff(truth.a, gu.a));
                const guns = (truth.tu || []).some(
                    (t, i) =>
                        Math.abs(
                            angleDiff(
                                t[0],
                                (sent.tu?.[i]?.[0] ?? 0) +
                                    ((sent.tu?.[i]?.[1] ?? 0) *
                                        (now - sent.t)) /
                                        1000,
                            ),
                        ) >
                        TURN_TOL * 3,
                );
                const same =
                    JSON.stringify(truth.of) === JSON.stringify(sent.of);
                if (off < MOVE_TOL && turn < TURN_TOL && !guns && same)
                    continue; // its guess is good enough
            }
            known.set(id, { ...truth, t: now });
            rows.push([
                id,
                +truth.x.toFixed(1),
                +truth.y.toFixed(1),
                +truth.a.toFixed(2),
                Math.round(truth.vx),
                Math.round(truth.vy),
                +truth.va.toFixed(2),
                ...(truth.tu ? [truth.tu] : []),
                ...(truth.of ? [truth.of] : []),
            ]);
        }
        for (const id of known.keys())
            if (!seen.has(id)) {
                known.delete(id);
                gone.push(id);
            }
        if (rows.length) a[m.kind] = rows;
        if (gone.length) d[m.kind] = gone;
    }
    return { a, d };
}

const newMoving = () =>
    Object.fromEntries(MOVERS.map((m) => [m.kind, new Map()]));

// ---- conversation ----
//
// A conversation is a stack of frames, and a frame is `[module, state]` -- a name and a
// bag, both plain JSON, so a whole conversation serialises by being what it already is.
// Behaviour is never in the stack: the name is looked up in `conversations/`, which is
// what makes the stack safe to write to disk and reload into a newer build.
//
// The bottom frame is authored by whatever offers the conversation; everything above it
// is an interrupt -- something that has to be dealt with before the usual business. Each
// frame is asked in turn, from the top, and answers with one step:
//
//   { say, options }     say this, and offer these
//   { pop }              nothing to say; drop me and ask the next one down
//   { exit }             the conversation ends, and I stay where I am
//   { push: name }       put that conversation on top of me and ask it; work is taken on
//   { open: markKey }    hand the session to another interaction; the conversation ends
//   { open: true }       ...to the one this conversation is standing at, whichever
//                        instance of it that is -- the same yard module serves every yard
//
// A frame that has become irrelevant -- a quest finished somewhere else entirely -- pops
// itself the next time it is asked, and the client never learns it was there.
const CONVERSATIONS = await (async () => {
    const dir = path.join(__dirname, 'conversations');
    const found = new Map();
    for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const entry = path.join(dir, name, 'index.js');
        // The whole module rather than its default export: a conversation that is also a
        // piece of work exports `offer` beside it, and that is the only thing that makes
        // it work rather than talk.
        if (fs.existsSync(entry))
            found.set(name, await import(pathToFileURL(entry)));
    }
    return found;
})();

// Each conversationalist is an instance, not a role: one town has one foreman, but the
// same set piece stamped somewhere else has its own. The set piece instance is the
// site that laid it down, which is already how one cell's rock is told from a neighbour's.
const whoId = (mark) =>
    `/setpieces/${mark.src ?? 'world'}/conversationalists/${mark.who}`;

// Who somebody is -- a name, a gender and a face -- worked out from that id rather than
// stored anywhere. The id already carries the site that laid them down, so one town's
// foreman is the same person on every restart while the next town's is somebody else, and
// there is nothing to persist, migrate or invalidate. One pool of given names
// for all three genders: a name is not a second place to say what somebody is.
const GIVEN = [
    'Vela',
    'Tam',
    'Orsa',
    'Bex',
    'Corran',
    'Mire',
    'Hask',
    'Juno',
    'Pell',
    'Sable',
    'Rook',
    'Ines',
    'Calder',
    'Wen',
    'Absalom',
    'Nix',
    'Toma',
    'Greer',
    'Isolde',
    'Vash',
];
const FAMILY = [
    'Orsk',
    'Ridd',
    'Vantry',
    'Kell',
    'Marrow',
    'Thane',
    'Bell',
    'Cordage',
    'Slate',
    'Hollow',
    'Ferris',
    'Quill',
    'Ashgrove',
    'Draper',
    'Munro',
    'Stave',
    'Halloran',
    'Perch',
    'Vane',
    'Wick',
];
const GENDERS = ['female', 'genderqueer', 'male'];

// mulberry32, seeded off the id. The portrait generator takes any Math.random-shaped
// function, so name, gender and face all come out of one stream drawn in a fixed order --
// which is the whole of "derived, not stored".
function seeded(str) {
    let a = crypto.createHash('sha1').update(str).digest().readUInt32LE(0);
    return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Compositing the sprites is the only part worth keeping, so the promise is the cache: it
// is created once, on the first word anybody exchanges with them, and never rejects -- a
// portrait that would not draw degrades to a nameplate with no face, not to a broken
// conversation.
const folk = new Map(); // conversationalist id -> promise of { name, gender, portrait }
function folkFor(who) {
    if (!folk.has(who)) {
        const rng = seeded(who);
        const name = `${pick(GIVEN, rng)} ${pick(FAMILY, rng)}`;
        const gender = pick(GENDERS, rng);
        // The two renders have to be the same person, and the generator consumes whatever
        // stream it is handed -- so each gets its own copy of one wound to the same place,
        // rather than sharing a stream and drawing two different faces.
        folk.set(
            who,
            portrait({
                template: gender,
                // Nobody is drawn asleep, and nobody has horns: these are people in a
                // harbour, and whether the setting has androids or elves in it is not a
                // question a portrait generator gets to answer on its own.
                exclude: [CLOSED_EYES, FANTASY_PARTS],
                // Its own stream, rather than what is left of the one the name came out
                // of, so that adding a draw to how somebody is named never silently
                // redraws every face in the world.
                rng: seeded(`${who}#face`),
            }).then(
                (img) => ({ name, gender, portrait: img }),
                (e) => {
                    console.warn(`portrait: ${who}: ${e.message}`);
                    return { name, gender, portrait: null };
                },
            ),
        );
    }
    return folk.get(who);
}

// Per player: two people may be mid-sentence with the same person and neither should see
// the other's half of it. The bottom frame is seeded from what the set piece authored, so
// "the world decides the default, the player owns the interrupts" holds without the two
// being stored in different places.
function stackFor(p, who, mark) {
    if (p.talks[who]?.length) return p.talks[who];
    p.talks[who] = mark.talk ? [mark.talk] : [];
    // Everybody in a town has a word ready for somebody who has just arrived, and it goes
    // on the first time you meet each of them -- not when you join, because on a cold start
    // nothing is loaded yet and there is nobody to hand it to. Pushed whether or not it is
    // still wanted: the frame itself knows whether anybody has said it, and pops unspoken
    // if somebody has.
    if (p.talks[who].length && siteBySrc(mark.src)?.kind === 'town')
        p.talks[who].push(['welcome', {}]);
    return p.talks[who];
}

// What a conversation knows about a player, which a frame's own bag cannot hold: that dies
// when the frame pops, and the whole point of knowing something is to outlive the exchange
// it was learned in.
//
// Keyed by (conversation, player) -- the module's name, not the conversationalist's id --
// so every yard foreman in the world reads and writes the one bag. That is the point
// rather than a compromise: it is how one of them knows what you told another, and a
// conversation that wants to remember something about a particular person can say so by
// putting the id in the key it chooses.
//
// Small on purpose. These are bags of flags and counts to branch on, not places to keep a
// player's business: what one conversation needs to know about you fits in ten keys, and a
// whole settlement's worth of standing facts fits in a hundred. A limit nobody reaches is a
// limit that never had to be explained.
const STORE_KEYS = 10; // what a conversation knows about a player
const PLACE_KEYS = 100; // what a set piece knows, shared by everybody in it
const BAG_KEY = 50;
const BAG_TEXT = 50; // a name or a label, not a paragraph
const bagOk = (what, bag, max) => {
    const keys = Object.keys(bag);
    let why = null;
    if (keys.length > max) why = `over ${max} keys`;
    for (const k of keys) {
        const v = bag[k];
        if (k.length > BAG_KEY) why = `key over ${BAG_KEY} characters: ${k}`;
        // Strings because a place knows its own name, which is neither a flag nor a count.
        // Capped, because the day a bag holds a paragraph is the day it is a save file.
        else if (typeof v === 'string') {
            if (v.length > BAG_TEXT)
                why = `${k} is over ${BAG_TEXT} characters`;
        } else if (typeof v !== 'boolean' && !Number.isFinite(v))
            why = `${k} is not a boolean, a number or a short string`;
    }
    // Dropped whole rather than trimmed. Half a write is a state nobody authored, and a
    // conversation that quietly forgets is easier to find than one that half-remembers.
    if (why) console.warn(`${what}: ${why}; write dropped`);
    return !why;
};

// Where a set piece keeps what it knows. It hangs off the site because the site *is* the
// instance -- the cell the piece claimed -- which is already how one cell's rock is told
// from a neighbour's, and which means it is saved and loaded with the mesh for free.
// Scanned rather than indexed: this runs once per thing anybody says, not per tick.
const siteBySrc = (src) =>
    src ? (sites.find((q) => siteKey(q) === src) ?? null) : null;

// What there is to be had here. A conversation that exports `offer` is a piece of work:
// it is asked whether it is on the table, given who is asking, what it already knows about
// this player, where they are standing and what they have destroyed.
//
// Anything already on this conversationalist's stack is left out, so "you have that one
// already" is answered by the stack rather than by a flag somebody has to remember to set.
// A predicate that throws is a predicate that says no: an authoring mistake in one piece of
// work must not take the conversation it was offered in down with it.
// ---- the map ----
//
// What a player has seen, remembered as a picture rather than as the world. A wall only
// exists while its chunk is loaded and merged, so a map of everywhere you have been cannot
// be made of walls: it is sampled instead, MAP_GRID by MAP_GRID per chunk, and what is kept
// is one bit per cell. Bounded however far anybody flies -- eight bytes a chunk, about 4KB
// for twenty thousand units square -- and it costs nothing to send or to draw.
//
// Sampled again every time you come back, which is what makes a wall somebody blew a hole
// in show the hole: the map is as old as your last visit and says nothing about what has
// happened since.
const MAP_GRID = 8; // samples across a chunk: 900/8 = 112 units a cell
// A byte a cell, so the map can tell one kind of matter from another and will not have to
// be widened again when there are twenty kinds: the town's blocking wall is not the same
// thing as the rock around it, and a map that drew them alike would be hiding the one piece
// of ground that behaves differently. Sixty-four bytes a chunk before it is stored, which
// is the wrong number to care about -- see below.
const MAP_MATS = ['rock', 'block']; // index + 1 is what goes in the cell; 0 is empty

// A tile is stored once for everybody, under the hash of what it says. Two players who
// have stood in the same place have seen the same ground, and an unexplored chunk is the
// same sixty-four zero bytes for all of them -- so a player's map is a list of names, and
// the pictures behind the names are world state like the mesh. Deflated on the way to disk,
// where a tile is mostly one repeated byte; sent raw, because the socket deflates the whole
// message anyway and a browser that had to inflate this would need a decompression stream
// nobody else here depends on.
const tiles = new Map(); // hash -> raw bytes
let tilesDirty = false;
const tileFile = () => path.join(WORLD_DIR, 'tiles.json');
// Twelve hex characters: a thousand million tiles collide with probability around 1e-7,
// and the whole point of the name is to be shorter than the thing it names.
const tileName = (bytes) =>
    crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 12);

function keepTile(bytes) {
    const name = tileName(bytes);
    if (!tiles.has(name)) {
        tiles.set(name, bytes);
        tilesDirty = true;
    }
    return name;
}

function saveTiles() {
    if (!tilesDirty) return;
    tilesDirty = false;
    const out = {};
    for (const [name, bytes] of tiles)
        out[name] = zlib.deflateRawSync(bytes, { level: 9 }).toString('base64');
    try {
        fs.mkdirSync(WORLD_DIR, { recursive: true });
        fs.writeFileSync(tileFile(), JSON.stringify({ v: 1, tiles: out }));
    } catch {
        /* unwritable store: the game runs, it just will not survive a restart */
    }
}

function loadTiles() {
    let d;
    try {
        d = JSON.parse(fs.readFileSync(tileFile(), 'utf8'));
    } catch {
        return; // no file: nobody has been anywhere yet
    }
    if (d.v !== 1) return console.warn('tiles.json: unknown version; ignored');
    for (const [name, b64] of Object.entries(d.tiles ?? {}))
        try {
            tiles.set(name, zlib.inflateRawSync(Buffer.from(b64, 'base64')));
        } catch {
            /* one unreadable tile is one chunk drawn as unvisited */
        }
}
const MAP_REACH = 2; // chunks either side of the one a hull is in, so about what it saw
const MAP_PER_TICK = 2; // chunks sampled a tick, to keep a long jump off the tick budget
const mapWork = []; // [player, cx, cy], drained a couple at a time

// Where a hull has just arrived, and the ground around it. Queued on entering a chunk
// rather than watched continuously: a ship sitting still has nothing new to show anybody,
// and one under way crosses a chunk about every six seconds.
function mapSweep() {
    for (const s of ships) {
        if (!crewed(s)) continue;
        const p = players.get(s.owner);
        if (!p) continue;
        const key = chunkKey(chunkOf(s.x), chunkOf(s.y));
        if (s.mapAt === key) continue;
        s.mapAt = key;
        const cx = chunkOf(s.x),
            cy = chunkOf(s.y);
        for (let dx = -MAP_REACH; dx <= MAP_REACH; dx++)
            for (let dy = -MAP_REACH; dy <= MAP_REACH; dy++)
                mapWork.push([p, cx + dx, cy + dy]);
        // Somewhere with a name, near enough to have been read off the hull. Only set
        // pieces have one, so this is a handful of sites rather than the whole mesh.
        for (const q of sites) {
            if (!q.bag?.name) continue;
            if (Math.hypot(q.x - s.x, q.y - s.y) > CHUNK * (MAP_REACH + 0.5))
                continue;
            if (p.places.some((r) => r.name === q.bag.name && r.x === q.x))
                continue;
            p.places.push({
                x: Math.round(q.x),
                y: Math.round(q.y),
                name: q.bag.name,
            });
            playersDirty = true;
        }
    }
    for (let i = 0; i < MAP_PER_TICK && mapWork.length; i++) {
        const [p, cx, cy] = mapWork.shift();
        sampleChunk(p, cx, cy);
    }
    flushMapNews();
}

// One chunk, as a grid of "is there matter here". `ensure` false throughout: the map may
// only ever record ground that already exists, or looking at it would call the world into
// being ahead of anybody going there.
function sampleChunk(p, cx, cy) {
    const bytes = Buffer.alloc(MAP_GRID * MAP_GRID);
    const step = CHUNK / MAP_GRID;
    for (let gy = 0; gy < MAP_GRID; gy++)
        for (let gx = 0; gx < MAP_GRID; gx++) {
            const x = cx * CHUNK + (gx + 0.5) * step,
                y = cy * CHUNK + (gy + 0.5) * step;
            const mat = matterAt(x, y);
            bytes[gy * MAP_GRID + gx] = mat ? MAP_MATS.indexOf(mat) + 1 : 0;
        }
    const key = chunkKey(cx, cy);
    const was = p.map[key];
    const name = keepTile(bytes);
    if (was === name) return; // the ground has not changed since last time
    p.map[key] = name;
    playersDirty = true;
    // Somebody with the map open is watching this happen. Sent as it is sampled rather
    // than fetched again: a flight reveals a handful of chunks at a time, and asking for
    // the whole atlas every few seconds to learn about four of them is the wrong trade.
    if (p.mapOn) (p.mapNew ??= new Map()).set(key, name);
}

// Whatever has been sampled since the last tick, for the people looking at it.
function flushMapNews() {
    for (const p of players.values()) {
        if (!p.mapNew?.size || p.ws?.readyState !== 1) continue;
        const fresh = Object.fromEntries(p.mapNew);
        p.mapNew = null;
        const art = {};
        for (const name of new Set(Object.values(fresh))) {
            const bytes = tiles.get(name);
            if (bytes) art[name] = bytes.toString('base64');
        }
        p.ws.send(JSON.stringify({ t: 'map+', tiles: fresh, art }));
    }
}

// ---- quests ----
//
// A quest is a thing in the world rather than a note on a player: one bag of them, keyed by
// id, saved beside the mesh. `who` is a player today, and it is the seam a shared quest
// would widen -- something everybody is working on wants one record, not one apiece.
//
// What it is *about* stays in the conversation module that gave it: the record carries a
// kind, where it was taken and whatever state the giver put in it, and the module says what
// that means and what it reads as.
const quests = new Map(); // id -> { id, kind, who, src, state, done }
let questsDirty = false;
const questFile = () => path.join(WORLD_DIR, 'quests.json');

const questsOf = (pid) =>
    [...quests.values()].filter((q) => q.who === pid && !q.done);

// The one a given frame is about: this kind of work, taken here, still open.
const questHere = (pid, kind, src) =>
    questsOf(pid).find((q) => q.kind === kind && q.src === src) ?? null;

function takeQuest(pid, kind, src, state) {
    const q = {
        id: nextId++,
        kind,
        who: pid,
        src,
        state: state ?? {},
        done: false,
    };
    quests.set(q.id, q);
    questsDirty = true;
    return q;
}

// Finished rather than forgotten: the record stays, because what somebody has done is worth
// as much as what they are doing, and `offer` reads it to know not to give it again.
function finishQuest(q) {
    if (!q || q.done) return;
    q.done = true;
    questsDirty = true;
}

function saveQuests() {
    if (!questsDirty) return;
    questsDirty = false;
    try {
        fs.mkdirSync(WORLD_DIR, { recursive: true });
        fs.writeFileSync(
            questFile(),
            JSON.stringify({ v: 1, quests: [...quests.values()] }),
        );
    } catch {
        /* unwritable store: the game runs, it just will not survive a restart */
    }
}

function loadQuests() {
    let d;
    try {
        d = JSON.parse(fs.readFileSync(questFile(), 'utf8'));
    } catch {
        return; // no file: nobody has been given anything yet
    }
    if (d.v !== 1) return console.warn('quests.json: unknown version; ignored');
    for (const q of d.quests ?? []) quests.set(q.id, q);
}

// One line per open quest, written by the module that gave it, so "(3 remaining)" is worked
// out from what is true now rather than from something that had to be kept up to date.
function questLines(p) {
    const out = [];
    for (const q of questsOf(p.id)) {
        const say = CONVERSATIONS.get(q.kind)?.describe;
        if (typeof say !== 'function') continue; // a build that no longer has that work
        try {
            const text = say(q, {
                kills: p.kills,
                place: siteBySrc(q.src)?.bag ?? null,
            });
            if (text) out.push({ id: q.id, text: String(text).slice(0, 200) });
        } catch (e) {
            console.warn(`work ${q.kind}: describe threw: ${e.message}`);
        }
    }
    return out;
}

// Said when it changes and not otherwise, like everything else that does not move.
function sendQuests(p) {
    if (p.ws?.readyState !== 1) return;
    p.ws.send(JSON.stringify({ t: 'quests', list: questLines(p) }));
}

function gatherWork(p, who, from, src, site) {
    const stack = p.talks[who] ?? [];
    const out = [];
    for (const [name, mod] of CONVERSATIONS) {
        if (typeof mod.offer !== 'function') continue;
        if (stack.some((f) => f[0] === name)) continue;
        try {
            if (
                mod.offer({
                    from,
                    src,
                    player: p.store[name] ?? {},
                    place: site?.bag ?? null,
                    kills: p.kills,
                    // Everything this player has of this kind, open or finished, so a
                    // predicate can say "not twice here" without keeping a flag of its own.
                    quests: [...quests.values()].filter(
                        (q) => q.who === p.id && q.kind === name,
                    ),
                })
            )
                out.push(name);
        } catch (e) {
            console.warn(`work ${name}: offer threw: ${e.message}`);
        }
    }
    return out;
}

// Ask the stack what happens next. Walks down through frames with nothing to say, so a
// pop is invisible to the client: it sees the first frame that actually speaks.
//
// `choice` is the option index, or null when nothing has been answered. `start` tells the
// two null cases apart: a frame being taken up -- walked up to, or uncovered by a pop --
// against being asked again where it already was, which is what a reconnect does. A
// conversation that reset itself on every reconnect would be a way to rewind one.
function nextStep(p, who, choice, start) {
    const stack = p.talks[who] ?? [];
    let input = choice,
        fresh = start;
    // Bounded rather than `while (true)`: a frame that pops on every ask, forever, is an
    // authoring bug, and one that hangs the tick loop is a much worse one.
    for (let guard = 0; guard < 64; guard++) {
        const frame = stack[stack.length - 1];
        if (!frame) return { exit: true }; // nothing left to say, by anybody
        const hold = CONVERSATIONS.get(frame[0])?.default;
        // Named a module this build does not have -- renamed, or gone. Drop the frame and
        // carry on down: an interrupt nobody can run degrades to never being mentioned,
        // which is survivable, and refusing to load the save is not.
        if (!hold) {
            console.warn(`conversation: no module ${frame[0]}; frame dropped`);
            stack.pop();
            input = null;
            fresh = true;
            continue;
        }
        let step, store, place;
        // immer, three times: its own frame's bag, what this conversation knows about this
        // player, and what the set piece it belongs to knows about anybody. The holder
        // mutates whichever it likes and returns the step; what comes back from each
        // produce is the next state, replacing what was there if anything changed.
        const name = frame[0];
        const site = siteBySrc(p.talk?.src);
        const placeWas = site?.bag ?? {};
        // Held rather than fetched twice, so a conversation that writes nothing is told
        // apart from one that wrote: immer hands back what it was given when a recipe
        // changes nothing, and without this every ask filed an empty bag of its own.
        const storeWas = p.store[name] ?? {};
        const src = p.talk?.src ?? null;
        // A quest is world state, not the conversation's own, so it is moved by asking
        // rather than by drafting: the module says take it or finish it and the registry
        // does the rest. `quest` is whatever this kind of work already is here, if any.
        let told = false; // the list has changed and this player has not been told
        const ask = (params, player, here) =>
            hold(params, player, here, {
                who,
                src,
                ship: p.talk?.ship,
                choice: input,
                start: fresh,
                kills: p.kills,
                quest: questHere(p.id, name, src),
                // Asked rather than handed over, because most steps never want to know:
                // gathering means running everybody's predicate.
                gatherWork: () => gatherWork(p, who, name, src, site),
                takeQuest: (state) => {
                    told = true;
                    return takeQuest(p.id, name, src, state);
                },
                finishQuest: () => {
                    told = true;
                    finishQuest(questHere(p.id, name, src));
                },
                // Paid into the hold of the ship that is standing here, not bolted on: what
                // to do with it is a refit, which is a decision and a sheet of its own. The
                // yard is where you are, so the walk to it is nothing.
                give: (type) => {
                    if (!MODULES[type] || MODULES[type].fixed) return false;
                    const ship = [...ships].find(
                        (q) => q.id === p.talk?.ship && q.owner === p.id,
                    );
                    if (!ship) return false;
                    ship.hold[type] = (ship.hold[type] || 0) + 1;
                    return true;
                },
            });
        frame[1] = produce(frame[1], (params) => {
            store = produce(storeWas, (player) => {
                // Nobody put this conversationalist anywhere, so there is no place: a null
                // rather than a draft whose writes go nowhere, because a module that wants
                // one should find out by asking rather than by being quietly forgotten.
                if (!site) step = ask(params, player, null);
                else
                    place = produce(placeWas, (here) => {
                        step = ask(params, player, here);
                    });
            });
        });
        if (
            store !== storeWas &&
            bagOk(`conversation store ${name}`, store, STORE_KEYS)
        )
            p.store[name] = store;
        if (told) sendQuests(p);
        if (
            site &&
            place !== placeWas &&
            bagOk(`set piece ${p.talk.src}`, place, PLACE_KEYS)
        ) {
            site.bag = place;
            meshDirty = true;
        }
        // Work taken on. The giver puts it on the stack and says nothing more: the frame
        // above it speaks for itself from here, and is asked as though walked up to.
        if (step?.push) {
            if (!CONVERSATIONS.get(step.push)?.default) {
                console.warn(
                    `conversation: no module ${step.push}; not pushed`,
                );
                return { exit: true };
            }
            stack.push([step.push, {}]);
            input = null;
            fresh = true;
            continue;
        }
        if (!step?.pop) return step ?? { exit: true };
        stack.pop();
        input = null; // whoever is underneath is starting, not answering
        fresh = true;
    }
    return { exit: true };
}

// One step, turned into whatever the client should be looking at.
//
// Async only because the first word anybody has with somebody draws their face; every step
// after that is awaiting a promise that has already settled. The face rides along with
// every node rather than being sent once and remembered: it is 2.3KB against a channel
// that carries nothing at all while a sheet is open, and the client stays a thing that
// draws what it was last told.
async function playTalk(p, step) {
    if (step.open) {
        // `true` is the mark this conversation was offered from, which is the one the
        // session is already inside. A module that named a key instead would name one
        // town's yard, and the second town's foreman would open the first town's sheet.
        const mark = marks.get(step.open === true ? p.busy : step.open);
        // Whatever it pointed at is not loaded, or not there any more. Saying nothing
        // would leave the sheet spinning, so the conversation simply ends.
        if (!mark) return endTalk(p);
        const ship = p.talk?.ship;
        p.talk = null;
        p.busy = mark.key;
        return p.ws.send(
            JSON.stringify({
                t: 'interact',
                kind: mark.kind,
                ship,
                mark: mark.key,
            }),
        );
    }
    if (!step.say || !p.talk) return endTalk(p);
    const { name, portrait: face } = await folkFor(p.talk.who);
    if (p.ws.readyState !== 1) return;
    p.ws.send(
        JSON.stringify({
            t: 'talk',
            ship: p.talk?.ship,
            name,
            portrait: face,
            say: step.say,
            options: step.options ?? [],
        }),
    );
}

function startTalk(p, shipId, mark) {
    const who = whoId(mark);
    stackFor(p, who, mark);
    // The set piece that laid this conversationalist down, carried so a later step can
    // reach what the place knows without picking the id apart. It rides in the saved
    // record with the rest of the conversation.
    p.talk = { who, ship: shipId, src: mark.src ?? null };
    playTalk(p, nextStep(p, who, null, true));
}

function endTalk(p) {
    p.talk = null;
    p.busy = null;
    if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ t: 'talk-end' }));
}

// ---- the market ----
//
// A basket rather than a till: everything being bought and everything being sold goes over
// as one order and settles in a single figure, so a trade is never half done and there is
// no order in which to do it that costs less. The client's running total is a preview; the
// price is worked out here from what the ship is actually carrying.
const forSale = () =>
    Object.keys(MODULES).filter((t) => !MODULES[t].fixed && MODULES[t].price);
const sellPrice = (t) => Math.round(MODULES[t].price * RESALE);

function canTrade(s) {
    if (!crewed(s)) return false;
    for (const m of marks.values())
        if (m.kind === 'market' && Math.hypot(s.x - m.x, s.y - m.y) <= m.r)
            return true;
    return false;
}

function trade(s, buy, sell) {
    if (!canTrade(s)) return 'not at a market';
    const count = (o) => {
        const out = {};
        for (const [t, n] of Object.entries(o || {})) {
            const k = Math.floor(Number(n));
            if (!Number.isFinite(k) || k < 0 || k > 999) return null;
            if (k && !MODULES[t]?.price) return null; // nothing else is traded
            if (k) out[t] = k;
        }
        return out;
    };
    const buying = count(buy),
        selling = count(sell);
    if (!buying || !selling) return 'bad basket';
    for (const [t, n] of Object.entries(selling))
        if ((s.hold[t] || 0) < n) return `no ${n} ${t} to sell`;

    let owed = 0;
    for (const [t, n] of Object.entries(buying)) owed += MODULES[t].price * n;
    for (const [t, n] of Object.entries(selling)) owed -= sellPrice(t) * n;
    if (owed > s.ore) return `needs ${owed} ore`;

    s.ore -= owed;
    for (const [t, n] of Object.entries(selling))
        s.hold[t] = (s.hold[t] || 0) - n;
    for (const [t, n] of Object.entries(buying))
        s.hold[t] = (s.hold[t] || 0) + n;
    for (const t of Object.keys(s.hold)) if (!s.hold[t]) delete s.hold[t];
    return null;
}

// Cargo goes between two hulls of your own, both ways at once, and costs nothing: it is all
// yours already. They have to be alongside each other, though -- a fleet whose holds are one
// pool wherever the hulls are is a fleet that never has to sail anything home, and the walk
// back with a full hold is most of what a hold is for.
// Alongside, give or take: a squadron in loose formation can pass cargo without being
// nudged into each other, and it is still a rendezvous rather than a fleet-wide pool. With
// the camera between them, two hulls this far apart are each 450 from the centre and so
// well inside the 866 that is on screen on every device -- you can watch both ends of the
// transfer at once, whatever you are playing on.
const TRANSFER_REACH = 900;

function moveCargo(a, b, give, take) {
    if (!a || !b || a === b) return 'no such ship';
    if (Math.hypot(a.x - b.x, a.y - b.y) > TRANSFER_REACH)
        return 'too far apart';
    const count = (o) => {
        const out = {};
        for (const [t, n] of Object.entries(o || {})) {
            const k = Math.floor(Number(n));
            if (!Number.isFinite(k) || k < 0 || k > 99999) return null;
            // Ore is not a module and is carried as a number, but it moves like one.
            if (k && t !== 'ore' && !MODULES[t]) return null;
            if (k) out[t] = k;
        }
        return out;
    };
    const out = count(give),
        back = count(take);
    if (!out || !back) return 'bad basket';
    const has = (q, t) => (t === 'ore' ? q.ore : q.hold[t] || 0);
    for (const [t, n] of Object.entries(out))
        if (has(a, t) < n) return `no ${n} ${t} aboard`;
    for (const [t, n] of Object.entries(back))
        if (has(b, t) < n) return `no ${n} ${t} aboard`;

    const shift = (from, to, what) => {
        for (const [t, n] of Object.entries(what)) {
            if (t === 'ore') {
                from.ore -= n;
                to.ore += n;
                continue;
            }
            from.hold[t] = (from.hold[t] || 0) - n;
            to.hold[t] = (to.hold[t] || 0) + n;
            if (!from.hold[t]) delete from.hold[t];
        }
    };
    shift(a, b, out);
    shift(b, a, back);
    return null;
}

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
// Far enough out that an encounter has its ships long before anyone could see them: what
// is visible on the widest screen is 2200 from the middle, and this is well past it. They
// are not spawned when you arrive -- they were already flying when you came over the
// horizon, which is the difference between finding a fight and watching one appear.
const ENC_BUILD = 3000;
// Room to spare above the radius an encounter builds at, or a ship hovering between the
// two would build it, drop it for being unwatched, and build it again for ever.
const ENC_KEEP = MAX_VIEW + 1800;
// If a script will not let go -- a guard wedged behind rock, say -- it is overruled
// eventually. A group that cannot finish tidying up is not a reason to hold a nest
// resident for the life of the process.
const ENC_PATIENCE = 25;

// Every hook is optional; this is what an encounter does if its script says nothing.
const ENCOUNTER = {
    spawn() {}, // build your members
    pack() {}, // remember what survived, before they are removed
    think() {}, // group rules, once a tick -- and where orders are given
    ready: () => true, // may we pack up? nobody is watching, but you decide
};

function addEncounter(kind, x, y, r) {
    encounters.push({
        ...ENCOUNTER,
        ...SCRIPTS[kind],
        kind,
        x,
        y,
        r,
        members: new Set(),
        aggro: new Set(),
        live: false,
        alone: 0,
        state: {},
    });
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
    for (const s of ships)
        if (crewed(s)) d = Math.min(d, Math.hypot(s.x - e.x, s.y - e.y));
    for (const p of players.values())
        if (p.view && p.ws && p.ws.readyState === 1)
            d = Math.min(d, Math.hypot(p.view.x - e.x, p.view.y - e.y));
    return d;
}

function manageEncounters(dt) {
    for (const e of encounters) {
        if (!e.live) {
            let near = Infinity;
            for (const s of ships)
                if (crewed(s))
                    near = Math.min(near, Math.hypot(s.x - e.x, s.y - e.y));
            if (near <= e.r) {
                e.spawn(e);
                e.live = true;
                e.alone = 0;
            }
            continue;
        }
        e.think(e, dt);
        // Out of sight, and the group says it is done -- or has had long enough to say so.
        e.alone = watched(e) > ENC_KEEP ? e.alone + dt : 0;
        if (e.alone > 0 && (e.ready(e) || e.alone > ENC_PATIENCE)) {
            e.pack(e);
            for (const s of e.members) ships.delete(s);
            e.members.clear();
            e.aggro.clear();
            e.live = false;
            e.alone = 0;
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
const NEST_NOTICE = 900,
    NEST_FORGET = 1700;
// No two nests within twice the leash, so their pursuits cannot overlap: there is always
// a direction that takes you out of one without carrying you into the next. Spacing is
// what governs density now, not the roll -- most rolls land too near something and are
// dropped.
const NEST_APART = NEST_FORGET * 2;
const GUARD_ORBIT = 120; // how tightly the guard circles its cache

const SCRIPTS = {
    nest: {
        // A cache with three fighters standing over it. Opposition and reward are the same
        // thing to find, so there is a reason to take the fight rather than avoid it. At
        // even odds they were on top of each other -- a chunk is only 900 units across --
        // and no two within twice the leash, so their pursuits cannot overlap: there is
        // always a direction that takes you out of one without carrying you into the next.
        place: { per: 0.15, apart: NEST_APART },
        spawn(e) {
            if (e.state.guards === undefined) {
                e.state.guards = NEST_GUARDS;
                e.state.cache = true;
            }
            if (e.state.cache)
                e.state.cacheShip = encShip(e, { x: e.x, y: e.y, a: 0 }, CACHE);
            // The guard stands off at even bearings from a random start. A berth in rock is
            // skipped rather than shuffled: two fighters is a thinner guard, not a broken nest.
            const phase = rand(0, Math.PI * 2);
            for (let k = 0; k < e.state.guards; k++) {
                const a = phase + (k * Math.PI * 2) / NEST_GUARDS;
                const gx = e.x + Math.cos(a) * NEST_RING,
                    gy = e.y + Math.sin(a) * NEST_RING;
                if (blockedAt(gx, gy, 24, false)) continue;
                encShip(e, { x: gx, y: gy, a }, FIGHTER);
            }
        },

        // What is carried across an unload is what is left, not what state it was in: a
        // fighter that comes back has its dents back too, and would have repaired them in
        // the time you were away anyway.
        pack(e) {
            e.state.cache = [...e.members].some((s) => s.hull === CACHE);
            e.state.guards = [...e.members].filter(
                (s) => s.hull === FIGHTER,
            ).length;
            e.state.cacheShip = null;
        },

        // Not while the guard is still out. A nest that vanishes mid-chase is a nest that
        // was never really there; letting it finish standing down costs a few seconds of
        // nobody watching, which is exactly what we have.
        ready(e) {
            if (e.aggro.size) return false;
            const home = e.state.cacheShip;
            const hx = home ? home.x : e.x,
                hy = home ? home.y : e.y;
            return [...e.members].every(
                (s) =>
                    s.hull.ai !== 'fighter' ||
                    Math.hypot(s.x - hx, s.y - hy) < GUARD_ORBIT * 3,
            );
        },

        think(e) {
            // Rule two lives here: the pool belongs to the encounter, so there is nowhere for
            // one fighter to hold a private opinion about who it is fighting. What one of them
            // notices, all of them are already fighting.
            for (const s of e.members) {
                for (const o of ships) {
                    if (!crewed(o) || o.team === s.team) continue;
                    if (Math.hypot(o.x - s.x, o.y - s.y) < NEST_NOTICE)
                        e.aggro.add(o.id);
                }
            }
            // Rule three, measured from the nest rather than from whoever is chasing, so a
            // pursuit has a leash: run far enough from what they are guarding and they let go.
            for (const id of [...e.aggro]) {
                const o = [...ships].find((q) => q.id === id);
                if (!o || Math.hypot(o.x - e.x, o.y - e.y) > NEST_FORGET)
                    e.aggro.delete(id);
            }

            // ...and then it gives orders, the same way a player would.
            const home = e.state.cacheShip;
            for (const s of e.members) {
                if (s.hull.ai !== 'fighter') continue;
                let prey = null,
                    best = Infinity;
                for (const id of e.aggro) {
                    const o = [...ships].find((q) => q.id === id);
                    if (!o) continue;
                    const d = Math.hypot(o.x - s.x, o.y - s.y);
                    if (d < best) {
                        best = d;
                        prey = o;
                    }
                }
                // Rule one: with nobody to fight, the guard circles what it is guarding.
                s.order =
                    prey ?
                        { kind: 'engage', id: prey.id }
                    :   {
                            kind: 'guard',
                            x: home ? home.x : e.x,
                            y: home ? home.y : e.y,
                            r: GUARD_ORBIT,
                        };
            }
        },
    },
};

// Somewhere clear inside the chunk, and never on top of anyone. The world places the
// nest and stops there -- what a nest is made of is the encounter's business.
// How often a kind of encounter happens, how far apart, and nothing else. Everything that
// made the last one fiddly to get right -- rolling on a newly loaded chunk, keeping the spot
// outside the active radius so it is discovered rather than watched arriving, the spacing
// against its own kind, not landing on somebody, giving up after a few tries -- is here
// rather than in the script. A new kind of opposition says two numbers and is done.
const PLACING = {
    per: 0, // how many of it a newly loaded chunk is worth, on average
    // How clumpy that is. Left out, chance alone decides and the count per chunk is
    // Poisson, which is as steady as independent rolls can be; a larger number spreads the
    // rate itself, so they arrive in groups with emptier ground between. Smaller than
    // Poisson is not on offer -- that would need rolls that know about each other.
    sd: null,
    apart: 0, // never nearer than this to another of its own kind
    clear: ENEMY_CLEAR, // ...nor this near any ship at all
    build: ENC_BUILD, // how close a hull has to be for it to have its ships
    tries: 8, // spots to try in the chunk before letting the roll go
};

// Poisson by Knuth, which is the right shape for "rare thing, independent rolls" and is
// exact rather than a normal curve pretending at small numbers.
function poisson(mean) {
    if (mean <= 0) return 0;
    const limit = Math.exp(-mean);
    let k = 0,
        p = 1;
    do {
        k++;
        p *= Math.random();
    } while (p > limit);
    return k - 1;
}

// Marsaglia and Tsang, for drawing the rate when a kind wants to arrive in clumps.
function gamma(shape) {
    if (shape < 1) return gamma(shape + 1) * Math.pow(Math.random(), 1 / shape);
    const d = shape - 1 / 3,
        c = 1 / Math.sqrt(9 * d);
    for (;;) {
        let x, v;
        do {
            const u1 = Math.random(),
                u2 = Math.random();
            x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
            v = 1 + c * x;
        } while (v <= 0);
        v = v * v * v;
        const u = Math.random();
        if (u < 1 - 0.0331 * x * x * x * x) return d * v;
        if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
}

// How many of this kind a chunk is worth this time. Plain Poisson unless the kind asked to
// be clumpier than that, in which case the rate is itself drawn from a Gamma wide enough to
// give the spread it wanted.
function rollCount(P) {
    if (!(P.per > 0)) return 0;
    const spread = P.sd === null ? 0 : P.sd * P.sd - P.per;
    if (spread <= 0) return poisson(P.per);
    const k = (P.per * P.per) / spread;
    return poisson(gamma(k) * (P.per / k));
}

// Which kinds want placing, and what each asked for, worked out once rather than per chunk.
// After `SCRIPTS`, which is the table it reads.
const PLACED = Object.keys(SCRIPTS).filter((k) => SCRIPTS[k].place?.per > 0);
const PLACING_OF = Object.fromEntries(
    PLACED.map((k) => [k, { ...PLACING, ...SCRIPTS[k].place }]),
);

// Somewhere in this chunk for one of these, or nowhere. Every rule an encounter would
// otherwise have had to remember lives in this function.
function tryPlace(kind, cx, cy) {
    const P = { ...PLACING, ...(SCRIPTS[kind].place || {}) };
    for (let i = 0; i < P.tries; i++) {
        const x = cx * CHUNK + rand(80, CHUNK - 80),
            y = cy * CHUNK + rand(80, CHUNK - 80);
        if (blockedAt(x, y, HULL_CLEAR, false)) continue;
        // Outside the area of interest, always. Ground is made a chunk further out than
        // that, which is the whole reason there is anywhere to put this.
        let out = true;
        for (const q of ships)
            if (crewed(q) && Math.hypot(q.x - x, q.y - y) < AOI_R) {
                out = false;
                break;
            }
        if (!out) continue;
        // Against its own kind rather than against their ships. Testing ships worked only
        // while an encounter built itself the instant it was placed; once placing and
        // building came apart, a dormant one had no hulls to keep the next one away and
        // they packed in on top of each other.
        let room = true;
        for (const e of encounters)
            if (e.kind === kind && Math.hypot(e.x - x, e.y - y) < P.apart) {
                room = false;
                break;
            }
        if (room)
            for (const q of ships)
                if (Math.hypot(q.x - x, q.y - y) < P.clear) {
                    room = false;
                    break;
                }
        if (!room) continue;
        addEncounter(kind, x, y, P.build);
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
const crewed = (s) => s.owner !== null;

// Only a crewed hull makes world. A camera may hold what it is looking at, so nothing
// vanishes in front of you, but it may not call anything into being -- otherwise a player
// with a finger on the map could drag the world into existence for as far as they cared to
// scroll, generating terrain, growing the mesh and deciding biomes for ground nobody has
// been anywhere near.
//
// Three screens is deliberately generous: a screen at full zoom-out reaches MAX_VIEW, so
// the edge of what exists stays two screens beyond anything anyone can see.
const AOI_R = MAX_VIEW * 3;
const AOI_KEEP = AOI_R + 900; // a chunk of hysteresis, so a hovering ship does not thrash
// Ground is made a chunk further out than the area of interest reaches. Nothing is played
// out there -- it is a skirt, so that there is somewhere for a thing to be placed that is
// *outside* the active radius and can be discovered by pushing the radius over it. A nest
// rolled in a chunk inside the radius is a nest that was not there a moment ago.
const AOI_LOAD = AOI_R + CHUNK;
const CHUNK_KEEP = AOI_LOAD + CHUNK; // ...and the same hysteresis on top of the skirt

function shipAnchors() {
    const out = [];
    for (const s of ships) if (crewed(s)) out.push({ x: s.x, y: s.y });
    return out;
}

function watchAnchors() {
    const out = [];
    for (const p of players.values())
        if (p.view && p.ws && p.ws.readyState === 1)
            out.push({ x: p.view.x, y: p.view.y });
    return out;
}

// Cells are what generate; chunks only hold what cells have already put there. So the
// mesh has to be walked out ahead of the ships deliberately, rather than as a side effect
// of somebody asking what is at a point. Once a second is plenty: a cell is three and a
// half screens across and the area of interest is seven, so there is a long way to go
// before anybody reaches ground that has not been asked about.
const pendingCells = [];
const queuedCells = new Set(); // in memory only: a restart before generating must requeue
let cellTick = 0;

function manageCells() {
    if (cellTick++ % 30 === 0) {
        const anchors = shipAnchors();
        // Grow the mesh over the ground anyone is near. Nothing is partitioned ahead of this:
        // a cell is bound, and its neighbours placed, at the moment it is first asked for.
        for (const a of anchors)
            for (let x = a.x - AOI_R; x <= a.x + AOI_R; x += CELL_R / 2)
                for (let y = a.y - AOI_R; y <= a.y + AOI_R; y += CELL_R / 2)
                    siteFor(x, y);
        // ...then queue the real sites that still owe content. Taking what siteFor handed back
        // instead was a bug worth remembering: it answers with a throwaway {kind:'open'} when
        // it cannot settle a cell, and that object is new every sweep, so it never deduplicated
        // and the queue filled with work that could never be done while real cells starved
        // behind it at one a tick. Flying out far enough, terrain simply stopped arriving.
        for (const s of sites) {
            // A set piece whose version has moved past what generated it is laid out again. An
            // older world recorded `true` rather than a number, which is behind every version.
            const stale =
                s.kind in SET_VERSION && s.gen !== SET_VERSION[s.kind];
            if (!s.kind || (s.gen && !stale) || queuedCells.has(s)) continue;
            // Still only ground somebody is near: reach is measured from the cell, not the site,
            // because a sprawling one is a long way across.
            if (
                !anchors.some(
                    (a) =>
                        Math.hypot(a.x - s.x, a.y - s.y) <
                        AOI_R + cellRadius(s),
                )
            )
                continue;
            queuedCells.add(s);
            pendingCells.push(s);
        }
    }
    // One cell per tick. Generating is a boolean over a few hundred polygons and has no
    // business in the same frame as the physics; the queue is what keeps it out.
    const s = pendingCells.shift();
    if (s) depositCell(s);
}

function manageChunks() {
    manageCells();
    for (const a of shipAnchors())
        for (
            let cx = chunkOf(a.x - AOI_LOAD);
            cx <= chunkOf(a.x + AOI_LOAD);
            cx++
        )
            for (
                let cy = chunkOf(a.y - AOI_LOAD);
                cy <= chunkOf(a.y + AOI_LOAD);
                cy++
            )
                loadChunk(cx, cy);

    const keep = new Set();
    const hold = (a, r) => {
        for (let cx = chunkOf(a.x - r); cx <= chunkOf(a.x + r); cx++)
            for (let cy = chunkOf(a.y - r); cy <= chunkOf(a.y + r); cy++)
                keep.add(chunkKey(cx, cy));
    };
    for (const a of shipAnchors()) hold(a, CHUNK_KEEP);
    for (const a of watchAnchors()) hold(a, STREAM_R + 400);
    for (const key of [...chunks.keys()])
        if (!keep.has(key)) {
            chunks.delete(key);
            wallsDirty = true;
        }
    if (wallsDirty) rebuildWalls();
}

// Walls in the 3x3 block of chunks around a point. `ensure` pulls the chunks off disk,
// which only spawn checks want -- the tick loop works from what is already resident. A
// wall wider than a chunk sits in several bins, so the same one can come back twice.
function nearbyWalls(x, y, ensure = false) {
    const cx0 = chunkOf(x),
        cy0 = chunkOf(y);
    if (ensure)
        for (let cx = cx0 - 1; cx <= cx0 + 1; cx++)
            for (let cy = cy0 - 1; cy <= cy0 + 1; cy++) loadChunk(cx, cy);
    if (wallsDirty) rebuildWalls();
    const out = [],
        seen = new Set();
    for (let cx = cx0 - 1; cx <= cx0 + 1; cx++)
        for (let cy = cy0 - 1; cy <= cy0 + 1; cy++)
            for (const w of wallBins.get(chunkKey(cx, cy)) || [])
                if (!seen.has(w.key)) {
                    seen.add(w.key);
                    out.push(w.rings);
                }
    return out;
}

// What kind of matter is standing at a point, or null. Ranked, so where two kinds abut the
// harder one is what the map records -- the town's own wall should not read as rock because
// a boulder is leaning on it.
function matterAt(x, y) {
    let best = null;
    if (wallsDirty) rebuildWalls();
    const cx0 = chunkOf(x),
        cy0 = chunkOf(y);
    for (let cx = cx0 - 1; cx <= cx0 + 1; cx++)
        for (let cy = cy0 - 1; cy <= cy0 + 1; cy++)
            for (const w of wallBins.get(chunkKey(cx, cy)) || []) {
                if (best && MAT_RANK[w.mat] <= MAT_RANK[best]) continue;
                if (pointInWall(w.rings, x, y)) best = w.mat;
            }
    return best;
}

// Blocking matter near a point: the walls asteroids cannot pass. Everything collides with
// walls the same way, so this asks the material rather than the shape.
function nearbyBlocking(x, y) {
    if (wallsDirty) rebuildWalls();
    const out = [],
        seen = new Set();
    const cx0 = chunkOf(x),
        cy0 = chunkOf(y);
    for (let cx = cx0 - 1; cx <= cx0 + 1; cx++)
        for (let cy = cy0 - 1; cy <= cy0 + 1; cy++)
            for (const w of wallBins.get(chunkKey(cx, cy)) || [])
                if (w.mat === 'block' && !seen.has(w.key)) {
                    seen.add(w.key);
                    out.push(w.rings);
                }
    return out;
}

// Where a rock of radius `rad` meets blocking matter, and the way out of it: the nearest
// point on the surface plus the normal there. A rock already inside is pushed toward the
// nearest surface rather than away from it, which is the only direction that gets it out.
function blockingHit(x, y, rad) {
    for (const rings of nearbyBlocking(x, y)) {
        const inside = pointInWall(rings, x, y);
        const c = closestOnWall(rings, x, y);
        if (!inside && c.d >= rad) continue;
        const dx = inside ? c.x - x : x - c.x,
            dy = inside ? c.y - y : y - c.y;
        const d = Math.hypot(dx, dy) || 1;
        return { x: c.x, y: c.y, nx: dx / d, ny: dy / d };
    }
    return null;
}

// A wall is a list of rings: the first is its outline, any others are holes punched
// through it. Crossing-count over every ring at once gives the even-odd answer, which
// puts a point inside a hole correctly outside the wall.
function pointInWall(wall, x, y) {
    let inside = false;
    for (const ring of wall)
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i],
                [xj, yj] = ring[j];
            if (
                yi > y !== yj > y &&
                x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
            )
                inside = !inside;
        }
    return inside;
}

// Nearest point on any edge of any ring: a hole's rim is a surface to be pushed off
// exactly as the outline is.
function closestOnWall(wall, x, y) {
    let px = 0,
        py = 0,
        best = Infinity;
    for (const ring of wall)
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [ax, ay] = ring[j],
                [bx, by] = ring[i];
            const ex = bx - ax,
                ey = by - ay;
            const t = Math.max(
                0,
                Math.min(
                    1,
                    ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey || 1),
                ),
            );
            const qx = ax + ex * t,
                qy = ay + ey * t;
            const d = Math.hypot(x - qx, y - qy);
            if (d < best) {
                best = d;
                px = qx;
                py = qy;
            }
        }
    return { x: px, y: py, d: best };
}

function segsCross(ax, ay, bx, by, cx, cy, dx, dy) {
    const r1 = bx - ax,
        r2 = by - ay,
        s1 = dx - cx,
        s2 = dy - cy;
    const den = r1 * s2 - r2 * s1;
    if (Math.abs(den) < 1e-12) return false; // parallel
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
                if (
                    segsCross(
                        ax,
                        ay,
                        bx,
                        by,
                        ring[j][0],
                        ring[j][1],
                        ring[i][0],
                        ring[i][1],
                    )
                )
                    return true;
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
            x += (dx / len) * push;
            y += (dy / len) * push;
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
const ROCKS_PER_SCREEN = ((MAX_VIEW * MAX_VIEW * 576) / 337) * ROCK_DENSITY;
const RICH_SCREENS = [1, 25, 100]; // screens you cross, on average, per +1, +2, +3

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
    const made = {
        id: nextId++,
        size,
        x,
        y,
        vx: rand(-70, 70),
        vy: rand(-70, 70),
        a: rand(0, Math.PI * 2),
        spin: rand(-1.2, 1.2),
        r: size * 16,
        seed: Math.floor(Math.random() * 1e6),
        grace, // seconds before this rock can hurt anything
        rich, // 0-3 grains showing, and that many handed over per break
    };
    rocks.push(made);
    return made;
}

// What is left of a rock that came apart, wherever it was standing: two smaller rocks
// and a handful of ore shaken loose. The pieces cannot hurt anything for a moment, which
// is what stops a cascade landing all at once.
//
// Any rock coming apart may give up ore, and mostly does not: one grain a sixth of the
// time, and a second grain in a fifth of those. Five rocks in six leave nothing at all,
// which is what keeps a battle from carpeting the field in gravel.
const ORE_CHANCE = 1 / 6,
    ORE_SECOND = 1 / 5;
function shed(x, y) {
    if (Math.random() >= ORE_CHANCE) return;
    spawnOre(x, y);
    if (Math.random() < ORE_SECOND) spawnOre(x, y);
}

// `off` is the surface it came apart against, if it came apart against one: the pieces
// are put down clear of it and thrown back along its normal. Without that they break out
// standing inside the wall, break again immediately, and the wall visibly eats the rock
// instead of turning it away.
function shatter(r, off = null) {
    shed(r.x, r.y);
    // What it was showing, it hands over -- on top of the roll, and on every break rather
    // than only the last one. Its children carry the same seam, so a rich rock pays out
    // again for each piece you take the trouble to finish.
    for (let i = 0; i < r.rich; i++) spawnOre(r.x, r.y);
    if (r.size <= 1) return;
    for (let i = 0; i < 2; i++) {
        const kid = spawnRock(r.size - 1, r.x, r.y, SPLIT_GRACE, r.rich);
        if (!off) continue;
        // Reflect what it arrived with, so a glancing rock leaves at a glancing angle, and
        // spread the two pieces apart. The floor stops a rock that crept in almost stationary
        // from being left sitting against the wall.
        const dot = r.vx * off.nx + r.vy * off.ny;
        let bx = r.vx - 2 * dot * off.nx,
            by = r.vy - 2 * dot * off.ny;
        const sp = Math.max(90, Math.hypot(bx, by));
        const a = Math.atan2(by, bx) + rand(-0.5, 0.5);
        kid.vx = Math.cos(a) * sp;
        kid.vy = Math.sin(a) * sp;
        kid.x = off.x + off.nx * (kid.r + 8);
        kid.y = off.y + off.ny * (kid.r + 8);
    }
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
        const a = rand(0, Math.PI * 2),
            d = Math.sqrt(Math.random()) * reach;
        const x = ax + Math.cos(a) * d,
            y = ay + Math.sin(a) * d;
        let clear = !blockedAt(x, y, 70);
        if (clear)
            for (const s of ships)
                if (Math.hypot(s.x - x, s.y - y) < SPAWN_SEP) {
                    clear = false;
                    break;
                }
        if (clear) return { x, y };
    }
    return { x: ax + rand(-3000, 3000), y: ay + rand(-3000, 3000) }; // pathologically crowded
}

// Uniform over the disc (hence the sqrt -- sampling the radius directly would pile
// rocks up around the ship), holding them off the hull itself.
const SEED_MIN = 150;
// Ore is allowed to come and go in plain sight, so it is scattered near the ship the way
// it always was.
const oreSpot = (s) => {
    const a = rand(0, Math.PI * 2),
        d = Math.sqrt(rand(SEED_MIN ** 2, ACTIVE_R ** 2));
    return [s.x + Math.cos(a) * d, s.y + Math.sin(a) * d];
};

// Rock is not. A new ship gets its field laid out across the whole area it will hold...
const rockSeedSpot = (s) => {
    const a = rand(0, Math.PI * 2),
        d = Math.sqrt(rand(SEED_MIN ** 2, AOI_KEEP ** 2));
    return [s.x + Math.cos(a) * d, s.y + Math.sin(a) * d];
};
// ...and everything after that arrives in the thin band just past the edge of interest,
// three screens out, where nobody can watch it happen. The band sits inside the cull
// radius on purpose: a rock spawned beyond what the stocking counts would never be
// counted, and the field would grow without bound.
const rockBandSpot = (s) => {
    const a = rand(0, Math.PI * 2),
        d = rand(AOI_R, AOI_R * 1.06);
    return [s.x + Math.cos(a) * d, s.y + Math.sin(a) * d];
};

function spawnOre(x, y, mod = null) {
    ore.push({
        id: nextId++,
        x,
        y,
        vx: rand(-40, 40),
        vy: rand(-40, 40),
        a: rand(0, Math.PI * 2),
        spin: rand(-2, 2),
        r: mod ? 7 : 5,
        // A module is loot rather than scenery: it waits far longer than a grain, because
        // watching one disperse while you turn towards it would be the worst thing in the game.
        life: mod ? ORE_LIFE * 20 : ORE_LIFE,
        held: null, // the one ship whose beam has it
        mod, // a module type if this is one, null if it is ore
    });
}

// What a cache lets go of besides its ore. Only what can actually be installed by hand --
// the fixed sorts are part of a hull and are nobody's salvage.
const LOOT = Object.keys(MODULES).filter((t) => !MODULES[t].fixed);

// Top a ship's neighbourhood back up to ROCK_TARGET, placing new rocks where `spot` says.
// Outside every ship's area of interest, not just the one being stocked. A fleet spread
// out puts one ship's rim through another ship's neighbourhood, and a rock arriving at
// six thousand units from one hull can be three hundred from the next.
function outsideEveryone(at) {
    for (const q of ships)
        if (crewed(q) && Math.hypot(at[0] - q.x, at[1] - q.y) < AOI_R)
            return false;
    return true;
}

function stock(s, spot) {
    // Counted over the same disc it is culled at, so a rock placed in the band counts
    // toward the target that asked for it.
    const want = Math.round(ROCK_DENSITY * Math.PI * AOI_KEEP * AOI_KEEP);
    let near = 0;
    for (const r of rocks)
        if (Math.hypot(r.x - s.x, r.y - s.y) < AOI_KEEP) near++;
    for (; near < want; near++) {
        let at = null;
        for (let try_ = 0; try_ < 8 && !at; try_++) {
            const p = spot(s);
            if (outsideEveryone(p)) at = p;
        }
        if (!at) break; // hemmed in this tick; the next one will place it
        spawnRock(3, ...at);
    }
}

const PLAYER_TEAM = 'players'; // every human shares one side, for now
// Build a ship's installed modules from a fit. This is the only thing that makes turrets,
// so a refit is the same operation as leaving the yard.
function fitTurrets(hull, fit) {
    const where = new Map(hull.installs.map((p) => [p.id, p.at]));
    return fit
        .filter((f) => where.has(f.install) && MODULES[f.type])
        .map((f) => ({
            install: f.install,
            type: f.type,
            at: where.get(f.install),
            rot: f.rot,
            a: f.rot,
            cool: rand(0, MODULES[f.type].cooldown),
            hp: MODULES[f.type].hp,
            wx: 0,
            wy: 0,
        }));
}

function newShip(owner, team, at = {}, hull = CARRIER) {
    const facing = at.a ?? rand(0, Math.PI * 2);
    const spot =
        at.x === undefined ?
            spawnPoint(at.nearX ?? 0, at.nearY ?? 0, at.reach)
        :   at;
    const s = {
        id: nextId++,
        owner,
        team,
        hull,
        x: spot.x,
        y: spot.y,
        vx: 0,
        vy: 0,
        a: facing,
        heading: facing, // where it wants to point once it is done travelling
        th: 0,
        dest: null,
        braking: false,
        detourSide: 0,
        stuckFor: 0,
        turrets: fitTurrets(hull, hull.fit),
        hold: {}, // modules pulled off and not yet reinstalled, counted by type
        side: Math.random() < 0.5 ? 1 : -1, // which way this one likes to break
        sideFor: rand(1.2, 3.5),
        wander: 0,
        order: null, // what it has been told to do, by whoever is in charge of it
        arm: null, // a marker it is on its way to use
        ore: 0, // what its hold has picked up
        beams: [], // the grains its tractors have hold of, for anyone watching
        prio: defaultPrio(),
        repairing: null, // index of the one gun the repair point is going into
        repairHold: 0, // seconds left before the crew may look elsewhere
        repairFocus: [], // guns named by hand, which outrank the curve entirely
        focus: null, // one ship this one shoots at in preference to anything else
    };
    ships.add(s);
    if (crewed(s)) {
        stock(s, rockSeedSpot);
        stockOre(s, oreSpot);
    } // arrives in a populated neighbourhood, not a void
    return s;
}

function hit(o1, o2) {
    const dx = o1.x - o2.x,
        dy = o1.y - o2.y,
        rr = o1.r + o2.r;
    return dx * dx + dy * dy < rr * rr;
}

// The only integrator. The live sim and the autopilot's rollout both run this, so a
// prediction cannot drift from what actually happens.
function advance(st, cmd, dt, hull) {
    // How fast it is turning, kept because it is half of what a client needs to carry on
    // turning by itself between one word from the server and the next.
    st.va = dt > 0 ? cmd.turn / dt : 0;
    st.a += cmd.turn;
    if (cmd.thrust) {
        st.vx += Math.cos(st.a) * hull.accel * dt;
        st.vy += Math.sin(st.a) * hull.accel * dt;
    }
    const sp = Math.hypot(st.vx, st.vy);
    if (sp > hull.maxSpeed) {
        st.vx = (st.vx / sp) * hull.maxSpeed;
        st.vy = (st.vy / sp) * hull.maxSpeed;
    }
    st.x += st.vx * dt;
    st.y += st.vy * dt;
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
    const bx = ux * hull.maxSpeed - st.vx,
        by = uy * hull.maxSpeed - st.vy;
    if (Math.hypot(bx, by) < 1) return { turn: 0, thrust: 0 }; // already at cruise: coast
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
const DETOUR_CLEAR = 90; // how far outside the silhouette to aim
const HULL_CLEAR = 70; // room a carrier needs to sit somewhere
const STUCK_SECONDS = 2.5; // pressed against rock this long: the order is over

function detourAim(s) {
    const walls = nearbyWalls(s.x, s.y);
    if (!walls.length || !segmentBlocked(s.x, s.y, s.dest.x, s.dest.y, walls)) {
        s.detourSide = 0; // the way is open; forget which way we were going
        return null;
    }
    let blocking = null;
    for (const wall of walls)
        if (segmentBlocked(s.x, s.y, s.dest.x, s.dest.y, [wall])) {
            blocking = wall;
            break;
        }
    if (!blocking) {
        s.detourSide = 0;
        return null;
    }

    // The silhouette: the two vertices furthest to either side of the straight line.
    const toDest = Math.atan2(s.dest.y - s.y, s.dest.x - s.x);
    let left = -Infinity,
        right = Infinity,
        lv = null,
        rv = null;
    for (const ring of blocking)
        for (const [x, y] of ring) {
            const off = angleDiff(Math.atan2(y - s.y, x - s.x), toDest);
            if (off > left) {
                left = off;
                lv = [x, y];
            }
            if (off < right) {
                right = off;
                rv = [x, y];
            }
        }
    if (!lv || !rv) return null;

    // Aiming past a corner is worthless if the corner itself is behind more rock, so each
    // candidate is only accepted when we can actually get to it in a straight line.
    const candidate = (side) => {
        const v = side > 0 ? lv : rv;
        const d = Math.hypot(v[0] - s.x, v[1] - s.y) || 1;
        const bearing =
            Math.atan2(v[1] - s.y, v[0] - s.x) + side * (DETOUR_CLEAR / d);
        const aim = {
            x: s.x + Math.cos(bearing) * d,
            y: s.y + Math.sin(bearing) * d,
        };
        return segmentBlocked(s.x, s.y, aim.x, aim.y, walls) ? null : aim;
    };

    // Commit to a side for the duration -- re-deciding every tick makes a ship dither
    // along the middle of an obstacle instead of rounding either end -- but take the other
    // way round rather than steering into rock.
    if (!s.detourSide)
        s.detourSide = Math.abs(left) <= Math.abs(right) ? 1 : -1;
    return candidate(s.detourSide) ?? candidate(-s.detourSide) ?? null;
}

// Two states, and the boundary between them is measured rather than derived:
// run at full throttle while there is still room to stop, then stop.
function autopilot(s, dt) {
    const hull = s.hull;
    const dx = s.dest.x - s.x,
        dy = s.dest.y - s.y;
    const dist = Math.hypot(dx, dy);
    if (dist < hull.arriveR && Math.hypot(s.vx, s.vy) < hull.arriveV) {
        s.dest = null;
        s.vx = 0;
        s.vy = 0; // last few px/s of drift, killed rather than coasted forever
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
            s.dest = null;
            s.vx = 0;
            s.vy = 0;
            s.stuckFor = 0;
            s.detourSide = 0;
            return { turn: 0, thrust: 0 };
        }
    } else s.stuckFor = 0;

    // Rock in the way: steer for the edge of it instead, at speed. Braking is for the
    // destination, and the destination is not where we are currently pointed.
    const aim = detourAim(s);
    if (aim) {
        s.braking = false;
        const ax = aim.x - s.x,
            ay = aim.y - s.y,
            ad = Math.hypot(ax, ay) || 1;
        return chaseCmd(s, ax / ad, ay / ad, hull, dt);
    }
    // Committing matters: chase and brake are both full-throttle, so re-deciding every
    // tick makes the ship dither on the boundary instead of crossing it. Once the stop
    // starts it runs to completion, then the next chase begins from a standstill.
    if (!s.braking && dist <= stopDistance(s, hull)) s.braking = true;
    if (s.braking && Math.hypot(s.vx, s.vy) <= hull.arriveV) s.braking = false;
    return s.braking ?
            brakeCmd(s, hull, dt)
        :   chaseCmd(s, dx / dist, dy / dist, hull, dt);
}

// Mounts ride the hull, so their world positions move every tick. Everything that
// aims at or shoots a turret needs these, so they are computed once for all ships
// rather than re-derived per shooter.
function placeTurrets() {
    for (const s of ships) {
        const cos = Math.cos(s.a),
            sin = Math.sin(s.a);
        for (let i = 0; i < s.turrets.length; i++) {
            const t = s.turrets[i];
            t.wx = s.x + t.at[0] * cos - t.at[1] * sin;
            t.wy = s.y + t.at[0] * sin + t.at[1] * cos;
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
const SPILL_RATE = 5; // grains a second

function bleed(dt) {
    for (let i = spills.length - 1; i >= 0; i--) {
        const s = spills[i];
        s.due -= dt;
        while (s.due <= 0 && s.left > 0) {
            spawnOre(s.x + rand(-18, 18), s.y + rand(-18, 18));
            s.left--;
            s.due += 1 / SPILL_RATE;
        }
        if (s.left <= 0) spills.splice(i, 1);
    }
}

// `by` is the player whose shell did it, or null for anything nobody owns -- a rock that
// finished off a fighter, or one raider's shot landing on another. A tally is only ever
// kept for a kill somebody can be said to have made.
function wound(s, t, amount, by = null) {
    t.hp = t.hp - amount <= 0 ? -WRECK_DEPTH : t.hp - amount;
    if (t.hp <= 0 && s.hull.frail) {
        // Read before the group lets go of it: what was killed and what it was part of are
        // both wanted, and one of them is about to be unhooked.
        if (by !== null) credit(by, s);
        ships.delete(s);
        if (s.enc) s.enc.members.delete(s);
        // A broken cache does not vanish: it lets its ore go over the same ten seconds the
        // client spends drawing it coming apart, so what you see and what you can collect
        // are the same event.
        if (s.hull.spills) {
            spills.push({ x: s.x, y: s.y, left: s.hull.spills, due: 0 });
            // And one module, which is the thing actually worth crossing the map for.
            spawnOre(
                s.x + rand(-24, 24),
                s.y + rand(-24, 24),
                LOOT[Math.floor(Math.random() * LOOT.length)],
            );
        }
        kills.push({
            x: Math.round(s.x),
            y: Math.round(s.y),
            a: +s.a.toFixed(2),
            h: hullKey(s.hull),
        });
    }
}

// What a player has destroyed, by what it was and what it was part of: `kills.cache.nest`
// is the number of nest caches they have broken. Two dimensions because the same hull means
// different things in different company -- a cache standing alone is salvage, and a cache
// with a guard over it is a fight somebody went looking for.
//
// It is player state rather than conversation state, which is why it sits here and not in
// one of the bags: those are ten flags a conversation branches on, and this is a record of
// what has happened in the world. A quest reads it; it does not own it.
function credit(pid, s) {
    const p = players.get(pid);
    if (!p) return; // gone in the time the shell was in the air
    const enemy = hullKey(s.hull);
    const where = s.enc?.kind ?? 'loose'; // killed out on its own, not as part of anything
    p.kills[enemy] ??= {};
    p.kills[enemy][where] = (p.kills[enemy][where] ?? 0) + 1;
    playersDirty = true;
    // What the list says is worked out from the tally, so the tally moving is the only
    // thing that can change it without anybody saying a word.
    sendQuests(p);
}

// What a given side is willing to shoot: every rock, plus the live guns of anyone
// on another team. A silenced turret is no longer worth a shell.
// Every candidate names the ship it belongs to, so an order given against a ship
// reaches the guns bolted to it. A rock belongs to nobody, which is what null means.
function targetsFor(team) {
    const list = rocks.map((r) => ({
        kind: 'rock',
        ship: null,
        x: r.x,
        y: r.y,
        vx: r.vx,
        vy: r.vy,
        r: r.r,
    }));
    for (const s of ships) {
        if (s.team === team) continue;
        // Set into rock, so no shell can arrive: aiming at one is a gun wasted and a fighter
        // stalled at the mouth plinking at something it cannot touch.
        if (s.hull.embedded) continue;
        // What kind of thing a mount counts as is the hull's business: a fighter is one
        // mount, and asking a gun to rank it against a carrier's battery is a different
        // question from ranking one battery against another.
        for (const t of s.turrets)
            if (t.hp > 0)
                list.push({
                    kind: s.hull.targetKind || 'turret',
                    ship: s.id,
                    // The hull and the mount themselves, for a shot that is resolved where
                    // it is fired: a shell finds what it hits by flying into it, and a
                    // hitscan gun has to be told.
                    body: s,
                    mount: t,
                    x: t.wx,
                    y: t.wy,
                    vx: s.vx,
                    vy: s.vy,
                    r: MODULES[t.type].hitR,
                });
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
    const target = [...ships].find((q) => q.id === o.id);
    return target ? { x: target.x, y: target.y, orbit: ORBIT_R } : null;
}

// A fighter picks the nearest crewed ship it can see and works it: it aims off to one
// side of its quarry by an angle that opens up as it closes, which is a straight run at
// long range and a turn across the bows at short, so it makes passes rather than sitting
// still to be shot. The side it favours flips at odd intervals and its aim wanders, so a
// gun leading it has to lead something that is not on rails.
const ORBIT_R = 200; // how close it tries to cut past what it is fighting
const WANDER = 0.9,
    SIDE_MIN = 1.2,
    SIDE_MAX = 3.5;
// How far ahead it looks, and a feeler either side of the nose to say which way is open.
// The horizon has to beat the turn: flat out it needs about maxSpeed/turn = 100 units to
// come round, so looking half a second (170) ahead left it committing too late to matter.
// Nearly a second gives it room to have turned before it arrives.
const FEEL_MIN = 110,
    FEEL_TIME = 0.9,
    FEEL_SPREAD = 0.6;

function fighterCmd(s, dt) {
    // Somebody else decided what to fly at; this only knows how to fly at something.
    const mark = orderMark(s);
    if (!mark) return { turn: 0, thrust: 0 }; // nothing to do: drift
    const best = Math.hypot(mark.x - s.x, mark.y - s.y);

    s.sideFor -= dt;
    if (s.sideFor <= 0) {
        s.side = -s.side;
        s.sideFor = rand(SIDE_MIN, SIDE_MAX);
    }
    // A slow random walk on the aim, bounded, so it weaves instead of tracking cleanly.
    s.wander = clamp(s.wander + rand(-WANDER, WANDER) * dt, 0.5);

    const polys = nearbyWalls(s.x, s.y);
    const bearing = Math.atan2(mark.y - s.y, mark.x - s.x);
    // With rock in between there is nothing to circle: come straight on and let the
    // feelers below work out how to get round. Circling something you cannot see is how a
    // fighter ends up grinding along the far side of a wall.
    const sighted =
        !polys.length || !segmentBlocked(s.x, s.y, mark.x, mark.y, polys);
    // Tangent to a circle of ORBIT_R about the quarry: zero far out, a quarter turn at the
    // circle itself. Newton does the rest -- it overshoots, and coming back round is the
    // orbit.
    const lead =
        sighted ?
            Math.asin(Math.min(1, mark.orbit / Math.max(best, mark.orbit)))
        :   0;
    let want = bearing + s.side * lead + s.wander;
    let hold = false; // cut thrust rather than pile in

    // Feelers. Nothing here plans a route: it looks a moment ahead along its own nose, and
    // if that moment ends in rock it takes whichever way round is open. A fighter carries
    // its speed into whatever it hits, so the useful question is not "where is the wall"
    // but "will I still be flying in half a second".
    if (polys.length) {
        const reach = Math.max(FEEL_MIN, Math.hypot(s.vx, s.vy) * FEEL_TIME);
        const clear = (a) =>
            !segmentBlocked(
                s.x,
                s.y,
                s.x + Math.cos(a) * reach,
                s.y + Math.sin(a) * reach,
                polys,
            );
        if (!clear(s.a)) {
            const port = clear(s.a - FEEL_SPREAD),
                star = clear(s.a + FEEL_SPREAD);
            // Keep breaking the way it was already breaking when both are open, so avoiding a
            // wall does not undo the weave.
            if (port || star)
                want =
                    s.a +
                    (star && (!port || s.side > 0) ?
                        FEEL_SPREAD
                    :   -FEEL_SPREAD);
            else {
                want = s.a + Math.PI;
                hold = true;
            } // boxed in: come about, off the gas
        }
    }

    const err = angleDiff(want, s.a);
    // Burn whenever it is roughly pointed where it wants to go; a fighter is never coasting
    // for long, which is what keeps it hard to lead.
    return {
        turn: clamp(err, s.hull.turn * dt),
        thrust: !hold && Math.abs(err) < 0.9 ? 1 : 0,
    };
}

// With no move order the ship holds station and simply comes round to its heading.
// Travelling overrides this: the autopilot needs the nose for burns, so a heading set
// while under way only takes effect once the ship has arrived and stopped.
function faceCmd(s, dt) {
    return {
        turn: clamp(angleDiff(s.heading, s.a), s.hull.turn * dt),
        thrust: 0,
    };
}

// Time until a shot fired now meets a target moving at constant velocity:
// |D + U t| = B t, i.e. (|U|^2 - B^2) t^2 + 2 D.U t + |D|^2 = 0. Null if the
// target outruns the shell or the solution lies in the past.
function intercept(dx, dy, ux, uy, B) {
    const a = ux * ux + uy * uy - B * B;
    const b = 2 * (dx * ux + dy * uy);
    const c = dx * dx + dy * dy;
    if (Math.abs(a) < 1e-9)
        return (
            Math.abs(b) < 1e-9 ? null
            : -c / b > 0 ? -c / b
            : null
        );
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const rt = Math.sqrt(disc);
    const roots = [(-b - rt) / (2 * a), (-b + rt) / (2 * a)].filter(
        (v) => v > 0,
    );
    return roots.length ? Math.min(...roots) : null;
}

// A shot with no shell. It is decided where it is fired: a roll against range says whether
// it lands, the damage goes on at once, and what everybody near enough is told is a line
// that was there for an instant. Missing is drawn as well as hitting -- a gun that only
// showed its hits would look like it was firing in bursts rather than being outshot.
const tracers = [];
function hitscan(s, t, T, at) {
    const H = T.hitscan;
    const u = Math.max(0, Math.min(1, at.range / T.range));
    const hit = Math.random() < H.near + (H.far - H.near) * u;
    // A miss goes wide by a hair rather than stopping short, so the line still reads as
    // aimed at something.
    const wide =
        hit ? 0 : (Math.random() < 0.5 ? -1 : 1) * (8 + Math.random() * 14);
    const a = at.bearing + wide / Math.max(60, at.range);
    const reach = Math.hypot(at.ax - t.wx, at.ay - t.wy);
    tracers.push({
        x: Math.round(t.wx),
        y: Math.round(t.wy),
        x2: Math.round(t.wx + Math.cos(a) * reach),
        y2: Math.round(t.wy + Math.sin(a) * reach),
        h: hit ? 1 : 0,
    });
    if (hit && at.g.mount?.hp > 0)
        wound(at.g.body, at.g.mount, H.damage, s.owner);
}

// Turret bearings are world-space: the mount rides the hull, the gun holds its own
// bearing. A gun fires only on the tick its slew lands exactly on the firing
// solution, so the shot leaves along the solved bearing rather than near it.
const LOS_TRIES = 6; // give up on a turret rather than sight-check a whole battlefield

function aimTurrets(s, targets, dt) {
    // An embedded gun answers no line-of-sight question at all: it is standing in a wall, so
    // every shot it could ever take is blocked, and the exemption is the whole point of it.
    const polys = s.hull.embedded ? [] : nearbyWalls(s.x, s.y); // once per ship, not per gun
    for (let i = 0; i < s.turrets.length; i++) {
        const t = s.turrets[i];
        const T = MODULES[t.type];
        if (t.hp <= 0) continue; // a dead gun neither tracks nor fires
        const rest = s.a + t.rot;

        // Everything this gun could shoot, best first, then take the best one it can
        // actually see. Picking the best and then rejecting it would leave the gun idle
        // while a clear target stood behind it.
        const shots = [];
        for (const g of targets) {
            // A mount that only answers one kind of question does not get asked others.
            if (T.only && g.kind !== T.only) continue;
            const dx = g.x - t.wx,
                dy = g.y - t.wy;
            const range = Math.hypot(dx, dy) - g.r;
            if (range >= T.range) continue;
            const score = prioAt(s.prio[g.kind], range / T.range);
            if (score <= 0) continue; // zero priority is "do not engage"
            // Focus fire outranks the envelope but does not overrule it: it decides which of
            // the targets this ship is willing to engage comes first, and a refusal stands.
            //
            // The first pass is the focused ship AND everything belonging to nobody. Being
            // told to concentrate on a hull is not a reason to ignore the rock about to hit
            // you; it is a reason to ignore the other hull. Within the pass the envelope
            // decides, so a rock close enough to matter still outranks a distant target.
            // With no focus set there is only one pass, which is the behaviour this replaced.
            const tier =
                s.focus === null || g.ship === null || g.ship === s.focus ?
                    0
                :   1;

            const ux = g.vx - s.vx,
                uy = g.vy - s.vy; // bullets inherit the hull's velocity
            // Nothing to lead: a hitscan shot arrives where it is pointed, at once.
            const ti = T.hitscan ? 0 : intercept(dx, dy, ux, uy, BULLET_SPEED);
            if (ti === null || ti > BULLET_LIFE) continue; // shell would expire before arrival
            const bearing = Math.atan2(dy + uy * ti, dx + ux * ti);
            if (Math.abs(angleDiff(bearing, rest)) > T.arcHalf) continue; // outside this mount's arc
            shots.push({
                g,
                tier,
                score,
                range,
                bearing,
                ax: g.x + ux * ti,
                ay: g.y + uy * ti,
            });
        }
        // Nearest breaks a tie, which is what makes a flat envelope behave exactly like the
        // nearest-first rule this replaced.
        shots.sort(
            (p, q) => p.tier - q.tier || q.score - p.score || p.range - q.range,
        );

        // The sight budget is spent per pass, not across the whole list. A focused ship
        // contributes exactly as many candidates as it has guns, so a single flat budget let
        // one hull behind a wall consume the lot and leave the turret idle with a target in
        // plain view. Refusing to shoot is the envelope's job -- zero priority -- so focus
        // decides what comes first and nothing more.
        let want = null,
            at = null; // the shot that answered, for a gun that resolves its own hit
        for (const group of [
            shots.filter((x) => x.tier === 0),
            shots.filter((x) => x.tier === 1),
        ]) {
            for (let k = 0; k < group.length && k < LOS_TRIES; k++) {
                if (
                    polys.length &&
                    segmentBlocked(t.wx, t.wy, group[k].ax, group[k].ay, polys)
                )
                    continue;
                want = group[k].bearing;
                at = group[k];
                break;
            }
            if (want !== null) break;
        }

        t.cool -= dt;
        const step = T.turn * dt;
        const err = angleDiff(want === null ? rest : want, t.a);
        const wasA = t.a;
        t.a += clamp(err, step);
        t.a = rest + clamp(angleDiff(t.a, rest), T.arcHalf); // hull turning under the gun cannot push it out of arc
        t.va = dt > 0 ? angleDiff(t.a, wasA) / dt : 0;

        if (want !== null && Math.abs(err) <= step && t.cool <= 0) {
            t.cool = T.cooldown;
            if (T.hitscan) {
                hitscan(s, t, T, at);
                continue;
            }
            bullets.push({
                id: nextId++,
                owner: s.owner,
                team: s.team,
                life: BULLET_LIFE,
                r: 2,
                ghost: s.hull.embedded, // fired from inside rock: walls are not in its way
                x: t.wx,
                y: t.wy,
                vx: s.vx + Math.cos(t.a) * BULLET_SPEED,
                vy: s.vy + Math.sin(t.a) * BULLET_SPEED,
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
    const cos = Math.cos(s.a),
        sin = Math.sin(s.a);
    for (const [ox, oy, r] of s.hull.collide) {
        let px = s.x + ox * cos - oy * sin,
            py = s.y + ox * sin + oy * cos;
        for (const wall of walls) {
            const inside = pointInWall(wall, px, py);
            const near = closestOnWall(wall, px, py);
            if (!inside && near.d >= r) continue;
            let dx, dy, push;
            if (inside) {
                dx = near.x - px;
                dy = near.y - py;
                push = near.d + r;
            } else {
                dx = px - near.x;
                dy = py - near.y;
                push = r - near.d;
            }
            const len = Math.hypot(dx, dy);
            if (len < 1e-9) continue; // exactly on an edge: no usable normal
            dx /= len;
            dy /= len;
            s.x += dx * push;
            s.y += dy * push;
            const into = s.vx * dx + s.vy * dy; // velocity along the outward normal
            if (into < 0) {
                s.vx -= into * dx;
                s.vy -= into * dy;
            }
            px = s.x + ox * cos - oy * sin;
            py = s.y + ox * sin + oy * cos;
        }
    }
}

// One point a second, into whichever gun the curve rates highest. There is no rule here
// making it stick: a band that rises with health is self-reinforcing, so the curve says
// whether repair finishes what it starts. Draw a falling band and it will genuinely
// interleave, because that is what "always work on the worst one" means. Zero priority
// is how you call the crew off a gun entirely.
function repairShip(s, dt) {
    const T = s.turrets;
    const wants = (i) =>
        i !== null &&
        T[i] &&
        T[i].hp < maxHp(T[i]) &&
        prioAt(repairCurve(s, T[i]), repairFrac(T[i].hp, maxHp(T[i]))) > 0;
    s.repairHold -= dt;

    // Guns named by hand are not a stronger opinion about priority, they replace it: the
    // crew works round the named ones in turn, a dwell each, and the curve does not get a
    // say. Naming a gun the curve refuses is a legitimate order, which is the point of
    // being able to name one. When they are all whole the curve takes over again rather
    // than leaving the crew idle beside a damaged gun.
    const named = s.repairFocus.filter((i) => T[i] && T[i].hp < maxHp(T[i]));
    if (named.length) {
        if (s.repairHold <= 0 || !named.includes(s.repairing)) {
            s.repairing =
                named[(named.indexOf(s.repairing) + 1) % named.length];
            s.repairHold = REPAIR_DWELL;
        }
        T[s.repairing].hp = Math.min(
            maxHp(T[s.repairing]),
            T[s.repairing].hp + REPAIR_RATE * dt,
        );
        return;
    }

    // Re-decide when the dwell is up, or the moment the gun in hand stops wanting the
    // point at all -- finished, or the band it sits in taken to zero.
    if (s.repairHold <= 0 || !wants(s.repairing)) {
        let best = null,
            bestScore = 0;
        for (let i = 0; i < T.length; i++) {
            if (!wants(i)) continue;
            const score = prioAt(
                repairCurve(s, T[i]),
                repairFrac(T[i].hp, maxHp(T[i])),
            );
            // Ties go to the gun nearest to being finished, so even a flat band completes one
            // before starting the next.
            if (
                score > bestScore ||
                (score === bestScore && best !== null && T[i].hp > T[best].hp)
            ) {
                best = i;
                bestScore = score;
            }
        }
        s.repairing = best;
        s.repairHold = best === null ? 0 : REPAIR_DWELL;
    }
    if (s.repairing === null) return;
    T[s.repairing].hp = Math.min(
        maxHp(T[s.repairing]),
        T[s.repairing].hp + REPAIR_RATE * dt,
    );
}

// Rocks exist near ships and nowhere else. New ones arrive in the band just short of
// ACTIVE_R -- out past anything anyone is looking at -- and drift inward from there.
function manageRocks() {
    for (let i = rocks.length - 1; i >= 0; i--) {
        const r = rocks[i];
        let keep = false;
        for (const s of ships)
            if (crewed(s) && Math.hypot(r.x - s.x, r.y - s.y) < AOI_KEEP) {
                keep = true;
                break;
            }
        if (!keep) rocks.splice(i, 1);
    }
    for (const s of ships) if (crewed(s)) stock(s, rockBandSpot);
}

// Top a ship's neighbourhood back up, same shape as stock() for rocks.
function stockOre(s, spot) {
    let near = 0;
    // Salvage is not scenery: a module lying about must not stand in for the ore this is
    // meant to keep topped up, or a cache's drop quietly thins the field around it.
    for (const o of ore)
        if (!o.mod && Math.hypot(o.x - s.x, o.y - s.y) < ACTIVE_R) near++;
    for (; near < ORE_TARGET; near++) spawnOre(...spot(s));
}

// The same bargain as rocks: it exists where players are, and goes when they leave.
function manageOre() {
    for (let i = ore.length - 1; i >= 0; i--) {
        let keep = false;
        for (const s of ships)
            if (
                crewed(s) &&
                Math.hypot(ore[i].x - s.x, ore[i].y - s.y) < KEEP_R
            ) {
                keep = true;
                break;
            }
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
// One beam per working tractor module. They are interchangeable -- nothing tells the
// second beam from the first -- so this takes the nearest unclaimed grain that many times
// over, and a hull carrying two fills its hold twice as fast.
function tractor(s) {
    const had = s.beams || [];
    const beams = s.turrets.filter(
        (t) => t.type === 'tractor' && t.hp > 0,
    ).length;
    s.beams = [];
    // Let go of anything this ship was holding and is not holding now, once at the end,
    // rather than per grain: two lists that have to be reconciled is how a grain ends up
    // held by a beam that stopped existing.
    const drop = (keep) => {
        for (const id of had) {
            if (keep.includes(id)) continue;
            const prev = ore.find((o) => o.id === id);
            if (prev && prev.held === s.id) {
                prev.held = null;
                prev.stamp = (prev.stamp | 0) + 1;
            }
        }
    };
    if (!crewed(s) || !beams) return drop([]);
    const polys = nearbyWalls(s.x, s.y);
    for (let b = 0; b < beams; b++) {
        // Chosen by the same envelope a gun uses: the curve for its kind against how far out
        // it is, best score first and nearest breaking a tie. A beam can be told to ignore ore
        // and hold out for modules exactly as a battery can be told to ignore rock.
        let best = null,
            bestD = 0,
            bestScore = 0;
        for (const o of ore) {
            // Spoken for: two beams on one grain would fight over its velocity and neither would
            // land it. Which now includes this ship's own other beams.
            if (o.held !== null && o.held !== s.id) continue;
            if (s.beams.includes(o.id)) continue;
            const d = Math.hypot(o.x - s.x, o.y - s.y);
            if (d >= TRACTOR_R) continue;
            const score = prioAt(
                s.prio[o.mod ? 'module' : 'ore'],
                d / TRACTOR_R,
            );
            if (score <= 0) continue; // zero priority is "leave it"
            if (score < bestScore || (score === bestScore && d >= bestD))
                continue;
            // Rock stops a beam the way it stops a shell. Checked only for grains that would
            // actually win, so the sight test runs a handful of times rather than once per grain.
            if (polys.length && segmentBlocked(s.x, s.y, o.x, o.y, polys))
                continue;
            bestD = d;
            bestScore = score;
            best = o;
        }
        if (!best) break;
        if (bestD <= ORE_GRAB) {
            ore.splice(ore.indexOf(best), 1);
            if (best.mod) s.hold[best.mod] = (s.hold[best.mod] || 0) + 1;
            else s.ore += ORE_VALUE;
            continue; // that beam is free again this tick
        }
        best.held = s.id;
        s.beams.push(best.id);
        // Straight at the ship, overriding whatever drift it had: a beam that merely nudged
        // would lose grains to their own momentum and look broken doing it.
        const wasx = best.vx,
            wasy = best.vy;
        best.vx = ((s.x - best.x) / bestD) * TRACTOR_PULL;
        best.vy = ((s.y - best.y) / bestD) * TRACTOR_PULL;
        // A beam is the only thing that bends a grain off its line, so it is the only thing
        // that has to be described again.
        if (Math.abs(best.vx - wasx) > 1 || Math.abs(best.vy - wasy) > 1)
            best.stamp = (best.stamp | 0) + 1;
    }
    drop(s.beams);
}

function step(dt) {
    manageChunks();
    // Take a snapshot: a spawn can load more chunks and queue more rolls, which wait for
    // the next tick rather than extending this one.
    // A roll a kind for every chunk nobody had seen before, then the placements those rolls
    // asked for. Both off a queue rather than as the chunk loads, because loading a chunk
    // can load more of them.
    for (const [cx, cy] of freshChunks.splice(0))
        for (const kind of PLACED)
            for (let n = rollCount(PLACING_OF[kind]); n > 0; n--)
                pendingPlaces.push([kind, cx, cy]);
    for (const [kind, cx, cy] of pendingPlaces.splice(0))
        tryPlace(kind, cx, cy);
    armedArrivals();
    mapSweep();
    manageEncounters(dt);
    bleed(dt);
    for (const s of ships) {
        const cmd =
            s.hull.ai === 'static' ? { turn: 0, thrust: 0 }
            : s.hull.ai === 'fighter' ? fighterCmd(s, dt)
            : s.dest ? autopilot(s, dt)
            : faceCmd(s, dt);
        s.th = cmd.thrust ? 1 : 0;
        advance(s, cmd, dt, s.hull);
        if (!s.hull.embedded) resolveWalls(s); // being in the rock is the point
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
        const px = o.x,
            py = o.y;
        o.x += o.vx * dt;
        o.y += o.vy * dt;
        o.life -= dt;
        if (o.life <= 0) {
            bullets.splice(b, 1);
            continue;
        }
        // Test the whole step, not just where it landed: a shell covers ~19px a tick and
        // would otherwise skip through a thin corner of rock.
        if (o.ghost) continue;
        const polys = nearbyWalls(o.x, o.y);
        if (polys.length && segmentBlocked(px, py, o.x, o.y, polys))
            bullets.splice(b, 1);
    }

    for (const r of rocks) {
        r.x += r.vx * dt;
        r.y += r.vy * dt;
        r.a += r.spin * dt;
        if (r.grace > 0) r.grace -= dt;
    }
    // Rocks against blocking matter. A rock that reaches it comes apart exactly as if it had
    // been shot, and its pieces are thrown back off the surface.
    for (let k = rocks.length - 1; k >= 0; k--) {
        const r = rocks[k];
        const off = blockingHit(r.x, r.y, r.r);
        if (!off) continue;
        rocks.splice(k, 1);
        shatter(r, off);
    }
    for (let i = ore.length - 1; i >= 0; i--) {
        const o = ore[i];
        o.x += o.vx * dt;
        o.y += o.vy * dt;
        o.a += o.spin * dt;
        o.life -= dt;
        if (o.life <= 0) ore.splice(i, 1);
    }
    for (const s of ships) tractor(s);

    // Rocks against guns. The hull is not a target -- same as for shells -- so a rock that
    // misses a turret sails over the ship it is mounted on.
    for (let k = rocks.length - 1; k >= 0; k--) {
        const r = rocks[k];
        if (r.grace > 0) continue;
        let struck = false;
        for (const s of ships) {
            if (s.hull.rockProof) continue;
            for (const t of s.turrets) {
                if (t.hp <= 0) continue; // nothing left there to hit
                const dx = r.x - t.wx,
                    dy = r.y - t.wy,
                    rr = r.r + MODULES[t.type].hitR;
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
                const dx = o.x - t.wx,
                    dy = o.y - t.wy,
                    rr = MODULES[t.type].hitR + o.r;
                if (dx * dx + dy * dy >= rr * rr) continue;
                wound(s, t, BULLET_DAMAGE, o.owner);
                bullets.splice(b, 1);
                struck = true;
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
            rocks.splice(k, 1);
            bullets.splice(b, 1);
            const shooter = players.get(o.owner);
            if (shooter) shooter.score += (4 - r.size) * 10;
            shatter(r);
            break;
        }
    }

    manageRocks();
    manageOre();
}

// Walls are static, so they are pushed once per player when a ship comes near and dropped
// when it leaves, rather than riding in every snapshot -- a dense biome would otherwise
// dominate the wire. They go by their own key rather than by chunk: a wall is merged out
// of whatever is loaded and can be far larger than any chunk, and keying delivery by the
// chunk holding its centre meant a long one vanished as soon as that chunk left the
// window, while its far end was still in plain sight.
function syncWalls(p) {
    const v = p.view;
    const need = new Map(),
        needArt = new Map();
    for (let cx = chunkOf(v.x - STREAM_R); cx <= chunkOf(v.x + STREAM_R); cx++)
        for (
            let cy = chunkOf(v.y - STREAM_R);
            cy <= chunkOf(v.y + STREAM_R);
            cy++
        ) {
            const k = chunkKey(cx, cy);
            for (const w of wallBins.get(k) || []) need.set(w.key, w);
            for (const a of artBins.get(k) || []) needArt.set(a.key, a);
        }
    const add = [],
        del = [];
    for (const [k, w] of need)
        if (p.walls.get(k) !== w) {
            p.walls.set(k, w);
            add.push([k, w.rings, w.mat]);
        }
    for (const k of [...p.walls.keys()])
        if (!need.has(k)) {
            p.walls.delete(k);
            del.push(k);
        }
    if (add.length || del.length)
        p.ws.send(JSON.stringify({ t: 'walls', add, del }));

    // Scenery, by the same rules. It is authored rather than derived, so it never changes
    // once sent -- only whether you are near enough to have it.
    const aAdd = [],
        aDel = [];
    for (const [k, a] of needArt)
        if (!p.art.has(k)) {
            p.art.add(k);
            aAdd.push([k, a.lines]);
        }
    for (const k of [...p.art])
        if (!needArt.has(k)) {
            p.art.delete(k);
            aDel.push(k);
        }
    if (aAdd.length || aDel.length)
        p.ws.send(JSON.stringify({ t: 'art', add: aAdd, del: aDel }));

    // Markers go out whole, and by view rather than by chunk: there are a handful in the
    // world and one you cannot see is one you cannot tap.
    const mAdd = [],
        mDel = [];
    for (const [k, m] of marks) {
        const near =
            Math.abs(m.x - v.x) < STREAM_R && Math.abs(m.y - v.y) < STREAM_R;
        if (near && !p.marks.has(k)) {
            p.marks.add(k);
            mAdd.push({ k, x: m.x, y: m.y, r: m.r, icon: m.icon });
        }
        if (!near && p.marks.has(k)) {
            p.marks.delete(k);
            mDel.push(k);
        }
    }
    for (const k of [...p.marks])
        if (!marks.has(k)) {
            p.marks.delete(k);
            mDel.push(k);
        }
    if (mAdd.length || mDel.length)
        p.ws.send(JSON.stringify({ t: 'marks', add: mAdd, del: mDel }));
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
const sessions = new Map(); // session id -> player id

// ---- players on disk ----
//
// A player is world state like the mesh is: the ships they own, what they have been told,
// and where they are up to with everybody they have spoken to. Written to one file rather
// than one apiece -- there are a handful of them against thousands of chunks -- and keyed
// by the session, because that is the name the client actually holds.
//
// The fleet is only in the file while its commander is away. While they are here the world
// holds the ships and the file holds what was true at the last save.
const playerFile = () => path.join(WORLD_DIR, 'players.json');
let playersDirty = false;

// How long a fleet stays in the world after its commander goes. It is a grace against a
// dropped connection and a tax on quitting a fight: the hulls sit where they were left,
// and anything that was shooting at them still is.
const LOGOFF_GRACE = 120; // seconds

// Everything about a ship that is not where it happens to be standing. Damage is per gun,
// so the loadout and what is left of it are one list.
const shipRec = (s) => ({
    id: s.id,
    h: hullKey(s.hull),
    ore: s.ore,
    hold: s.hold,
    prio: s.prio,
    ft: s.turrets.map((t) => [t.install, t.type, t.rot, t.hp]),
});

// Where a fleet comes back to: the last settlement this player touched anything in, or the
// origin for somebody who has not touched one yet. The site rather than the spot, so it is
// "you come back at Still Basin" rather than "you come back at that gantry" -- and so a set
// piece that lays itself out again cannot strand anybody inside new rock.
function respawnAt(p) {
    const s = siteBySrc(p.respawnSite);
    return s ? { x: s.x, y: s.y } : { x: 0, y: 0 };
}

// Put a saved fleet back in the world. It arrives where its commander last put in rather
// than where it was left: a hull that reappears in the middle of a nest its owner logged
// out of is a worse bargain than a walk back out. Ids are kept, because a conversation held
// mid-sentence names the ship that started it.
function restoreFleet(p) {
    const fleet = [];
    for (const rec of p.fleet ?? []) {
        const lead = fleet[0];
        const home = respawnAt(p);
        const s = newShip(
            p.id,
            PLAYER_TEAM,
            lead ?
                { nearX: lead.x, nearY: lead.y, reach: SPAWN_SEP }
            :   { nearX: home.x, nearY: home.y },
            HULLS[rec.h] ?? CARRIER,
        );
        s.id = rec.id; // the id newShip just handed out is spent; the saved one is the ship
        s.ore = rec.ore ?? 0;
        s.hold = rec.hold ?? {};
        s.prio = rec.prio ?? defaultPrio();
        const saved = rec.ft ?? [];
        s.turrets = fitTurrets(
            s.hull,
            saved.map(([install, type, rot]) => ({ install, type, rot })),
        );
        for (const t of s.turrets) {
            const was = saved.find((f) => f[0] === t.install);
            if (was && Number.isFinite(was[3])) t.hp = was[3];
        }
        fleet.push(s);
    }
    p.fleet = null;
    return fleet;
}

// The shape every player has, whether they have just arrived or just been read off disk.
// One place, so a loaded player cannot be missing a field that something iterating players
// expects to find.
function newPlayer(id, session) {
    return {
        id,
        session,
        ws: null,
        name: `ship-${id}`,
        score: 0,
        walls: new Map(),
        art: new Set(),
        marks: new Set(),
        moving: newMoving(),
        ships: new Map(),
        told: null,
        busy: null,
        talk: null, // who it is talking to, if it is talking to anybody
        talks: {}, // conversationalist id -> stack of [module, state]
        store: {}, // conversation name -> what that conversation knows about them
        kills: {}, // what they have destroyed: hull -> encounter kind -> how many
        map: {}, // chunk key -> what the ground there looked like when last seen
        mapOn: false, // looking at it right now, so worth telling about changes
        mapNew: null, // ...and what has changed since we last did
        places: [], // named set pieces they have been near
        view: { x: 0, y: 0 },
        respawnSite: null, // where they last put in; the origin until they have
        left: null, // when their socket went, if they are away
        fleet: null, // their ships, while the world is not holding them
    };
}

function savePlayers() {
    const live = [...players.values()].some((q) => q.ws?.readyState === 1);
    if (!live && !playersDirty) return;
    playersDirty = false;
    const out = [];
    for (const p of players.values()) {
        if (!p.session) continue; // never named itself; nothing to come back to
        const inWorld = [...ships].filter((s) => s.owner === p.id);
        out.push({
            session: p.session,
            id: p.id,
            name: p.name,
            score: p.score,
            // Mid-sentence is a place to be, and coming back to the same words is the
            // whole of why the stack is plain JSON.
            talk: p.talk,
            busy: p.busy,
            respawnSite: p.respawnSite,
            talks: p.talks,
            store: p.store,
            kills: p.kills,
            map: p.map,
            places: p.places,
            fleet: inWorld.length ? inWorld.map(shipRec) : (p.fleet ?? []),
        });
    }
    try {
        fs.mkdirSync(WORLD_DIR, { recursive: true });
        fs.writeFileSync(
            playerFile(),
            JSON.stringify({ v: 1, nextId, players: out }),
        );
    } catch {
        /* unwritable store: the game runs, it just will not survive a restart */
    }
}

function loadPlayers() {
    let d;
    try {
        d = JSON.parse(fs.readFileSync(playerFile(), 'utf8'));
    } catch {
        return; // no file, or nothing readable in it: everybody is new
    }
    if (d.v !== 1)
        return console.warn('players.json: unknown version; ignored');
    // Ids are one counter shared by players, ships, rocks and ore. A restored ship keeps
    // its id, so the counter has to start past every id this world has ever issued.
    nextId = Math.max(nextId, d.nextId | 0);
    for (const rec of d.players ?? []) {
        const p = newPlayer(rec.id, rec.session);
        p.name = rec.name ?? p.name;
        p.score = rec.score ?? 0;
        p.talks = rec.talks ?? {};
        p.store = rec.store ?? {};
        p.kills = rec.kills ?? {};
        p.map = rec.map ?? {};
        p.places = rec.places ?? [];
        p.talk = rec.talk ?? null;
        p.respawnSite = rec.respawnSite ?? null;
        p.busy = rec.busy ?? null;
        p.fleet = rec.fleet ?? [];
        players.set(p.id, p);
        sessions.set(p.session, p.id);
    }
}

// Anybody whose grace has run out: their fleet goes into their record and out of the
// world. Nothing owned by somebody who is not here may stay, because a crewed hull is what
// makes terrain -- leaving them would hold every chunk any player had ever stood in
// resident from boot, and the world would grow without bound.
function sweepAbsent() {
    const now = Date.now();
    for (const p of players.values()) {
        if (!p.left || now - p.left < LOGOFF_GRACE * 1000) continue;
        p.left = null; // dealt with: from here the record is all there is of them
        const fleet = [...ships].filter((s) => s.owner === p.id);
        if (!fleet.length) continue;
        p.fleet = fleet.map(shipRec);
        for (const s of fleet) {
            ships.delete(s);
            if (s.enc) s.enc.members.delete(s);
            // A grain held by a beam that no longer exists is a grain nobody can ever pick
            // up again.
            for (const o of ore)
                if (o.held === s.id) {
                    o.held = null;
                    o.stamp = (o.stamp | 0) + 1;
                }
        }
        playersDirty = true;
    }
}

loadPlayers();
loadQuests();
loadTiles();
setInterval(sweepAbsent, 1000);
setInterval(savePlayers, 5000);
setInterval(saveQuests, 5000);
setInterval(saveTiles, 5000);

wss.on('connection', (ws) => {
    let p = null;

    function join(session) {
        p = players.get(sessions.get(session));
        if (p) {
            // A player read off disk has no socket at all, and a returning one may have a
            // dead socket still hanging off them: only a live other socket is displaced.
            if (p.ws !== ws && p.ws?.readyState === 1) p.ws.close();
            p.ws = ws;
        } else {
            const id = nextId++;
            p = newPlayer(id, session);
            p.ws = ws;
            players.set(id, p);
            sessions.set(session, id);
        }
        // Back within the grace, or back a week later -- either way they are here now.
        p.left = null;
        playersDirty = true;
        p.walls = new Map(); // a new socket has been sent no terrain yet
        p.art = new Set();
        p.marks = new Set();
        p.moving = newMoving();
        p.told = null;
        p.ships = new Map();
        // A conversation outlives the socket that started it: a session is held in one
        // until it ends, so a reload drops you back where you were standing.
        p.busy = p.talk ? p.busy : null; // the interaction this session has open

        // Returning players keep the fleet they left -- still in the world if they were
        // quick, put back at the origin from their record if they were not -- and a new
        // commander is issued one. No ship is special: they are simply the ships this
        // player owns.
        let fleet = [...ships].filter((s) => s.owner === p.id);
        if (!fleet.length && p.fleet?.length) fleet = restoreFleet(p);
        if (!fleet.length)
            for (let i = 0; i < FLEET_SIZE; i++) {
                // The rest of the fleet forms up on the first ship rather than being scattered
                // across the map: a squadron you cannot see together is not a squadron.
                const lead = fleet[0];
                const home = respawnAt(p);
                fleet.push(
                    newShip(
                        p.id,
                        PLAYER_TEAM,
                        lead ?
                            { nearX: lead.x, nearY: lead.y, reach: SPAWN_SEP }
                        :   { nearX: home.x, nearY: home.y },
                    ),
                );
            }
        p.view = { x: fleet[0].x, y: fleet[0].y }; // until the client says where it is looking

        ws.send(
            JSON.stringify({
                t: 'welcome',
                id: p.id,
                dev: DEV,
                cv: clientHash(),
                maxView: MAX_VIEW,
                hulls: Object.fromEntries(
                    Object.entries(HULLS).map(([k, h]) => [
                        k,
                        { installs: h.installs },
                    ]),
                ),
                modules: MODULES,
                refit: {
                    remove: REFIT_REMOVE,
                    rotate: REFIT_ROTATE,
                    stops: ROT_STOPS,
                },
                market: { stock: forSale(), resale: RESALE },

                prioMax: PRIO_MAX,
                turretHp: TURRET_HP,
                // What a shell does, which is the one thing about a gun that is not in the
                // module table: the readout would otherwise have to guess at it.
                shellDamage: BULLET_DAMAGE,
                transferReach: TRANSFER_REACH,
                wreck: WRECK_DEPTH,
            }),
        );
        // Held in the conversation it was in: a reload lands back on the same words
        // rather than outside a sheet the server still believes is open. Asked again
        // rather than replayed, because the frame's own state is where it was up to.
        sendQuests(p);
        if (p.talk) playTalk(p, nextStep(p, p.talk.who, null, false));
    }

    // Gone. Not necessarily for good: the fleet stays in the world until the grace runs
    // out. A socket that is no longer this player's has already been replaced by a newer
    // one, and its closing is not a departure.
    ws.on('close', () => {
        if (!p || p.ws !== ws) return;
        p.left = Date.now();
        playersDirty = true;
    });

    ws.on('message', (raw) => {
        let m;
        try {
            m = JSON.parse(raw);
        } catch {
            return;
        }
        if (
            m.t === 'hello' &&
            typeof m.session === 'string' &&
            m.session.length <= 64
        ) {
            if (!p) join(m.session);
            return;
        }
        if (!p) return; // nothing is answered before a session arrives

        if (m.t === 'move' && Number.isFinite(m.x) && Number.isFinite(m.y)) {
            for (const s of ships) {
                if (s.owner !== p.id || s.id !== m.ship) continue; // you may only order your own
                const goal = pushOutOfWalls(m.x, m.y, HULL_CLEAR);
                const dx = goal.x - s.x,
                    dy = goal.y - s.y;
                s.dest = goal;
                s.braking = false;
                s.detourSide = 0;
                s.stuckFor = 0;
                s.arm = null; // sent elsewhere is told to stop going there
                // Face the way you travelled, unless the order was a nudge too small to have a
                // direction worth adopting. Dragging the ring afterwards still overrides it.
                if (Math.hypot(dx, dy) > s.hull.arriveR)
                    s.heading = Math.atan2(dy, dx);
            }
        }
        // The whole intended layout in one order, because a stream of drags and rotations
        // would leave a rejected one halfway through and unrecoverable over half a second of
        // latency. The price is worked out here from what the ship already has: the client's
        // running total is a preview and is never sent.
        else if (m.t === 'refit' && Array.isArray(m.fit)) {
            for (const s of ships) {
                if (s.owner !== p.id || s.id !== m.ship) continue;
                const why = refit(s, m.fit);
                ws.send(
                    JSON.stringify({
                        t: 'refit',
                        ship: s.id,
                        ok: !why,
                        ...(why ? { why } : {}),
                    }),
                );
            }
        }
        // Sent to a marker: fly there, and be ready to use it on arrival. It is the same move
        // order underneath, so everything about getting there -- avoidance, giving up, being
        // redirected -- is unchanged.
        else if (
            m.t === 'engage-mark' &&
            Array.isArray(m.ships) &&
            marks.has(m.mark)
        ) {
            const mark = marks.get(m.mark);
            for (const s of ships) {
                if (s.owner !== p.id || !m.ships.includes(s.id)) continue;
                const goal = pushOutOfWalls(
                    mark.x + rand(-60, 60),
                    mark.y + rand(-60, 60),
                    HULL_CLEAR,
                );
                s.dest = goal;
                s.braking = false;
                s.detourSide = 0;
                s.stuckFor = 0;
                s.arm = mark.key;
                const dx = goal.x - s.x,
                    dy = goal.y - s.y;
                if (Math.hypot(dx, dy) > s.hull.arriveR)
                    s.heading = Math.atan2(dy, dx);
            }
        } else if (m.t === 'interact-done') {
            p.busy = null;
        } else if (m.t === 'talk-choose' && Number.isInteger(m.option)) {
            if (p.talk) playTalk(p, nextStep(p, p.talk.who, m.option, false));
        } else if (m.t === 'trade' && m.buy && m.sell) {
            for (const s of ships) {
                if (s.owner !== p.id || s.id !== m.ship) continue;
                const why = trade(s, m.buy, m.sell);
                ws.send(
                    JSON.stringify({
                        t: 'trade',
                        ship: s.id,
                        ok: !why,
                        ...(why ? { why } : {}),
                    }),
                );
            }
        } else if (m.t === 'transfer' && m.give && m.take) {
            const a = [...ships].find(
                (s) => s.owner === p.id && s.id === m.ship,
            );
            const b = [...ships].find(
                (s) => s.owner === p.id && s.id === m.with,
            );
            // Answered on the market's own channel: the sheet is the market's, and what it
            // does with a yes -- empty the basket and stay open -- is what this wants too.
            const why = moveCargo(a, b, m.give, m.take);
            ws.send(
                JSON.stringify({
                    t: 'trade',
                    ship: m.ship,
                    ok: !why,
                    ...(why ? { why } : {}),
                }),
            );
        } else if (m.t === 'map-off') {
            p.mapOn = false;
            p.mapNew = null;
        } else if (m.t === 'map') {
            // Only while it is open: the increments are worth nothing to a client that is
            // not drawing them, and it will ask for the whole thing again when it is.
            p.mapOn = true;
            // Asked for rather than pushed: it is a few kilobytes that only matter when
            // somebody is looking at it, and it does not change while they are.
            const art = {};
            for (const name of new Set(Object.values(p.map))) {
                const bytes = tiles.get(name);
                if (bytes) art[name] = bytes.toString('base64');
            }
            ws.send(
                JSON.stringify({
                    t: 'map',
                    grid: MAP_GRID,
                    mats: MAP_MATS,
                    chunk: CHUNK,
                    tiles: p.map, // chunk -> the name of what was seen there
                    art, // and the pictures those names stand for
                    places: p.places,
                }),
            );
        } else if (m.t === 'face' && Number.isFinite(m.a)) {
            for (const s of ships)
                if (s.owner === p.id && s.id === m.ship) s.heading = m.a;
        } else if (m.t === 'focus' && Array.isArray(m.ships)) {
            // null clears. Only another player's ship can be focused -- pointing your own
            // guns at your own hull is not an order anyone means to give.
            const target =
                m.target === null ?
                    null
                :   ([...ships].find(
                        (s) => s.id === m.target && s.owner !== p.id,
                    )?.id ?? null);
            for (const s of ships)
                if (s.owner === p.id && m.ships.includes(s.id))
                    s.focus = target;
        } else if (
            m.t === 'repfocus' &&
            Array.isArray(m.guns) &&
            m.guns.every(Number.isInteger)
        ) {
            for (const s of ships) {
                if (s.owner !== p.id || s.id !== m.ship) continue;
                s.repairFocus = [...new Set(m.guns)].filter(
                    (i) => i >= 0 && i < s.turrets.length,
                );
            }
        } else if (
            m.t === 'prio' &&
            PRIO_KINDS.includes(m.kind) &&
            Array.isArray(m.points) &&
            m.points.length >= 2 &&
            m.points.length <= PRIO_MAX &&
            m.points.every(
                (q) =>
                    Array.isArray(q) &&
                    q.length === 2 &&
                    q.every(Number.isFinite),
            )
        ) {
            const pts = m.points.map(([x, y]) => [
                Math.max(0, Math.min(1, x)),
                Math.max(0, Math.min(100, Math.round(y))),
            ]);
            // The ends anchor the axis and x never runs backwards. A curve that breaks either
            // cannot be evaluated, so it is dropped rather than repaired into something the
            // player did not draw.
            let ok = pts[0][0] === 0 && pts[pts.length - 1][0] === 1;
            for (let i = 1; ok && i < pts.length; i++)
                if (pts[i][0] < pts[i - 1][0]) ok = false;
            if (ok)
                for (const s of ships)
                    if (s.owner === p.id && s.id === m.ship)
                        s.prio[m.kind] = pts;
        } else if (
            m.t === 'view' &&
            Number.isFinite(m.x) &&
            Number.isFinite(m.y)
        )
            p.view = { x: m.x, y: m.y };
        else if (m.t === 'name' && typeof m.name === 'string')
            p.name = m.name.slice(0, 16);
    });
    // Nothing happens on disconnect. The world outlives its players -- ships stay where
    // they were, scores stand, and only restarting the process clears any of it.
});

// Every phase that has ever cost a tick, timed where it is defined rather than where it is
// called: generation pulls chunks in and a chunk load merges walls, so the same work is
// reached from several places and there is no one call site to wrap. They nest, so the
// shares do not sum to the tick -- this names a culprit, it is not a balanced budget.
// Rebinding a function declaration is what this rule is normally right to flag. Here it is
// the point: every call site is timed wherever it is reached from, without a wrapper name
// leaking into the code being measured, and the instrumentation stays in one block instead
// of scattered through fifteen functions.
/* eslint-disable no-func-assign */
const phased =
    (name, fn) =>
    (...a) =>
        timed(name, () => fn(...a));
depositCell = phased('cells', depositCell);
loadChunk = phased('load', loadChunk);
rebuildWalls = phased('merge', rebuildWalls);
tryPlace = phased('place', tryPlace);
mapSweep = phased('map', mapSweep);
armedArrivals = phased('arrive', armedArrivals);
manageEncounters = phased('enc', manageEncounters);
syncWalls = phased('walls', syncWalls);
syncShips = phased('standing', syncShips);
// Writes to disk. These run on their own intervals rather than in the tick, which is why
// the tick loop measures the gap between ticks as well as the ticks: a save that blocks
// the loop for 200ms costs the same rewind as a tick that overran by 200ms, and shows up
// nowhere in the tick's own total.
saveSites = phased('save:sites', saveSites);
savePlayers = phased('save:players', savePlayers);
saveQuests = phased('save:quests', saveQuests);
saveTiles = phased('save:tiles', saveTiles);
saveChunk = phased('save:chunk', saveChunk);
sweepAbsent = phased('sweep', sweepAbsent);
/* eslint-enable no-func-assign */

let last = Date.now(),
    frame = 0,
    ended = performance.now(); // when the last tick finished, to measure the gap after it
setInterval(() => {
    const t0 = performance.now();
    // Anything in `spent` now ran between ticks -- a save, a socket, a GC-adjacent pause --
    // and is charged to the gap, not to the tick that happens to follow it.
    const gap = t0 - ended;
    if (gap > TICK + OVERRUN) offTick(gap);
    else for (const k in spent) delete spent[k];

    const now = Date.now();
    const real = (now - last) / 1000;
    const dt = Math.min(real, DT_MAX);
    // What the clamp threw away: world time that never happened, which the clients have
    // already extrapolated through and will be pulled back from.
    const lost = real - dt;
    metric.debt += lost;
    last = now;
    step(dt);
    const sim = performance.now() - t0;
    const streamChunks = ++frame % 10 === 0;
    for (const p of players.values()) {
        if (!p.ws || p.ws.readyState !== 1) continue;
        if (streamChunks) syncWalls(p);
        syncShips(p);
        const msg = worldFor(
            p,
            +performance.now().toFixed(1),
            syncMotion(p, Date.now()),
        );
        if (msg) p.ws.send(msg);
    }
    kills.length = 0; // said once, to whoever was near enough to see it
    tracers.length = 0;
    ended = performance.now();
    endTick(ended - t0, sim, lost);
}, TICK);

// Dev mode. `node --watch` restarts this process when server.js changes, which drops
// every socket -- and the client treats a dropped socket as "reload once I'm back".
// Client files are not in this process's module graph, so they get the same treatment
// by hand: watch public/, tell everyone to reload. One recovery path for both.
if (DEV) {
    let pending = null;
    fs.watch(path.join(__dirname, 'public'), (_, file) => {
        clearTimeout(pending); // editors touch a file several times per save
        pending = setTimeout(() => {
            console.log(`reload: ${file}`);
            for (const p of players.values())
                if (p.ws?.readyState === 1)
                    p.ws.send(JSON.stringify({ t: 'reload' }));
        }, 120);
    });
}

// Every address something else could reach this on, named by the interface it belongs
// to. Picking one and calling it "lan" was a guess: a box with Docker or a VPN has
// several, and the first one the OS happens to list is as likely to be a bridge no phone
// is on as the wifi. Printing all of them says what is true and lets the reader choose --
// if there is more than one, they know why.
function reachableAddresses() {
    const found = [];
    for (const [name, list] of Object.entries(os.networkInterfaces() ?? {}))
        for (const a of list ?? [])
            if (a.family === 'IPv4' && !a.internal)
                found.push({ name, url: `http://${a.address}:${PORT}` });
    return found;
}

// The callback is called synchronously; it is only how the library hands back a string
// rather than printing one. Trailing blank lines go: the gap between blocks is the
// layout's business now, not the QR's.
// The widest QR built so far. A code cannot be wrapped and still be scanned, so the
// banner is never laid out narrower than one, however narrow the terminal is: a square
// running off the edge can be read by scrolling, and a folded one cannot be read at all.
let qrWidth = 0;

function qrBlock(url) {
    let art;
    qrcode.generate(
        url,
        { small: true },
        (code) => (art = code.replace(/\s+$/, '')),
    );
    // Every line of a QR is the same width and newlines are hard breaks, so this centres
    // the square as a unit rather than each row on its own.
    qrWidth = Math.max(qrWidth, stringWidth(art.split('\n')[0]));
    return text(art, { align: 'center', hyphenate: false });
}

// A title, the QR under it, then the link. The QR is what a phone is here for, so it goes
// where a thumb-held camera finds it: between the name and the text it encodes. The
// margins are declared rather than printed, so neighbours collapse to a single blank line
// however these blocks end up arranged.
const announce = (title, url, qr = true) =>
    stack(
        [
            text(title, { align: 'center' }),
            qr && qrBlock(url),
            text(url, { align: 'center' }),
        ],
        { marginTop: 1, marginBottom: 1 },
    );

// An agent already tunnelling THIS port is worth adopting -- that is the --watch
// restart case. One pointed at another port belongs to someone else's server, and
// printing its URL would send people somewhere else entirely.
async function existingTunnel(port) {
    try {
        const r = await fetch('http://127.0.0.1:4040/api/tunnels', {
            signal: AbortSignal.timeout(800),
        });
        const j = await r.json();
        const mine =
            j.tunnels?.filter((t) =>
                (t.config?.addr ?? '').endsWith(`:${port}`),
            ) ?? [];
        return (
            mine.find((t) => t.public_url?.startsWith('https'))?.public_url ??
            null
        );
    } catch {
        return null;
    }
}

// Read the URL from the agent's own log rather than the shared local API: a second
// agent cannot bind that API's port, so asking it would answer for the wrong tunnel.
let ngrokProc = null;
async function openTunnel(port) {
    const already = await existingTunnel(port);
    if (already) return already;
    let missing = false;
    ngrokProc = spawn(
        'ngrok',
        ['http', String(port), '--log', 'stdout', '--log-format', 'json'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const url = await new Promise((resolve) => {
        let buf = '',
            settled = false;
        const finish = (v) => {
            if (!settled) {
                settled = true;
                resolve(v);
            }
        };
        ngrokProc.stdout.on('data', (d) => {
            buf += d;
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                try {
                    const o = JSON.parse(line);
                    if (typeof o.url === 'string' && o.url.startsWith('https'))
                        finish(o.url);
                } catch {
                    /* not a json log line */
                }
            }
        });
        // ENOENT is the only failure worth telling apart: there is nothing to
        // authenticate or configure, the program is simply not on the PATH.
        ngrokProc.on('error', (e) => {
            missing = e.code === 'ENOENT';
            finish(null);
        });
        ngrokProc.on('exit', () => finish(null));
        setTimeout(() => finish(null), 12000);
    });
    if (url) return { url };
    return {
        problem:
            missing ?
                'ngrok is not installed -- https://ngrok.com/download'
            :   'ngrok did not start -- is it authenticated? (ngrok config add-authtoken ...)',
    };
}

const stopTunnel = () => {
    if (ngrokProc && ngrokProc.exitCode === null) ngrokProc.kill();
};
process.on('exit', stopTunnel);
for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, () => {
        stopTunnel();
        savePlayers();
        saveQuests();
        saveTiles();
        process.exit(0);
    });

// After the declarations, not beside seedTown: newShip reaches for `crewed`, which is a
// const further down the file, and calling up into it is a TDZ error that `node --check`
// passes clean.
seedBastions();

// Refusing to start is worth a sentence, not a stack trace: this is the one moment the
// boot output matters most, and every one of these is something the reader can act on.
// Both servers need the listener: ws forwards the http server's error to itself, and an
// error event with nothing listening on the socket server is thrown however this ends.
const cannotListen = (e) => {
    const say = {
        EADDRINUSE: `Port ${PORT} is already in use. Try --port with another one.`,
        EACCES: `Port ${PORT} needs privileges this process does not have. Try --port above 1023.`,
        EADDRNOTAVAIL: `Nothing here can listen on ${PORT}.`,
    }[e.code];
    console.error(
        `\n${say ?? `Could not listen on port ${PORT}: ${e.message}`}`,
    );
    process.exit(1);
};
server.on('error', cannotListen);
wss.on('error', cannotListen);

// Stopping is a thing the process does, not a thing that happens to it. Two reasons it
// has to be: state reaches disk on five-second timers, so a kill loses up to five seconds
// of world; and `node --cpu-prof` writes its profile from an exit hook, which a signal
// never reaches -- so without this, every way of stopping the server throws the profile
// away, which is most of what makes a profiled run possible at all.
let leaving = false;
for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, () => {
        if (leaving) process.exit(1); // asked twice: they mean it
        leaving = true;
        for (const save of [saveSites, savePlayers, saveQuests, saveTiles])
            try {
                save();
            } catch {
                // One store being unwritable must not stop the others being written.
            }
        process.exit(0);
    });

server.listen(PORT, async () => {
    // Nothing but the loopback: say so rather than print nothing at all, which reads as
    // a server that failed to start. No QR -- a phone scanning it points at itself.
    const found = reachableAddresses();
    const where =
        found.length ?
            found.map(({ name, url }) => announce(name, url))
        :   [announce('this machine only', `http://localhost:${PORT}`, false)];
    const { url: tunnel, problem } = NGROK ? await openTunnel(PORT) : {};
    // Built whole and printed once, because the tunnel is awaited: half a banner before
    // the wait and half after is how a QR ends up split across a pause.
    console.log(
        stack([
            text(
                `ragtag ${VERSION}${DEV ? '  [dev: auto-restart + client hot-reload]' : ''}`,
                { marginTop: 1 },
            ),
            ...where,
            tunnel && announce('ngrok', tunnel),
            problem && text(problem, { marginTop: 1 }),
            !NGROK && text('(--ngrok for a public URL)'),
        ]).toString(
            Math.max(qrWidth, Math.min(process.stdout.columns || 80, 80)),
        ),
    );
});
