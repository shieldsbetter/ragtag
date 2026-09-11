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
skill. Shellfire is exact; imprecision is added deliberately, as a tunable, and never
inherited from sloppy maths. The first of it is the flak, which fires too fast to be
modelling shells and does not try: the shot is resolved the moment it leaves, hit or miss
on a roll against range, and what is drawn is a line that is gone again. A mount may also
refuse everything but one kind of target — a property of the gun, not a preference, so it
sits in the module and not in the priorities.

**Terrain is the board.** Walls are obstacles ships cannot cross, and the eventual
intent is biomes: open space with occasional structures at one extreme, narrow tunnels
and fissures through dense rock at the other. Neither extreme is the design target —
both must work. Walls will eventually be destructible, which is why overlapping walls
are merged into single polygons rather than left stacked.

**A warren is meant to be gone through, not round.** The dense end of that range is
somewhere you usually get across, not a wall with a way in — so a tunnel reaches every edge
of the cell and the bores are wide enough to take a hull. Usually is the standard, not
always: a spur may dead-end and a passage may be too tight, and being caught out by one is
the biome doing its job. What is not allowed is a warren that seals the ground behind it.

**Mobile first.** The phone is the target; desktop is the phone with a mouse. The whole
gesture budget is tap, drag, long-press and pinch — and drag is already the map, so it
is really three. Having nothing selected is a legitimate state, not an empty one to fill:
it is how a fleet is put down without ordering it somewhere by accident. A feature needing a fifth gesture needs a different design, not a
modifier key. Feedback is sized in screen pixels, never world units, because a thumb is
the same size at every zoom and covers roughly 45px of whatever is under it.

**A fleet retires with its commander.** The world outlives a session — the mesh, the
rock you cut, what you were told — but a player's ships do not stand in it while nobody is
flying them. They are kept where they were left for `LOGOFF_GRACE`, two minutes, so a
dropped connection is not a lost battle and quitting a fight is not a way to save a hull;
after that they go into the player's record and come back next time at `respawnSite` — the
last station anybody in the fleet touched, the origin until one has been. Leaving them
standing is not a kindness: a crewed hull is what makes terrain, so every fleet that ever
existed would hold ground resident from boot.

**A hold is a place, not a pool.** Cargo moves between two of your own hulls freely and
for nothing — it is all yours already, and charging a fleet to shift its own cargo teaches
people to leave it aboard whichever ship happens to be going. But they have to be alongside
(`TRANSFER_REACH`, near enough that both are on screen at once with the camera between
them), because a fleet whose holds are one pool wherever the hulls are is a fleet that never
has to sail anything home, and the walk back with a full hold is most of what a hold is for.

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

**A second set piece costs a `kind` and a version, and nothing else.** Low Berth is a
cavern with one way in; Still Basin is the other kind of settlement, a slab of rock with a
warren dug through it. Each mouth keeps a moat for the reason the town's door has one: a
neighbour's blob landing across it would seal that way in. It claims its hexagon the same
way, names itself the same way, and offers the same two things to do through the same two
conversation modules. It is founded once, 35 screens out at a bearing nobody chose, on a
world that does not already have one.

**A biome may bring its own generator, and the warren is the first that does.** The others
are a density and a blob size run through one scatterer; a warren is bored, not scattered, so
`BIOMES` takes an optional `make` instead. The same walks the second city is dug with, minus
everything a settlement adds: no hub, no station, and no count that can be written down --
the cell is filled with rock and bored through in proportion to how much ground it turned out
to have. A trunk goes out through the middle of every edge of the cell, which is the whole of
how two warrens meet: both make for the middle of the edge they share, from opposite sides, so
the seam is a junction without either cell knowing the other exists or what it turned out to
be. It lays `rock`, not `block`, so a neighbour's field merges into it rather than being
truncated at the border the way the town's asteroid truncates its own neighbours.

**A biome may decline a cell, and the roll goes on without it.** Some ground does not suit
some of them: the cut is superlinear in how much of it there is, and a cell 16,841 across
costs a warren 481ms against 37ms for a median one — half a second is a stall the whole
server feels. Cells run wildly over target and nothing in the mesh can be bent to stop that,
so `takes(s)` is part of what a biome is and a warren says no to anything past `WARREN_BIG`.
Declining takes that one name out of the hat and the roll runs over the rest, so the ground
is not quietly handed to any particular biome either — measured, an ordinary cell comes out
40/40/20 open/dense/warren and an oversized one 50/50 open/dense. If every biome declines,
the cell is `open`: there is always somewhere for nothing in particular to go. The
alternative — generating somebody else's terrain under your own name — leaves `kind` saying
one thing while the ground says another, and everything that reads a cell's kind is then
reading a lie. Worst case is now 213ms, near what a set piece costs.

**A tunnel is a walk, and the warren is what the walks make between them.** Nothing lays a
network out. A trunk is a walk steered toward the middle of one edge of the cell, bending
the whole way and arriving because the last point is the mouth regardless — six of those, so
every edge has a way out. A spur is the same walk with nothing steering it, started from a
point on whatever is already dug. Spurs run across trunks and across each other, and a
crossing is a junction because the warren is all one cut. Clearings are opened where those
points are furthest apart, which is what stops a market and a yard ending up side by side.

**What makes it read as rock is the rock left standing, and three rules put it there.**
Bores are deliberately narrow against the slab: at full width the trunks severed it into
plates and the place read as something shattered rather than something tunnelled through.
A minimum rib (`CITY_PILLAR`) stands between any two tunnels: a step that would eat it turns
away from whatever it came too near and tries once more, and a walk that cannot get clear is
running _alongside_ rather than crossing, so it ends there. That budget is in steps and there
is no angle to measure — a crossing is in and out again whatever angle it comes in at, and
the shallow crossing, which is the worst kind of seam, is exactly the one that cannot get
clear. And each spur sets out from a different quarter of the compass, taken in turn, and
from the outer of two picks within it: left to pick freely spurs clump, because every spur
adds its own points to the pool and wherever the last one went is where the next is likeliest
to start — the warren came out packed down one side with plates of untouched rock down the
other, and packed at the hub besides, since every trunk runs through the middle.

The two rules that are not aesthetic: a clearing goes on a _trunk_, never a spur, because a
spur may be half the bore and may dead-end, and a market nobody can reach is not a thing a
player can see to be wrong — only fail at; and a walk covers less ground than it travels, so
a trunk budgeted for the straight-line distance stops short and leaves a plug in its own
mouth. Neither the rib rule nor the step budget may apply to a trunk for that second reason:
a trunk that stops is an edge of the cell with no way out.

**Like stations are one drawing, not two that resemble each other.** The yard's staging and
the market's dome are authored in a _face frame_ — `u` along a rock face, `v` inward off it
— and know nothing else, so the same drawing stands on the town's cavern wall and on a wall
in the second city's warren. What the city has to work out is where that wall is. A clearing
is cut into rock that is already tunnelled, so its wall is not the circle it was drawn as:
tunnels open into it and the void runs on past them, and standing the art at a fixed bearing
put it in mid-air in the middle of a merged cavern. So the wall is found rather than assumed
— march out along each bearing until rock starts, and take the stretch, as wide as the
station itself, where the furthest of those is nearest. The art lies on the deepest point of
that stretch, so none of the station is buried and the rest of the wall stands a little proud
of it, which is what "built against the rock" looks like when the rock is not a drawn circle.
The layout is worked out three times in the life of a cell — by matter, by art and by marks,
all three inside the one `depositCell` that lays the cell down — and nothing carries a
half-spent random stream out of it, which is what makes that safe.

**A conversation names no mark.** `{ open: true }` hands the session to the mark the
conversation is standing at, whichever instance that is, so one foreman module serves every
yard there will ever be. Naming a key instead — `town:yard` — meant the second city's
foreman opened the first city's refit sheet.

**A set piece is versioned and lays itself out again in place.** Its claim is permanent, its
contents are not: bump `SET_VERSION` and every cell of that kind rebuilds what is inside it
on worlds that already exist. Everything deposited carries the cell that put it there, which
is the only way to tell one cell's rock from a neighbour's after both have overhung the same
chunk — and the only way to take back what the previous version left.

**Adding a field to a chunk file must not bump `WALL_FORMAT`.** Only set-piece cells ever
lay themselves out again, so discarding chunk files takes a biome's rock away for good on
ground somebody has already explored. `WALL_OLDEST` is the oldest still read, and fields
added since default to empty.

**A conversation is a stack of frames, and a frame is a name and a bag.** `['yard',
{at: 'work'}]` — plain JSON both halves, so a conversation serialises by being what it
already is. Behaviour is never in the stack: the name is looked up in `conversations/`,
which is what makes a stack safe to write to disk and load into a build that has moved on.
A module is one function handed an immer draft of its own bag; where it is in its own tree
is state like anything else, which is what makes resuming after a reconnect free.

**Frames are asked from the top, and one with nothing to say pops itself.** The bottom
frame is authored by whatever offers the conversation; everything above it is an interrupt
— something to be dealt with before the usual business. A step is `{say, options}`,
`{pop}` (drop me, ask the next one down), `{exit}` (it ends, I stay), `{push: name}` (put
that conversation on top of me and ask it — how work is taken on) or `{open: markKey}`
(hand off, and it ends). A quest finished somewhere else pops its own frame the next time
it is asked, so nothing has to reach in and remove it, and the client never learns it was
there. A module this build does not have is dropped with a warning rather than refusing
the save: an interrupt nobody can run degrades to never being mentioned.

**`start` tells a frame being taken up from one being asked again.** Both arrive with no
answer to a question. Walked up to, or uncovered by a pop, a frame should begin at the top
of what it has to say; asked again after a reconnect it should hand back where it already
was. Without the distinction, reconnecting is a way to rewind a conversation.

**The client is handed one step at a time and cannot read ahead.** Words and labels,
nothing else; it answers with the index it tapped. What an option _does_ never crosses the
wire, which is what lets a later step turn on what you have done rather than on what you
have been told. A session is held in a conversation until a step ends it — the sheet has
no way out of its own.

**A conversationalist is an instance, not a role.** One town has one yard foreman, and
the same set piece stamped somewhere else has its own, so the id carries the site that
laid it down — already how one cell's rock is told from a neighbour's. Stacks are per
player, because two people may be mid-sentence with the same person.

**A conversation keeps things in three places, chosen by how widely they should be
known.** A holder is handed three immer drafts. `params` is its own frame's state and dies
when the frame pops. `player` is what this _conversation_ knows about this player — keyed
by the module's name, not the conversationalist's id, so every yard foreman in the world
reads and writes the one bag, which is how one of them knows what you told another; it
rides in the player's record. `place` is what the _set piece_ knows, shared by everybody it
put in the world and by every player who walks up to them; it hangs off the site, because
the site is the instance, so it is saved and loaded with the mesh for free. It is `null`
when whoever is speaking was not put there by a set piece, rather than a draft whose writes
go nowhere: a module that wants a place should find out by asking. A generator may
declare what its place starts out knowing by returning `place` beside its matter, art and
marks — filling in only keys that are missing, so laying a cell out again for a new version
replaces what is standing there without unlearning what has happened since. Both bags are
small on purpose: things to branch on, ten keys for a conversation and a hundred for a
place, keys under 50 characters, values booleans, finite numbers, or strings under 50 —
strings because a place knows its own name, capped because the day a bag holds a paragraph
is the day it is a save file. A bag that breaks a rule is dropped whole with a warning
naming it, so a bad write costs the good writes made in the same breath — half a write is
a state nobody authored. A generator's declaration is held to the same rules: it is author
code too.

**Work is a conversation with two more exports, and that is the whole of the difference.**
`offer({from, src, player, place, kills, quests})` says whether it is on the table;
`describe(quest, {kills})` writes the line it reads as in the quest sheet, so "(2
remaining)" is worked out when it is asked rather than kept up to date by somebody. A
conversation node reaches the rest with `gatherWork()`, which runs every predicate and
drops anything already on this conversationalist's stack — so "you have that one already"
is answered by the stack rather than by a flag. A predicate that throws says no: a mistake
in one piece of work must not take down the conversation it was offered in. The giver puts
it on the stack with `{push}` and says nothing more.

**A quest is a thing in the world, not a note on a player.** They live in one bag in
`quests.json` beside the mesh — `{id, kind, who, src, state, done}` — and `who` is a player
today because that is the seam a shared quest widens: something a group is working on wants
one record, not one apiece. What a quest _means_ stays in the module that gave it; the
record only carries where it was taken and whatever state the giver put in it. Finished
ones are kept rather than deleted, which is what lets `offer` answer "not twice at this
yard" with no flag anywhere — and what makes "Any work?" the way to hand work in as well as
to take it on. What a player has destroyed is tallied separately, on the player, by what it
was and what it was part of (`kills.cache.nest`): a quest reads that, it does not own it.

**A set piece can offer something to do, and the server decides what that is.** Besides
matter and art, a generator may emit _interaction markers_: a point, a reach, a kind, and
an icon the marker carries itself. Tapping one sends the selection there _armed_; arriving
inside the reach fires the interaction, and the server tells the client what to open. A
Arriving fires the armed action once and clears it, whatever comes of it — but a session
shows one sheet at a time, so a second ship arriving while the first is still up fires into
a session with no room for it and nothing happens. Nothing is queued, and closing the first
does not let the second in: a sheet that opens by itself long after the tap that armed it is
worse than one that never opens. Being ordered anywhere else disarms.

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
— three max-zoom screens — of a player's ship, and nothing else. Ground itself is made one
chunk further out than that (`AOI_LOAD`): a skirt, so there is somewhere _outside_ the
active radius for a thing to be placed and then discovered by pushing the radius over it.
Chunk residency has its own radius on top of the skirt rather than sharing the rocks'
`AOI_KEEP`, which would have inflated the rock field as a side effect of loading further. A camera may _hold_
what it is looking at so nothing vanishes in front of you, but it may never call anything
into being: otherwise a finger on the map drags the world into existence for as far as
anyone cares to scroll, deciding biomes for ground nobody has been near.

**A player is world state, and the session is their name.** `players.json` holds what
cannot be worked out again: the fleet, the score, and where they are up to with everybody
they have spoken to, including the conversation they were in the middle of. It is keyed by
the session string the client keeps in localStorage — a bearer token and nothing more,
which is the right weight for a game with no accounts. Ids are one counter shared by
players, ships, rocks and ore, so it is saved with them: a restored ship keeps its id,
because a conversation held mid-sentence names the ship that started it. What is _not_
saved is everything the world makes for itself — rocks, ore, fighters, the settlement's own
guns — which is the same bargain the mesh makes.

**The map is a picture of where you have been, not a view of the world.** A wall exists
only while its chunk is loaded and merged, so a map of everywhere you have been cannot be
made of walls. The server samples an 8×8 grid of _what matter is standing where_ as a
crewed hull passes — five chunks either side of the one it is in, two chunks a tick off a
queue — and keeps a byte a cell, which is room for every kind of matter there will ever be.
Every sample asks with `ensure = false`: the map may only ever record ground that already
exists, or looking at it would call the world into being ahead of anybody going there.
Sampled again on every visit, which is precisely when a wall somebody has blown a hole in
shows the hole — the map is as old as your last look at the place and says nothing about
what has happened since.

**A tile is stored once for everybody, under the hash of what it says.** Two players who
have stood in the same place have seen the same ground, and an unexplored chunk is the same
sixty-four zero bytes for all of them — so a player's map is a list of names and the
pictures behind the names are world state, in `tiles.json`. Deflated on the way to disk,
where a tile is mostly one repeated byte; sent raw, because the socket deflates the whole
message anyway and inflating in a browser would need a decompression stream nothing else
here depends on. The client caches a painted tile under the same name, which can never go
stale: a different picture would have a different name. Measured: 57 distinct pictures
behind 75 chunks, 2.3KB on disk, 0.02ms a frame to pan.

**Nothing rock-shaped arrives in sight.** Asteroids are stocked and culled across the
whole area of interest rather than a small disc: they appear only in a thin band just
outside `AOI_R` and are culled past `AOI_KEEP`, so no one watches one wink in or out.
Density is what is preserved, not the count — the same rock per unit of space over an
area twenty times larger, about 500 a ship. The band has to sit _inside_ the radius the
stocking counts over, or rocks spawn where they are never counted and the field grows
without bound. Ore is exempt on purpose: it comes and goes near the ship, because it
is meant to be noticed.

**An encounter declares how often and how far apart, and nothing else about where it
goes.** `place: { per, apart }` on a script in `SCRIPTS` — how many of it a newly loaded
chunk is worth, and how near another of its own kind it may stand — and the world does the
rest: the roll, keeping the spot outside `AOI_R`, the spacing, not landing on a ship,
giving up after a few tries, and the radius it builds at. `sd` is there for a kind that
should arrive in clumps; left out, the count per chunk is Poisson, which is as steady as
independent rolls get, and steadier than that is not on offer. The point of the block is
that the next kind of opposition gets all of this right without knowing any of it exists.

**Opposition is found, never delivered.** Everything is placed outside `AOI_R` — in the
skirt, never within the active radius — and builds its ships at `ENC_BUILD`, which is well
past the 2200 the widest screen can reach. Measured: built 2888 out, first visible forty
seconds later at 1273. Found at the rim, a nest was always there and you sailed up to it;
the fighters were already flying when you came over the horizon. `ENC_KEEP` has to stay
above `ENC_BUILD` with room to spare, or a ship hovering between the two builds a nest,
drops it for being unwatched, and builds it again for ever. Spacing rather than the roll is
what governs density: most rolls land too near something and are dropped.

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

**`polygon-clipping` falls over on a warren, and one throw is the whole set piece.**
Hundreds of overlapping quads is exactly the input that produces "unable to find segment in
SweepLine tree" — a segment whose ends differ in the twelfth decimal. Measured: 4 cells in
30 threw, and a throw meant the cell came back as a solid slab with no way in, which reads
as the set piece simply not being there. Two defences, both needed: snap every ring to whole
units and drop what collapses, and cut in batches so a batch that still throws costs the
four or five runs of tunnel that were in it rather than the whole town. Batch size is a
speed knob as much as a safety one and the bigger end wins: each batch re-walks the whole
slab, so 128 at a time is a median 99ms against 234 at 32.

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
