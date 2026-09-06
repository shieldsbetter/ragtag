# ragtag

Mobile-friendly multiplayer naval-tactics roguelike.

Newtonian space, no drag: a ship that wants to stop has to turn and burn, and that
takes real time. You command a bag of ships, none of them privileged, and you command
position and facing — the turrets acquire and fire on their own, within the arcs they
are mounted in. Half a second of latency must not matter.

The phone is the target and the desktop is the phone with a mouse. Open the page,
scan the QR, and anyone on your network is in the same world.

> **Alpha.** It runs, it is multiplayer, and it is playable — but there is not much
> _game_ here yet. Expect an unfinished world, sparse opposition, and changes that
> break the save. The world directory is not a format anyone should rely on.

## Run it

```sh
npx @shieldsbetter/ragtag
```

Or install it and keep it:

```sh
npm install -g @shieldsbetter/ragtag
ragtag
```

Either way it prints a QR for each address it can be reached on. Scan one with a
phone on the same network.

## Options

```
Usage: ragtag [options]

Serves the game and simulates it. The world is written to ./ragtag in the
directory the command is run from, unless --datadir says otherwise.

Options:
  -p, --port <number>      Port to listen on. Defaults to 3000, or $PORT.
  --ngrok                  Also open a public ngrok tunnel.
  -d, --datadir <string>   Where the world is kept. Defaults to ./ragtag, or
                           $RAGTAG_DATADIR.
  -h, --help               Show this help and exit.
```

`--ngrok` needs [ngrok](https://ngrok.com/download) installed and authenticated. It is
opt-in because it is metered, and this game pushes a continuous stream to every client.

## Hacking on it

No build step and no framework. `server.js` is the simulation, terrain and streaming;
`public/game.js` is rendering and input.

```sh
npm run dev -- --port 8123   # auto-restart, and the client hot-reloads
npm run lint
npm run prettier
```

`CLAUDE.md` is the design document: what the game is trying to be, and why the odd
parts of the code are the shape they are.

## Licence

ISC. See [LICENSE](LICENSE).
