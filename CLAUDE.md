# ships

A naval-tactics RTS in space. Server-authoritative simulation over a WebSocket, drawn
on a canvas as outlined polygons — Asteroids' look, an RTS's pace.

```
PORT=8123 npm run dev     # 8080 is usually taken on this machine
NGROK=0 PORT=8123 npm run dev   # skip the public tunnel
```

Startup prints the local URL, the tunnel URL, and a QR of it.

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
rendering tricks are a bug, not an optimisation, and platform-specific *feedback* may
only ever be a bonus on top of something that works everywhere.

**Open questions** — undecided, do not assume an answer:
- Pathfinding beyond local avoidance. A ship aims past the edge of whatever single wall
  stands between it and its destination, which clears isolated obstacles. It will not
  solve a maze and is not meant to: it sits in the mouth of a concave pocket until the
  give-up rule stops it. Whether that is ever worth a real search is undecided.
- Opposition. The enemy carrier was removed; what provides conflict is unsettled.
- Whether players can fight each other. All humans share one team today; per-player
  teams would make it PvP, and the machinery already supports it.
- Whether ships ever retire. The world outlives its players and nothing removes ships.

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

**The world is unbounded and deterministic.** Terrain is chunked; each chunk's walls
are a pure function of `(WORLD_SEED, cx, cy)`, written to `world/` on first visit and
read back after. Overlapping blobs are merged with `polygon-clipping` into single
walls, so a wall is a list of rings — outline first, then holes.

**Clients receive only what they can see.** `MAX_VIEW` bounds the camera, the client
reports where it is looking, and snapshots carry only nearby entities plus your own
ships. World *simulation* stays anchored to ships; only delivery follows the camera.

**Interpolation renders the past.** Snapshots are placed on the timeline by the
server's send time, not by arrival, and drawn `RENDER_DELAY` ms late. Stamping by
arrival replays a third of a second of motion in a millisecond when a phone hitches.

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

**Bandwidth is compression-bound, not field-bound.** Snapshots are deflated with a
shared context. Removing redundant fields buys almost nothing; digits do, because
entropy is what survives. Measure before restructuring the protocol.

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

Comments explain *why*, especially where the code looks arbitrary: a constant that was
measured, a workaround for a device bug, an ordering that matters. What the code does
is visible; what it is defending against is not.

Prefer measuring to reasoning. Most of this file's harder-won lines exist because a
plausible theory was wrong and a measurement was not.
