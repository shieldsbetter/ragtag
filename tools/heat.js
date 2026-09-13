// A .cpuprofile is JSON: a tree of call frames, each with the number of samples that
// landed IN it (self time), plus the sample list and the gaps between samples. So the heat
// map is two walks -- one to sum self time, one to push it up through the parents -- and
// needs nothing installed.
//
// Self time is where the work is. Total time is where to look for it: a function with no
// self time and all the total is the one that called the expensive thing.
import fs from 'node:fs';

const file = process.argv[2];
const top = Number(process.argv[3] || 30);
if (!file) {
    console.error('usage: node tools/heat.js <file.cpuprofile> [rows]');
    process.exit(1);
}
const prof = JSON.parse(fs.readFileSync(file, 'utf8'));

// Samples are node ids and timeDeltas are microseconds since the previous sample, so a
// node's self time is the sum of the deltas of the samples that named it. Hit counts alone
// would assume an even sample interval, and the profiler does not promise one.
const self = new Map();
const { samples = [], timeDeltas = [] } = prof;
for (let i = 0; i < samples.length; i++)
    self.set(samples[i], (self.get(samples[i]) || 0) + (timeDeltas[i] || 0));

const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes)
    for (const c of n.children || []) parent.set(c, n.id);

// A function appears once per call path; the heat map wants it once. Keyed by where it is
// written, not by the path it was reached through.
const where = (n) => {
    const f = n.callFrame;
    const name = f.functionName || '(anonymous)';
    const at = f.url ? `${f.url.split('/').pop()}:${f.lineNumber + 1}` : '';
    return at ? `${name}  ${at}` : name;
};
// Frames that are not the program doing work: the profiler's own scaffolding, and the
// time the loop spent waiting for its next tick, which is most of a run and none of the cost.
const IDLE = new Set(['(root)', '(idle)', '(program)', '(garbage collector)']);

const selfBy = new Map();
const totalBy = new Map();
let wall = 0,
    busy = 0;
for (const n of prof.nodes) {
    const t = self.get(n.id) || 0;
    wall += t;
    const k = where(n);
    selfBy.set(k, (selfBy.get(k) || 0) + t);
    if (!IDLE.has(n.callFrame.functionName)) busy += t;
    // Push this node's self time up its ancestors, counting each function once per sample
    // so recursion does not multiply it.
    const climbed = new Set();
    for (let id = n.id; id !== undefined; id = parent.get(id)) {
        const key = where(byId.get(id));
        if (climbed.has(key)) continue;
        climbed.add(key);
        totalBy.set(key, (totalBy.get(key) || 0) + t);
    }
}

const ms = (us) => (us / 1000).toFixed(1);
const pct = (us) => ((100 * us) / (busy || 1)).toFixed(1);
const rows = (map) =>
    [...map]
        .filter(([k]) => ![...IDLE].some((i) => k.startsWith(i)))
        .sort((a, b) => b[1] - a[1])
        .slice(0, top);

// Shares are of busy time, not of the wall: a run that idles twice as long is not a run
// whose hot function got cheaper.
console.log(
    `${file}\n  ${ms(wall)}ms sampled, ${ms(busy)}ms of it doing something ` +
        `(${((100 * busy) / (wall || 1)).toFixed(1)}% of the wall; shares below are of the busy half)\n`,
);
console.log('SELF -- where the time is actually spent');
for (const [k, v] of rows(selfBy))
    console.log(`  ${ms(v).padStart(9)}ms  ${pct(v).padStart(5)}%  ${k}`);
console.log('\nTOTAL -- where to look for it');
for (const [k, v] of rows(totalBy))
    console.log(`  ${ms(v).padStart(9)}ms  ${pct(v).padStart(5)}%  ${k}`);
