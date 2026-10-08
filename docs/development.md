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
has changed, regenerates the catalog, builds the physics module, makes a
local HTTPS certificate, builds and starts `keel serve`, starts Vite, and
prints QR codes for setting up a phone and for the game. Changing a Go file
rebuilds and restarts the server, and rebuilds the physics module when the
file is in `internal/physics`; changing a client file reloads the page.
Ctrl-C stops everything.

The first run asks for your computer's password once, to trust the local
certificate authority that signs the certificate (mkcert). On macOS it also
asks to allow incoming connections, so phones can reach Vite.

The game is served at your computer's local network address, for example
`https://192.168.1.20:5173`. Use that address on the computer too, so the
computer and phones share one origin.

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
| `ci.yaml` | Every pull request (each part only when its files changed), every push to `main` | Go tests with the race detector on amd64 and arm64 (the physics tests also built with `GOAMD64=v3`), a short fuzz of the catalog decoder, the physics module built and its golden tests run in WebAssembly, client tests, the client build (which fails on a bundled package with a licence not in `tools/licences/allowed.txt`) and the size of its first download, and the one command started and checked over HTTPS | `go test -race ./...`, `go run ./tools/physics` then `npm test` in `client/`, `go run ./tools/dev -smoke` |
| `pr.lint.yaml` | Pull requests, not drafts, that change its files | gofmt, go vet, staticcheck, Biome and tsc (the client and `art/`) | `go run ./tools/dev -lint` |
| `pr.render.yaml` | Pull requests, not drafts, that change its files | The test sea's fixtures current; the physics module built; the browser tests on Chromium, on WebGL 2 and, where the runner offers an adapter, WebGPU, in four jobs side by side: each back end's `@long` tests and the rest | `go run ./tools/testsea -check`, `go run ./tools/physics`, `npx playwright test` in `client/` |
| `pr.licences.yaml` | Pull requests, not drafts, that change its files | The licence header in every source file (and the art header in `art/`'s scripts and sound recipes); licences of Go packages linked into `keel` | `go run ./tools/licences` |
| `pr.catalog.yaml` | Pull requests, not drafts, that change its files | The catalog against its schema, unique ids, art present, generated files current, no kind's id used as a string in code | `go run ./tools/catalog -check` |
| `pr.physics.yaml` | Pull requests, not drafts, that change its files | The physics package's rules (imports, `math` functions, no fused multiply-add in the source or the compiled code for arm64 and amd64), its layout files current, and the module built with no heap allocation and within its size budget; each boat's polar against its original's measured data, and the trimmed sail against ORC's mainsail | `go run ./tools/physics -check`, `go run ./tools/polar -check`, `go run ./tools/polar -sail` |
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

## The game's page

The game's page, `/`, is the player's boat at sea, sailed with two thumbs or
the keyboard. Until the game connects to a server it is the **offline
sandbox**: one Jolly boat, stepped by the physics module in the page, in a
steady wind that is the same everywhere, with nothing to correct it. It
starts at the disk's centre, at rest, heading 090°, the helm centred and the
sheet half out, in 10 knots from the north. The developer page is
`/dev.html`. Query strings:

| Query | What |
|-------|------|
| `?sandbox` | The offline sandbox. For now the page is nothing else; links made with it keep working once `/` connects to a server |
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
