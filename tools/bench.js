// One instrumented run, start to finish: stand a server up on a port nobody is using, fly
// a fixed route, scrape the counters either side of it, stop the server cleanly, and print
// what changed. Nothing here is meant to be watched -- it prints once, at the end.
//
// The server is started with --cpu-prof, whose profile is written from an exit hook. That
// is why it is stopped with SIGTERM and why the server handles it: killed any harder, the
// profile is never written and the run is wasted.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, fallback) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
};
const SECONDS = Number(arg('seconds', 90));
const PORT = Number(arg('port', 8300));
const LABEL = arg('label', new Date().toISOString().replace(/[:.]/g, '-'));
const KEEP = process.argv.includes('--keep'); // keep the world, to measure a second visit
const out = path.join(
    arg('out', path.join(os.tmpdir(), 'ragtag-bench')),
    LABEL,
);
const data = path.join(out, 'world');

fs.mkdirSync(out, { recursive: true });
if (!KEEP) fs.rmSync(data, { recursive: true, force: true });

const scrape = async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/metrics`);
    const text = await res.text();
    const d = {};
    for (const line of text.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const i = line.lastIndexOf(' ');
        d[line.slice(0, i)] = Number(line.slice(i + 1));
    }
    return d;
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The pid is captured at launch and killed directly. Looking the port up afterwards is
// what silently misses, and a missed kill leaves 60-140MB standing for the life of the
// shell -- this repo has lost several gigabytes that way.
const server = spawn(
    process.execPath,
    [
        '--cpu-prof',
        `--cpu-prof-dir=${out}`,
        `--cpu-prof-interval=${arg('interval', 500)}`,
        'server.js',
        `--port=${PORT}`,
        `--datadir=${data}`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
);
const log = [];
server.stdout.on('data', (b) => log.push(b.toString()));

let over = false;
const stop = () => {
    if (over) return;
    over = true;
    server.kill('SIGTERM');
};
process.on('exit', stop);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(1));

try {
    // Up and listening before anything is asked of it.
    for (let i = 0; i < 60; i++) {
        try {
            await scrape();
            break;
        } catch {
            await wait(250);
        }
    }
    // A moment of quiet first: the first rebuild is a cold cache and says nothing about
    // steady state, and it would otherwise sit inside the measured window.
    await wait(3000);
    const before = await scrape();

    const pilot = spawn(
        process.execPath,
        [
            'tools/fly.js',
            `--url=ws://127.0.0.1:${PORT}`,
            `--seconds=${SECONDS}`,
            `--session=bench-${LABEL}`,
        ],
        { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let flown = '';
    pilot.stdout.on('data', (b) => (flown += b.toString()));
    await new Promise((r) => pilot.on('exit', r));

    const after = await scrape();
    stop();
    await new Promise((r) => server.on('exit', r));
    await wait(200);

    const report = { label: LABEL, out, flight: JSON.parse(flown || '{}') };
    const d = (k) => (after[k] || 0) - (before[k] || 0);
    const span = d('ragtag_uptime_seconds');
    const rebuilds = d('ragtag_phase_ticks_total{phase="merge"}');
    report.server = {
        seconds: +span.toFixed(1),
        ticks: d('ragtag_tick_seconds_count'),
        tickMsMean: +(
            (1000 * d('ragtag_tick_seconds_sum')) /
            (d('ragtag_tick_seconds_count') || 1)
        ).toFixed(2),
        // The one number the whole exercise is about: world time the clamp discarded, which
        // the clients had already flown through and get pulled back from.
        lostWorldSeconds: +d('ragtag_sim_debt_seconds_total').toFixed(3),
        overruns: d('ragtag_tick_overruns_total'),
        gaps: d('ragtag_gaps_total'),
        rebuilds,
        unions: d('ragtag_merge_unions_total'),
        differences: d('ragtag_merge_cuts_total'),
        rockImpacts: d('ragtag_rock_impacts_total'),
        shadowMisses: d('ragtag_shadow_miss_total'), // only counted under SHADOW=1

        rockScans: d('ragtag_rock_scans_total{of="all"}'),
        rockScansNearBlock: d('ragtag_rock_scans_total{of="near_block"}'),
        walls: after['ragtag_world{of="walls"}'],
        chunks: after['ragtag_world{of="chunks"}'],
    };
    const buckets = [
        '0.005',
        '0.01',
        '0.02',
        '0.033',
        '0.05',
        '0.1',
        '0.2',
        '0.5',
        '1',
        '+Inf',
    ];
    let prev = 0;
    report.tickBands = {};
    for (const le of buckets) {
        const cum = d(`ragtag_tick_seconds_bucket{le="${le}"}`);
        report.tickBands[`<=${le}`] = cum - prev;
        prev = cum;
    }
    report.phases = {};
    for (const k of Object.keys(after))
        if (k.startsWith('ragtag_phase_seconds_total{')) {
            const name = k.slice(k.indexOf('"') + 1, k.lastIndexOf('"'));
            const v = d(k);
            if (v > 0.0005)
                report.phases[name] = {
                    seconds: +v.toFixed(3),
                    msPerRebuild:
                        name.startsWith('merge') && rebuilds ?
                            +((1000 * v) / rebuilds).toFixed(1)
                        :   undefined,
                };
        }
    // What no phase claimed. It is the unnamed rest of step() -- ships, turrets, bullets,
    // rocks -- and if it is the biggest number here, the profile is where to look next.
    const named = Object.entries(report.phases)
        .filter(([n]) => !n.includes(':') && n !== 'merge')
        .reduce((s, [, v]) => s + v.seconds, 0);
    report.unattributedSeconds = +(
        d('ragtag_tick_seconds_sum') -
        named -
        (report.phases.merge?.seconds || 0)
    ).toFixed(2);

    report.profile =
        fs
            .readdirSync(out)
            .filter((f) => f.endsWith('.cpuprofile'))
            .map((f) => path.join(out, f))[0] || null;
    fs.writeFileSync(
        path.join(out, 'report.json'),
        JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.profile)
        console.log(`\nheat map:  node tools/heat.js ${report.profile}`);
} finally {
    stop();
}
