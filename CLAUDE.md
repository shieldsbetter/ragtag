# ragtag

A mobile-friendly multiplayer naval-tactics roguelike. Server-authoritative simulation over a WebSocket,
drawn on a canvas as outlined polygons — Asteroids' look, an RTS's pace.

```
npm run dev -- --port 8123             # 3000 is the default
npm run dev -- --port 8123 --ngrok     # ...and a public ngrok URL
```

Startup prints the localhost URL, this machine's address on the local network, and a QR
of the latter to scan from a phone. The tunnel is opt-in because it is metered and this
game pushes ~22KB/s per client continuously.

---

## Game design goals

The section to edit when intent changes. Everything below it follows from these.

**Tactics, not reflexes.** Half a second of latency must not matter. Orders are given
to ships, not executed by twitch. Nothing in the design may assume a fast connection or
a steady hand.

**Newtonian space.** No drag. A ship that wants to stop must turn and burn, and that
manoeuvre takes real time. Capital ships are heavy and slow to answer the helm; that
sluggishness is the game, not an obstacle to it.

**A fleet, not an avatar.** A player owns a bag of ships. None is privileged, none is
"you". Selection moves between them freely.

**Ships fight themselves.** Turrets acquire, lead and fire without orders, within their
mounted arcs and line of sight. The player commands position and facing — where the
guns point is a consequence of where the ship is, which is what makes positioning the
skill. Gunnery is currently exact; imprecision is meant to be added deliberately, as a
tunable, not inherited from sloppy maths.

**Terrain is the board.** Walls are obstacles ships cannot cross, and the eventual
intent is biomes: open space with occasional structures at one extreme, narrow tunnels
and fissures through dense rock at the other. Neither extreme is the design target —
both must work. Walls will eventually be destructible, which is why overlapping walls
are merged into single polygons rather than left stacked.

**Mobile first.** The phone is the target; desktop is the phone with a mouse. The whole
gesture budget is tap, drag, long-press and pinch — and drag is already the map, so it
is really three. Having nothing selected is a legitimate state, not an empty one to fill:
it is how a fleet is put down without ordering it somewhere by accident. A feature needing a fifth gesture needs a different design, not a
modifier key. Feedback is sized in screen pixels, never world units, because a thumb is
the same size at every zoom and covers roughly 45px of whatever is under it.

**One game on every screen.** Phone and desktop show the same thing. Platform-specific
rendering tricks are a bug, not an optimisation, and platform-specific _feedback_ may
only ever be a bonus on top of something that works everywhere.

**Open questions** — undecided, do not assume an answer:

- Pathfinding beyond local avoidance. A ship aims past the edge of whatever single wall
  stands between it and its destination, which clears isolated obstacles. It will not
  solve a maze and is not meant to: it sits in the mouth of a concave pocket until the
  give-up rule stops it. Whether that is ever worth a real search is undecided.
- Opposition. Each newly loaded chunk rolls once, at long odds, for a nest: an ore
  cache with three fighters standing over it. Exploring is what finds a fight, and the
  fight and the reward are the same thing to find. Fighters come at you and die rather
  than leaving hulks; whether they should ever patrol, or leave their cache, is
  undecided.
- Whether players can fight each other. All humans share one team today; per-player
  teams would make it PvP, and the machinery already supports it.
- Whether ships ever retire. The world outlives its players and nothing removes ships.

**Not requirements** — do not reason from these, and do not reintroduce them as
justifications:

- _That the data directory can be deleted and the same world come back._ It cannot, and that is
  fine. The world is state, not a cache of a seed: the mesh is grown as it is explored,
  cells are decided from whatever content exists at that moment, and generation is
  allowed to depend on what was generated before it. Reproducibility from the seed was
  never asked for and has been explicitly ruled out. Weighing a design against it costs
  real time and has done so more than once.

---

## Shape of the thing

`server.js` — simulation, terrain, streaming. `public/game.js` — rendering and input.
`public/index.html` — a canvas and a HUD. No build step; no framework.

**The server owns everything.** Clients send orders (`move`, `face`, `view`, `hello`)
and receive snapshots at 30Hz. A client renders; it does not simulate.

**One integrator.** `advance()` is the only place physics happens, and both the live
simulation and the autopilot's forward rollout call it. A prediction that used its own
copy of the maths would drift from the truth it predicts.

**Navigation is measured, not derived.** `stopDistance()` simulates the ship's own
braking manoeuvre to find where full throttle has to end. There is no tuned brake
constant, which is why a hull with different stats needs no retuning.

**Hulls are data.** `CARRIER` holds accel, turn rate, mounts, turret stats, collider
discs. A new class of ship is a new object here.

**Matter is units; a wall is a view of them.** A unit is one lump: a polygon and what it
is made of. Units are the only thing stored. A chunk owns the units whose centre falls
inside it and is free to have them hang over its seams. A _wall_ is not held anywhere —
it is the answer to "what does the loaded matter look like from outside", built by
unioning touching units of the same material with `polygon-clipping`, so a wall is a list
of rings (outline first, then holes). Nothing about it is persisted, which is what makes
laying material down, cutting a vein out of rock and blasting a hole in it all the same
kind of operation: an edit to units.

**A set piece can draw whatever it likes, and the client is never told what it is.** Besides
matter, a generator may emit _art_: polylines in world coordinates, filed into the chunk
where they start and streamed by key exactly as walls are, so they arrive when you are near
and leave when you go. The client draws lines and has no idea what any of it depicts — no
matching artwork has to be shipped for a new set piece to look like something, and nothing
about it collides, merges or is matter.

**The yard is where a hull is worked on, and the marker is the only way in.** Refitting is
checked against the reach of something offering to do it, not against being somewhere in
the cavern, so the rule the order is validated by is the same one that opened the sheet.

**A set piece is versioned and lays itself out again in place.** Its claim is permanent, its
contents are not: bump `SET_VERSION` and every cell of that kind rebuilds what is inside it
on worlds that already exist. Everything deposited carries the cell that put it there, which
is the only way to tell one cell's rock from a neighbour's after both have overhung the same
chunk — and the only way to take back what the previous version left.

**Adding a field to a chunk file must not bump `WALL_FORMAT`.** Only set-piece cells ever
lay themselves out again, so discarding chunk files takes a biome's rock away for good on
ground somebody has already explored. `WALL_OLDEST` is the oldest still read, and fields
added since default to empty.

**A conversation is a tree the server walks and the client cannot read.** A node is a
statement and a list of things you may say back; the client is handed one node at a time
— the words and the labels, nothing else — and answers with the index it tapped. What an
option _does_ never crosses the wire, which is what will let a later node turn on what
you have done rather than on what you have been told. A session is held in a conversation
until an option ends it: the sheet has no way out of its own, and the node is resent on
reconnect, so a reload lands back on the same words. Handing off to another interaction
_ends_ the conversation rather than suspending it — you walk the tree again if you want
it back.

**A set piece can offer something to do, and the server decides what that is.** Besides
matter and art, a generator may emit _interaction markers_: a point, a reach, a kind, and
an icon the marker carries itself. Tapping one sends the selection there _armed_; arriving
inside the reach fires the interaction, and the server tells the client what to open. A
session holds one interaction at a time, so a second ship arriving while the first is still
inside stays armed and fires when the way clears — which is why one tap can yield two
interactions if the first is closed quickly. Being ordered anywhere else disarms.

**Materials are ranked, and the higher one keeps the ground.** Matter of different kinds
never merges, so where two kinds meet their outlines would otherwise cross in mid-air. The
lower-ranked one is truncated at the boundary instead, so they abut exactly: `block` beats
`rock`, which is how the starter town's asteroid keeps its shape while the biome's rock
stops where it starts. Only pairs whose boxes meet are cut, which is a handful around the
town rather than every wall in the area of interest.

**A settlement gun is a hull set inside the rock, and every odd thing follows from that.**
It is `embedded`: walls do not push it out, walls do not stop its shells, and nothing takes
aim at it — not by decree but because nothing anybody has can reach a thing inside a rock,
so a fighter that could target one would only stall at the mouth plinking at it. It is
unowned, so it never anchors the world, and it traverses all the way round, having no hull
in its own way. Its reach is capped by the shell rather than the gun: 560 a second for 1.2
seconds is 672 units, and a range past that silently rejects every target as unreachable.

**Blocking matter stops asteroids; ordinary rock does not.** A drifting rock that reaches
`block` comes apart exactly as if it had been shot, and its pieces are put down clear of
the surface and thrown back along its normal — reflecting what the rock arrived with, so a
glancing hit leaves at a glancing angle. Without the throw-back the pieces break out
standing inside the wall and break again at once, and the wall visibly eats the rock
instead of turning it away. Measured: 10 impacts in 12 leave two pieces travelling away.

**The cell generates; the chunk only files.** A generator is handed a cell and returns
polygons of material of any size, anywhere in it — a set piece draws its walls, a biome
scatters its rock — and never sees a chunk or a unit. Anything too big is cut on a fixed
grid, and each piece goes to the chunk holding its centre. Cells generate one per tick
off a queue, driven by a sweep of the area of interest once a second, so ground is made
long before anyone reaches it.

**Re-merging everything on every chunk load costs 85ms.** Working the components out
again is linear and cheap; the booleans are not. The merge is cached by which units went
into it, so a chunk loading at the rim of the area of interest does not re-merge rock
three screens the other way. Steady state is 14-18ms against a 33ms tick.

**The mesh is world state, not a cache.** Space is partitioned by a Voronoi diagram over
persisted sites in `sites.json` under the data directory: every point belongs to its nearest site, so the
partition is total by construction. A site's position is fixed once placed — a loaded
neighbour is already shaped by it — but its biome is undecided until the cell loads,
which is where new content enters: a biome added later is assigned to cells not yet
loaded, without touching anything already generated. Delete the data directory and the terrain
comes back; delete `sites.json` alone and the map does not.

**A set piece claims a cell by placing its neighbours.** For any convex polygon and any
site inside it, reflecting the site across each edge gives the neighbour that produces
that edge — the perpendicular bisector of the pair _is_ the edge line. Six reflections,
six edges, and the Voronoi cell comes out as exactly the authored shape. The claim is
permanent and cannot grow; the contents inside it are free to change with later versions.

**Walls are delivered by their own key, never by chunk.** A wall is merged out of
whatever is loaded and can be far larger than any chunk, so there is no chunk that owns
it; keying delivery by the one holding its centre made a long wall vanish as soon as that
chunk left the client's window, while its far end was still in plain sight. A wall's key
is its lowest-ordered member unit, which holds still while its membership does, so a
rebuild does not make every wall look new and get sent again.

**A set piece asks for its neighbours' biomes, it does not assign them.** A site carries
`want`: a biome it will take when it loads. Writing `kind` up front instead would mark a
cell as loaded while its shape is still unbounded, and the admissibility test would read
its phantom corners as ground worth protecting and refuse every site near it. The town
decrees exactly one neighbour — the one its tunnel points at — `open`, because a dense
biome's blobs reach nearly 400 units past their own cell, further than the asteroid stands
back from the border, and one landing across the mouth would seal the starting town for
everybody, for good. The other five get whatever they get: a decree is for what a set
piece actually needs, not for tidiness.

**Bind a cell, then load whatever it came out as.** The order is: decide to bind a cell
off the side of a loaded one, add sites until it is bounded, subdivide it while it is still
potential, then generate. Size is steered, not required — too big and we subdivide, too
small is fine and left alone — so nothing refuses to load on account of its shape. Being
finite is the one hard rule, because an unbounded cell's outline runs to the far box and
loading it makes the admissibility test protect phantom corners.

**Closing a cell and subdividing it are the same move.** `bindCell` goes at whichever
corner reaches further than a cell ought to. A corner still out on the far clipping box
means nothing bounds the cell that way; a corner at 9,000 means the cell is merely too big;
both are answered by a site between here and there. A site placed inside a cell that is
merely too big takes ground from that cell alone, which is why subdividing is always
available where closing may not be.

**Subdivision is refused where it would reshape a loaded cell, and that is what makes big
cells.** A site is inadmissible if it lands nearer a corner of a loaded cell than that
cell's own site is — so a cell loaded at 20,000 across blocks new sites for 20,000 units
around each of its corners, and its neighbours cannot then be subdivided either. Cells
therefore run over target, with a tail that grows as you travel: measured over a 20,000
unit flight, a median of 3,672 against a 3,240 target but a worst of 16,841. The town's own
six neighbours are permanently 3,672, since each has a corner on a vertex of the authored
hexagon that may never be cut.

**A loaded cell can never be reshaped.** A cell loads only once it is bounded, and no
site may afterwards take ground from it — checked at every corner, since cutting area off
a convex cell always takes a corner with it. Cull that check by the cell's own reach
(`2 × cellRadius`), never by a fixed distance: a sprawling cell's corners run much further
than its site suggests, and a fixed cull let a site 25,000 units away quietly steal one.

**Only a crewed hull makes world.** Terrain and the mesh are generated within `AOI_R`
— three max-zoom screens — of a player's ship, and nothing else. A camera may _hold_
what it is looking at so nothing vanishes in front of you, but it may never call anything
into being: otherwise a finger on the map drags the world into existence for as far as
anyone cares to scroll, deciding biomes for ground nobody has been near.

**Nothing rock-shaped arrives in sight.** Asteroids are stocked and culled across the
whole area of interest rather than a small disc: they appear only in a thin band just
outside `AOI_R` and are culled past `AOI_KEEP`, so no one watches one wink in or out.
Density is what is preserved, not the count — the same rock per unit of space over an
area twenty times larger, about 500 a ship. The band has to sit _inside_ the radius the
stocking counts over, or rocks spawn where they are never counted and the field grows
without bound. Ore is exempt on purpose: it comes and goes near the ship, because it
is meant to be noticed. Nests are placed past `AOI_R * NEST_EDGE` for the same reason a
rock is — found at the rim, a nest was always there and you sailed up to it.

**A "screen" is 1732 world units, and it is the unit to design against.** At full
zoom-out the visible rectangle's half-diagonal is always `MAX_VIEW` (2200) on every
device — `minZoom` solves for it, so the zoom _factor_ changes with pixel size but the
world distance does not. What changes is the aspect, since a fixed diagonal splits
differently: 16:9 sees 1917 × 1078 from the centre, a phone upright sees 1078 × 1917,
21:9 sees 2022 × 866. So the disc that is visible on _every_ device has a radius of 866,
the short half-side of the widest aspect, and one screen is twice that. Content within
half a screen of a point is on screen everywhere. 2200 is the corner reach and nothing
beyond it is ever visible. Width and height individually are not stable — a layout that
fills a 16:9 screen is cropped on a phone held upright, and the reverse.

For scale: a cell is roughly 3.5 screens across, and the area of interest is 7.6.

**Clients receive only what they can see.** `MAX_VIEW` bounds the camera, the client
reports where it is looking, and snapshots carry only nearby entities plus your own
ships. World _simulation_ stays anchored to ships; only delivery follows the camera.

**Nothing is sent on a clock.** There are no snapshots and no tick rate on the wire. A
thing that moves is _described_ — where it was at a moment, and how fast — and the client
carries it on from there in a straight line. It is described again only when that line has
drifted past tolerance (3 units, 0.05 rad), and never more than `MOTION_HZ` (4) times a
second. A rock costs one message for its whole life; a ship sitting still costs nothing;
a ship under power costs four small rows a second. The linear case is not a special case,
it is what happens when the error never grows.

**A correction is a nudge, not a snap.** The client keeps the line it was on as well as
the one it has just been given and cross-fades between them over `MOTION_BLEND` ms with
`u²(3−2u)`, which is flat at both ends — so position _and_ speed stay continuous. The fade
must start where the render clock stood **when the correction arrived**, not at a fixed
offset from the correction's own timestamp: starting part-way along puts a step in exactly
where the fade was meant to remove one. Measured on screen, that mistake showed as a
frame-to-frame speed spike of 3× the median, four times a second.

**Messages are still placed on the timeline by the server's send time**, not by arrival,
and read `RENDER_DELAY` ms late. Stamping by arrival replays a third of a second of motion
in a millisecond when a phone hitches.

---

## Things that have already bitten

**`node --watch` stops silently.** It has twice missed every server change in a
session. The HUD shows the server's source hash and, in dev, flags `STALE` when the
file on disk no longer matches the running process. Check it before believing a change
did nothing. The client's hash is shown too (`c…`).

**Canvas rasterisation is done on the CPU on purpose.** `willReadFrequently` on the
drawing context. A phone's GPU tile rasteriser corrupted individual shapes for single
frames — one hull torn open while the ship beside it drew perfectly. Nothing about what
was drawn could avoid it; this is the only lever a page has. `?gpu=1` opts back in to
compare. Do not remove this without testing on a phone.

**Terrain generation is re-entrant.** `blockedAt` loads the chunks it inspects, so
anything that queries walls _because_ a chunk loaded will pull in nine more, each of
which rolls for its own raider, and the frontier walks outward forever. It starved the
tick loop completely -- the server clock froze while wall time ran on, which looks
exactly like ships being stuck rather than like a busy process. Work triggered by chunk
loading goes on a queue drained after loading settles, and asks with `ensure = false`.

**`siteFor` can answer with a site that is not in the mesh.** When it cannot settle a
cell it hands back a throwaway `{ kind: 'open' }` so terrain does not stall over one
stubborn cell. That object is new every call, so anything that remembers sites in a Set or
keys work off them will never deduplicate it. Queueing it for generation filled the work
queue with jobs that could never be done, and real cells starved behind it at one a tick:
fly far enough from the town and terrain simply stopped arriving. Anything walking the
mesh should iterate `sites`, not collect what `siteFor` returns.

**Raiders are not anchors.** Terrain stays resident and asteroid fields stay stocked
around _crewed_ ships only. A ship left in every chunk you have ever visited would
otherwise hold both open for the life of the process, and the world would grow without
bound as you explore.

**A carved chunk must never be regenerated.** Chunk files carry a format version and
regenerate on mismatch. Once walls are destructible that would silently heal damage —
an "edited" flag is needed before destruction ships.

**Haptics are Chrome-on-Android only.** Firefox disabled vibration in 79 and removed
the API in 129; iOS Safari never had it; the W3C is retiring the spec. `navigator.vibrate`
must stay a bonus — every gesture needs visual confirmation that stands alone. It also
needs user activation, so a pulse is scheduled inside the pointer handler as a pattern
with a leading pause, not fired later from a timer.

**A ship that cannot get there must stop.** Without the give-up rule an unreachable
destination is a carrier shoving at rock forever. It only counts as stuck while actually
burning — a carrier spends its first several seconds turning, motionless and healthy, and
an earlier version of this rule cancelled every order before the ship had moved.

**What goes together is what changes together, not what is about the same subject.**
A ship is split across two channels by _rate_, not by topic: where it is and how it is
moving (including whether it is burning, and where its guns point) on the motion channel;
what it is — hull, loadout, damage, orders, hold — on the standing one, resent whole when
any of it changes. Thrust sat on the standing side for a while, and every flicker of the
throttle resent the loadout with it. Measured: 12.75 KB/s at 30 Hz snapshots, 1.33 after
describing drifters, ~0.3–0.5 with nothing on a clock at all.

**Bandwidth is compression-bound, not field-bound.** Snapshots are deflated with a
shared context. Removing redundant fields buys almost nothing; digits do, because
entropy is what survives. Measure before restructuring the protocol: trimming the three
fields of a rock that never change saved 3% of the wire, and not sending its position at
all saved 93%.

**Test servers leak, and this box has no RAM to spare.** Every throwaway server holds
60-140MB, and any run that dies before its cleanup line leaves one behind. Thirty-eight
of them once accumulated in a single session, about 4.5GB. Capture the pid at launch
(`node server.js & S=$!`) and kill _that_, rather than looking the port up afterwards --
the lookup is what silently misses.

**`pgrep -f` and `pkill -f` match the shell that runs them.** The pattern is a literal
substring of your own command line, so `pkill -f "node server.js"` kills the wrapper
mid-script and the rest of the line never runs -- which looks exactly like the cleanup
having worked. Bracket a character to break the self-match (`pgrep -f 'node [s]erver.js'`)
or, better, use the pid you kept. Node also reports its comm as `MainThread` here, so
`pkill -x node` finds nothing and `top` shows pages of processes that do not look like
node at all.

---

## Diagnostics

`?off=labels,bars,wallfill,walls,arcs` — drop a class of drawing, to bisect a rendering
fault on the device that shows it. `?gpu=1` — GPU rasterisation. `?cpu` is the default.
The dev HUD shows `buf` (snapshot buffer depth), `stalls` (frames that could not
interpolate), `chunks`, and fps.

For anything visual and intermittent, a ten-second screen recording beats reasoning.
`ffmpeg` frame extraction plus an isolated-frame detector — a frame unlike both its
neighbours, while those neighbours resemble each other — found in one pass what days of
theorising did not.

---

## Conventions

Comments explain _why_, especially where the code looks arbitrary: a constant that was
measured, a workaround for a device bug, an ordering that matters. What the code does
is visible; what it is defending against is not.

Prefer measuring to reasoning. Most of this file's harder-won lines exist because a
plausible theory was wrong and a measurement was not.
