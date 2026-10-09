# Development

How to run the game on your own computer, check it on a phone, and run the
same checks a pull request runs.

## What to install

- **Go**, any recent version. The repository pins its own toolchain in
  `go.mod`, and Go downloads it on first use.
- **Node.js 24**, the version in `.nvmrc`. With nvm: `nvm install` in the
  repository, then `nvm use`.
- **npm 12**. Either `npm install -g npm@12`, or `corepack enable npm`, which
  uses the exact version pinned in `client/package.json` and checks its hash.
- **Docker or Podman**, for the database: `tools/dev` runs PostgreSQL 18 in a
  container. Docker Desktop on macOS and Windows; Docker or Podman on Linux.
  Or, instead, **a PostgreSQL 18 of your own**: set `KEEL_DEV_DATABASE_URL`
  to it and no container is started (see [The database](#the-database)).

Nothing else: the certificate tool, linters and scanners are Go tools listed
in `go.mod` and run with `go tool`. TinyGo, which builds the physics package
for the browser, is downloaded into `.dev/` on first use (about 180 MB, once)
and checked against the digest pinned in `tools/internal/tinygo`; its
`wasm-opt` comes with the client's packages.

## The one command

```sh
go run ./tools/dev
```

It checks Node and npm, installs the client's packages when the lock file
has changed, regenerates the catalog, builds the physics module, starts the
database (or finds it running), makes a local HTTPS certificate, builds
`keel`, runs `keel migrate` and starts `keel serve`, starts Vite, and prints
QR codes for setting up a phone and for the game. Changing a Go file
rebuilds the server, migrates and restarts it, and rebuilds the physics
module when the file is in `internal/physics`; changing a client file
reloads the page. Ctrl-C stops everything but the database, which is left
running for next time and for `go test`.

The first run asks for your computer's password once, to trust the local
certificate authority that signs the certificate (mkcert). On macOS it also
asks to allow incoming connections, so phones can reach Vite.

The game is served at your computer's local network address, for example
`https://192.168.1.20:5173`. Use that address on the computer too, so the
computer and phones share one origin.

`go run ./tools/dev -lag 200ms,2%` does the same with the game's traffic
between Vite and `keel` slowed and lost as a phone's network would: half the
round trip each way, and that share of packets lost each way (see [The game
connection](#the-game-connection)). `go run ./tools/dev -limit 2` lets at
most two boats sail: a third tab waits in the queue (see [Other
boats](#other-boats)). `keel` runs with `KEEL_DEV_COMMANDS=1`,
so `curl -X POST 'http://127.0.0.1:9090/debug/wind?knots=15&from=270'`
changes the wind.

## On a phone

The game is served over HTTPS with a certificate your computer makes itself,
so a phone shows "not secure" until it trusts your computer. You do that once
per phone. Keep `go run ./tools/dev` running throughout, and have the phone on
the same Wi-Fi as the computer.

`tools/dev` prints two QR codes:

1. **Once per phone, trust this computer**: a page served by your computer
   over plain HTTP (port 5174), with the steps below and a button to download
   the certificate.
2. **The game**: the HTTPS address (port 5173).

Scan the first, follow the steps for your phone, then scan the second.

### iPhone

1. Open the first QR code in **Safari**: other browsers cannot install
   profiles. If Safari is not your default browser, type the address shown
   above the QR code into Safari. Tap **Download the certificate**, then **Allow** and **Close**.
2. Open **Settings**. Near the top, tap **Profile Downloaded**, then
   **Install**, and enter your passcode. If it is not there: Settings →
   General → VPN & Device Management → the mkcert profile → Install.
3. Settings → General → About → **Certificate Trust Settings**, at the very
   bottom. Turn on the switch for **mkcert**, then tap Continue. Without
   this step the phone still does not trust the certificate.

### Android

1. Open the first QR code in **Chrome**. Tap **Download the certificate**.
2. Open **Settings** and search for **CA certificate**. It is usually under
   Security → More security settings → Encryption & credentials → Install a
   certificate → CA certificate; the names vary by maker.
3. Tap **Install anyway** and choose `keel-dev-root.crt` from Downloads.

### Check it worked

Scan the game's QR code: the sea and the Jolly boat load with no warning,
and the boat can be sailed.
Then open `/dev.html` at the same address, the developer page. Its first line
reads **Secure context: HTTPS**. The rest of the list shows what the phone
offers: WebGPU (and whether its adapter has WebGPU's core features or only
compatibility mode), the screen wake lock, passkeys and module workers. Under
**Physics**, the phone runs every golden scenario in the physics module and
shows whether it got the same bits as the server, and how long a step takes.

The certificate stays trusted until you remove it, so next time just scan the
game's QR code. To remove it later: on iPhone, Settings → General → VPN &
Device Management; on Android, Settings → Encryption & credentials → User
credentials.

## Checks

| Workflow | When | What | Locally |
|----------|------|------|---------|
| `ci.yaml` | Every pull request (each part only when its files changed), every push to `main` | Go tests with the race detector on amd64 and arm64, each with a PostgreSQL service (the physics and simulation tests also built with `GOAMD64=v3`), the tick's benchmarks as a smoke test, short fuzzes of the catalog decoder, the input log's reader, the sailor name check, the decoding of what a game client sends and of the other boats' views (Go's and the page's), the physics module built and its golden tests run in WebAssembly, client tests, the client build (which fails on a bundled package with a licence not in `tools/licences/allowed.txt`) and the size of its first download, and the one command started from scratch, its database container included, and checked over HTTPS with a guest made and read back, its game connection, and a second player seeing the first's boat | `go run ./tools/dev -db` once, then `go test -race ./...`, `go run ./tools/physics` then `npm test` in `client/`, `go run ./tools/dev -smoke` |
| `pr.lint.yaml` | Pull requests, not drafts, that change its files | gofmt, go vet, staticcheck, the store's queries compiled against the migrations and their generated code current (`sqlc compile`, `sqlc diff`), the look-alike table current, Biome and tsc (the client and `art/`) | `go run ./tools/dev -lint` |
| `pr.render.yaml` | Pull requests, not drafts, that change its files | The test sea's fixtures current; the physics module built; the browser tests on Chromium, against `keel` and a PostgreSQL service, on WebGL 2 and, where the runner offers an adapter, WebGPU, in four jobs side by side: each back end's `@long` tests and the rest | `go run ./tools/testsea -check`, `go run ./tools/physics`, `npx playwright test` in `client/` |
| `pr.licences.yaml` | Pull requests, not drafts, that change its files | The licence header in every source file (and the art header in `art/`'s scripts and sound recipes); licences of Go packages linked into `keel` | `go run ./tools/licences` |
| `pr.catalog.yaml` | Pull requests, not drafts, that change its files | The catalog against its schema, unique ids, art present, generated files current, no kind's id used as a string in code | `go run ./tools/catalog -check` |
| `pr.physics.yaml` | Pull requests, not drafts, that change its files | The physics package's rules (imports, `math` functions, no fused multiply-add in the source or the compiled code for arm64 and amd64, nor in the simulation's), its layout files current, and the module built with no heap allocation and within its size budget; each boat's polar against its original's measured data, and the trimmed sail against ORC's mainsail | `go run ./tools/physics -check`, `go run ./tools/polar -check`, `go run ./tools/polar -sail` |
| `pr.actions.yaml` | Pull requests, not drafts | actionlint and zizmor over the workflows | `go tool actionlint` |
| `pr.dependencies.yaml` | Pull requests, not drafts, that change its files | GitHub's dependency review, govulncheck, npm registry signatures | `go tool govulncheck ./...`, `npm audit signatures` in `client/` |
| `pr.secrets.yaml` | Pull requests, not drafts | gitleaks over the pull request's commits | `go tool gitleaks git --log-opts="main..HEAD" .` |
| `codeql.yaml` | Pull requests (not drafts), pushes to `main`, weekly | CodeQL for Go, TypeScript and the workflows | |
| `scorecard.yaml` | Pushes to `main`, weekly | OpenSSF Scorecard | |
| `security.yaml` | Weekly | govulncheck and npm signatures on `main` | |

Every workflow pins its actions to full commit hashes; the repository refuses
any other. Each multi-job workflow ends in one job named after the workflow,
and that job is the required check.

A workflow marked "that change its files" starts with a `changes` job, which
asks `dorny/paths-filter` whether the pull request touches any file the check
reads (the filter is in the workflow, and always includes the workflow itself
and `.github/actions/setup`). The checks run only if it does; the last job
always runs, and passes when every job before it passed or was skipped, so
the required check is reported either way. Those two jobs, which only ask
GitHub's API or read results, run on `ubuntu-slim` (one CPU, a 15-minute
limit), as does the test sea's fixtures check, which runs beside the browser
tests; the rest run on `ubuntu-24.04`. A new file a check reads, outside
the paths its filter lists, must be added to the filter. `pr.actions`,
`pr.secrets` and `codeql` are not filtered: the first and last upload to code
scanning, which the `main` ruleset waits for, and gitleaks must see every
commit.

## The catalog

Kinds of things in the game, such as boat types, are data in
`shared/catalog/*.yaml`, checked against `shared/catalog.schema.json`.
`go run ./tools/catalog` turns them into the server's copy in
`internal/catalog/` and the client's copy in `client/src/catalog/`, with
types for both. Edit the YAML and run the tool; never edit the generated
files. Code reads a kind's properties, never its id.

A boat's `physics` object holds every number its physics needs, in groups
(`hull`, `rig`, `foils`, `sailor`, `rates`), in SI units with angles in
degrees. Every value is required, with its unit and range in the schema. The
schema's fields must match the physics package's `Params` field for field;
the tool checks that and generates `catalog.PhysicsParams` for the server and
`writeParams` (`client/src/predict/params.gen.ts`) for the client, so the
three cannot drift.

## The physics package

`internal/physics` steps boats. The server runs it natively, and the client
runs the same code compiled to WebAssembly by TinyGo to predict the player's
own boat, so both must get the same bits from the same inputs. The package's
rules, at the top of `physics.go`, make that hold:

- It calls only the `math` functions that IEEE 754 rounds exactly, and has
  its own sine, cosine, exponential, logarithm and arctangent (`fmath.go`).
- Every product of floats is written `float64(x*y)`, unless it only feeds
  another product or a division, so Go cannot fuse it into a multiply-add on
  arm64 or amd64 v3. Go fuses across statements and through inlined calls,
  so a product kept in a variable and added later counts too. The check
  disassembles the package and names each line it finds fused.
- Floats become integers only through `toInt32`; a step never allocates.

```sh
go run ./tools/physics          # write the layout files, build client/src/predict/physics.wasm
go run ./tools/physics -check   # the rules, the layout files, the module's allocations and size
```

The records a step reads and writes (`records.go`) are all `float64` or
fixed arrays of them, and the client reads them through typed arrays at
indices generated into `client/src/predict/layout.gen.ts` (an array's index
is its first value's; `ARRAYS` gives its length). Changing a record changes
the layout version; the client refuses a module whose version differs.

- `State`, `Control` and `Env`: what a step reads and writes.
- `Params`: a kind of boat, the catalog's raw values. The client writes them
  with `writeParams` and calls the module's `prepare`; the server calls
  `physics.Prepare`. Everything derived from them is computed there, in the
  package, never in JavaScript.
- `Out`: what a step derives for drawing and instruments (the apparent wind
  at the masthead and the sail, each sail strip's angle of attack and flow,
  the sail's and foils' forces, leeway, speed and course over ground, the
  heeling and righting moments). A step writes it and never reads it, and it
  is never sent.

The golden tests run the scenarios in `internal/physics/testdata/scenarios.json`
natively (`go test ./internal/physics`) and in the module (`npm test` in
`client/`), and compare every step's state and `Out`, and a table of
function values, with `testdata/golden.json`. A scenario can steer with a
simple heading-hold (`steer`), which both runners compute with exactly
rounded operations only. CI runs them on amd64 and arm64. After a deliberate
change to the physics, rewrite the file and review the diff:

```sh
go test ./internal/physics -run Golden -update
```

`go test ./internal/physics -run Accuracy -samples 100000` measures the
functions against values computed with `math/big` on a hundred thousand
inputs each; CI draws four thousand.

## The boat's physics

### The model

A boat is a rigid body in surge, sway, yaw and roll on flat water, with the
boom as a body of its own and the sailor's position as state. There is no
pitch or heave yet: waves bring them. Each part of the boat computes its
force from the flow it meets, including the flow from the boat's own turning
and rolling, so tacks, gybes, luffing, weather helm and capsizes follow from
the forces, with no special cases. Each step is four substeps of
semi-implicit Euler (`Substeps`).

| File | What |
|------|------|
| `wind.go` | The frames; the wind at each height by the open sea's log profile (z₀ = 0.0002 m; the game's wind is 10 m up); the apparent flow at any point of the boat, turned into the heeled body's plane |
| `sail.go` | The sail as two strips, foot and head, the head twisted further out (more as the sailor flattens the sail and as the boom goes out); lift and drag from each strip's angle of attack; the boom on its sheet; the backed head that drags the boom across in an accidental gybe; a capsized sail floating on the water |
| `foils.go` | Daggerboard and rudder: Helmbold's lift slope, the stall to a flat plate, reversed flow, the hull's carry-over, the board's downwash at the rudder |
| `hull.go` | Upright resistance from the towed hull's drag area, cross-flow drag, the Munk moment, the righting lever |
| `sailor.go` | The automatic sailor: hiking to the position that balances the boat, flattening the sail by the apparent wind, falling in past 70° of heel, swimming to the board, righting the boat, climbing back in |
| `boat.go` | The step: the rudder and sheet following the controls at the hands' rates, the substeps, the boom's stop, `Out` |
| `prepare.go` | `Prepare`: every derived constant |

The player has two controls, `Helm` and `Sheet`. The sheet sets how far the
boom may swing out; it never pulls the boom in, so an eased sail luffs, a
trimmed one presses on the sheet, and a sail with the wind behind its leech
swings across.

### The Jolly boat's numbers

The Jolly boat is an ILCA 7 (formerly the Laser, full rig) with an 80 kg,
1.83 m sailor. Each value in `shared/catalog/boats.yaml` says where it comes
from:

- **Measured or published:** hull form and the upright resistance of a towed
  Laser (Day and Nixon 2014); masses, centre of gravity, windage, the
  sailor's reach (Day 2017); rig dimensions (ILCA class); the board's carry-over
  and loss of lift with heel (Keuning and Verwerft 2009); induced and
  quadratic drag (ORC VPP 2023).
- **Fitted:** the sail's greatest lift, stall, drag and separated-flow table,
  and its eased twist, to ORC's low-lift mainsail (`tools/polar -sail`).
- **Estimates, tuned against the reference data:** the board's position and
  the rudder's downwash (weather helm), the flattening (VMG above 9 knots),
  the backed head (where an accidental gybe comes), the sailor's roll-rate
  gain (no death roll running in 22 knots with the boat sailed well), the
  swim and climb times (righting in 15 to 45 s).
- **Estimates, left as argued:** the righting lever beyond the data, added
  masses and inertias, the rudder's size, the sail on the water.

### `tools/polar`

```sh
go run ./tools/polar               # the polar at 6 to 20 knots: a table, and .dev/polar/<boat>.json and .svg
go run ./tools/polar -check        # against internal/physics/testdata/reference.json; fails outside its tolerances
go run ./tools/polar -sail         # the trimmed sail against ORC's mainsail
go run ./tools/polar -manoeuvres   # tacks and gybes at 6, 12 and 18 knots, and where an accidental gybe comes
```

The tool steers with a heading-hold of its own, tries the sheet from hauled
in to let fly at every true wind angle, and measures each point after 60 s
of sailing. Winds are given at sail height, 3 m, where the reference data's
wind was measured; the table shows the 10 m wind beside them. Its columns:
speed and VMG in knots; heel, positive to leeward; rudder, positive for
weather helm; leeway; boom; the foot's angle of attack; how far out the
sailor is; the flattening; the best sheet. In the chart, filled points are
measurements and hollow ones upper bounds (speeds measured with surfing,
which flat water cannot reach).

The reference data (`reference.json`) holds each point with its source:
Day's VPP for upwind and downwind VMG (±5% and ±10%), Binns, Bethwaite and
Saunders's measured close-hauled and beam-reach speeds (±10%), and their
broad-reach and run speeds as upper bounds.

### Recalibrating

When a parameter changes, or better data arrive:

1. Fit the sail first: `go run ./tools/polar -sail` must hold drive within 5%
   of ORC's from 28° to 180°, and side force at 28° and 60°. Change only
   `maxLift`, `stallAngle`, `stallWidth`, `sailDrag`, `normalForce` and
   `twistEased`.
2. The board's position and the downwash, for weather helm upwind
   (`go run ./tools/polar`, the rudder column).
3. `headBacked`, for accidental gybes 10° to 25° by the lee
   (`-manoeuvres`).
4. The flattening, against the upwind VMG above 9 knots (`-check`).
5. The drag area above 9 knots, only if the reaches miss by more than 10%.

Then run the behaviour tests (`go test ./internal/physics`), rewrite the
golden file, and copy the catalog's new values into `scenarios.json`'s
`params` (a test fails until they match). Note each change and its reason in
`reference.json`'s notes.

### Where the model and the data differ

- **Weather helm is light.** Upwind the boat needs 0.1° of weather helm at
  9 knots, 0.7° at 12 and 1.7° at 15: it grows with heel, as it should, but a
  real dinghy carries 2° to 4°. The rudder, working at the leeway angle at the
  stern, balances the boat close to neutral when it is flat.
- **It heels more than Day's boat at 12 knots**: about 6° to 10° upwind,
  where Day holds 2° to 3°. The towed hull's resistance is upright only, so
  heel costs this model less than it costs a real hull.
- **The sail's side force from a beam reach aft** is not ORC's: there, an
  attached trim and a stalled one give nearly the same drive, and which is
  best decides the side force. Drive matches.

## The server

`keel serve` runs the game. Its heart is the **simulation** (`internal/sim`),
the only writer of the world's state: it steps every boat 30 times a second,
with the same physics package the phone runs. Nothing outside it changes the
world; everything reaches it through the **bus** (`internal/bus`).

### The parts

| Package | What |
|---------|------|
| `internal/bus` | A control slot per boat: one atomic 64-bit word (input sequence, helm and sheet in 1/1024 steps, the slot's generation), stored by the boat's sailor and read by the tick. A queue of 4,096 commands (`Join`, `Leave`, `Disconnect`, and for developers only `SetWind` and `Place`); `TrySend` never blocks. The frames: the whole world after each tick, with its grid of boats by 64 m cell, each boat's sail byte and the queue for boats, published through an atomic pointer and recycled once no reader holds them (`Acquire`, `Release`). |
| `internal/sim` | The world (4,096 slots, at most `KEEL_BOAT_LIMIT` boats, a queue beyond) and `Tick`: read the control slots, apply the commands, admit from the queue, step every boat, sort the boats into the grid, publish the frame. A tick is a deterministic function of the world and its inputs: `rules_test.go` checks the package never imports the clock, I/O or unseeded randomness, never ranges over a map and never uses `sync.Pool`, and `go run ./tools/physics -check` disassembles it for fused multiply-adds as it does the physics. Boats are stepped by long-lived workers, in ranges of at least 32. Snapshots (`snapshot.go`) and digests (`digest.go`) of a frame. |
| `internal/sim/loop` | The clock: tick k after the world's epoch (the database's world row; world 1's is 1 January 2026) is due at k/30 s, computed from the tick, never summed. A late tick is followed by up to 3 more back to back; further behind, the loop skips to the present and counts the skip. It times the tick and its phases, updates the metrics and beats the heartbeat, all between ticks. |
| `internal/replay` | The input log, `keel replay` and `/debug/replay` (below). |
| `internal/scripted` | Scripted sailors: they join through the bus like players and steer and trim at random, each every 0.2–3 s. |
| `internal/obs` | Logs, metrics, the probes, pprof and the flight recorder. |
| `internal/store` | The database: migrations, queries, the pool. The only package that talks to PostgreSQL (a test checks no other imports pgx or goose); see [The database](#the-database). |
| `internal/auth` | Session tokens, the cookie, the session cache and the session middleware. |
| `internal/moderation` | Sailor names: their display form, rules and key, and the word filter. |
| `internal/api` | The `play.` listener's routes and the middleware in front of them. |
| `internal/protocol` | The game connection's wire format: the kind byte, the generated messages (`pb`), the snapshot: the own boat and the other boats' view. |
| `internal/edge` | The game connection, `GET /ws`: the door, one connection per account, the reader and writer, the queue's waiting connections, the encoders and each connection's area of interest; `edgetest` runs it in a test. |
| `internal/client` | The game's client in Go: what the page and its net worker do, for tests, traces and the load bot; and `Lag`, a slow network under TCP. |

### Listeners and configuration

Three HTTP servers, each with a 10 s header timeout, a 120 s idle timeout and
16 KB of headers, and no read or write timeout (they would cut WebSockets):

| Listener | Variable, default | Serves |
|----------|-------------------|--------|
| `play.` | `KEEL_PLAY_ADDR`, `127.0.0.1:8080` | The game's routes (below), with an access log |
| `agents.` | `KEEL_AGENTS_ADDR`, `127.0.0.1:8081` | Nothing yet: 404 to everything |
| internal | `KEEL_INTERNAL_ADDR`, `127.0.0.1:9090` | `/livez`, `/readyz`, `/metrics`, `/debug/pprof/…`, `/debug/flightrecorder`, `/debug/replay`, and with `KEEL_DEV_COMMANDS=1` `POST /debug/wind` |

The internal listener must never be reachable from outside. The three
addresses must differ. The other variables:

| Variable | Default | What |
|----------|---------|------|
| `KEEL_PLAY_ORIGIN` | required | The players' HTTPS origin; `http://` only on `localhost`, `127.0.0.1` or `[::1]`, which browsers treat as secure (the browser tests) |
| `KEEL_DATABASE_URL` | required | The database: a `postgres://` URL or `key=value` pairs, as pgx reads them. It holds the password and is never logged |
| `KEEL_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `KEEL_TRACE_DIR` | none | Where traces of overrunning ticks are written |
| `KEEL_REPLAY_DIR` | none (memory only) | Where the input log is written |
| `KEEL_BOAT_LIMIT` | 1000 | The most boats at sea at once, from 1 to 4,096; beyond it players wait in a queue of up to 4,096. A starting value, until load tests on the server's machine set it |
| `KEEL_DEV_SAILORS` | 0 | Scripted sailors, up to 4,096; any beyond the boat limit stay ashore |
| `KEEL_DEV_COMMANDS` | 0 | 1 for the developer's commands on the internal listener: `POST /debug/wind?knots=…&from=…` (degrees the wind comes from). `tools/dev` and `tools/e2e` set it |

Every problem in the configuration is reported at once. `go run ./tools/dev`
sets the database's URL, the internal address, `KEEL_TRACE_DIR=.dev/traces` and
`KEEL_REPLAY_DIR=.dev/replays` (keeping the last hour), passes
`KEEL_DEV_SAILORS` through, and prints the internal URLs:

```sh
KEEL_DEV_SAILORS=1000 go run ./tools/dev
```

The server starts its internal listener first. Then it waits for the
database, trying again with a wait that doubles from 0.5 s to 30 s, beating
its heartbeat and logging at most once a minute: it stays live and not ready
(`/readyz` says "waiting for the database") rather than exiting, which would
earn a restart's back-off. It refuses to start when the database lacks a
migration it was built with ("run keel migrate"), and starts when the
database has newer ones. It loads the active world, making world 1 (epoch
1 January 2026) when there is none, and the world's epoch sets the tick
clock. Then come the world and the tick loop, then the public listeners,
and only then is it ready. On `SIGTERM` or Ctrl-C it is no longer ready at
once, shuts down the public listeners, lets the tick under way finish,
flushes the input log, stops the flight recorder, closes the database's
pool and shuts the internal listener down last. A second signal kills it.
A panic in the tick, its workers or the input log's writer ends the
process. Once open, the database is not part of readiness: if it goes away,
the requests that need it answer 503 and the world sails on.

### Probes, logs and metrics

`/livez` fails once the heartbeat, beaten after every tick (and every second
while waiting for the database), is 10 s old; it looks at nothing else.
`/readyz` passes once the database has answered, the world has ticked and
the public listeners are open, and fails as soon as the server starts
stopping.

Logs are JSON lines on stdout, each with the build. The public listeners log
each request after it is served: a random request ID (also returned as
`X-Request-Id`), the method, the **route pattern** (never the path or query),
the account that made it if any, the status, bytes and duration. No body,
cookie or name is logged. The tick never logs.

The metrics are on their own registry; everything the tick updates is
resolved at start, so updating it allocates nothing:

| Metric | What |
|--------|------|
| `keel_build_info{build,catalog}` | Which version runs |
| `keel_sim_tick` | The latest tick |
| `keel_sim_tick_duration_seconds` | Each tick, in buckets from 0.5 ms to 100 ms with edges at 10, 25 and 33 ms |
| `keel_sim_phase_duration_seconds{phase}` | `inputs`, `physics`, `grid`, `publish` |
| `keel_sim_grid_duration_seconds` | Sorting the boats into the grid, each tick |
| `keel_sim_ticks_total`, `_late_total`, `_skipped_total` | All ticks; those run back to back to catch up; those skipped |
| `keel_sim_clock_drift_seconds` | World time minus UTC as a tick starts |
| `keel_sim_boats`, `keel_sim_physics_workers` | Boats; goroutines that stepped them |
| `keel_sim_boat_limit`, `keel_sim_queue_length` | The boat limit; players waiting for a boat |
| `keel_sim_admissions_total{result}` | `joined`, `rejoined`, `queued`, `admitted` from the queue, `dequeued` (gave up waiting), `full` (the queue too) |
| `keel_sim_queue_wait_seconds` | How long each player given a boat from the queue waited |
| `keel_sim_commands_total{kind,result}`, `keel_sim_commands_refused_total` | Commands applied; refused because the queue was full |
| `keel_sim_frames_allocated_total` | Frames made because every pooled frame was held: flat once running |
| `keel_replay_bytes_total`, `_segments_total`, `_records_dropped_total` | The input log |
| `keel_flightrecorder_snapshots_total{reason}` | Traces written, `overrun` or `request` |
| `keel_db_pool_connections{state}`, `keel_db_pool_max_connections` | The pool's connections, `acquired`, `idle` or `constructing`, and its limit (17) |
| `keel_db_pool_acquire_wait_seconds_total`, `keel_db_pool_empty_acquire_total` | Time requests waited for a connection; requests that found none idle |
| `keel_db_query_duration_seconds{query}`, `keel_db_query_errors_total{query}` | Each query's time and failures, by its sqlc name (`other` for the rest) |
| `keel_db_schema_version` | The newest migration the database has had |
| `keel_guests_created_total`, `keel_guests_refused_total{reason}` | Guests made, and names refused by reason (`short`, `long`, `characters`, `scripts`, `words`, `taken`) |
| `keel_session_cache_lookups_total{result}` | Sessions found in the cache (`hit`), fetched (`miss`) or unknown |
| `keel_sim_grace_total{result}` | Boats' graces `started`, ended by a join of the account (`rejoined`), or `expired` |
| `keel_edge_connections` | Game connections open |
| `keel_edge_upgrades_total{result}` | `ok`, `no_session`, `ai_account`, `origin`, `bad_request` |
| `keel_edge_hello_total{result}` | `ok`, or what differed: `protocol`, `catalog`, `layout`; or `timeout` |
| `keel_edge_joins_total{result}` | `joined`, `rejoined`, `queued`, `full`, `busy`, `timeout` |
| `keel_edge_queued_connections` | Connections waiting in the queue |
| `keel_edge_closes_total{code}` | Connections ended, by the close code sent or received, `other` or `none` |
| `keel_edge_messages_total{direction,kind}`, `keel_edge_bytes_total{direction}` | Messages and WebSocket frames' bytes each way |
| `keel_edge_messages_dropped_total{reason}` | Over a connection's rate (`rate`); a snapshot replaced before it was sent (`snapshot_replaced`) |
| `keel_edge_encoders` | The encoders: one a core |
| `keel_edge_encode_duration_seconds`, `keel_edge_write_duration_seconds` | An encoder's frame, for its connections; writing one message |
| `keel_edge_view_boats{band}` | Other boats in each snapshot's view, `near` and `far` |
| `keel_edge_snapshot_bytes`, `keel_edge_snapshot_entries_total{op}` | Snapshots' sizes; their entries, `update`, `enter`, `leave` |
| `keel_edge_snapshot_lag_ticks` | Each snapshot's tick less the newest the client had acknowledged |
| `keel_edge_resyncs_total{result}` | Clients' requests for a full snapshot, `honoured` or `ignored` (more than one a second): should stay at 0 |
| `keel_edge_input_margin_ticks` | How many ticks before their tick inputs arrived; negative when late |
| `keel_client_rtt_seconds`, `keel_client_frame_seconds` | The phones' round trips and 95th percentile frame times, from their pings |
| `keel_http_cross_origin_refused_total` | Requests refused as cross-origin |
| `go_*`, `process_*` | The runtime and the process |

```sh
curl -s 127.0.0.1:9090/metrics | grep keel_sim_tick_duration
go tool pprof http://127.0.0.1:9090/debug/pprof/profile    # 30 s of CPU
```

### The flight recorder

The server keeps the last 10 s or more of its execution trace in memory
(`runtime/trace`'s flight recorder, at most 32 MB). When a tick takes more
than 25 ms it writes the trace to `KEEL_TRACE_DIR` as
`trace-<UTC time>-tick<N>.out`, at most once a minute. Each phase of a tick is
a trace region (`inputs`, `physics`, `grid`, `publish`), so a slow tick's trace says
which phase was slow. To take one now:

```sh
curl -o trace.out 127.0.0.1:9090/debug/flightrecorder
go tool trace trace.out
```

A second request while one is being written gets 409.

### The input log and `keel replay`

The tick is deterministic, so what it was given reproduces what it did. The
input log records, tick by tick, what each tick **applied**: the control words
that changed and the commands with their results, and any ticks skipped. It
is binary, in segments of 30 s, each opening with a snapshot of the whole
world, with a digest of the world every second. The tick hands its records to
a writer goroutine and never waits for it: if the writer falls 10 s behind,
records are lost, the segment is marked broken and a new one starts. The last
four segments (1.5 to 2 minutes) are kept in memory; with `KEEL_REPLAY_DIR`
the log is written to files there too, a new file every 10 minutes.

```sh
curl -o keel.log 127.0.0.1:9090/debug/replay       # the last two minutes
go run ./cmd/keel replay keel.log                   # replayed N ticks: identical
go run ./cmd/keel replay -dump 726794600 keel.log   # the boats at a tick, as JSON
go run ./cmd/keel replay -workers 1 keel.log
```

`keel replay` runs the same `Tick` without a clock, starting from the first
snapshot, and compares every digest, every later snapshot and every
command's result with the log's. It stops at the first difference, which a
digest places within a second, and exits 1; `-dump` at that tick from a good
and a bad run shows which field differs. A log replays faithfully only under
the build, catalog and physics layout that made it, which its header names
(`keel replay` warns when they differ): check out that build to replay a
log from a bug report.

`internal/sim/testdata/replays/fixture.log` is a log recorded once and
committed; CI replays it on amd64 and arm64, with one worker and with eight.
After a deliberate change to the physics or the tick, record it again and
commit it:

```sh
go test ./internal/sim -run Fixture -args -update
```

The tests also sail 200 scripted sailors through the clocked loop for five
minutes and replay the log to the same world, byte for byte, and sail the
sandbox's recordings (`internal/physics/testdata/recordings`) through the
tick to the state the browser reached.

### Testing in fake time

The loop, the probes, catch-up and skipping, and `keel serve` from start to
stop are tested inside `testing/synctest` bubbles, where the clock moves only
when every goroutine is waiting: ten minutes of ticks run in a fraction of a
second. A bubble's clock starts at midnight UTC on 1 January 2000, so those
tests give the world that epoch. Code that runs in a bubble waits on channels
or `WaitGroup`s made in it, never on a mutex or a socket: `cmd/keel`'s tests
serve over an in-memory network for that reason.

`TestFullTickAllocatesNothing` (`internal/sim/loop`) requires a whole tick
with 1,000 boats, a third of them changing controls, a join, a leave, the
metrics and the input log to allocate nothing, with and without the race
detector. Benchmarks:

```sh
go test -run '^$' -bench 'Tick|Workers' ./internal/sim
```

### Routes and middleware

| Route | What |
|-------|------|
| `GET /api/version` | The build and the catalog's version |
| `POST /guest` | `{"name", "look"}` makes a guest: 201 with the sailor (`{"name", "look"}`, the name in its display form) and the session cookie; 422 `{"error": reason}` for a refused name; 409 when the request already has a session; 400 for a malformed body, an unknown member or a look not in the catalog; 415 for anything but JSON; 413 past 16 KB |
| `GET /api/me` | The session's account, `{"name", "look", "kind", "saved"}`, or 401 |

Errors are `{"error": "<code>"}`; the client puts codes into words. Nothing
the API answers is cached. Every request passes, in order: the request ID
and the access log; the client's address (a place kept: players reach the
server directly for now); read and write deadlines of 10 s and 30 s,
except on routes marked long-lived (none yet); a 16 KB limit on the body;
Go's `http.CrossOriginProtection`, which refuses a browser's unsafe request
from another origin (`Sec-Fetch-Site`, or else `Origin` against `Host`);
the session; and limits on how often a client may ask (a place kept).

### Guests and sessions

A guest is an account made from a sailor's name and a look, with no
password: its browser's cookie is all that keeps it. The cookie,
`__Host-keel-session`, carries 32 random bytes in base64url; the database
keeps only their SHA-256. It is `Secure`, `HttpOnly`, `SameSite=Lax`, for
`/`, with no `Domain` (the `__Host-` prefix makes browsers insist), and lives
400 days, the most browsers allow; it is set again on a request a day or
more after it was last set, so a player who comes back never loses it.
Chromium counts `localhost` as secure, so the browser tests use the same
cookie over `http://localhost`; WebKit does not, so its tests use https.

Sessions are looked up through a cache (`internal/auth`): an account found
is kept 30 s, at most 100,000 of them, oldest dropped first; tokens nobody
holds are never kept. A session's last-seen time, and its account's, are
written at most once an hour.

A sailor's name (`internal/moderation`) is shown in its display form, RFC
8266's Nickname profile: spaces trimmed and collapsed, characters
normalised (NFKC), so fullwidth letters fold to ordinary ones. It must be:

- 3 to 20 characters (a letter with its accents counts once), at most 80
  bytes;
- letters and decimal digits, with single spaces, hyphens, full stops or
  apostrophes between them (a full stop may be followed by a space, as in
  "St. Ives"), starting with a letter and ending with a letter or digit: no
  symbols, emoji, controls, zero-width or direction characters;
- of one script, or Latin with Japanese, Chinese or Korean (UTS #39's
  "highly restrictive" level), so Cyrillic letters cannot pass for Latin;
- free of the word lists' words (below).

Two sailors cannot share a name's **key**: the Nickname comparison form
(lowercased), separators removed, then UTS #39's skeleton, which maps each
character to the one it looks like, from Unicode's `confusables.txt`. So
"Sea Wolf", "seawolf", "SEA-WOLF" and "Sea W0lf" are one sailor. The
skeleton also maps "rn" and "m" together, so "Fern" and "Fem" are one too.
Case is folded before the skeleton, so a capital I is not matched with a
lowercase l.

The word lists are in `internal/moderation/lists/`, each entry in key form
(the tests print the right form of one that is not): `anywhere.txt`,
refused even inside a word, only for strings no innocent word contains;
`words.txt`, refused as whole words or words run together ("s h i t");
`reserved.txt`, names that would pass for the game (harbourmaster, Port
Royal, moderator…). Digits and symbols written for letters are read as the
letters (`sh1t`). `innocent.txt` lists names that must pass (Scunthorpe,
Sussex, Arsenal, Dickens…); a test checks each. A refusal never says which
word.

The look-alike table, `internal/moderation/confusables.gen.go`, is
generated from `tools/confusables/confusables-17.0.0.txt`, pinned by its
SHA-256, with Unicode's licence beside it. Its version follows the Unicode
version of `golang.org/x/text`'s tables:

```sh
go run ./tools/confusables          # write the table
go run ./tools/confusables -check   # pr.lint: the table is current
```

The client checks a name's length only, counting as the server does
(`client/src/account/reasons.ts`); `internal/moderation/testdata/lengths.json`
is the server's count of a table of names, written by
`go test ./internal/moderation -run LengthTable -args -update`, and the
client's tests read it.

### The game connection

The page sails its boat through one WebSocket, `GET /ws` on `play.`
(`internal/edge`), opened by a dedicated worker, the net worker
(`client/src/workers/net`), so the times messages arrive are not blurred by
long frames.

**The door.** The session comes first: no session, 401 before any upgrade;
an AI account, 403 (agents sail through their own interface). The
connection's deadlines are cleared, then `github.com/coder/websocket`
accepts it if its `Origin` is the request's own host or `KEEL_PLAY_ORIGIN`'s
(a request with no `Origin` is not a browser's, and passes; Vite does not
check WebSockets' origins, keel does). A message may be 1 KB at most.

**The protocol** (`shared/protocol`). One binary message is one game
message; its first byte is its kind: `1`, a Protocol Buffers envelope
(`keel/v1/game.proto`: `Hello`, `Input`, `Ping`, `Command` from the client;
`Welcome`, `Pong`, `Queued` from the server), or `2`, the packed snapshot
(`snapshot.txt`: a 160-byte header with the own boat's state as float64,
then the other boats' entries; see [Other boats](#other-boats)). `go run
./tools/protocol` generates the Go (`internal/protocol/pb`) and TypeScript
(`client/src/net/gen`) with buf and its two generators, and the protocol
version: a hash of the schema and the snapshot's layout. Run it after
changing either; `-check` (in `go run ./tools/dev -lint`) fails on stale
code, and `buf lint` checks the schema. The golden vectors in
`shared/protocol/testdata` pin both sides' codecs.

**A connection's life.** The client's `Hello` carries the protocol version,
the catalog's and the physics layout's; any that differs closes with 4002,
and the page reloads (once a minute at most). No `Hello` in 10 s closes with
1008. Then the edge sends `Join(account, connection)` to the simulation: a
new boat at the start, or the account's own (`Rejoined`). One account sails
through one connection: a newer one stops the older writing the boat's
control slot, closes it with 4001 ("playing on another device", with **Take
over**), then joins. `Welcome` comes with the first frame that holds the
boat; a snapshot follows on every even tick (15 a second). The client sends
an `Input` when its quantised controls change, stamped with the tick it
stepped them for; the edge holds it until the tick before that is
published, and the simulation never applies a word before its tick, so the
server steps the boat with the controls the page stepped it with. Each
snapshot carries the lowest **arrival margin** since the last: how many
ticks early inputs came. Every message carries the newest snapshot's tick;
after 100 ms with nothing to send, an empty `Input` does. A client may send
60 messages a second (120 at once); more than 120 over that in 10 s closes
with 1008. 60 s of silence drops the connection, and a write that takes
10 s does too (no close frame: the peer has gone). When a connection ends
its boat sails on on its held controls for 60 s, the **grace**; the same
account joining within it gets the boat back, after it the boat leaves.
`keel serve` closes every connection with 1012 as it stops, before the
simulation, so the graces are in the input log; the boats are lost (until
checkpoints), and clients get new ones at the start: "Your boat has
returned to port."

| Code | Sent when | The page |
|------|-----------|----------|
| 1000 | The page leaves | nothing |
| 1003 | A text message, an unknown kind, an unreadable message | waits from 1 s |
| 1008 | Over the rate, too many messages waiting, no `Hello` | waits from 1 s |
| 1009 | A message over 1 KB | waits from 1 s |
| 1012 | `keel` stops | waits 0.5 to 5 s |
| 1013 | The queue for boats is full (4,096), or the simulation's command queue | waits from 2 s |
| 4001 | Another connection for the account | "playing on another device", **Take over** |
| 4002 | Protocol, catalog or physics differ | reloads |
| 4003 | Removed (not sent yet) | the reason |
| none | 60 s of silence, a 10 s write | waits from 0.5 s |

Waits are drawn uniformly under a ceiling that doubles with each failure, to
10 s. A failure before the `Welcome` asks `GET /api/me`, since a browser
cannot see why an upgrade failed: 401 goes to the start screen. The network
coming back, or the page shown again, ends a wait; no `Pong` for 6 s closes
and reconnects.

**The clock, and running ahead.** After the `Welcome` the worker sends 8
`Ping`s 100 ms apart, then one every 2 s. The clock's offset is the median
of those of the 8 lowest round trips of the last 32 samples; it moves by at
most 1 ms per 100 ms, unless more than 250 ms off. The page steps its boat to
the tick due at the estimated world time plus half the round trip plus *m*
ticks, every step due taken in the frame (up to 30: a slow phone keeps up):
the boat answers the helm on the frame it is moved. *m* starts at 2; a late input (a negative margin) raises it at
once, once a round trip; 5 s of margins of 3 or more lower it by one. Steps
for ticks an input could no longer reach in time (catching up, or before the
first `Pong`) keep the controls the server holds.

**Prediction** (`client/src/predict/predictor.ts`). The page keeps 64 ticks
of its steps' controls and states. A snapshot equal to the state predicted
for its tick, bit for bit, changes nothing, as it is whenever the inputs
arrived in time; one that differs puts the boat back to the server's state
and steps it again to the present, and the drawn boat eases the difference
away over 100 ms (at once past 3 m or 20°). A snapshot older than the 64
ticks kept is let go. Behind its target by more than 30 ticks (a stall, a
hidden page), the boat is put back to the latest snapshot. `?dev` shows the
clock's offset, the round trip, *m*, margins, corrections and bytes.

**Testing it.** `internal/edge/edgetest` runs a world, the edge and the
routes on `net/http/httptest`'s in-memory network, in `testing/synctest`
bubbles: minutes of connection in milliseconds. `internal/client`'s `Sailor`
is the page in Go (its clock, *m*, prediction with `physics.Step`, the view
decoder, the net worker's schedule) and records traces into
`shared/protocol/testdata`, which the Vitest tests replay through the page's
own code: the same messages out, the same corrections, the same views.
`go test ./internal/edge/edgetest -run Traces -update` records them again.
`internal/client`'s `Lag` models a slow network under TCP: each chunk
written arrives after half the round trip; a "lost" one is held for TCP's
probe timeout (twice the round trip) and, lost again, a second more, and
nothing behind it overtakes it. `go run ./tools/lag` is the same model as a
TCP proxy. On a Mac or an iPhone, Apple's Network Link Conditioner slows and
drops real packets instead (on the Mac from Additional Tools for Xcode; on an
iPhone under Settings › Developer › Network Link Conditioner, with a custom
profile of 100 ms delay and 2% packets dropped each way).

### Other boats

Each snapshot carries, after the own boat, the other boats the player can
see: up to 64, in **view slots** of the connection's own numbering.

**The area of interest** (`internal/edge/aoi.go`). After the physics the
simulation sorts the boats into a grid of 64 m cells (`physics.Cell`, exact
on every machine, so the grid is part of the deterministic tick). For each
connection the encoder looks in the cells around its boat: a boat comes into
view within 700 m and stays until beyond 750 m; of those, the 64 nearest.
Within 300 m a boat is in the **near band**, kept near to 330 m, and sampled
by every snapshot (15 a second); beyond, the **far band**, sampled by every
third (5 a second), on snapshots that depend on the connection's ID, so a
third of the connections sample their far band on each.

**The snapshot** (`shared/protocol/snapshot.txt`). Each boat is quantised to
what can be seen: position to the centimetre, heading in 65,536 steps, heel,
boom and rudder in 1.4° steps, the sailor's offset in centimetres, its mode,
and the **sail byte**, which the physics workers keep for every boat: the
sail's flattening and the flow over its two strips (luffing, drawing,
stalled, aback), which the state cannot tell. The entries change the view of
a **base**: an `enter` (the boat in full, 16 bytes), an `update` of the
fields that changed (a moving near boat costs about 5 bytes), or a `leave`.
A boat that has not changed sends nothing. The game connection is TCP, and
one writer writes a connection's messages in turn, so the base is the newest
snapshot the writer has **taken** from the mailbox: the client will hold it
when the new one arrives. The client keeps its last 4 views; one whose base
it lacks (a bug) it drops, asking for a full snapshot with
`Command(resync)`, at most once a second. A new connection's first snapshot
is full. Golden vectors, a shared corpus of entry streams (Go writes it,
Vitest must agree refusal for refusal) and fuzzing (`FuzzApplyEntries`, and
`client/src/net/view.fuzz.test.ts`) pin both decoders.

**Encoders** (`internal/edge/encoder.go`). One goroutine a core, each with
its own connections; a connection joins the encoder with fewest. Each frame,
each encoder first stores its connections' held inputs due next tick, then,
on even ticks, encodes. Nothing is allocated per frame:
`TestEncoderAllocatesNothing` encodes 1,000 connections of 64 boats each.

**The page.** The net worker decodes each snapshot's entries into a view
and hands the page one record a snapshot: the header as it came (the own
boat), then the 64 view slots in metres and radians. The page hands each
record back once read, and the worker fills it again. `client/src/game/fleet.ts`
keeps 8 samples a view slot and draws each boat at a **render tick** behind
the newest data: 133 ms for the near band, 400 ms for the far, each growing
up to double with the spread of the snapshots' lateness (the 99th percentile
less the least, over 30 s), since TCP holds everything behind a lost segment
for about two round trips. The render tick runs at most 10% faster or slower
than real time, and never back. Past its newest sample a boat is carried on
its last velocity and turn for 250 ms, then held; when data comes the
difference is eased away over 100 ms. Boats fade in and out over half a
second, dithered (`alphaHash`), so they stay in the opaque pass.

**Drawing** (`client/src/render/fleet.ts`, `fleetparts.ts`). Each model is
merged by material, each vertex tagged with the joint it turns on (the
hull's frame, the boom, the rudder), and drawn as one `InstancedMesh` a
material; the parts' vertex nodes place each boat themselves from
per-instance attributes, since the sail's own node discards the instance
matrix. The full model is drawn for the 12 boats nearest the camera within
60 m, the **far model** (the catalog's `art.far`, built by the same script
with few segments) for the rest: 64 boats in 15 draw calls and about
163,000 triangles. Other boats carry the class insignia and no number, and
no telltales or pennant. `e2e/fleet.spec.ts` checks a boat of the fleet
looks as the own boat does at the same pose.

**The queue.** At most `KEEL_BOAT_LIMIT` boats sail, those in their grace
included. A `Join` beyond it, or while others wait, waits in the
simulation's queue (world state, in snapshots and the input log); each tick,
while there is room, the head gets a boat. The edge tells a waiting
connection its place (`Queued`) when it changes, at most once a second, and
welcomes it when its boat appears. The page shows "The sea is full. You are
12th in line." over the "Back soon" screen; while waiting the net worker
pings every 2 s. A player who reconnects keeps their place; one who closes
the page gives it up. Try it with `go run ./tools/dev -limit 2` and three
tabs.

**The load bot.**

```sh
go run ./tools/loadbot -n 200 -url https://127.0.0.1:5173 -for 2m
go run ./tools/loadbot -n 200 -lag 200ms,2% -ramp 30s
```

sails N guests with `internal/client` against a server, steering at random,
and reports bytes and messages each way, others in view, corrections,
resyncs and closes, and, from keel's metrics, the tick's and the encoders'
99th percentiles and the frames allocated. Its guests ("Loadbot 1" …) are
made by `POST /guest` once, their sessions kept in
`.dev/loadbot/sessions.json` and used again.

## The database

The game keeps its players, and later its worlds' data, in PostgreSQL 18.
`go run ./tools/dev` runs it in a container, `keel-dev-db`, from the
official `postgres` image pinned by digest, on `127.0.0.1:5433` (not 5432,
which a PostgreSQL of your own may hold), its data in the volume
`keel-dev-db` and its password, made at random, in `.dev/db.env`. The
container is left running.

```sh
go run ./tools/dev -db         # start the database alone; print its URLs for psql and go test
go run ./tools/dev -db-reset   # remove the container, its data and its password
psql "$(grep ^KEEL_DATABASE_URL .dev/db.env | cut -d= -f2-)"
```

`KEEL_DEV_DATABASE_URL=postgres://…` instead points `tools/dev` at a
PostgreSQL 18 of your own, and no container is started; set
`KEEL_TEST_DATABASE_URL` too, to a database from which the tests can make
databases.

### Migrations

`internal/store/migrations/` holds the schema as numbered SQL files
(`00001_players.sql`), applied in order by goose, each in a transaction,
under a session-level advisory lock so two runs take turns. `keel migrate`
applies them; `keel migrate -status` lists them; `keel serve` refuses a
database that lacks one. A deployment migrates before it starts the new
build, and `tools/dev` does the same before every start.

The rules, since a running build may meet a database a newer build has
migrated:

- **Migrations only go up, and only add.** A table, column or constraint an
  older build reads is removed or renamed only in a later release, once no
  running build reads it (expand, then contract).
- **An applied migration is never edited.** `migrations/SUMS` holds each
  file's SHA-256, and a test fails on a changed or removed file. A new
  migration is added to it with
  `go test ./internal/store -run AppendOnly -args -update`.
- Keys are `uuid DEFAULT uuidv7()`. An account's `kind` and `owner_id` never
  change, which a trigger enforces; an AI account's owner is a saved human
  account.
- **Every table of a world's data has a `world_id` and is
  `PARTITION BY LIST (world_id)`**, one partition per world named
  `<table>_w<number>`. `create_world_partitions(world)` makes a world's
  partition of every such table, found in the catalog; making a world calls
  it, and a migration that adds such a table calls it for the worlds there
  are: `SELECT create_world_partitions(id) FROM world;`. A test checks every
  table with a `world_id` is partitioned on it.

### Queries

Queries are SQL in `internal/store/queries/`, compiled by sqlc against the
migrations into `internal/store/db/` (generated; never edited), and wrapped
by `internal/store` in methods that speak the game's types. No other package
imports pgx or goose: a test checks. After changing a query or adding a
migration:

```sh
CGO_ENABLED=0 go tool sqlc generate -f internal/store/sqlc.yaml
```

(Without cgo, sqlc parses with PostgreSQL's parser compiled to WebAssembly,
so no C compiler is needed.) `pr.lint` runs `sqlc compile` and `sqlc diff`.
One pool, at most 17 connections, serves the API and starting up; each query
is timed by its sqlc name.

### Tests with a database

`internal/store/storetest` gives a test a database of its own:
`storetest.URL(t)` a migrated one, `storetest.Empty(t)` an empty one,
`storetest.Store(t, …)` a store on a migrated one, each dropped when the
test ends. A migrated database is a copy of a template migrated once
(`CREATE DATABASE … TEMPLATE`), named by a hash of the migrations, so a
copy takes milliseconds. The server is `KEEL_TEST_DATABASE_URL`, or the one
in `.dev/db.env`. With neither, these tests are **skipped** locally (`go
test -v` says why) and **fail** in CI. Tests that use a database run in
real time, never in a `synctest` bubble; the server's other tests use an
in-memory stand-in.

## The game's page

The game's page, `/`, is the player's boat at sea, sailed with two thumbs or
the keyboard. While the scene and the physics module load, the page asks
`GET /api/me`: a returning player goes straight to sea; a new one gets the
**start screen** over the loading sea, with a name to give, a sailor drawn
at random from the catalog (drawn again with ⟳) and **Set sail**; when the
server cannot answer, the page says "Back soon" and asks again, waiting
longer each time. A refused name is explained in words beside the field;
the page itself checks only its length. The menu shows "Sailing as" and
the name. The controls listen only once at sea, so typing a name steers
nothing. Every name a player wrote is shown as text in a `<bdi>`, so a
right-to-left name cannot reorder what is around it
(`client/src/ui/player.tsx`).

At sea it is still the **offline sandbox**: one Jolly boat, stepped by the physics module in the page, in a
steady wind that is the same everywhere, with nothing to correct it. It
starts at the disk's centre, at rest, heading 090°, the helm centred and the
sheet half out, in 10 knots from the north. The developer page is
`/dev.html`. Query strings:

| Query | What |
|-------|------|
| `?sandbox` | The offline sandbox alone: no server, no session, no start screen. The browser tests of the scene use it |
| `?wind=12,45` | The sandbox's wind: knots 10 m up, and the degrees it comes from |
| `?dev` | The developer panel (a lazy import, outside the first download); see below |
| `?backend=webgl2` | The WebGL 2 back end, even where WebGPU is offered |
| `?sea=gale` | The test sea: `calm`, `breeze`, `fresh` or `gale`; flat water without it. The boat sits level on it |
| `?view=bands` | A camera preset: `chase` (the default), `sea` and `bands` (the waves rendering's "Sea states" and "Two bands" views, for a boat heading 330°), `aboard`, `high` |
| `?test` | The hooks the browser tests drive, on `window.keel` |

### Sailing

| Control | Touch | Keyboard and mouse |
|---------|-------|--------------------|
| Helm | The arc bottom left: drag left to turn the bow to port, right to starboard, relative to where the thumb lands (140 px is the full travel). A double tap centres it | ← and → (or A and D), the full travel in 0.6 s while held; C centres it |
| Sheet | The slider bottom right: drag up to trim (haul in), down to ease, relative to where the thumb lands (160 px from hauled in to let fly) | W trims and S eases, the whole range in 2 s while held |
| Camera | Drag on the sea to swing it round and up or down; pinch for its distance (5 to 80 m). It eases back behind the boat 5 s after the last touch | Drag with the mouse; the wheel for the distance |

Both controls take a thumb each at once. Each shows its target (the knob)
and, faintly, where the rudder and the sheet really are, since they follow
at the rates the catalog gives (the rudder 0.25 s for its full travel, the
sheet 2.5 s to haul in and 1.0 s to ease). The tiller on the model moves the
real way: to port when the bow turns to starboard. The helm stays where it is
let go; the menu's "Centre the helm when let go" returns it to the centre.
While the sailor is out of the boat after a capsize, the physics ignores the
controls: they are dimmed, a line under the instruments says what the sailor
is doing, and the targets set meanwhile apply once the sailor is back.

Each control is rounded to 1/1024 of its range before the physics sees it
(`src/input/quantise.ts`), the resolution the server will receive.

The menu (☰) holds this device's settings, kept in `localStorage`: the frame
rate (60, or 30 to save battery), sound, the beginners' overlays (**wind**:
the true wind's arrow on the water upwind and the apparent wind's above the
masthead; **sail forces**: drive and side force at the sail's centre of
effort, and a clinometer), and the helm's release.

### The frame

| File | What |
|------|------|
| `client/src/game/cap.ts` | Draws on every n-th animation frame, n the smallest whole number that brings the display's measured rate (the median of the last 30 intervals) within the cap: 120 Hz draws at 60, 90 Hz at 45, 144 Hz at 48. Every drawn frame stays on screen for the same number of refreshes |
| `client/src/game/loop.ts`, `clock.ts` | Fixed steps of 1/30 s taken out of real time, at most four a frame (the rest of a stall is dropped); world time is steps ÷ 30 plus the fraction drawn |
| `client/src/predict/blend.ts` | The state before and after the latest step; the boat is drawn between them, the heading the short way round |
| `client/src/game/driver.ts`, `client/src/sandbox/` | The boat driver: controls in, states and `Out` to draw. The sandbox is the offline driver |
| `client/src/game/game.ts` | The frame: keys, steps, the pose, the instruments, the sound. Input events only move targets; the frame reads them. The frame allocates nothing |
| `client/src/render/camera.ts` | The chase camera: its yaw follows the heading through a critically damped spring (ω = 4 s⁻¹, 12 with reduced motion), never below 1.5 m |
| `client/src/render/boat.ts`, `sailshape.ts`, `telltales.ts`, `pennant.ts`, `sailor.ts` | The boat from the physics: heeled about its centre of gravity; the boom, rudder and tiller; the sail's twist from `Out.Twist`, camber from `Out.Flattening`, rippling where a strip luffs; the telltales from each strip's flow (attached: both stream aft; luffing: the windward one lifts; stalled: the leeward one droops; aback: both stream forward); the pennant downwind of the apparent wind at the masthead; the stand-in sailor by mode |
| `client/src/render/overlays.ts` | The beginners' arrows, each its own shape with a label |
| `client/src/ui/` | The screen at sea in Preact: instruments, sailor line, helm, sheet, menu. Words and numbers are signals written at most ten times a second; what moves every frame moves by `style.transform` |
| `client/src/audio/` | Sound, synthesised with Web Audio from the recipes in `art/sound/` (below) |

### The developer panel

`?dev` adds a panel: the sandbox's wind (knots and the direction it comes
from); the boat, reset to the start, placed at a position and heading, or
jumped to the rim; time, paused, stepped once or slowed to ½ or ¼; the live
`State` and `Out`; the test sea; camera presets; the back end, render scale,
tile pass and antialiasing; and the frame statistics: the interval between
drawn frames (median and 90th percentile over 2 s), the main thread's work
per drawn frame, the display's measured rate and the divisor drawn at, GPU
time where the device has timestamps, draw calls and triangles.

### Recording a sail

While the panel is open the sandbox records the sail, from the moment the
panel opened or the last reset or placing: the starting state and each change
of control or wind with the step it applied to. **Download the sail** saves
it as a scenario file in the golden tests' format, with `end`, the state the
sandbox reached. To make it a test, put it in
`internal/physics/testdata/recordings/`: `go test ./internal/physics -run
Recordings` replays every file there and must reach `end` bit for bit. Or
copy its scenario into `scenarios.json` and rewrite the golden file.
`sandbox-sail.json` there is a scripted sail the client's tests record and
compare (`UPDATE_RECORDING=1 npx vitest run src/sandbox` rewrites it after a
deliberate change to the physics).

### How it is drawn

| File | What |
|------|------|
| `client/src/render/renderer.ts` | `WebGPURenderer` on WebGPU, on WebGL 2 otherwise; the render scale and output buffer by back end; a lost device or context makes a new renderer on a new canvas |
| `client/src/render/stage.ts` | The camera, the frame and its cap, the post-processing (the output transform, then FXAA or SMAA) |
| `client/src/render/coords.ts` | World (x east, y north, float64) to scene (x east, y up, z south); the floating origin, always on a tile centre, moved when the boat is 500 m from it |
| `client/src/render/materials.ts` | **The material factory. Every material is made here**, so every one carries the dome's bend: the world drops by d²/2R from the boat, R = 2,500 m. The sky is the one kind without it. A browser test walks the scene and fails on any other material |
| `client/src/ocean/hex.ts` | The lattice: hexagons 4 m across the flats, corners east and west, one centred on the disk's centre, named by axial (q, r); the field of 5,101 tiles within 150 m; the tile hash, the same on the GPU |
| `client/src/ocean/phases.ts`, `wave.ts` | The boat band: 64 waves, their phases at the floating origin reduced in float64 on the CPU each frame, the sum on the GPU |
| `client/src/ocean/tilepass.ts`, `tiles.ts` | Each tile's plane (height and slope at its centre, with the dome's drop and slope) computed once a frame into a float target, one texel per tile; every vertex of a tile reads the same texel, so the tile is a rigid flat slab. Without float render targets the vertex stage computes the same plane |
| `client/src/ocean/seamaterial.ts`, `far.ts`, `client/src/render/sky.ts` | The sea's look (seams, bevels, tint, shimmer, Fresnel, sun, haze), the far sea out past the horizon, the sky |
| `client/src/render/boat.ts` | Loads a boat's model and its sailor from the catalog's art, replaces their materials with the factory's |

### The test sea

Until the physics package has its own boat band, the tiles move under a
developer test sea: 64 waves for each of four sea states (6 knots over
1.5 NM, 12 over 4, 20 over 6.5, 34 over 9), drawn from a JONSWAP spectrum.

```sh
go run ./tools/testsea          # write client/src/ocean/testsea/*.json
go run ./tools/testsea -check   # fail if they are out of date
```

The draws are seeded and written to nine figures, so the files are the same
on every machine. Never edit them by hand.

## Art

`art/` holds the game's models and the scripts that build them. It is art,
all rights reserved and not covered by the AGPL (`art/README.md`); its source
files carry `SPDX-License-Identifier: LicenseRef-All-Rights-Reserved`, and
`tools/licences` checks that they do.

A boat is a script that reads its dimensions from the catalog, so the model
is the boat the physics sails, pennant and telltales included. The sailor is
a plain stand-in figure, a script of its own:

```sh
go run ./tools/catalog   # after changing a boat's numbers
cd client && npm run art # rebuild every model's .glb (gltfpack, meshopt)
```

Commit the rebuilt `.glb`. `npm test` checks each boat's model against the
catalog: its named parts sit where the physics puts them, within 1 cm, its
telltales at each sail strip's height, and it is under 15,000 triangles; and
each sailor's model has its parts and is under 2,000. A kind's `art.model`
must name a file that exists (`go run ./tools/catalog -check`). The catalog's
`sailors` list names the figures; the first is drawn.

### Sound

Sound is synthesised in the browser with Web Audio; there are no sound
files. The recipes are art, in `art/sound/*.json` (each names the art
licence in its first field): **wind**, noise through a band-pass whose
centre and level rise with the apparent wind; **rigging**, a narrow band at
the sheet's Aeolian tone, 0.2 × apparent wind ÷ 10 mm; **flogging**, the
cloth's band beaten at a flap rate, only while a sail strip luffs;
**water**, low-passed noise rising with speed and a bow wave's hiss past the
hull speed. `client/src/audio/voices.ts` maps them onto the physics;
`engine.ts` plays them, setting parameters at most every 50 ms. Audio starts
on the first tap (a touch's `pointerup`, a mouse's `pointerdown`, a key) and
is suspended while the page is hidden. On an iPhone with the silent switch
on, the page plays no sound.

## Browser tests

`client/e2e` holds Playwright tests that run the game in Chromium, on the
WebGL 2 back end and on WebGPU where the browser offers an adapter (on Linux
through SwiftShader; without an adapter the WebGPU tests are skipped). The
page loads the physics module, so build it first (`go run ./tools/physics`).
Playwright starts four servers: `keel`, which `go run ./tools/e2e` builds from
the tree and serves on a database of its own on the test database's server
(so start it first: `go run ./tools/dev -db`), on ports 18080, 18081 and
19090, dropping the database when it stops, with developer commands on, the
lag proxy on 18090 (200 ms, 2%) and, on 19099, `POST /restart`, which
restarts `keel`; Vite on `http://localhost:5181` in front of it; a second
Vite on `http://localhost:5182` whose traffic goes through the lag proxy;
and a third on `https://localhost:5183` with a throwaway certificate, for
WebKit. `connect.spec.ts` sails online: the sea with the server's boat, a
sail with no correction, the server's wind reaching the boat, the same boat
after a reload, "returned to port" after a restart, and a second device
taking the boat and being taken back from. `lag.spec.ts` sails through the
lag proxy (or, in CI where the runner has it, through netem): no correction
over the snap thresholds, and the helm answering at once. `together.spec.ts`
sails two players in contexts of their own: each sees the other's boat
where the server has it at the tick it is drawn at, sees it turn, and still
sees it through its grace after its page closes; and, through the lag proxy
(or netem), for a minute no near boat held in more than 1% of frames but in
retransmission timeouts, which it reports, and no correction drawn at once.
`fleet.spec.ts` draws other boats in the sandbox: a boat of the fleet as
the own boat at seven poses, 64 boats within 22 draw calls and 200,000
triangles, the materials dithered, and a picture. `worker.spec.ts`,
on Chromium and WebKit (`--project webkit`, `npx playwright install
webkit`), opens `e2e/net.html`, which runs the net worker alone. The scene's tests open `?sandbox`.
`start.spec.ts`, on WebGL 2 alone, starts as a guest: the start screen,
names refused in words (too short, a symbol, a reserved name, mixed
scripts, a name taken through the API and look-alikes of it), a name
accepted, the cookie's attributes, the sailor kept across a reload without
the start screen, and a second browser refused the same name.
`sea.spec.ts` reads back what the GPU computed and checks it against the
same sums in float64: every tile a rigid plane with the exact hexagon's
outline, the lattice fixed as the boat moves and the origin jumps, the tile
hash, the scene walk, recovery from a lost device, and pictures.
`sail.spec.ts` sails: the page's steps are the module's under Node, bit for
bit; two touch pointers move the helm and the sheet at once; a held key
turns the boat; a capsize in 20 knots, the sailor's line and the dimmed
controls, and sailing again within 45 s; a frame the cap skips leaves the
picture on screen; every new material is the factory's; sound starts on a
tap and stops while hidden; pictures of the boat heeled with the overlays,
and capsized; and the heap over 1,000 frames of sailing with the controls
moving.

```sh
cd client
npx playwright install chromium   # once
npx playwright test               # or PW_CHANNEL=chrome to use your installed Chrome
```

The reference pictures are kept per back end and platform in
`client/e2e/pictures/<back end>-<platform>/`, and are changed only by hand,
after looking at the new ones: `npx playwright test --update-snapshots`
writes this machine's. CI runs on Linux; a failing picture test uploads the
pictures it took (the `playwright-<back end>-short` artifact of `pr.render`),
and those are what to commit for `linux` once judged right.

A test that takes minutes on CI's SwiftShader is tagged `@long`
(`test(title, { tag: '@long' }, ...)`); `pr.render` runs each back end's
`@long` tests in a job of their own, beside the rest.

## Commits

Changes reach `main` only through pull requests, merged by squashing. Every
commit must be signed; the `main` ruleset refuses unsigned ones. To sign with
an SSH key:

```sh
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519.pub
git config commit.gpgsign true
git config tag.gpgsign true
```

and add the same key on GitHub as a **signing** key (Settings → SSH and GPG
keys). Every source file starts with `SPDX-License-Identifier: AGPL-3.0-only`.

## Repository settings

GitHub's settings for this repository are kept in `.github/settings/`.

```sh
go run ./tools/github -check   # print every difference
go run ./tools/github -apply   # make the repository match
```

Both use your own `gh` login. Settings GitHub has no API for are listed in
[repository-settings.md](repository-settings.md).

## Troubleshooting

- **The phone cannot load the page.** Guest and office Wi-Fi often stop
  devices on the network reaching each other. Use the phone's hotspot with
  the computer joined to it, or `tailscale serve`.
- **The phone says "not secure".** The certificate is not trusted yet, or
  only half-way: on an iPhone, check that the switch in Certificate Trust
  Settings is on. Do not tap through the warning; the game needs a real
  secure context.
- **The setup page does not load.** The phone cannot reach the computer.
  Check both are on the same Wi-Fi, and that macOS allowed incoming
  connections when `tools/dev` first started (System Settings → Network →
  Firewall → Options).
- **"node is …; this repository needs …".** Run `nvm install && nvm use`.
- **"client/node_modules has no wasm-opt".** Run `npm ci` in `client/`;
  `tools/dev` does it for you.
- **TinyGo will not download or unpack.** Delete `.dev/tinygo` and run again.
  A digest mismatch means the archive is not the one pinned: do not work
  around it.
- **`tools/polar -check` fails after a change to the physics.** Run
  `go run ./tools/polar` and read the table: a capsizing row or a sudden
  change in the best sheet points at the part that moved. Recalibrate in the
  order above.
- **The developer page says the physics differs from the server.** Note the
  phone, browser and first difference shown, and open an issue: the golden
  tests should have caught it.
- **Port 5173, 5174 or 8080 is in use.** Another copy of `tools/dev`, or
  another Vite, is running.
- **"neither docker nor podman is installed" or "… is not running".**
  Install or start Docker Desktop (or Podman: `podman machine start`), or set
  `KEEL_DEV_DATABASE_URL` to a PostgreSQL 18 of your own.
- **"the database's container or volume exists but .dev/db.env is
  missing".** The password is lost with the file: `go run ./tools/dev
  -db-reset` removes the container and its data, and the next start makes
  them again.
- **Port 5433 is in use.** Another PostgreSQL holds it; stop it, or use it
  through `KEEL_DEV_DATABASE_URL`.
- **"the database is behind this build: run keel migrate".** `tools/dev`
  migrates before every start; a `keel serve` started by hand needs
  `keel migrate` first.
- **Tests say "no test database".** Run `go run ./tools/dev -db` once; the
  tests read `.dev/db.env`.
