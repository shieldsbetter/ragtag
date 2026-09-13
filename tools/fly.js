// A headless client that flies. The server cannot be made to work without somebody in the
// world -- terrain is generated around crewed hulls and nothing else -- so measuring it
// needs a pilot, and one that flies the same route twice is what makes two runs comparable.
//
// It also measures the thing a server-side metric can only approximate: a correction that
// puts a ship BEHIND where the client had already carried it. That backwards step is the
// rewind, seen from where it is actually visible, and it is counted here rather than
// inferred from how much world time the server admits to having lost.
import WebSocket from 'ws';

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};

const URL = arg('url', 'ws://127.0.0.1:8300');
const SECONDS = Number(arg('seconds', 90));
const SESSION = arg('session', 'pilot');
// How far each leg of the route runs, and how long before the next one is ordered. Far
// enough that the fleet is still under way when the next order comes, so it never arrives
// and sits: ground is made around a moving hull, and a parked one makes none.
const LEG = Number(arg('leg', 6000));
const EVERY = Number(arg('every', 6000));
// The same as the client's, and it has to be: a correction is judged against where the
// client's render clock stood, and a pilot reading at a different delay judges a different
// moment. See RENDER_DELAY in public/game.js.
const RENDER_DELAY = 120;

const ws = new WebSocket(URL);
const moving = new Map(); // ship id -> the line we are on, and the one before it
const mine = new Set();
let me = null,
    clockOffset = null;

// Straight from public/game.js: snapshots are placed on the timeline by the server's send
// time, corrected by the least-delayed packet seen. A pilot that stamped by arrival would
// measure its own scheduling rather than the server's.
const renderStamp = (serverTime, arrival) => {
    const delay = arrival - serverTime;
    if (clockOffset === null || delay < clockOffset) clockOffset = delay;
    else clockOffset += 0.0005 * (delay - clockOffset);
    return serverTime + clockOffset;
};
const along = (tr, clock) => {
    const dt = (clock - tr.t) / 1000;
    return { x: tr.x + tr.vx * dt, y: tr.y + tr.vy * dt };
};

const seen = {
    corrections: 0,
    back: 0, // corrections that put a ship behind where we had carried it
    backUnits: 0, // ...and how far behind, summed
    worstBack: 0,
    forward: 0,
    forwardUnits: 0,
    orders: 0,
    messages: 0,
    bytes: 0,
};

ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', session: SESSION })));

ws.on('message', (raw) => {
    seen.messages++;
    seen.bytes += raw.length;
    let m;
    try {
        m = JSON.parse(raw);
    } catch {
        return;
    }
    if (m.t === 'welcome') me = m.id;
    if (m.t === 'ships')
        for (const [id, info] of m.set || [])
            if (info.owner === me) mine.add(id);
    if (m.t !== 'm') return;
    const rt = renderStamp(m.st, performance.now());
    const clock = performance.now() - RENDER_DELAY;
    for (const row of (m.a || {}).ship || []) {
        const [id, x, y, , vx, vy] = row;
        const track = { x, y, vx, vy, t: rt };
        const had = moving.get(id);
        moving.set(id, track);
        if (!had || !mine.has(id)) continue;
        // Where we had already carried it, against where we are now told it was. The
        // difference projected on the direction of travel: negative is a step backwards,
        // which is a ship visibly changing its mind.
        const was = along(had, clock);
        const now = along(track, clock);
        const sp = Math.hypot(had.vx, had.vy);
        if (sp < 1) continue; // sitting still: there is no "backwards" to be
        const along_ =
            ((now.x - was.x) * had.vx + (now.y - was.y) * had.vy) / sp;
        seen.corrections++;
        if (along_ < 0) {
            seen.back++;
            seen.backUnits += -along_;
            if (-along_ > seen.worstBack) seen.worstBack = -along_;
        } else {
            seen.forward++;
            seen.forwardUnits += along_;
        }
    }
});

// The route. Fixed rather than random, so two runs fly the same ground and their numbers
// mean the same thing. Two of them, because they are different workloads and a change can
// help one and not the other:
//
//   spiral -- always new ground. Everything is generated, merged and mapped for the first
//             time, and nothing is ever seen twice.
//   patrol -- a circuit flown over and over. Ground is made once and then revisited, which
//             is what most play actually looks like.
//
// Real play is a mixture, and a change measured on only one of these has been measured on
// half the game.
const ROUTE = arg('route', 'spiral');
let leg = 0;
const waypoint = () => {
    if (ROUTE === 'patrol') {
        // Four corners, a couple of screens apart, walked round and round.
        const at = leg % 4;
        return {
            x: at === 0 || at === 3 ? -LEG : LEG,
            y: at < 2 ? -LEG : LEG,
        };
    }
    const a = leg * 2.4; // radians; an irrational-ish turn, so legs do not retrace
    const r = LEG * (1 + leg * 0.35);
    return { x: Math.round(Math.cos(a) * r), y: Math.round(Math.sin(a) * r) };
};

const orders = setInterval(() => {
    if (ws.readyState !== 1 || !mine.size) return;
    const to = waypoint();
    leg++;
    // One message a ship: `move` names a single hull, which is how the client sends it.
    for (const id of mine) {
        ws.send(JSON.stringify({ t: 'move', ship: id, x: to.x, y: to.y }));
        seen.orders++;
    }
    ws.send(JSON.stringify({ t: 'view', x: to.x, y: to.y }));
}, EVERY);

setTimeout(() => {
    clearInterval(orders);
    const per = (n, d) => (d ? (n / d).toFixed(1) : '0.0');
    console.log(
        JSON.stringify(
            {
                route: ROUTE,
                seconds: SECONDS,
                ships: mine.size,
                orders: seen.orders,
                messages: seen.messages,
                kbPerSecond: +(seen.bytes / 1024 / SECONDS).toFixed(2),
                corrections: seen.corrections,
                backwards: seen.back,
                backwardsShare: +per(100 * seen.back, seen.corrections),
                backwardsUnitsMean: +per(seen.backUnits, seen.back),
                backwardsUnitsWorst: +seen.worstBack.toFixed(1),
                forwardUnitsMean: +per(seen.forwardUnits, seen.forward),
            },
            null,
            2,
        ),
    );
    ws.close();
    process.exit(0);
}, SECONDS * 1000);

ws.on('error', (e) => {
    console.error(`pilot: ${e.message}`);
    process.exit(1);
});
