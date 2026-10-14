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
and checked against the digest pinned in `tools/internal/pinned`; its
`wasm-opt` comes with the client's packages. cosign and the Flux CLI, which
only a release needs, are pinned and fetched the same way (see
[Releases](#releases)).

## The one command

```sh
go run ./tools/dev
```

It checks Node and npm, installs the client's packages when the lock file
has changed, regenerates the catalog, builds the physics module, starts the
database (or finds it running), makes a local HTTPS certificate, builds
`keel`, runs `keel migrate` and starts `keel serve`, starts Vite, and prints
QR codes for setting up a phone and for the game. Changing a Go file
rebuilds the server, migrates and restarts it (with no bell, `KEEL_BELL=0s`;
the boats are kept, see [Restarts and deploys](#restarts-and-deploys)), and
rebuilds the physics module when the file is in `internal/physics`;
changing a client file reloads the page. Ctrl-C stops everything but the database, which is left
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
sets a steady wind and `…/debug/weather?regime=stormy` holds a regime (see
[Setting the weather](#setting-the-weather)).

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
| `ci.yaml` | Every pull request (each part only when its files changed); every push to `main`, called by `release.yaml` | Go tests on amd64 and arm64, each with a PostgreSQL service: in their short forms with the race detector, then at full length without it (the physics and simulation tests also built with `GOAMD64=v3`), the tick's benchmarks as a smoke test, short fuzzes of the catalog decoder, the input log's reader, the sailor name check, the decoding of what a game client sends and of the other boats' views (Go's and the page's), the physics module built and its golden tests run in WebAssembly, client tests, the client build (which fails on a bundled package with a licence not in `tools/licences/allowed.txt`) and the size of its first download, the one command started from scratch, its database container included, and checked over HTTPS with a guest made and read back, its game connection, and a second player seeing the first's boat; and the image built on amd64 and arm64 (not pushed), checked to be for its runner's machine, to run as 65532 with no shell, `keel help` to run and the page to be in it, its size in the job's summary | `go run ./tools/dev -db` once, then `go test -race -short ./...` and `go test ./...`, `go run ./tools/physics` then `npm test` in `client/`, `go run ./tools/dev -smoke`, `docker buildx build .` |
| `pr.lint.yaml` | Pull requests, not drafts, that change its files | gofmt, go vet, staticcheck, the store's queries compiled against the migrations and their generated code current (`sqlc compile`, `sqlc diff`), the look-alike table current, Biome and tsc (the client and `art/`) | `go run ./tools/dev -lint` |
| `pr.render.yaml` | Pull requests, not drafts, that change its files | The physics module built; the browser tests on Chromium, against `keel` and a PostgreSQL service, on WebGL 2 and, where the runner offers an adapter, WebGPU, in four jobs side by side: each back end's `@long` tests and the rest | `go run ./tools/physics`, `npx playwright test` in `client/` |
| `pr.licences.yaml` | Pull requests, not drafts, that change its files | The licence header in every source file (and the art header in `art/`'s scripts and sound recipes); licences of Go packages linked into `keel` | `go run ./tools/licences` |
| `pr.catalog.yaml` | Pull requests, not drafts, that change its files | The catalog against its schema, unique ids, art present, generated files current, no kind's id used as a string in code | `go run ./tools/catalog -check` |
| `pr.physics.yaml` | Pull requests, not drafts, that change its files | The physics package's rules (imports, `math` functions, no fused multiply-add in the source or the compiled code for arm64 and amd64, nor in the simulation's), its layout files current, and the module built with no heap allocation and within its size budget; each boat's polar against its original's measured data, the trimmed sail against ORC's mainsail, and the polar in a breeze's sea and a gale's, printed and not checked | `go run ./tools/physics -check`, `go run ./tools/polar -check`, `go run ./tools/polar -sail`, `go run ./tools/polar -sea 12` |
| `pr.infra.yaml` | Pull requests, not drafts, that change its files | Every entry point of both clusters in `infra/cluster` rendered with kustomize, as a release renders it, checked against the manifests' rules (each rule also broken on purpose) and with kubeconform against its kinds' schemas (a field no schema knows, and a kind with no schema, also tried); no Secret under `infra/`; the release's signer accepted and every other refused; a promotion's refusals; `tools/cluster`'s and `tools/release`'s steps against fake commands, a fake registry and a fake GitHub; the pinned tools' downloads; Renovate's patterns finding every pin; every alert rule made to fire and to stay quiet, with VictoriaMetrics' `vmalert-tool`; the dashboards and the vendored manifests against their records; and the signatures Flux cannot check, of cert-manager's chart and images and Kured's image, with cosign (see [The local cluster](#the-local-cluster), [Releases](#releases) and [Monitoring](#monitoring)) | `go test ./tools/cluster ./tools/release ./tools/dashboards ./tools/vendored ./tools/ops ./tools/internal/...`, `go run ./tools/release -verify-keyed` |
| `pr.machine.yaml` | Pull requests, not drafts, that change its files | The tailnet policy's rules (each broken on purpose); `tools/machine`'s and `tools/tailnet`'s steps against fake programs, a fake registry, a fake Infisical and a fake Tailscale; `join.sh` in bash and shellcheck; Ansible and ansible-lint from hashed requirements, the playbooks' syntax and the `production` profile, in a couple of minutes | `go test ./tools/machine ./tools/tailnet`, `go run ./tools/tailnet -check` |
| `pr.accounts.yaml` | Pull requests, not drafts, that change its files | `infra/tofu` formatted, initialised without a backend from the lock file alone, and valid; the lock file what OpenTofu writes for every platform; `tools/accounts` against a fake OpenTofu and a fake Infisical (the credentials in tofu's environment alone, masked first; no value of a plan shown; addresses scrubbed from errors; a plan from elsewhere refused). No credential | `go run ./tools/accounts -check`, `go test ./tools/accounts` |
| `machine-test.yaml` | Pull requests labelled `machine` (each push while the label stays), and by hand; not a required check | **The whole playbook on a fresh Ubuntu 26.04 runner, twice, the second run changing nothing**; `verify.yaml` (the firewall, the hardening, k3s, Flux following the real `prod`); Lynis with no warning not accepted; kube-bench as a report (see [The machine](#the-machine)) | |
| `pr.actions.yaml` | Pull requests, not drafts | actionlint and zizmor over the workflows | `go tool actionlint` |
| `pr.dependencies.yaml` | Pull requests, not drafts, that change its files | GitHub's dependency review, govulncheck, npm registry signatures | `go tool govulncheck ./...`, `npm audit signatures` in `client/` |
| `pr.secrets.yaml` | Pull requests, not drafts | gitleaks over the pull request's commits | `go tool gitleaks git --log-opts="main..HEAD" .` |
| `codeql.yaml` | Pull requests (not drafts), pushes to `main`, weekly | CodeQL for Go, TypeScript and the workflows | |
| `release.yaml` | Every push to `main` | `ci.yaml`, whole; then the image for amd64 and arm64, signed and attested, each checked on a runner of its own machine; then every cluster's manifests rendered, checked and pushed as a signed artifact (see [Releases](#releases)) | `go run ./tools/release -render <dir> -image <image>` |
| `promote.yaml` | By hand, approved by the owner | The tag production follows moved to a release, once its signature and its place on `main` are checked | |
| `machine.yaml` | By hand, approved by the owner | The playbook on production's machine, over Tailscale SSH: `check`, `apply` (then `verify.yaml`; with **rebuild**, on a machine reinstalled from nothing), or `audit` (see [The machine](#the-machine)) | |
| `accounts.yaml` | By hand, approved by the owner (twice to apply) | OpenTofu on `infra/tofu`: `plan`, or `apply` of the plan the owner read (see [Online](#online)) | `go run ./tools/accounts -check` |
| `tailnet.yaml` | Pushes to `main` that change `infra/tailnet/`, and by hand; approved by the owner | The tailnet policy validated by Tailscale, its tests run, then written over the live one | `go run ./tools/tailnet -check` |
| `scorecard.yaml` | Pushes to `main`, weekly | OpenSSF Scorecard | |
| `security.yaml` | Weekly | govulncheck and npm signatures on `main` | |

Every workflow pins its actions to full commit hashes; the repository refuses
any other. Each multi-job workflow a pull request runs ends in one job named
after the workflow, and that job is the required check.

A workflow marked "that change its files" starts with a `changes` job, which
asks `dorny/paths-filter` whether the pull request touches any file the check
reads (the filter is in the workflow, and always includes the workflow itself
and `.github/actions/setup`). The checks run only if it does; the last job
always runs, and passes when every job before it passed or was skipped, so
the required check is reported either way. Those two jobs, which only ask
GitHub's API or read results, run on `ubuntu-slim` (one CPU, a 15-minute
limit); the rest run on `ubuntu-24.04`. A new file a check reads, outside
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
- `SeaParams`: the catalog's sea values. The client writes them with
  `writeSeaParams` and calls `seaPrepare`, before `prepare`; the server
  calls `physics.PrepareSea` (`catalog.Prepare` does both, in order).
- `Out`: what a step derives for drawing and instruments (the apparent wind
  at the masthead and the sail, each sail strip's angle of attack and flow,
  the sail's and foils' forces, leeway, speed and course over ground, the
  heeling and righting moments, the sea under the hull and the speed
  through the water). A step writes it and never reads it, and it is never
  sent.
- `Components` and `EffectiveWave`: the sea's waves, and the sea under a
  hull, for drawing (see [Waves](#waves)).
- `WeatherParams`, `Regime` and `Spell`: the catalog's wind values, a kind
  of spell, and a spell of weather; `WindPoint`, the wind at a point in
  full, and `GustFrame`, what the GPU needs of the gust fields (see
  [Wind](#wind)).

A step sails in a sea, `physics.Sea`, or in flat water with none. The sea is
not a record: the module keeps it, and the client fills it through exports
(`seaWindow`, `seaArea`, `seaSeal`, `seaUse`, `seaAt`).

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

A boat is a rigid body in surge, sway, yaw and roll, heaving and pitching on
the waves ([Waves](#waves)), with the boom as a body of its own and the
sailor's position as state. In flat water it neither heaves nor pitches, and
sails exactly as it did before it knew of waves. Each part of the boat computes its
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
| `sea.go`, `waves.go` | The sea and the boat in it: see [Waves](#waves) |

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
go run ./tools/polar -sea 12       # the polar in 12 knots and the sea it raises over open water, beside flat water
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

`-sea` sails each angle for two minutes in the sea the wind raises, with the
sheet that sails it fastest among those that keep the boat upright, and
prints the mean speed with its 10th and 90th percentiles, the VMG, and the
greatest heel, heave and pitch, beside the flat-water speed. Nothing is
checked: no published polar of a dinghy in known waves exists to check
against. Off the wind the boat surfs and gains; to windward it loses a
little.

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

## Wind

The wind differs from place to place and from second to second: a base wind
that is lighter at the centre and stronger at the rim, slow shifts of its
direction, and a field of gusts and lulls carried downwind. The physics
package computes it (`weather.go`, `gusts.go`), so the server, the client's
prediction and the gusts drawn on the water are the same wind. It is a pure
function of the tick, the place and a few records of whole numbers: nothing
of it is stored, and no wind is on the wire.

### Spells and the sequence

A **spell** is a stretch of time with one base wind, its shifts and its gust
field (`physics.Spell`, whole numbers all: speeds in steps of 0.01 m/s,
directions in 65536ths of a turn, times in ticks). A **regime** is a kind of
spell, in the catalog's `weather.regimes`: the ranges a spell's numbers are
drawn from.

| Regime | Wind at mid-disk | Gust factor | Shifts | Share of the time |
|--------|------------------|-------------|--------|-------------------|
| `settled` | 3–9 knots | 1.2 | ±5°, 6–10 minutes | 25% |
| `trade` | 10–16 knots | 1.3 | ±8°, 5–8 minutes | 40% |
| `unsettled` | 12–20 knots | 1.45 | ±12°, 4–7 minutes | 25% |
| `stormy` | 16–24 knots | 1.5 | ±12°, 4–7 minutes | 10% |

The world's spells follow `weather.sequence`: six spells over twenty hours,
again and again from the world's epoch (the two-hour day does not divide
twenty hours, so each regime comes at a different hour each time).
`internal/weather` is the timeline: `physics.DrawSpell` draws spell number
n's speed, shifts, periods, phases, drift and seed from its regime by n and
the sequence's seed, so every process draws the same spell. Its direction
follows from the spell before: into or out of a `frontal` regime the wind
veers by 40–90°, as when a front passes; between others it moves either way
by up to 30°. A spell gives way to the next over ten minutes
(`weather.gusts.change`), everywhere at once: the direction along the
shorter arc, the speed and the gust factor between the two, and the two gust
fields mixed so that their spread is kept.

A frame holds the **spells in play** (`bus.Frame.Spells`, four at most):
the one in effect, the one before it until ten seconds after their change
has ended, and the next from ten seconds before its change begins. They are
not in the checkpoint: a world that is loaded computes them again.

### The wind at a point

`physics.WeatherAt` computes a tick's part once (each spell's direction, the
turn of its axis, how far its field has travelled; 22 ns), and
`physics.WindAt(t, x, y)` the wind one boat sails in (51 ns in a spell, 80 ns
through a change, on the Mac). From the spell:

- **Speed.** The spell's wind is its wind at mid-disk, 2.1 NM out. It is
  multiplied by 0.65 at the centre rising to 1.35 at the mist band, 4.2 NM
  out, by a smooth step (`weather.disk`).
- **Direction.** Where it comes from at its start, a drift of up to 20° over
  its length, two shifts that swing two thirds and one third of the regime's
  `shift` with periods of their own, and a difference of up to 5° from one
  side of the disk to the other along an axis that turns once in four to
  eight hours. A shift's phase is the fraction of `turns × tick`, the
  product taken exactly, as a wave's is.
- **Gusts.** The gust field, n in [−1, 1], makes the wind `mean × (1 + (G −
  1) × rim × (h(n) − 0.0821))`: G the gust factor, h(n) = n in a gust and
  n ÷ 2 in a lull, the constant h's mean over the field so that the mean
  wind is kept, and `rim` rising from 1 at 3 NM to 1.3 at the rim. The
  strongest gust veers the wind by 8° and the deepest lull backs it by 4°.
- **The refuge.** Within 1 NM of the centre the mean wind above 10 knots is
  passed through `knee + soft × tanh((v − knee) ÷ soft)`, which nears 14
  knots and never passes it, and the wind with its gusts the same way from
  14 knots toward 18; the limits fade out by 1.4 NM. So a beginner at the
  centre never meets more than a force 4 with gusts into 5, whatever blows
  outside.

A **steady** spell is one wind everywhere with none of this: what a
developer's `/debug/wind` sets, what the tests of other things sail in, and
`sim.DefaultSpell` (10 knots from the north) for a world given no timeline.

### The gust field

Gradient noise (Perlin, 2002) in three dimensions, along the wind, across
it and in time, in three octaves whose cells and weights halve. The largest
cells are 300 m along the wind, 200 m across and 240 s (`weather.gusts`), so
a patch of gust is about 150 m by 100 m. Each spell has its own field, by
its seed, in a frame turned to the spell's direction that travels downwind
at 0.9 of its wind at mid-disk: where the field has got to is a closed form
of the tick. The corners of the lattice are hashed with integer arithmetic,
which wraps alike in Go, in WebAssembly and on every GPU.

`go test ./internal/physics -run GustField -v` measures it: its spread (0.31),
the 99th percentile the sum is scaled by (`gustScale`), the mean of h
(`gustMeanH`), how far a patch reaches (its correlation falls to a half
110 m along the wind and 72 m across) and how long it lasts (0.90 after 30 s,
0.70 after a minute, moving with it). After changing the cells or the
octaves, put the two constants it prints into `gusts.go`. `-run SeenGust`
checks that a gust seen 150 m upwind arrives: the field there, and at the
boat when the field has travelled that far, correlate at 0.69 in the
lightest regime and about 0.9 in the others.

### The wave wind

The sea lags the wind. Each sea area's waves are raised by its **wave
wind**: the mean wind at its centre, without gusts, averaged over the last
minutes with a time constant of 240 s (`weather.waveWind`). The average is
of samples on a grid of world time, one every 30 s taken at the middle of
its interval, forty of them, blended with the present mean so that it moves
every second. It is a pure function of the tick and the weather
(`physics.WaveWindAt`), so the simulation keeps only a ring of samples for
each area (`internal/sim/sea.go`) and a world that is loaded makes them
again. After a change of spell the sea reaches 95% of its new height in
about twelve minutes.

Every area now has its own inputs, and most change every second: see
[Waves](#waves) for what they raise.

### On the wire

`WeatherSystems` (`game.proto`) is the spells in play. The edge sends it
after the `Welcome` and whenever the frame's spells in play change
(`internal/edge/weather.go`), so a spell arrives ten seconds before its
change begins. The client keeps the latest in the physics module
(`client/src/predict/weather.ts`, `internal/client`), and before each step
it predicts or replays asks the module for the wind at its boat at that
step's tick (`windAt`), as the simulation does for every boat. The snapshot
carries no wind (layout 5). In a gusty spell and through a change the Go
client sails five minutes with no correction (`go test
./internal/edge/edgetest -run 'SailGusts|SailWeatherChange' -v`).

### Setting the weather

With `KEEL_DEV_COMMANDS=1`, on the internal listener (`bus.SetWeather`):

```sh
curl -X POST 'http://127.0.0.1:9090/debug/weather?regime=stormy'   # one endless spell of a regime
curl -X POST 'http://127.0.0.1:9090/debug/wind?knots=15&from=270'  # a steady wind
curl -X POST 'http://127.0.0.1:9090/debug/weather?auto'            # the sequence again
```

Each takes effect at the second after next, at once and without a blend,
and every client has heard of it by then. A held regime's spell is drawn as
the sequence draws one, with no drift. The frame keeps the last eight
weathers a developer set, since the wave wind looks back over twenty
minutes of them, and so do checkpoints and the input log.

### In the module

`go run ./tools/physics` builds the same code into the client's module. Its
exports: `weatherPrepare` (the catalog's `weather.disk`, `gusts` and
`waveWind`, written by `writeWeatherParams`), `spellSet` and `spellCount`
(the spells in play), `spellDraw` (a spell from a regime, for a client with
no server), `windAt` (the env the next step sails in), `windPoint` and
`windSample` (the wind in full at the boat or at many points, for the
instruments and the ring), `gustFrameAt` (what the GPU needs of the fields)
and `waveWind`.

`go test ./internal/physics -run WindFile -update` writes
`internal/physics/testdata/wind.json`: in seven weathers and places (a
trade spell, a stormy one in the refuge and at the rim, a change of spell
with and without the next in play, a steady wind alone and after a spell),
near the present tick and late, the wind in full at 240 points, the gust
field's frame and the wave wind. `client/src/predict/wind.test.ts` loads the same spells
into the module, which must give the same bits; `/dev.html` runs the same
check on a phone and times `windAt`. The golden scenarios sail in spells too
(`"weather"` in `scenarios.json`).

### Gusts on the water

A gust is drawn where it is: its tiles are darker and their ripples steeper,
and a lull's ripples flatter. `client/src/ocean/gusts.ts` is the
field again in TSL, evaluated once a tile in the tile pass (it shares the
pass's target, in rows of its own). Each frame the page asks the module for
the **gust frame** (`gustFrameAt`): for each spell in play and each octave,
the lattice cell the floating origin is in and how far across it, found in
64 bits, with the direction, the seeds and the two spells' shares. The cells
and seeds are 32-bit integers and cross as two 16-bit halves in floats. So
the shader works only with a tile's few metres, and never sees a world
position or the hours a field has travelled. The hash, the gradient and an
octave's noise are functions of the shader's own, and the gusts' rows are
drawn only while a spell in play has gusts (and once more when it has gone,
to nothing), so a page in a steady wind never builds their shader: on CI's
software GPU that shader takes seconds to compile, on a real one
milliseconds. How a gust looks is `GUST_LOOK` in `gusts.ts`; none of it
moves a boat.

`e2e/wind.spec.ts` gives the page the weathers of `wind.json` and reads back
what the GPU computed at every tile: within 10⁻⁴ of the server's field, on
WebGL 2 and WebGPU. It also checks that a gust's tiles are darker and
rougher than they are with the gusts hidden, at noon and under a full moon,
that a steady wind draws none, and that the tiles' rows are zero before any
field and after it has gone.

### The readout and the ring

The wind readout is the wind at the boat, gusts and all, averaged over the
last three seconds of world time as an anemometer's is, with the Beaufort
force of the **mean** wind there: "Wind WSW 14 kn · F4" (`ui/format.ts`,
`ui/model.ts`). The force is by the Met Office's table of knots.

With the menu's wind overlay on, a dashed **ring** lies on the water round
each gust that is heading for the boat (`client/src/render/gustring.ts`).
Four times a second the module's field is sampled on a grid 240 m upwind of
the boat and 160 m across; the patches where the gust is at least half way
to the spell's gust factor are found; and each whose edge will pass within
30 m of the boat within a minute, by the field's travel and the boat's own
way, gets a ring, the three soonest at most (`weather.ring`). The rings come
from the field the boat feels, not from what is drawn.

### Tuning

Everything is in `shared/catalog/weather.yaml`. After a change:

```sh
go run ./tools/catalog                                   # the generated catalog
go run ./tools/physics                                   # the layout files and the module
go test ./internal/physics -run 'Golden|WindFile' -update
go test ./internal/sim -run Fixture -args -update
go test ./internal/edge/edgetest -run Traces -update
(cd client && UPDATE_RECORDING=1 npx vitest run src/sandbox)
```

A change to the regimes or the sequence changes the catalog's version, so
the deploy that carries it is a reset (see [Restarts and
deploys](#restarts-and-deploys)). To judge a change, hold a regime with
`/debug/weather`, or open `?sandbox&dev&weather=stormy` and use the panel:
its wind line gives the mean, the wind with its gust, the gust factor, the
field and the veer at the boat. The behaviour tests say what must stay true
(`go test ./internal/physics -run 'HeelFollows|PlayingTheShifts|CapsizeInAGust|Refuge' -v`): a still
sailor's heel follows the gusts, tacking on the headers gains on holding a
tack, a gust can capsize a boat sheeted hard in, and the refuge's limits
hold.

## Encounters

Boats are solid, take each other's wind, and are judged by the Articles,
the game's right-of-way rules. The physics package does all of it
(`outline.go`, `contact.go`, `shadow.go`, `articles.go`), so the server,
the client's module and the tests are the same code; the simulation calls
it in the order of the boats' slots. Every number is in
`shared/catalog/encounters.yaml`, and each boat's plan in `boats.yaml`.

### The outline and contacts

A boat's hull is its plan at the sheer: `outline`, its half-beam at 11
stations equally spaced from the transom (`transom` m aft of the centre of
gravity) to the stem (`stem` m forward), a convex polygon of 21 points with
the stem a point. `art/boats/jolly-boat/build.ts` draws the hull from the
same numbers, straight between the stations, so what is drawn is what
bumps; the hull node's `extras.plan.deviation` says how far the drawn sheer
strays (under a centimetre). `tools/catalog -check` refuses an outline that
is not convex, not 11 stations, wider than the beam or not the boat's
length. Heel, the rig, the foils and a swimming sailor are ignored.

After the physics and the grid, the **contacts** phase (`sim/contacts.go`)
finds the boats near each other, each pair once (a boat's own cell and the
four after it), in slot order. Two hulls touch when their bounding circles
overlap and no edge of either separates them (separating axes); the
contact's normal is the axis they overlap least along, its point the
centre of their overlap. A tick's contacts are resolved together by
sequential impulses in surge, sway and yaw, each boat with its added
masses and yaw inertia: `contact.passes` passes, `contact.restitution`
(0.3, a padded knock) and `contact.friction`; then what penetration is left
beyond `contact.slop` is pushed apart, `contact.push` of it, at most
`contact.cap` a tick. Boats a contact moved have their wind and wake worked
out again, and the grid is built again. A pair's first contact after
`contact.apart` ticks apart is a **bump**: one, however long the hulls rub.

### The wake and the shadow

Each boat's step leaves a **wake** (`physics.Wake`): where its sail's
centre of effort is, the way its wake runs and the height of its rig as it
stands (none once capsized). The wake lies along the source's **apparent**
wind, turned `shadow.deflection` (5° close-hauled, 9° on a reach and
beyond) toward its windward side: wind-tunnel studies of two yachts put it
there, not along the true wind. In the next tick each boat looks, in the
current frame's grid, for the `shadow.sources` nearest wakes that reach it,
and sails in the wind at its place times Π(1 − A fᵢ), turned by Σ H fᵢ:
`shadow.deficit` A is the share lost one rig height behind on the axis,
falling as s^(−2/3) and widening as s^(1/3) (`shadow.width`), fading in
over `shadow.near`, out from `shadow.taper` to `shadow.reach` rig heights.
`shadow.header` H turns the wind away from the source's windward side: a
header for a boat behind it on the same tack. Wakes are derived, worked out
again from the states when a world is loaded.

On the phone the step sails in the same shadow, approximated: the
predictor (`predict/wakes.ts`, and its twin `internal/client/wakes.go`)
keeps each near-band boat's two newest samples and, before stepping into
tick t, offers the module the wakes of the 16 nearest, where their samples
put them at t − 1, in the wind there. The difference from the server's
shadow is corrected as any other. The readout shows the wind with the
shadow, as an anemometer at the masthead would; the force is still the
mean wind's.

### The Articles

The Articles are the Racing Rules of Sailing 2025–2028, Part 2, Sections A
and B, and rule 22, numbered as the rulebook numbers them, between every
two boats, racing or not. For each pair within `articles.pairs` hull lengths,
every tick, `physics.Relate` says which keeps clear and by which Article:

| Article | Who keeps clear | How the game decides it |
|---------|-----------------|-------------------------|
| 22 | the boat that is not capsized | a boat is capsized when its sailor is not aboard and sailing, or its heel is past 90°; both capsized: no one |
| 13 | a boat tacking; both: the one astern, or on the other's port side | from passing head to wind until her heading is `closeHauled` off the true wind, whatever her speed |
| 10 | port tack | a boat's tack is the side the true wind at her comes over; aft of the beam with her boom on that side (by the lee), or dead downwind, the side opposite her boom; within `articles.headToWind` of head to wind she keeps the tack she had |
| 12 | the boat clear astern | her bow and transom, projected on the other's heading, behind the other's transom |
| 11 | the windward boat | of two overlapped on the same tack, the one on the other's windward side, across their mean heading |

Each boat's **course** (`physics.Course`: tack, tacking, ticks since her
tack changed, her heading smoothed over `articles.course` seconds) is kept
in the frame. Each **pair** (`bus.Pair`) remembers who keeps clear, since
when and by whose action: a tack or gybe within the room window, or a boat
that was clear astern and is now overlapped with right of way. A pair new
in range, or one a `Place` command moved a boat of, starts with no one's
action.

At a bump, `physics.Fault` judges the relation the pair had the tick
before: the keep-clear boat's fault (a right-of-way boat is exonerated for
a contact without damage, rule 43.1(c)), unless the right-of-way boat
acquired right of way by her own action within `articles.room` seconds
(**15**), or her heading is more than `articles.turn` off her course toward
the other (**16.1**). The fault counts against the account sailing the boat
at fault. `internal/physics/testdata/articles.json` holds the recorded
situations, each naming the Case Book case it follows; Go and the module
must give every one its verdict.

### Bumps on the wire and in the log

A frame keeps the bumps of the last `bus.BumpTicks` ticks, so an encoder
that skips a frame misses none. Each connection is sent a `Bump` for each
bump after the last it was sent (from its Welcome): to the two boats'
sailors with their part (`yours`, `theirs`, `none`) and the Article; to a
connection that sees either boat in its near band, without them. The page
knocks (`art/sound/bump.json`), shakes the camera (a third as much under
reduced motion) and, for its own, says the verdict under the readout for
four seconds. The persist queue writes each bump to the `event` table, kind
`bump`, the sailor and boat at fault first (with no fault, the first boat),
the other's, the Article, the fault (`account` or `none`) and where.

### The overlays

**Right of way** (the menu's "Show right of way"): four times a second the
page follows each drawn boat's course in the wind at it, takes the
`overlay.marks` boats within `overlay.range` whose closest approach in
`overlay.ahead` seconds, by their present motions, comes within
`overlay.close` hull lengths, and asks the module's Articles which keeps
clear: a ring with a bar ("Keep clear") over a boat the player must keep
clear of, a diamond ("Right of way") over one that must keep clear of the
player, each with its Article; and the player's tack beside the readout.
The **wind** overlay lays a faint wedge of dirty air behind each boat
within `overlay.wedges`, along its wake, out to where the loss falls under
`overlay.wedgeDeficit`.

### Trying it

With `KEEL_DEV_COMMANDS=1`, on the internal listener:

```sh
curl -X POST 'http://127.0.0.1:9090/debug/wind?knots=12&from=0'
curl -X POST 'http://127.0.0.1:9090/debug/encounter?situation=port-starboard'
```

places a scripted boat to meet the first sailing player's boat, held on its
course and trim for half a minute: `port-starboard` (10), `windward-leeward`
(11), `overtaking` (12), `tacking` (13), `luffing` (15) and `capsized` (22).
It answers with where it put the boat and the Article the bump should be
judged by; hold your course. The developer panel (`?dev`) shows the wind
with any shadow, how many wakes reach the boat, its course as the Articles
follow it, and the last bump.

### Tuning

Everything is in `shared/catalog/encounters.yaml`, and the outline in
`boats.yaml`. After a change:

```sh
go run ./tools/catalog
go run ./tools/physics
(cd client && npm run art)                               # after a change to the outline
go test ./internal/physics -run 'Golden|EncounterFile' -update
go test ./internal/sim -run Fixture -update
go test ./internal/edge/edgetest -run Traces -update
```

The behaviour tests say what must stay true
(`go test ./internal/physics -run 'BoatsBump|DirtyAir|Shadow|Contact|Articles' -v`):
boats bump at every crossing angle and part, the wake follows the apparent
wind, and dirty air costs a boat a share of its way to windward (logged in
three winds). The snapshot is version 7: a change to the courses or the
pairs is a new version, and a reset at the deploy.

## Waves

The sea moves boats. The waves longer than about 8 m, which the 4 m tiles can
carry, are the **boat band**: a sum of 256 waves that the physics package
evaluates, so the server, the client's prediction and the tiles on screen
have the same sea. Shorter waves are not there yet.

### The waves

Each wave is `a sin(φ + k d·x − ω t)`, with `ω² = g k` (deep water). Its
direction `d`, its frequency and its phase `φ` are **the same over the whole
world and never change** (`physics.PrepareSea`, from the catalog's
`weather.sea`): the frequencies and directions sample the plane of (ln ω, θ)
by the R2 sequence, from the frequency of a 76 m wave to that of an 8 m one
and all the way round the compass, and the phases come from a hash of the
wave's number. Only the amplitudes follow the weather. A wave whose frequency
or direction moved with the wind would sweep its phase through whole cycles:
by `t dω` after `t` seconds, and world time is tens of millions of seconds.

The world is cut into **sea areas** 463 m (a quarter of a nautical mile) on a
side, 37 by 37, the middle one centred on the world's centre. Each area has
the wind that raises its waves and its fetch, in whole steps (`SeaInput`:
0.01 m/s, a 65536th of a turn, a metre), and from them an amplitude for every
wave (`SeaArea`): the JONSWAP spectrum with its fetch-limited fits, limited
to the fully developed sea, spread about the wind as cos²ˢ(θ/2), each wave
carrying the energy of the patch of (ln ω, θ) it stands for. The amplitudes
are then scaled together to the spectrum's own variance over the band, so
the sea is as high whichever way the wind blows, and those under a tenth of
the highest are left out: from 8 waves in a calm to about 100 in a gale are
evaluated. At a point between four areas' centres the **amplitudes** are
blended, not the surfaces, with weights smoothed so that the slope is
continuous: every place sums the same sines, so the sea is one surface and
keeps its height where areas meet.

Each area's wind is its **wave wind**, the mean wind at its centre averaged
over the last minutes (see [The wave wind](#the-wave-wind)), and until land
shelters the water every area has the fetch of open water
(`weather.sea.fetchCap`, 6 NM): 10 knots raise a boat band of about 0.25 m, 12 knots 0.33 m, 20 knots 0.6 m, 34 knots
1 m.

Time is the tick. A wave's phase from its frequency is the fraction of
`turns × tick`, the product taken exactly (`SeaAt`), so it is the same bits
on every machine and good for ticks to 2⁵³.

### The boat in waves

A hull feels the surface averaged over its waterplane and the slope of the
plane that fits it best (the effective wave of ship stability; `waves.go`).
For each wave both have a closed form, so the sea under a hull costs three
sine-and-cosine pairs a wave evaluated, and a long hull filters short waves
by itself. From it:

- **Heave and pitch**, in the state: the hull as a mass on the spring of its
  waterplane, toward the surface's height and slope, damped by how fast it
  moves against them.
- **Roll**: the righting lever is read at the heel off the surface, so a beam
  sea rolls the boat.
- **Surge and sway**: the water under a slope accelerates down it and
  carries the hull and its added mass along: the boat surfs.
- **Yaw**: that push, spread along the hull, has a moment which turns the
  hull with the water of an oblique wave, a few degrees each way in a chop.
  A kind takes a share of it, `waveYaw`, and the Jolly boat takes none: see
  below.
- **The water moves**: the hull's resistance and the foils feel the flow
  through the water, and the pitching mast rocks the apparent wind.

The sea is read once a step, where the boat is, and carried across the
substeps by its rates as the moving hull meets them. The new values are in
the boat's `physics.hull`: `waterlineBeam`, `waterplaneArea`,
`waterplanePitch`, `addedMassHeave`, `pitchInertia`, `heaveDamping`,
`pitchDamping`, `waveForce`, `waveYaw`. All but the beam are estimates, each
with its range beside it in `boats.yaml`. `waveForce` is the share of the
Froude–Krylov force; lower it toward 0.6 if the boat surfs too easily.

`waveYaw` is the share of that force's moment along the hull, and it is 0.
A boat left alone with its sheet eased rounds up until its sail is on the
edge of luffing, and all but stops; that is so in flat water too. In a sea,
with all of the moment, the hull is yawed by several times what the rudder
gives under a knot and a half. The sail loses its last drive, the boat stops
and slides to leeward, and with no flow over the rudder the helm does
nothing: steered for a beam reach from there, 70% of getaways failed, where
13% fail in flat water. With a quarter of the moment 29% fail, with none
11%. A boat that is sailing hardly notices: with or without the moment the
polar in waves differs by a hundredth of a knot in 12 knots, and by a tenth
running dead before 20. Raise the share only with the getaway test passing.

`go test ./internal/physics -run 'Waves|Surfing|Heave|BeamSea|Drift|UnderWay|YawMoment'`
checks what physics is sure of (a long wave is followed, a wave as long as
the hull is not felt, a released heave settles, a beam sea rolls the boat at
the wave's period, the boat surfs off the wind and does not gain to windward,
it does not drift away at rest, the moment along the hull is the push's own)
and what the game needs (a stopped boat gets under way in a sea as readily
as in flat water), and `go run ./tools/polar -sea 20` shows the rest. After changing a value: those tests, then the golden file and
`sea.json` (`go test ./internal/physics -run 'Golden|SeaFile' -update`), then
`scenarios.json`'s copy of the catalog's values, as for any parameter.

### The sky

The sun, the moon and the stars stand where one rule puts them,
`internal/sky`, from **sky time** and a place on the disk alone. The server
has the rule and its tests; the client runs the same Go in the physics
module (`skyAt`, `skyStar`), once a frame, so every player sees the same sky
and JavaScript computes nothing of it. Nothing in the game's rules reads the
sky yet.

### The rule

The disk is the polar cap of the sky's sphere, with the disk's centre at the
pole. A place r nautical miles from the centre stands `scale × r` degrees
from the pole, so it sees the real sky of the latitude `90° − scale × r`:
the Pole's at the centre and, at ten degrees to the mile, that of 45° north
at the rim. A body's height is 90° less the angle on the sphere between the
place and the point the body stands over (`At` turns the centre's east,
north and up into the place's, by that angle about the level axis square to
the place's bearing from the centre).

- **The stars** keep their J2000 places in the Bright Star Catalogue and turn
  about the pole once in a sidereal day: `day × year ÷ (year + 1)`, 117 min
  40.7 s for a day of 118 minutes. The Pole Star is moved the 0.74° to the
  pole itself, so it stands still: the Hub Star. Constellations keep their
  shapes from every place, a star whose point lies inside the disk never sets
  for anyone on it, and the Hub Star's height is `90° − scale × r` exactly.
- **The sun** rides a great circle over the centre, rising due east and
  setting due west there, once a day: day and night are equal everywhere,
  and dawn sweeps the disk from east to west (the east rim sees the sun 14.75
  minutes before the centre). The noon sun's height is 90° less the scale's
  degrees for each mile north or south of the line through the centre.
- **The moon** rides the same circle behind the sun by its age, a month of
  29.530589 days; its lit share is `(1 − cos age) ÷ 2`.

`At` gives the sun's and the moon's direction (the place's east, north and
up), height and bearing, the moon's lit share, and the **stars' matrix**,
which turns any star's catalogue vector (`Vector`) into its direction:
`Star` is that matrix on one star. `SunAltitude` is the sun's height alone,
for whatever comes to depend on night and day.

The package is held to the physics package's rules (`tools/physics -check`):
its own sine, cosine and arctangent, no fused multiply-add, no allocation.
Every angle is `2π × frac(t ÷ period)` taken on whole microseconds, the
remainder exact, so none loses precision however old the sky.
`testdata/sky.json` is the sky at 12 places and 40 times, compared bit for
bit by Go on both machines and by the module under Node
(`client/src/sky/golden.test.ts`); after a deliberate change, `go test
./internal/sky -run Golden -update`.

### Sky time

Sky time is whole microseconds of UTC since the sky's epoch, the catalog's
`sky.epoch` (midnight UTC, 1 January 2026), **the same in every world**: it
is the world's epoch plus world time (`sky.Time`). The first world's epoch is
that same moment, so there sky time is world time. `Welcome` carries the
world's epoch (`epoch_us`); the page counts sky time from it and the world
clock it draws the sea by (`client/src/sky/skytime.ts`), so the sky slews with
the clock and never apart from the sea. Offline the sandbox counts from an
epoch that puts world time 0 two hours after sunrise at the centre.

### The numbers

`shared/catalog/sky.yaml` holds the day in minutes (118: not two hours, which
divide the real day and would show a player who sails at the same hour every
evening the same part of the day for ever), the year and the month in days,
the scale in degrees to the mile, the epoch, the three angles at it, and the
**named stars**: name, number in the catalogue, right ascension, declination
and magnitude. `tools/catalog` checks the numbers against `sky.Params`, field
for field, and generates `catalog.SkyParams` and `writeSkyParams`, as for a
boat's physics. A change to any of them changes the catalog's version, and
the world starts empty at the next deploy.

### The stars' table

`tools/stars/bsc5/` keeps the Bright Star Catalogue, 5th revised edition
(Hoffleit and Warren 1991, CDS catalogue V/50), as CDS publishes it, with its
ReadMe; `tools/stars` checks their SHA-256, checks every named star against
the catalogue by its number (within 0.01° and 0.05 of a magnitude; the Hub
Star's declination excepted), and writes `client/src/sky/stars.bin`: the
2,360 stars brighter than magnitude 5.5 and north of −45°, brightest first,
six bytes each (right ascension and declination as 16-bit fractions, the
magnitude in hundredths and B−V in twentieths packed in 16 bits), 14 KB,
loaded with the scene. A device in WebGPU's compatibility mode draws the
first 1,336, to magnitude 5. `go run ./tools/stars` after changing the named
stars or the tool; its test fails if the committed table is not what it
writes.

### Drawing it

| File | What |
|------|------|
| `client/src/render/daylight.ts` | **The light of the hour**: one table keyed by the sun's true height at the boat, read between its rows: the sky's colours and the glow toward the sun, the sun's and the hemisphere's light, the sea's colours and wide highlight, the haze, the clouds, the sail's glow, the faintest star that shows, the lanterns. By night the main light is the moon, by its lit share and height; never both. The night rows keep a floor: a moonless night is readable |
| `client/src/render/sky.ts` | Writes the table into `look` and the two lights each frame; the sky's shader: the gradient, the glow, the sun, the moon's disc (1.5°, lit as a sphere by the true sun, so its phase is right), the clouds |
| `client/src/render/stars.ts` | The stars: one draw of quads, each turned by the module's matrix (one 3 × 3 uniform a frame, no trigonometry on the GPU), sized and dimmed by magnitude, tinted by B−V, faded low down, behind clouds and the moon; a tap on a named star shows its name for four seconds |
| `client/src/render/lanterns.ts` | Navigation lights: one instanced draw of glows for every boat in view and the player's, each over its arc in the boat's own frame (Rule 21: red to port and green to starboard to 22.5° abaft the beam, white over the 135° astern, faded across 4°), on the dome so the sea hides them, lit while the sun is below the horizon at the boat |
| `client/src/render/camera.ts` | The tilt: a drag that would take the camera below its lowest view lifts its gaze toward the sky instead, up to the zenith, and back the same way |

To tune the look, edit the rows of `LIGHT_TABLE`: colours are display
values, as picked from a picture. Its Vitest test fails if a row is out of
order, if anything but the stars, the moon and the lanterns grows brighter as
the sun sinks, or if noon is no longer the day's look.

A boat's lights are the catalog's: `lights`, a list of `tricolour`, `port`,
`starboard` and `stern`, each with a node of the same name in its model where
the lantern is. `tools/catalog -check` fails on a light without its node, on
a tricolour on a boat of 20 m or more, and on lights that do not make the
full circle once. The Jolly boat carries a brass tricolour lantern at the
masthead, with the pennant's staff above it.

### Seeing it

`?sky=dusk` (or `dawn`, `noon`, `midnight`, or an hour from 0 to 24, noon at
12 at the centre) draws the sky at that hour from the page's start, and
`?sky=midnight,0.5` with the moon that far through its month (0 new, 0.5
full). The developer panel sets the hour, the moon and the speed the sky runs
at (×1, ×60, held), and reads out the sun's and the moon's height and
bearing, the Hub Star's height beside `90° − scale × r`, and every named
star's height and bearing above the horizon, all by the module. Both move
only the sky this page draws: online nothing is sent, and the server's sky is
unchanged.

## The server

The frame holds each area's inputs twice (`bus.Sea`): **in effect**, and for
**the next second**. The sea changes only on a second's first tick, to what
was fixed a second before from the wave wind as it then stood. So a change
of weather reaches the waves no sooner than the next second but one, and
every client hears of it before it predicts a tick it applies to. The amplitudes
are not in the frame: the simulation keeps two windows of the whole world
(2.8 MB each), the one in effect and the one being made ready, a share of
its areas each tick, and only an area whose inputs changed costs anything
(`internal/sim/sea.go`). The `sea` phase of a tick does this and sets the
sea's time. In a spell of weather most areas' inputs change every second
(about 1,140 of the 1,369), so the phase now does that work every tick.
Checkpoints and the input log do not hold the sea: it is a pure function of
the tick and the weather, and a world that is loaded makes it again
(snapshot version 6).

On the local cluster `keel` runs with `KEEL_DEV_COMMANDS=1`, so the weather
can be set there, on the internal listener, which no route leads to: forward
its port and post to it.

```sh
export KUBECONFIG=$PWD/.dev/cluster/kubeconfig
kubectl -n keel port-forward deploy/keel 9090:9090 &
curl -X POST 'http://127.0.0.1:9090/debug/wind?knots=34&from=0'
```

6, 12, 20 and 34 knots are a calm, a breeze, a fresh breeze and a gale; the
sea takes some twelve minutes to follow. Production has no developer's
commands: its weather is the sequence's.

### The wire

`SeaAreas` (`game.proto`) is a window of 5 by 5 areas about the boat's own:
the tick it applies from, its first area's column and row, and each area's
inputs. The edge sends it after the `Welcome`; when the next second's sea
differs from the one in effect, a second before it applies; and when the
boat sails more than 60 m into another area, with the areas about that one
(`internal/edge/sea.go`). A client keeps the two with the latest ticks, each
in one of the module's two windows, and steps each tick in the later of
those whose tick has come (`client/src/predict/seas.ts`,
`internal/client/sea.go`). The amplitudes are a pure function of the inputs,
computed by the same code, so a prediction's sea is the server's to the bit
and waves cause no correction.

The own boat's heave and pitch travel in the snapshot's header with the
rest of its state. Other boats' do not travel at all: each client floats
them on the sea it draws under them (`client/src/game/float.ts`), with each
kind's own heave and pitch stiffness, mass and damping, since a boat is
drawn a little in the past and the sea at the present.

### On the GPU

`client/src/ocean/phases.ts` reads the waves and the window's amplitudes
from the module's memory into two small float textures, numbering only the
waves with an amplitude somewhere in the window, and computes each wave's
phase at the floating origin in float64 every frame. `wave.ts` is the sum in
TSL: it blends each wave's amplitude between the four areas about the point
(skipped when the window is one sea), and **brings the sine's argument into
[−π, π] itself**, since a tile 650 m from the origin has an argument of
hundreds of radians and WGSL promises its sine only on that interval, to
2⁻¹¹. The tile pass, its per-vertex fallback and the far sea all use it.
Crests are coloured by their height against the sea's own significant
height, so a breeze and a gale both show theirs.

The check against the server: `go test ./internal/physics -run SeaFile
-update` writes `internal/physics/testdata/sea.json`: the waves, and for a
breeze, a gale and a calm that meets a gale, at the world's centre and near
its rim, near the present tick and past 2³¹, the surface at 240 points and
the sea under four hulls. `src/predict/sea.test.ts` loads the same seas into
the module, which must give the same bits. `e2e/sea.spec.ts` gives them to
the page and reads back what the GPU summed at the same points, on WebGL 2
and WebGPU: within the sum of the amplitudes × 2⁻¹¹, a millimetre or two in
a gale. On a phone, **Check the sea** in the developer panel (`?sandbox&dev`)
runs the same file and shows the largest differences.

### No water in a hull

The sea's surface passes through a boat, so its shader leaves out the
fragments inside a hull (`client/src/ocean/hulls.ts`): the fragment is taken
into the hull's own frame, heave, pitch and heel included, and dropped if it
lies above the bottom and within 94% of the hull's width at its depth,
between the stations the model's script measured from the hull's mesh. The
volume has no top, so a crest above the gunwale is not drawn inside the boat
either. It is done for the player's boat and the seven nearest others within
150 m. A tile or a triangle of the far sea with no hull in reach says so from
its vertices, and its fragments skip the test.

### The sea's look

What the sea shows beside the boat band is drawn and never felt: nothing
here moves a boat, and nothing of it is on the wire, in the catalog or in
the checkpoint. Its numbers are in `client/src/ocean/look.ts`.

**The detail band** is the sea's own JONSWAP spectrum, with the boat band's
spreading, for the waves shorter than the boat band's shortest (8 m), at
the wind and fetch of the sea under the boat (`under.ts`: blended between
areas as the boat band is, eased over 2 s). It is Tessendorf's sea: a
square patch, 41 m a side, that repeats over the world; 41 m because tile
rows are 4 m apart, and a patch of 32 m would repeat every eighth row.
Every frequency is a whole multiple of 2π/128 s, so the patch is a function
of world time that repeats every 128 s and the shader needs only the time
within the loop (the worst frequency is 0.9% off). Each wave's phase comes
from a hash of its wave vector, so every device draws the same sea.
`spectrum.ts` has the amplitudes; `field.ts` makes the fields on the CPU in
float64: the height, the two slopes, and the convergence of the horizontal
shift, from which the surface's folding comes (1 − chop × convergence, the
Jacobian to first order).

On WebGPU (`detail.ts`) the band is four compute passes a patch: the
spectrum at the frame's time, the transform of every row, of every column,
and the fields put together with the foam's memory (what folds now, or what
was foam before, spread a little and faded over the force's decay time). A
row is one workgroup: its invocations share the row and run the radix-2
stages between two arrays, with a barrier after each. So a patch of 128
fits compatibility mode's 128 invocations a workgroup, and one of 256 needs
core's 256. The outputs are `rgba16float` with mipmaps, the intermediates
`rgba32float`, never filtered. The high tier has a second patch, 7.3 m a
side, with the ripples of 6 to 32 cm: glitter, almost no height.

On the low tier the band is a loop made on the device as the page starts,
by `field.ts`: 64 × 64 over the same 41 m, the waves of 2 to 6.8 m, 32 frames
over 8 s, for 6 and 20 knots, made in slices of at most 4 ms a frame (about
20 ms in all on the Mac), mixed by the wind, turned to its direction and
scaled to the band's height. The developer panel shows how long it took.

**On a tile** (`seamaterial.ts`) the band is drawn in two parts, so that what
is drawn on a tile stays inside it. Read once a tile, at its centre, from
the mipmap whose texels are about 2.5 m, it tilts and shades the tile as a
whole: every fragment of the tile has the same. Read at the fragment, at a
place shifted by the tile's hash and faded to nothing at the rim, it gives
ripples that are the tile's own. The far sea reads it plainly. Where a tier
leaves the finest ripples out, a shimmer from the pattern's noise stands in
for them.

**Foam** (`foam.ts`) has five sources: folding in the detail band; whitecaps
where the boat band's crest stands above 0.75 of half the significant
height; streaks down the wind, from force 7; the hulls; and the wakes. Their
sum sets how much of a pattern of lace shows (`pattern.ts`: one small
texture made at start, lace and noise, read once a fragment), and the cover
fades to a fifth over each tile's rim, so a patch of foam reads as white
tiles. What it does at each wind is `FOAM_BY_FORCE` in `look.ts`, a row a
Beaufort force, read at the middle of each force and between them; each sea
area has its own, by its own wind. `npx vitest run src/ocean/look.test.ts`
checks the table: a row for every force, strengths from 0 to 1, nothing
falling as the wind rises, no whitecaps under force 3 and no streaks under
force 7. To tune it, change a row, look at it in the sandbox
(`?sandbox&dev&sea=…`, or the panel's wind), and take the browser tests'
pictures again. The browser tests record the white share of the sea at 6,
12, 20 and 34 knots beside Monahan and O'Muircheartaigh's whitecap coverage:
the drawn foam is a look, and covers about a sixth of what the fit gives.

**Round a hull** (`hulls.ts`), in the same walk that keeps the water out of
it: a ring at the waterline, more at the bow, and two arms that trail at
Kelvin's 19.5°, growing with the hull's speed through the water. Another
boat's speed is how fast its drawn position moves, smoothed over 0.5 s.
**The wakes** are a foam map (`foammap.ts`): a square 256 m a side that
follows the boat in whole texels, 512 × 512 (256 × 256 on the low tier),
8-bit. Each frame a pass moves it, fades it over 6 s, spreads it a little,
and stamps every boat in it under its stern; its 8 bits are dithered, so it
fades at the right rate at any frame rate. **Spray**
(`client/src/render/spray.ts`) is sprites in one draw: from a bow the sea
rises against faster than 0.2 m/s, more with speed and whitecaps, blown down
the wind for about a second; and off the crests near the camera from
force 8.

**Shadows** (`client/src/render/shadows.ts`): one map of the sun's, round the
boat. The boat and its sailor cast and receive; on the high tier the other
boats within 40 m too. The sea receives none.

### Tiers and adaptive quality

A tier is a set of values (`client/src/render/quality.ts`):

| | High | Medium | Low |
|---|---|---|---|
| Starts on | WebGPU, core features | WebGPU, compatibility mode | WebGL 2 |
| Render scale, at most | 2 | 1.5 | 1 |
| Detail band | Transform 256², two patches | Transform 128², one patch; shimmer | The loop; shimmer |
| Compute dispatches a frame | 8 | 4 | 0 |
| Foam map | 512² | 512² | 256² |
| Shadows | 2,048², 40 m, other boats too | 1,024², 12 m, own boat | None |
| Spray | 512, own boat and 3 nearest, off the crests | 256, own, off the crests | 96, own |

A page starts on the best tier its back end runs, or where this device
settled last time (kept in `localStorage` with `QUALITY_VERSION` from
`look.ts`: change it when the tiers' values change). The menu's **Detail:
low** starts the ladder at the low tier, to save battery. Adaptive quality
then moves down and up a ladder: the render scale by tenths to 0.7 of the
tier's, then the shadows off, then the second patch off, then the tier
below. A window of frames (2 s; 0.5 s for the first 6 s, which are the
benchmark, behind the start screen) is slow when the 90th percentile of the
intervals between drawn frames is over 1.15 times what the frame cap asks
for. Before a slow window is believed the display is measured again: for
six animation frames nothing is drawn, so a 30 Hz display is not taken for
a slow phone. Two slow windows step down. Ten seconds of windows that are
not slow and have time to spare (GPU time under 70% of the interval where
the device has timestamps, the main thread's work under 6 ms where not)
step up; a step up undone within 20 s doubles the wait, to 320 s at most.
Within a tier no step changes a shader: shadows go off by the boats no
longer casting, the map drawn once empty. A change that needs new shaders
(the detail band, the light casting or not) is compiled off the frame first,
compute kernels too, and swapped in once ready; windows are not counted
until a second after it, nor while the page is hidden.

The page tells the server its tier and render scale in every `Ping`; the
server counts clients by tier (`keel_client_tier`) and keeps the scale's
histogram (`keel_client_render_scale`), beside the frame times on the game
dashboard. The Go client and the load bot send 0, unknown.

`?tier=high|medium|low` holds a tier, no better than the back end's, with
adaptive quality off. `?compat` makes the WebGPU device without
`core-features-and-limits`, so the browser enforces compatibility mode's
limits on any machine: three.js otherwise asks for every feature, and a
desktop always gets a core device. The browser tests' `compat` project runs
the sea's tests that way.

## The server

`keel serve` runs the game. Its heart is the **simulation** (`internal/sim`),
the only writer of the world's state: it steps every boat 30 times a second,
with the same physics package the phone runs. Nothing outside it changes the
world; everything reaches it through the **bus** (`internal/bus`).

### The parts

| Package | What |
|---------|------|
| `internal/bus` | A control slot per boat: one atomic 64-bit word (input sequence, helm and sheet in 1/1024 steps, the slot's generation), stored by the boat's sailor and read by the tick. A queue of 4,096 commands (`Join`, `Leave`, `Disconnect`; for developers only `SetWeather` and `Place`; and the server's own `Hold`, admission held while the world's writes are behind); `TrySend` never blocks. The frames: the whole world after each tick, with its grid of boats by 64 m cell, each boat's sail byte and the queue for boats, published through an atomic pointer and recycled once no reader holds them (`Acquire`, `Release`). |
| `internal/sim` | The world (4,096 slots, at most `KEEL_BOAT_LIMIT` boats, a queue beyond) and `Tick`: read the control slots, apply the commands, admit from the queue, bring the sea to the tick, step every boat in the shadow of the boats near it, sort the boats into the grid, find the pairs, contacts and bumps, publish the frame. A tick is a deterministic function of the world and its inputs: `rules_test.go` checks the package never imports the clock, I/O or unseeded randomness, never ranges over a map and never uses `sync.Pool`, and `go run ./tools/physics -check` disassembles it for fused multiply-adds as it does the physics. Boats are stepped by long-lived workers, in ranges of at least 32. Snapshots (`snapshot.go`) and digests (`digest.go`) of a frame. |
| `internal/persist` | The world's writer: the lasting events and a checkpoint every 10 s, written behind the tick in fenced batches (see [Restarts and deploys](#restarts-and-deploys)). |
| `internal/sim/loop` | The clock: tick k after the world's epoch (the database's world row; world 1's is 1 January 2026) is due at k/30 s, computed from the tick, never summed. A late tick is followed by up to 3 more back to back; further behind, the loop skips to the present and counts the skip. It times the tick and its phases, updates the metrics and beats the heartbeat, all between ticks. |
| `internal/weather` | The weather's timeline: the catalog's sequence of spells, each drawn from its regime, a developer's weathers over it, and the spells in play about a tick (see [Wind](#wind)). |
| `internal/replay` | The input log, `keel replay` and `/debug/replay` (below). |
| `internal/scripted` | Scripted sailors: they join through the bus like players and steer and trim at random, each every 0.2–3 s. |
| `internal/obs` | Logs, metrics, the probes, pprof and the flight recorder. |
| `internal/store` | The database: migrations, queries, the pools, the simulation's lease. The only package that talks to PostgreSQL (a test checks no other imports pgx or goose); see [The database](#the-database). |
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
| internal | `KEEL_INTERNAL_ADDR`, `127.0.0.1:9090` | `/livez`, `/readyz`, `/metrics`, `/debug/pprof/…`, `/debug/flightrecorder`, `/debug/replay`, and with `KEEL_DEV_COMMANDS=1` `POST /debug/wind` and `/debug/weather` |
| metrics | `KEEL_METRICS_ADDR`, none | `GET /metrics` and nothing else; not opened unless set |

The internal listener must never be reachable from outside. The addresses
must differ. The metrics listener is for the cluster's scraper: a
NetworkPolicy lets it in to a port, not to a path, so on the internal
listener it could read the profiles and the input log too; on a port of its
own (9091 in the cluster) it reads the metrics alone. The other variables:

| Variable | Default | What |
|----------|---------|------|
| `KEEL_PLAY_ORIGIN` | required | The players' HTTPS origin; `http://` only on `localhost`, `127.0.0.1` or `[::1]`, which browsers treat as secure (the browser tests) |
| `KEEL_DATABASE_URL` | required | The database: a `postgres://` URL or `key=value` pairs, as pgx reads them. It holds the password and is never logged |
| `KEEL_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `KEEL_TRACE_DIR` | none | Where traces of overrunning ticks are written |
| `KEEL_REPLAY_DIR` | none (memory only) | Where the input log is written |
| `KEEL_CLIENT_DIR` | none | The game's built page (`client/dist`), served by the `play.` listener (see [Routes and middleware](#routes-and-middleware)); it must hold `index.html`, or the server does not start. The image sets it; in development Vite serves the page instead |
| `KEEL_BOAT_LIMIT` | 1000 | The most boats at sea at once, from 1 to 4,096; beyond it players wait in a queue of up to 4,096. A starting value, until load tests on the server's machine set it |
| `KEEL_BELL` | `3s` | How long the world sails on, as the server stops, once every phone has been told it is restarting; from `0s` to `10s`. `tools/dev` and `tools/e2e` set `0s` |
| `KEEL_DEV_SAILORS` | 0 | Scripted sailors, up to 4,096; any beyond the boat limit stay ashore |
| `KEEL_DEV_COMMANDS` | 0 | 1 for the developer's commands on the internal listener: `POST /debug/wind?knots=…&from=…` (a steady wind; degrees it comes from) and `POST /debug/weather?regime=…` or `?auto` (see [Setting the weather](#setting-the-weather)). `tools/dev` and `tools/e2e` set it |

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
database has newer ones. Then it waits for the **simulation's lease**, so
that only one process ever runs the world (`/readyz` says "waiting for the
simulation lease (held by …)"). It loads the active world, making world 1
(epoch 1 January 2026) when there is none, and the world's epoch sets the
tick clock; restores the world from its checkpoint when it can; then come
the world, the tick loop and the world's writer, then the public listeners,
and only then is it ready. On `SIGTERM` or Ctrl-C it is no longer ready at
once, rings the bell and stops in the order [Restarts and
deploys](#restarts-and-deploys) gives. A second signal kills it. A panic in
the tick, its workers or the writers ends the process, and the next
restores the last checkpoint. Once open, the database is not part of
readiness: if it goes away, the requests that need it answer 503, the
world's writes wait, and the world sails on.

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
| `keel_sim_phase_duration_seconds{phase}` | `inputs`, `sea`, `physics`, `grid`, `contacts`, `publish` |
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
| `keel_db_pool_connections{state}`, `keel_db_pool_max_connections` | The main pool's connections, `acquired`, `idle` or `constructing`, and its limit (17) |
| `keel_sim_lease_epoch`, `keel_sim_lease_wait_seconds` | The simulation lease's epoch this process took it at; how long it waited for it |
| `keel_sim_lease_lost_total{outcome}` | The lease's connection lost and taken back (`retaken`) or not (`lost`); a write refused, another process holding the lease (`fenced`) |
| `keel_sim_restores_total{result}`, `keel_sim_restored_boats`, `keel_sim_restore_gap_seconds` | The checkpoint at start: `restored`, `none`, `too_old`, `incompatible`; the boats restored; the world time between the checkpoint and the first tick |
| `keel_persist_inbox_fill_ratio`, `keel_persist_oldest_seconds` | The share of the world's writes' inbox (300 items) not yet written; the world time since the oldest of them |
| `keel_persist_batch_duration_seconds`, `keel_persist_checkpoint_duration_seconds`, `keel_persist_batches_total{result}` | Each batch's transaction, and those that held a checkpoint; batches `ok`, `failed` (tried again) or `fenced` |
| `keel_persist_events_total`, `keel_persist_checkpoints_total`, `keel_persist_checkpoint_bytes` | Lasting events and checkpoints written; the latest checkpoint's size |
| `keel_persist_overflow_total` | Writes lost to a full inbox: the process stops |
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
a trace region (`inputs`, `sea`, `physics`, `grid`, `contacts`, `publish`), so a slow tick's trace says
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
| `GET /`, `GET /{file}`, `GET /assets/{file}` | With `KEEL_CLIENT_DIR`, the built page, read into memory at start: `index.html` at `/`, the other files of the directory's top level (`dev.html`, the licences notice) by name, and the hashed files in `assets/`. Assets are cached for a year as `immutable`, the rest `no-cache`. No listings, no other folders, no hidden files; types from a table of the build's extensions (`.wasm` as `application/wasm`, `.glb` as `model/gltf-binary`); `HEAD` too. These routes need no session, so the page loads while the database cannot be asked |

Errors are `{"error": "<code>"}`; the client puts codes into words. Nothing
the API answers is cached. A path with dot segments or repeated slashes is
404, never redirected. Every request passes, in order: the request ID
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
`Welcome`, `Pong`, `Queued`, `Restart`, `SeaAreas`, `WeatherSystems` from
the server), or `2`, the packed snapshot (`snapshot.txt`: a 176-byte header
with the own boat's state as float64, its heave and pitch included, then the
other boats' entries; see [Other boats](#other-boats)). `SeaAreas` is the
sea about the boat ([Waves](#waves)) and `WeatherSystems` the spells of
weather its wind is computed from ([Wind](#wind)). `go run
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
As `keel serve` stops it sends every connection a `Restart` (the bell),
then, after the world's final checkpoint, closes it with 1012; the next
`keel serve` restores the boats, and a client coming back within the grace
is welcomed back to its own (`rejoined`). One that finds its boat gone (the
checkpoint too old, or of another build) gets a new one at the start: "Your
boat has returned to port."

| Code | Sent when | The page |
|------|-----------|----------|
| 1000 | The page leaves | nothing |
| 1003 | A text message, an unknown kind, an unreadable message | waits from 1 s |
| 1008 | Over the rate, too many messages waiting, no `Hello` | waits from 1 s |
| 1009 | A message over 1 KB | waits from 1 s |
| 1012 | `keel` stops, after its bell | waits 0.5 to 5 s, keeping the bell's line |
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
what can be seen: position to the centimetre, heading, heel, boom and rudder
in 65,536 steps a turn (coarser angles, which change only every few
snapshots, make a boat drawn between them heel and swing its boom in
jerks), the sailor's offset in centimetres, its mode,
and the **sail byte**, which the physics workers keep for every boat: the
sail's flattening and the flow over its two strips (luffing, drawing,
stalled, aback), which the state cannot tell. The entries change the view of
a **base**: an `enter` (the boat in full, 19 bytes), an `update` of the
fields that changed (a moving near boat costs about 10 bytes), or a `leave`.
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
99th percentiles and the frames allocated. After a close with 1012 a bot
waits 0.5 to 5 s, as the page does (a second after any other); each time
one comes back it reports the pause (its last snapshot before to its first
after), whether it got its own boat back, and how far the boat had sailed
meanwhile. Its guests ("Loadbot 1" …) are
made by `POST /guest` once, their sessions kept in
`.dev/loadbot/sessions.json` and used again.

## The local cluster

`go run ./tools/dev` is where almost all work happens. Beside it, the game
also runs **the way it will run for good**: one image holding `keel` and its
page, in a k3s cluster, behind Traefik, in front of a CloudNativePG
database, with Flux's controllers installing charts. On a Mac it runs in a
Lima virtual machine with Ubuntu 26.04, with k3s installed and configured
as on the machines that will run the game. Phones on the same Wi-Fi play
it at **`https://<your Mac's name>.local`**, for example
`https://macbook.local`.

### What to install

- **Lima**: `brew install lima`. It runs the VM on Apple's Virtualization
  framework.
- **Docker** with buildx (Docker Desktop has it), to build the image, and
  **kubectl** (Docker Desktop ships one; or `brew install kubectl`).
- Nothing for Flux or cosign: `go run ./tools/release -tools` puts the
  pinned `flux` and `cosign` in `.dev/bin`.

The VM takes 4 CPUs, 8 GiB of memory and up to 60 GiB of disk.

### The commands

```sh
go run ./tools/cluster -up       # make or start the VM, install k3s, apply everything, deploy the game
go run ./tools/cluster -deploy   # build the image from this tree and put it in place
go run ./tools/cluster -deploy -rebuild   # the same, its database recovered from its backups if it is not there
go run ./tools/cluster -monitoring   # apply the monitoring layer alone
go run ./tools/cluster -release 0123456789ab   # take a published release through Flux; prod for production's
go run ./tools/cluster -smoke    # check the game in the cluster
go run ./tools/cluster -status   # the VM, the pods, the build running, the addresses
go run ./tools/cluster -logs     # follow keel's logs
go run ./tools/cluster -phone    # the phone setup page, and the game's QR code
go run ./tools/cluster -schemas  # write infra/schemas from the cluster's own definitions
go run ./tools/cluster -stop     # stop the VM (-up starts it again)
go run ./tools/cluster -delete   # delete the VM and .dev/cluster (asks first)
```

`-up` the first time takes several minutes: Lima downloads Ubuntu's image
(pinned by digest), k3s is installed, Flux's controllers, the cluster's
controllers (CloudNativePG, External Secrets, cert-manager, the Barman
Cloud plugin, the VictoriaMetrics operator; each chart fetched only if its
signature is its project's own, or checked in CI where Flux cannot) and
Traefik's configuration are applied in that order, each waited for; then
the game is deployed, and the monitoring layer after it. Run again, it
changes only what changed.

The local cluster watches itself as production does, in about half the
sizes: `kubectl -n monitoring port-forward svc/grafana-forward 3000:80`,
then `http://localhost:3000` as `admin`, with the password in the Secret
`monitoring/grafana-admin` ([Monitoring](#monitoring)). Its database is
backed up to a bucket of its own when `.dev/backups.env` holds that
bucket's key, as `KEEL_B2_KEY_ID` and `KEEL_B2_KEY` (the owner copies it
there once, from Infisical's `keel-backups`, `/local`); without the file a
deploy says so and leaves the backups out: the database archives nowhere,
and there is no restore test ([Backups](#backups)). `KEEL_DEV_SAILORS=100 go run ./tools/cluster
-deploy` adds scripted sailors.

`-smoke` checks, over HTTPS at the Mac's name and trusting only the local
root: the page and its scripts with their caching, the physics module as
WebAssembly, `/api/version` naming the build just deployed, a guest made and
read back, the game connection, a second player seeing the first's boat,
`/readyz` and `/metrics` through `kubectl port-forward`, and the database
refusing a connection without TLS (`keel migrate` with `sslmode=disable`,
from a pod of its own).

`tools/cluster` keeps its own kubeconfig, `.dev/cluster/kubeconfig`
(context `keel-local`), and never reads or changes `~/.kube/config`:

```sh
export KUBECONFIG=$PWD/.dev/cluster/kubeconfig
kubectl get pods -A
kubectl -n keel port-forward deployment/keel 9090:internal   # probes, metrics, pprof, replay
```

`go run ./tools/dev` keeps working beside the cluster: their ports never
meet, and they share the local root, so a phone that trusts one trusts the
other.

### On a phone

The cluster's certificate comes from the same local root as `tools/dev`'s
([On a phone](#on-a-phone)): a phone set up once needs nothing more. To set
up a new phone, `go run ./tools/cluster -phone` serves the same setup page
on port 5175. The game is at `https://macbook.local` (your Mac's
`LocalHostName`, in System Settings → General → Sharing → Local hostname);
the Mac's Wi-Fi address works too (`https://192.168.…`), with a cookie of
its own, for a phone that cannot resolve `.local` names.

Lima forwards Traefik's ports 80 and 443 to every address of the Mac
(IPv6 included), and the Kubernetes API to `127.0.0.1:16443` alone; no other
port of the VM reaches the Mac. Plain HTTP answers with a redirect to HTTPS.
When the Mac sleeps, the VM pauses with it, and the game with it.

### How a build reaches the cluster

`-deploy` names the build after the commit, `0123456789ab`, with
`-dirty-<UTC time>` when the tree has changes, so no two builds share a tag.
It builds the image for `linux/arm64` (`docker buildx build`, the
`Dockerfile` at the root), saves it, and imports it into k3s's containerd in
the VM; no registry is involved, and the Deployment's `imagePullPolicy:
Never` makes a missing image fail rather than be pulled. The node keeps the
newest three of the game's images. Then it renders `clusters/local/apps`
with that image in place of the registry's, never pulled, and the Mac's
name, applies it, and waits for the database and the new pod. If the
cluster was following a release (`-release`, see [Releases](#releases)),
`-deploy` lets go of it first: the working tree is in charge again. A new build is a restart, and a restart is a pause: see
[Restarts and deploys](#restarts-and-deploys).

The image is built from the repository alone: the page (the physics module
with the pinned TinyGo, then `vite build`) on the building machine's
platform, `keel` cross-compiled with `CGO_ENABLED=0` and the build ID set by
`-ldflags "-X main.buildOverride=…"`, on `gcr.io/distroless/static`, every
base pinned by digest. It runs as 65532 with no shell, `KEEL_CLIENT_DIR`
pointing at the page. `.dockerignore` is an allow list: nothing in `.dev/`,
no `node_modules`, no build output.

### The layout of `infra/`

```
infra/
  MANUAL-STEPS.md        what is done by hand, once: the accounts, the machine, the join
  REBUILD.md             the machine rebuilt from nothing, step by step
  production.yaml        production's identifiers, none secret: the machine's and
                         tailnet's names, the workflows' identities, Infisical's IDs,
                         Cloudflare's account and zone, the state's bucket, the
                         backups' buckets
  vendor.yaml            the release manifests kept as published, each pinned by
                         its SHA-256 (tools/vendored)
  keys/cert-manager.pem  cert-manager's public key, which its chart and images
                         are checked against before a release
  tofu/                  what the accounts workflow manages with OpenTofu: the zone,
                         the tunnel, the secrets they make (see Online)
  bootstrap/join.sh      joins a fresh machine to the tailnet, then closes OpenSSH
  tailnet/policy.hujson  who may reach production's machine, and how
  ansible/               the playbook that configures production's machine
                         (see The machine)
  k3s/
    release.yaml         the k3s release every machine installs, and its commit
    config.yaml          k3s's settings on every machine: kubeconfig root's alone,
                         Secrets encrypted with secretbox, protect-kernel-defaults,
                         and the k3s CIS hardening guide's arguments
    psa.yaml             Pod Security (restricted, but kube-system) and EventRateLimit
    audit.yaml           the API server's audit policy
    prod.yaml            production's drop-in: node name, no ServiceLB
    sysctl.conf          the kernel settings k3s checks, and inotify limits
  schemas/               the JSON schemas of the custom resources the manifests
                         use, written by tools/cluster -schemas
  local/
    lima.yaml            the VM: Ubuntu 26.04 by digest, size, port forwarding
    k3s-local.yaml       the local drop-in: node name
  cluster/
    flux-system/         flux install --export, its images pinned by digest
    infrastructure/
      controllers/       the CloudNativePG operator, External Secrets'
                         controller, cert-manager, the Barman Cloud plugin and
                         the VictoriaMetrics operator: each an OCIRepository and
                         a HelmRelease; and, for production alone, Kured and the
                         system-upgrade controller, from their releases' manifests
      configs/           Traefik's HelmChartConfig: the Gateway API, its timeouts;
                         the default service accounts without tokens; the
                         NetworkPolicies of kube-system, default and kube-public
    apps/keel/           the game: Deployment, Service, ConfigMap, Gateway,
                         HTTPRoute, the limits per address, the database's
                         Cluster, the NetworkPolicies; production's sizes. Its
                         backups: the object store, the daily base backup, the
                         archive's generation, the weekly dump. Its scrapes,
                         alerts and fixed addresses
    apps/keel-restore/   the weekly restore test, in a namespace of its own
    apps/archive/        a component: writes the archive's name where it goes
    apps/rebuild/        a component: the database recovered from its backups
    apps/cloudflared/    production's tunnel connectors, their token's
                         ExternalSecret, their NetworkPolicies, scrape and alert
    monitoring/          what watches the game: VictoriaMetrics' stack (the
                         stores, the scraper, vmalert, Alertmanager, Grafana,
                         node-exporter, kube-state-metrics), VictoriaLogs and
                         vlagent, the dashboards, the machine's and cluster's
                         alerts and their tests, the NetworkPolicies
    clusters/local/      the local cluster's entry points: controllers, configs,
                         apps (half the sizes, HTTPS, the redirect, its own
                         bucket), monitoring (half the sizes); and release,
                         what -release applies to follow a release
    clusters/prod/       production's entry points: flux-system (Flux's
                         controllers, and sync.yaml, what they follow),
                         controllers (Kured and the upgrade controller too),
                         configs (Traefik's Service ClusterIP, External
                         Secrets' two stores, the k3s upgrade plan), apps (the
                         players' host, the passwords and the backups' keys
                         from Infisical, cloudflared), monitoring (Grafana's
                         passwords, Kured's scrape)
    clusters/prod-rebuild/   production rebuilt: the same, its database
                         recovered from the backups (infra/REBUILD.md)
```

The bases hold what every cluster shares; each cluster's folder patches
what differs. k3s installs the Gateway API's standard CRDs itself, with its
Traefik. `tools/cluster` writes k3s's files into the VM before installing
k3s and again when they change, restarting k3s. The k3s release is pinned
in `infra/k3s/release.yaml`, by version and by the commit its tag names:
the release's `install.sh` is fetched at that commit and no other, as a
workflow's actions are pinned, and it checks the binaries it downloads
against the release's checksums. To raise k3s's version, change both
lines together (Renovate does). Lima reads `lima.yaml` only when it makes
the VM: after changing it, `-delete` and `-up`. To raise Flux's, run the
command at the top of `gotk-components.yaml` with the new version
(`.dev/bin/flux`, after its pin in `tools/internal/pinned` is raised),
update the digests in its `kustomization.yaml`, and run `-schemas` on a
cluster that has it.

Secrets are never in the repository (a test fails on any). On the local
cluster `tools/cluster` makes the database's passwords (`keel-db-app`, and
the read-only roles' `keel-db-reader` and `keel-db-grafana`) and Grafana's
admin password (`monitoring/grafana-admin`) once, at random, and never
replaces them; `keel-tls`, the certificate, again when its names change;
and, from `.dev/backups.env`, the local bucket's key (`keel/keel-b2`,
`keel-restore/keel-b2-read`). In production, External Secrets makes them
from Infisical (see Online).

The rules the manifests keep, checked by `go test ./tools/internal/manifests`
on every entry point of both clusters, by a release before it publishes
anything, and by `-up`, `-deploy` and `-release` before applying anything:
no Secret; every image pinned by digest, the game's own included (only a
deploy from the working tree names it by a tag, with `imagePullPolicy:
Never`); every `OCIRepository` fetched only if cosign verifies its
signature, keyless, against identities whose issuer and subject patterns
are anchored at both ends, and the release's own only from the release
workflow on `main`; Flux's `Kustomization`s each applying its layer's
folder of the release for its cluster, with `prune` on, `deletionPolicy:
Orphan`, `wait` on and a `dependsOn` naming the layer before it (the first
of production's, which holds the others, waits for Flux's controllers by
name instead); the database, and the namespace it is in, annotated never
to be pruned; each cluster naming its own players' host alone; the game's
Deployment with one replica, `Recreate`, `keel migrate`
as an init container, probes on the internal listener, the restricted
security context and no service account token; `GOMEMLIMIT` between 80% and
95% of the memory limit; no route to the internal listener; every route on
a listener of the `keel` Gateway, an HTTPS listener with a certificate; no
`LoadBalancer` or `NodePort` Service in production, Traefik's included
(the chart's default is `LoadBalancer`, which opens NodePorts on every
address of the node even without ServiceLB); the
database refusing connections without TLS, with no superuser and the
builtin `C.UTF-8` locale; the database's `smartShutdownTimeout` at most
30 s and its clients' TCP keepalives set; and keel's
`terminationGracePeriodSeconds` at least its bell, the final checkpoint's
and the closes' bounds and 10 s more; every namespace enforcing Pod
Security's `restricted` profile, and holding a NetworkPolicy that selects
all its pods for ingress; no `ipBlock` but `0.0.0.0/0` (with exceptions);
in production, every `ExternalSecret` reading the store `infisical`, in a
namespace the store's conditions name, which name exactly those, and no
store or `ExternalSecret` elsewhere; in production, every Secret a
workload or the database names made by an `ExternalSecret` or by
CloudNativePG; every rule of a route to the game's players' listener
passing through one limit per address, `/ws` through the connections one;
and production's Gateway listener and routes naming
`play.keelovertheedge.com` alone.

And, for what watches and keeps the game: only `monitoring-node`, `kured`
and `system-upgrade` enforce `privileged`, each saying why in an
annotation and holding its own workload alone; the database with one
plugin, Barman Cloud's, archiving to `keel-b2` under the live generation's
name (or, in the rebuild form, recovering from it and archiving under the
next), a base backup daily and at once when it is made, and nothing else
archiving; the restore test restoring the archive the database writes,
with its image and `max_connections`; no object store naming a server,
each writing to its cluster's bucket, the restore test's reading what the
live one writes with a key of its own; one instance having no disruption
budget; nothing fetched at deploy time (the stack's download job and its
own dashboards and rules off, no plugin from Grafana's catalog, the one
fetched from its release checked against its SHA-256, no chart value
naming `raw.githubusercontent.com`); a source with no `verify` being one
of the listed ones CI checks against a key; no route, Ingress or grant
into the monitoring namespaces; the k3s upgrade plan naming the pinned
k3s release and its upgrade image, cordoning and never draining, in a
window; and a Service with an address chosen by hand being one of the
five forwards, at its address. Two more hold across a cluster's layers
together: every scrape's port is let in to the scraper by a NetworkPolicy
beside its pods, by number, and outside the monitoring namespaces nothing
else is; and each forward's Service is there once.

Beside the rules, every rendered object is checked against the schema of
its kind with [kubeconform](https://github.com/yannh/kubeconform)
(`go tool kubeconform`, `-strict`): a field the schema does not know, a key
written twice, or a kind with no schema fails. The schemas of Kubernetes'
own kinds come from `yannh/kubernetes-json-schema`, at one commit, for the
version of Kubernetes the k3s pin holds; they are downloaded once into
`.dev/schemas`. Those of custom resources (Flux's, CloudNativePG's, the
Barman Cloud plugin's, VictoriaMetrics', the Gateway API's, Traefik's,
k3s's) are in `infra/schemas/`, written by
`go run ./tools/cluster -schemas` from the definitions in the local
cluster, which runs exactly the versions the manifests are written for
(the upgrade controller's `Plan`, which only production runs, from the
definition the manifests hold); so is `CustomResourceDefinition`'s own,
which the published set lacks.
After raising a chart, Flux or k3s, run `-up` and then `-schemas`, and
commit what changed.

### The game in the cluster

| Part | What |
|------|------|
| `keel` | One replica, replaced rather than rolled (`Recreate`), `terminationGracePeriodSeconds: 30` (it stops within about 11 s: the bell, the final checkpoint, the closes). `keel migrate` runs first, as an init container. Liveness `/livez` every 10 s, readiness `/readyz` every 2 s, both on the internal listener, `0.0.0.0:9090` in the pod; the metrics alone on `0.0.0.0:9091`, for the scraper. Non-root, read-only root, no capabilities, `RuntimeDefault` seccomp. Locally 1 CPU requested and 3 the limit (so `GOMAXPROCS` is 3, as in production), 2 GiB with `GOMEMLIMIT=1800MiB` |
| `keel-db` | CloudNativePG's `Cluster`, one instance, PostgreSQL 18.6 (`minimal` image), the builtin `C.UTF-8` locale. `pg_hba` refuses every connection without TLS; `keel` connects with `sslmode=verify-full` against the operator's CA (`keel-db-ca`, its `ca.crt` alone mounted), the password from `keel-db-app` as `PGPASSWORD`. `smartShutdownTimeout: 10` (not 180 s: keel never disconnects of itself) and server-side TCP keepalives of 10 s, 5 s, 3 probes. Locally 1–2 GiB and 10 GiB of `local-path` storage |
| `keel` Gateway | In the game's namespace, class `traefik`: `http` on Traefik's `web` entry point and, locally, `https` on `websecure` with `keel-tls`, which is also Traefik's default certificate for clients that name no host. The `play` route sends everything to keel's game listener; locally, plain HTTP is redirected |
| Traefik | k3s's own, with the Gateway API on, Ingress off, and its entry points' timeouts written down: `readTimeout` 60 s (a request must arrive within it; a stalled one is cut), `idleTimeout` 180 s, no `writeTimeout`. A game connection is not cut by them |

Every namespace but `kube-system` enforces Pod Security's `restricted`
profile, on both clusters (`infra/k3s/psa.yaml`); a namespace that needs
more says so with a label of its own, and three do: `monitoring-node`
(node-exporter and vlagent read the host), `kured` (it reboots it) and
`system-upgrade` (its jobs replace k3s's binary).

## Releases

Every push to `main` makes a release, by itself. Nothing in it deploys.
`release.yaml` runs the tests (`ci.yaml`, whole), and only if they pass:

1. **The image.** One `docker buildx build` for `linux/amd64` and
   `linux/arm64`, on a BuildKit pinned by digest, pushed as
   `ghcr.io/daneelvt/keel:<build>`. The `Dockerfile` builds the page and
   compiles `keel` on the runner's own platform, so neither needs
   emulation, and the page is the same in both. cosign signs the image's
   digest, and GitHub attests how it was built (`actions/attest`; the
   attestation is kept beside the image).
2. **A check on each machine.** A runner of each architecture pulls the
   image by that digest and checks it as `ci.yaml` checks its own build:
   for its machine, 65532, no shell, `keel help`, the page.
3. **The manifests.** First `go run ./tools/release -verify-keyed` checks
   the signatures Flux cannot ([Who signed it](#who-signed-it)). Then
   `go run ./tools/release -render` builds every entry
   point of every cluster with the game's image **by its digest**, checks
   the rules and the schemas ([The layout of
   `infra/`](#the-layout-of-infra)), and writes plain YAML. `flux push
   artifact` pushes the folder as
   `ghcr.io/daneelvt/keel-manifests:<build>`, and cosign signs its digest.

The **build** is the first 12 characters of the commit, as `/api/version`
reports it. The run's summary names the build and both digests.

```
keel-manifests:<build>            signed; made from main@sha1:<commit>
  local/
    controllers/manifests.yaml    the charts (each one's signature checked)
    configs/manifests.yaml        Traefik's HelmChartConfig
    apps/manifests.yaml           keel by digest, the database, the Gateway (macbook.local)
    monitoring/manifests.yaml     the stack, the logs, the dashboards, the alerts
  prod/
    flux-system/manifests.yaml    Flux's controllers, and what they follow
    controllers/manifests.yaml
    configs/manifests.yaml
    apps/manifests.yaml           keel by digest, the database, play.keelovertheedge.com
    monitoring/manifests.yaml
  prod-rebuild/                   production rebuilt: the same five, the database
                                  recovered from its backups (infra/REBUILD.md)
```

The layers are applied in order, each once the one it follows is ready:
Flux itself, the controllers, their configuration, then the game (`apps`)
and what watches it (`monitoring`) side by side, neither waiting for the
other: a dashboard that fails to apply never holds back a deploy of the
game. No release is rendered until `infra/production.yaml` names the
backups' buckets and the project that holds their keys.

Flux applies exactly what was rendered and checked: a folder with no
kustomization of its own is applied as it is.

**A build is released once.** A second run of the same commit stops at
"already released": the `build` job finds the manifests published and
signed, and nothing is built or pushed. The push is reproducible (the same
commit and image give the same artifact), so if a run fails after pushing
the manifests and before signing them, **Re-run failed jobs** pushes the
same artifact and signs it. *Re-run all jobs* would instead fail at
`build`, which says the manifests are published and not signed: nothing
may deploy them until they are.

The first release makes the packages `keel` and `keel-manifests`, and
GitHub makes a new package private. Each is made public once, by hand
([repository-settings.md](repository-settings.md)): Flux, and
`tools/cluster -release`, read them with no credential.

### Who signed it

The signatures are Sigstore's, keyless: no key is kept anywhere. The
release workflow's run proves who it is to Sigstore with GitHub's OIDC
token; Sigstore issues a short-lived certificate naming the workflow's file
and ref, and records the signature in its public log. Whoever verifies
says which signer they accept. Flux accepts one
(`infra/cluster/clusters/prod/flux-system/sync.yaml`): this repository's
`release.yaml` on `main`, matched whole. Not a pull request's run, another
branch, another workflow, or a fork. Each signing job checks its own
signature against that very identity before it ends, and a test holds the
workflow's copy of the patterns to the manifests'.

To check a release by hand, with the pinned cosign and Flux CLI
(`go run ./tools/release -tools` puts them in `.dev/bin`):

```sh
signer=(--certificate-oidc-issuer-regexp '^https://token\.actions\.githubusercontent\.com$'
        --certificate-identity-regexp '^https://github\.com/daneelvt/keel-over-the-edge/\.github/workflows/release\.yaml@refs/heads/main$')
.dev/bin/cosign verify "${signer[@]}" ghcr.io/daneelvt/keel-manifests:0123456789ab
.dev/bin/cosign verify "${signer[@]}" ghcr.io/daneelvt/keel:0123456789ab
gh attestation verify oci://ghcr.io/daneelvt/keel:0123456789ab --repo daneelvt/keel-over-the-edge
mkdir release && .dev/bin/flux pull artifact oci://ghcr.io/daneelvt/keel-manifests:0123456789ab --output release
```

The same checking applies to what the cluster fetches from others. Each
chart is fetched only if its project's release workflow signed it:
CloudNativePG's and the Barman Cloud plugin's, External Secrets',
VictoriaMetrics' three. Flux checks those itself, and a rule fails any
`OCIRepository` that does not verify.

One cannot be checked by Flux: cert-manager signs its chart and images
with a key of its own, in a form Flux's verification does not read. Its
source is pinned by tag and digest with no `verify`, and
`go run ./tools/release -verify-keyed` checks instead, with cosign: the
chart's digest and each image's digest in its values against
cert-manager's public key, kept in `infra/keys/cert-manager.pem`
(cert-manager's documentation, "Verifying signatures"). The cluster
fetches by those digests, so it runs the bytes that were checked. The same
command checks Kured's image, which comes from a release manifest and not
a chart, against its own release workflow, keyless. It runs on every pull
request that touches `infra/` and in the release workflow before anything
is rendered. The rule allows a source without `verify` only when it is in
that list.

Two things come as files, as their projects publish them, and not as
charts: Kured's manifest and the system-upgrade controller's.
`infra/vendor.yaml` records each one's release, address and SHA-256;
`go run ./tools/vendored -check` (in the tests) fails when a file differs
from its record, and `-pull` fetches them again. Grafana's dashboards from
other projects are kept the same way, each pinned to a commit and a
SHA-256 in `infra/cluster/monitoring/dashboards/index.yaml`
(`go run ./tools/dashboards -pull`, `-check`).

### Promoting, and rolling back

Deploying is tagging. Production's Flux follows the tag **`prod`** of
`keel-manifests`, and looks every minute. `promote.yaml` moves it: Actions
→ promote → Run workflow, with the build. The run waits in the
`production` environment for the owner's approval, and then, before it
moves anything (`go run ./tools/release -promote`):

- the `production` environment must require a reviewer: GitHub makes an
  environment a workflow names and the repository lacks, with no
  protection, and a promotion nobody approved is refused;
- the build must be released, and its signature verify as Flux will
  verify it, so `prod` never names what Flux would refuse;
- the commit it was made from must be on `main`;
- it must not be **older** than the build production follows now.

**Rolling back** is promoting an older build with the *rollback* box
ticked, which lifts only the last check. Promotions never run two at once:
a second waits for the first. The run's summary shows the build, commit
and digest before and after. Flux's own controllers, and what they
follow, are the release's first layer, `prod/flux-system`: once a
machine's Flux has been given it, Flux applies it itself from then on, and
so upgrades itself.

Flux applies a release's layers in order, each once the one before is
ready: Flux itself, the controllers, their configuration, the game. It
removes what a release no longer holds, with two exceptions it never
removes: the database and the namespace it is in (an annotation on each).
Deleting one of Flux's `Kustomization` objects deletes nothing it applied
(`deletionPolicy: Orphan`). Removing the database takes a person.

### A release on the local cluster

The local cluster stays your own, deployed from the working tree. But a
published release can be taken through Flux on it exactly as production
will take one:

```sh
go run ./tools/cluster -release 0123456789ab   # a build
go run ./tools/cluster -release prod           # what production follows
```

It applies `clusters/local/release`: the release's source at that tag,
with production's signature check, and Flux's layers `controllers` →
`configs` → `apps` on the artifact's `local/` folders. It waits for Flux
to verify and fetch the source, then for each layer to be ready, then runs
`-smoke`, which checks `/api/version` names that build. A source Flux
refuses stops it at once, with what Flux said. The times it prints are
from the moment the release was applied.

The artifact is rendered for a Mac named `macbook` (`clusters/local/apps`
names `https://macbook.local`); on another Mac `-release` stops and says
so, since nothing puts the Mac's own name in, as `-deploy` does. When the
working tree is another commit than the release, `-smoke` checks only what
every build shares (the page, the build, the database's TLS): the guest
and the game connection are this tree's protocol.

`go run ./tools/cluster -deploy` goes back: it deletes Flux's layers and
their source (which deletes nothing they applied), and applies the working
tree with the image it builds. `-status` says which is in charge.

Two sources Flux must refuse are kept as fixtures, applied by hand and
never by a command: `tools/cluster/testdata/refused-other-signer.yaml`
(the CloudNativePG chart, well signed, but not by the release workflow)
and `refused-unsigned.yaml` (an artifact nobody signed, in a package of its
own, `keel-manifests-check`). Each file says how to apply it and what it
must show: `SourceVerified` False, `VerificationError`, no artifact. The
unsigned artifact is pushed once, by hand, with a token that may write
packages, and its package then made public:

```sh
gh auth refresh --scopes write:packages
gh auth token | docker login ghcr.io --username daneelvt --password-stdin
mkdir unsigned && echo 'apiVersion: v1
kind: ConfigMap
metadata:
  name: unsigned
  namespace: default' > unsigned/configmap.yaml
.dev/bin/flux push artifact oci://ghcr.io/daneelvt/keel-manifests-check:unsigned \
  --path unsigned --source https://github.com/daneelvt/keel-over-the-edge --revision "main@sha1:$(git rev-parse HEAD)"
```

### What keeps the pins current

Renovate (`renovate.json`) updates, each with its digest or commit: the
actions in the workflows; the `Dockerfile`'s images and the CI service's
PostgreSQL; the CloudNativePG chart (tag and digest) together with the
operator's image; Flux's manifests, its controllers' images and its CLI,
as one update; External Secrets' chart (tag and digest) with its image;
cert-manager's chart with its images; the Barman Cloud plugin's chart and
images, with CloudNativePG's; VictoriaMetrics' operator, stack and every
image they run (the stores, the scraper, vmalert, Alertmanager, Grafana
and its sidecar, node-exporter, kube-state-metrics, VictoriaLogs and
vlagent), as one update; rclone's and the upgrade controller's `kubectl`
image; Kured, the system-upgrade controller and `vmalert-tool`, each
waiting for a tick on the dashboard; cloudflared's image; OpenTofu's
providers, at exact versions from
OpenTofu's registry, with the lock file's hashes; k3s's version and commit
(a new minor version waits for a tick on the dashboard), together with
the upgrade plan's version and its image, which a test keeps the same;
cosign, TinyGo,
kube-bench and OpenTofu; BuildKit; Ansible
and ansible-lint, with `pip-compile` and every file's hash
(`infra/ansible/*requirements.txt`); kubeconform and every Go module. An
image in a chart's values, a custom resource or a ConfigMap is found by
the comment above it (`# renovate: image=<name>`), and a test fails when a
pinned image has none. A
test fails if one of its patterns stops finding its pin. Raised by hand:
the vendored manifests' files and the dashboards from other projects
(`tools/vendored`, `tools/dashboards`, after Renovate raises the image
beside them); Grafana's logs plugin (its address and SHA-256 in the
stack's values); cert-manager's key, if the project ever replaces it;
the commit of the Kubernetes schemas (`tools/internal/manifests`), Lima's
Ubuntu image, Tailscale's client for the runners (`go run
./tools/machine -pin <version>`, from Tailscale's own site, which Renovate
does not read), and OpenTofu's `required_version` in `infra/tofu`, raised
with a new minor version of OpenTofu.

## The machine

Production runs on one rented VM, `keel-prod-1`: Ubuntu 26.04, k3s, and
Flux following the release the `prod` tag names. It has no open port. The
owner and the workflows reach it over the tailnet, with Tailscale SSH, as
root; nothing else reaches it at all.

What is made by hand, once (the accounts, the VM, the join), is in
[infra/MANUAL-STEPS.md](../infra/MANUAL-STEPS.md). Everything after it is a
commit and a workflow run, which the owner approves.

### The workflows

**`machine`** (Actions → machine → Run workflow) runs the playbook in
`infra/ansible` on the machine. Its job:

1. Joins the tailnet as a short-lived node tagged `tag:ci-prod`: Tailscale
   accepts the job's own OIDC token, as the identity
   `infra/production.yaml` names, from `machine.yaml` on `main` in the
   `production` environment, and no other job. The node is ephemeral: it
   leaves the tailnet when the job ends (`-leave`, whatever happened). The
   tailnet's own record of the machine's SSH host keys becomes the job's
   `known_hosts`, so SSH checks the machine's key strictly.
2. Signs in to Infisical the same way, and reads the cluster's credential
   from `keel-ops`, `prod`, `/machine`. It is masked in the log first, and
   reaches the playbook in its environment alone.
3. Reads the release `prod` names, checks its signature as Flux will, and
   pulls it by digest: the playbook bootstraps Flux from exactly those
   bytes.
4. Runs the playbook over Tailscale SSH, and writes its recap, what
   changed and each role's time to the run's summary.

Its `mode`:

| Mode | What |
|------|------|
| `check` | What `apply` would change (`--check --diff`); changes nothing. Read its summary: every task listed under "Would change" is drift, or a change waiting in the repository |
| `apply` | Changes the machine, then `verify.yaml` checks it from outside the roles. With **reboot** ticked, it reboots when a change needs it (a new kernel, the kernel's command line, a module in use, the audit rules, which are locked until a boot); otherwise the summary says a reboot is due |
| `apply` with **rebuild** | For a machine reinstalled from nothing: the same, with Flux bootstrapped on the release's rebuild form, whose database is recovered from the backups ([infra/REBUILD.md](../infra/REBUILD.md)) |
| `audit` | Lynis, copied to a folder of its own on the machine, run, and removed; changes nothing. Its hardening index, warnings and suggestions in the summary. It fails on a warning that `infra/ansible/lynis-accepted.txt` does not list with its reason |

There is no schedule: every run logs in as root, so every run waits for
the owner's approval. A second `apply` changes nothing, and that is
checked on every pull request.

Before the playbook, a run reads what Flux follows on the machine and the
name the database archives its WAL under (`infra/ansible/state.yaml`,
which changes nothing), and refuses to move Flux between the release's two
forms when that would point a database at another's archive: **rebuild**
on a machine whose database is not the one a rebuild made; and, after a
rebuild, a run without it until the release production follows has the
rebuilt database's archive as its live one. Its log says what it read
(`flux follows […]; the database archives as […]`), and with **rebuild**
the summary says what is recovered and what it will archive as.

**`tailnet`** writes `infra/tailnet/policy.hujson` to Tailscale when it
changes on `main`, or when run by hand, after approval. It signs in as the
other identity, which only `tailnet.yaml` may use and which can write the
policy and nothing else. Tailscale validates the policy and runs its
`tests` first, and refuses one that fails them; the write names the
policy's ETag, so two runs never overwrite each other. The summary shows
what was live and what replaced it: a change made in the admin page shows
there, and is gone.

The policy: two tags, each owned by `autogroup:admin` (the owner; no
person's login is in the file). `tag:ci-prod` reaches `tag:keel-prod` on
TCP 22 alone, and logs in there as root; the owner's devices reach it on
22 too, and log in as root after a fresh sign-in every 12 hours
(`check`). Nothing else: no rule for `*`. `go run ./tools/tailnet -check`
keeps that shape, offline.

### The playbook

```
infra/ansible/
  ansible.cfg                   root, pipelining, strict host keys, the junit callback for the times
  inventory/production.yaml     keel-prod-1, reached at its tailnet address
  inventory/runner.yaml         the same, on a workflow's own runner (pr.machine)
  requirements.txt              ansible-core, every file hashed (pip-compile)
  lint-requirements.txt         ansible-lint, likewise
  site.yaml                     the roles, in order; AIDE's record; the reboot
  verify.yaml                   checks the machine is as site.yaml leaves it
  state.yaml                    reads what Flux follows and what the database archives as
  audit.yaml                    Lynis, run in a folder of its own and removed
  lynis-accepted.txt            the Lynis warnings accepted, each with its reason
  roles/
    base/                       host name; packages up to date; the image's extras
                                purged; UTC; the journal; names resolved through
                                systemd-resolved; k3s's kernel settings; no swap
    hardening/                  the CIS benchmark, below
    access/                     Tailscale from its own repository; OpenSSH gone
    firewall/                   the table hostfw, and its unit
    updates/                    security updates every day, Tailscale's too; no reboot
    observe/                    the journal uploaded to the cluster's logs; the
                                machine's facts written for node-exporter
    k3s/                        k3s at the pin, with infra/k3s's settings
    flux/                       Flux, from the release prod names
    bootstrap_secret/           the cluster's credential for Infisical
```

Ansible's own modules only (`ansible.builtin`), no collection. Every role
runs again and changes nothing; what takes effect only after something
else (GRUB, the kernel's settings, a mount's options) is read and compared,
not remembered, so a run that stopped half-way is finished by the next.

**The firewall** is the table `inet hostfw`, in `/etc/hostfw/hostfw.nft`,
loaded by `hostfw.service` before the network comes up: no packet arrives
unfiltered, even at boot. Its `input` drops everything but loopback,
established connections, the tailnet's interface, the cluster's own pod
and service networks, DHCP's answers, and the ICMP that keeps a network
working. Its `forward` drops any new connection arriving from the public
interface, so no NodePort or host port is reachable whatever a Service
says. It is written in one transaction that never touches another table:
k3s's and Tailscale's rules are theirs. Ubuntu's `nftables.service` stays
off, as it flushes every table when it starts and stops.

**k3s** is installed from `infra/k3s/release.yaml`'s installer and version
when missing, and upgraded when older, never downgraded. A changed
setting restarts it; running containers survive that. The cluster's
upgrade plan raises it too, in its window ([Reboots and
upgrades](#reboots-and-upgrades)): whichever comes first, the other finds
nothing to do.

**What the machine tells the cluster** (`observe`). `systemd-journal-upload`
sends the journal to VictoriaLogs at its fixed address in the cluster
(`10.43.0.50:9428`), from the machine itself, so the kernel's, k3s's,
Tailscale's, the firewall's and auditd's lines are beside the pods'; it
keeps its place across a restart, and retries while the cluster is down.
And `keel-machine-facts`, every five minutes, writes what no exporter
knows to `/var/lib/node-exporter/textfile/keel_machine.prom`, whole or not
at all, which node-exporter reads: whether a reboot is required and since
when, the security updates waiting, unattended-upgrades' last run, what
AIDE's last check found, the size of auditd's log, and whether each unit
the machine needs is active (k3s, tailscaled, hostfw, chrony, auditd, the
upload). `sysstat` is purged: node-exporter records what it did.

**Flux** is applied from the release production follows, signed by the
release workflow, never from the working tree: `kubectl diff
--server-side`, and when it differs, `apply --server-side` as the field
manager `kubectl`. Flux takes over those fields when it applies the same
objects, so the playbook and Flux never fight. Running `apply` again
repairs a Flux that broke itself.

**The bootstrap secret** is `external-secrets/infisical-universal-auth`,
with the keys `clientId` and `clientSecret`, piped to `kubectl`: never on
the machine's disk, never in a log. Its namespace is never pruned by Flux.

### The game waits for its database password

Until the `accounts` workflow has written the database's password into
Infisical, production's `apps` layer is applied as released, and waits:
External Secrets reports `keel-db-app`'s key missing and tries again; so
CloudNativePG makes the job that would create the database, whose pod
cannot start without the password, and no instance; `keel`'s pod waits in
`CreateContainerConfigError`, and cloudflared's for its token; Flux
reports the layer's health check failing, and tries again every minute.
Once the Secrets exist, all go on by themselves, and the database is made
with the password kept in Infisical and no other (see Online).

### Looking at the machine

From one of the owner's devices on the tailnet, from any network:

```sh
tailscale ssh root@keel-prod-1
```

Tailscale asks for a fresh sign-in at most every 12 hours. Where UDP is
blocked, Tailscale relays over HTTPS on 443, slower but enough for a
shell; `tailscale ping keel-prod-1` says whether the path is direct.

The Kubernetes API listens on the machine alone. To reach it, forward it
over the same session:

```sh
tailscale ssh root@keel-prod-1 -L 16443:127.0.0.1:6443
# (the machine first: tailscale refuses a flag before it)
# on the machine: k3s kubectl …, or copy /etc/rancher/k3s/k3s.yaml to the
# computer with its server set to https://127.0.0.1:16443
```

Change nothing by hand: `machine check` reports it as drift, and `apply`
undoes it. A change is a commit, and a run.

### Hardening

The machine is hardened to the **CIS Ubuntu Linux 26.04 LTS Benchmark,
Level 1 Server**, and k3s to the **k3s CIS Hardening Guide**. Each control
is taken, by a role, and checked by `verify.yaml` or Lynis; or not taken,
with its reason, below. A few settings beyond CIS that cost nothing are
taken too.

| Area | Taken |
|------|-------|
| Kernel modules | Not loadable: `cramfs`, `freevxfs`, `hfs`, `hfsplus`, `jffs2`, `usb-storage`, `dccp`, `rds`, `sctp`, `tipc` |
| Mounts | `/tmp` in memory, and `/dev/shm`, with `nodev,nosuid,noexec` |
| Boot | `audit=1 audit_backlog_limit=8192 apparmor=1` on the kernel's command line; no memory kept back for crash dumps (`crashkernel=` removed, 512 MB given back); AppArmor on |
| Kernel | ASLR (`randomize_va_space=2`), `ptrace_scope=1`, no core dumps (`suid_dumpable=0`, a hard limit of 0, systemd-coredump storing none). Beyond CIS: `kptr_restrict=2`, `dmesg_restrict=1`, eBPF for root alone and its JIT hardened, `protected_fifos=2`, `protected_regular=2` |
| Network | No redirects sent or taken, no source routing, strict reverse-path filtering, martians logged, SYN cookies, broadcasts and bogus ICMP ignored; IPv6 router advertisements ignored (the machine has no IPv6). Beyond CIS: no multicast DNS or LLMNR |
| Services | About twenty of the image's packages purged (VMware's tools, apport, kdump, snapd, iSCSI, multipath, LVM, mdadm, udisks, thermald, fwupd, rsyslog, ufw, cloud-init …); what Ubuntu's metapackages need is kept with its units masked. No mail server. chrony the only time service, every source authenticated with NTS. cron and at for root alone |
| Access | No SSH server (Tailscale SSH serves SSH); root the only account with a shell, every other locked; `su` for nobody; `sudo` in its own terminal; passwords of 14 characters and 4 classes, yescrypt; 5 failed logins lock an account for 15 minutes, root excepted; `umask 027`; a 15-minute idle shell timeout; banners that name no system |
| Logging | journald on disk, compressed, capped at 1 GB, the only log. auditd with the benchmark's rules (time, identity, network, sudo, logins and sessions, permissions, refused access, mounts, deletions, AppArmor, modules, every set-user-ID program on the disk), locked until the next boot; 10 logs of 50 MB |
| Integrity | AIDE's record of the system, made once the playbook is done, checked every day (`dailyaidecheck.timer`), leaving out what changes by design (k3s's and the kubelet's folders, logs, caches, `/run`, `/tmp`) |
| Files | The account files at the benchmark's modes; world-writable and unowned files reported; root alone with UID 0; no empty password; root's `PATH` absolute |
| k3s | The API server: `NodeRestriction` and `EventRateLimit`, Pod Security's `restricted` enforced for every namespace but `kube-system`, an audit log of every request (metadata, 30 days, 10 files of 100 MB), service account tokens not extended. The controller manager: finished pods removed past 100. The kubelet: idle streams closed after 5 minutes, the guide's six TLS cipher suites, 4096 processes a pod. Its logs folder `0700`, its certificates `0600` on every run. The three default service accounts without a token. Already there: `protect-kernel-defaults`, Secrets encrypted with secretbox |

| Not taken | Why |
|-----------|-----|
| IP forwarding off | k3s routes every pod's traffic through the host |
| `forward` and `output` policies of drop | Pods' traffic crosses `forward`; Flux, images and updates go out through `output`. The firewall drops new connections arriving from outside on `forward`, which is what the policy is for here |
| Separate partitions for `/var`, `/var/tmp`, `/var/log`, `/var/log/audit`, `/home` | Level 2; the image has one root partition, and repartitioning means installing from Ubuntu's ISO, for little gain on a machine with one purpose |
| A bootloader password | The console is behind the provider's panel, and it is the way back if Tailscale fails; a password would only stand between the owner and it |
| Root's password ageing | Root's password is used only at the console, when everything else failed; an expired one would lock the owner out exactly then |
| auditd stopping the machine on a full log | Availability comes first: the log rotates, and a full one is an alert, not a stop |
| `overlay`, `squashfs`, `udf` off | containerd needs `overlay`; the other two are Level 2 |
| SSH server settings | There is no SSH server; who may log in is the tailnet policy's |
| A remote log server | Nothing to send logs to yet; the journal stays on the machine |
| k3s: `AlwaysPullImages` | Every image is pinned by digest, and a restart while the registry is down would stop every pod |
| k3s: NetworkPolicies for `kube-system`, `default`, `kube-public` | They come with the game's own NetworkPolicies |
| k3s: `request-timeout` | The default, 60 s; nothing holds a request open longer |

The audit rules on system calls list only the calls the machine's kernel
has (`ausyscall --dump`), so they load on any architecture.

**Measuring it**: `machine` with `audit` runs Lynis (Ubuntu's own package,
unpacked on the runner and copied over, nothing installed) before and after
a change. Lynis's index is not CIS's score: the gate is "no warning not
accepted with its reason", not a number. `pr.machine` runs Lynis on its
runner, and kube-bench too, as a report: its newest k3s profile is for
Kubernetes 1.29, so its findings are read against the k3s guide, not
obeyed.

### Testing the playbook: `pr.machine` and `machine-test`

Two tiers, as most Ansible projects test. **`pr.machine`**, the required
check, runs on every pull request that touches the playbook, k3s's
settings or their tools, in a couple of minutes: the tools' tests, the
policy's rules, shellcheck, the playbooks' syntax and ansible-lint.

**`machine-test`** runs the playbook itself, on a pull request labelled
`machine` (and on each push while the label stays), or by hand: on a fresh
`ubuntu-26.04` runner, the machine's own system, as root, twice, and **the
second run must change nothing**. Then `verify.yaml` checks the runner as
the machine would be checked: the firewall, the hardening, k3s, and Flux
following the **real** `prod`, its signature verified; then Lynis and
kube-bench. Label a pull request `machine` before merging any change to a
role. What a runner cannot do is left out: the join (no tailnet),
OpenSSH's removal, and the accounts check (the runner has its own user);
the cluster's credential is made up. The runner's image holds tens of
gigabytes of toolchains the machine does not have: they are left out of
the searches of the disk, and the runner gets no AIDE record, which would
take more than ten minutes to make there. The tool is built before the
first run: after it, the runner's `/tmp` holds nothing to run.

### Changing it

- **Tailscale's client for the runners**: `go run ./tools/machine -pin
  <version>` reads the new digests from Tailscale's site and rewrites
  `tools/internal/pinned`. Any client from 1.94 on joins with a federated
  identity. The machine's own client updates itself every day.
- **The cluster's credential**: [infra/MANUAL-STEPS.md](../infra/MANUAL-STEPS.md),
  "Rotating the cluster's credential".
- **A Lynis warning** the machine should keep: a line in
  `infra/ansible/lynis-accepted.txt`, the warning's ID and why. One that
  comes of the runner's image alone goes in `lynis-accepted-runner.txt`,
  which only `machine-test` reads.

## Online

Players reach the game at **https://play.keelovertheedge.com**, through
Cloudflare and a tunnel. The machine still has no open port: cloudflared,
in the cluster, dials out to Cloudflare, and Cloudflare sends `play.`'s
requests down that connection.

```
phone ──HTTPS──▶ Cloudflare's edge ──tunnel (cloudflared dialled out, 7844)──▶ cloudflared ×2
      (TLS, HSTS, WAF, the rate rule,                                         (namespace cloudflared)
       the cache for /assets/,                                                      │ HTTP, Host play.…
       CF-Connecting-IP written)                                                    ▼
                                         keel :8080 ◀── the limits per address ── Traefik :8000
                                            │                                    (kube-system)
                                            ▼
                                         keel-db :5432
```

What is made by hand, once (the Cloudflare token, the B2 key for the
state, the state's passphrase, the `gha-accounts` identity, the DS record),
is in [infra/MANUAL-STEPS.md](../infra/MANUAL-STEPS.md), sections 8 to 12;
and the backups' buckets and keys, in sections 13 and 14, which no
workflow ever makes or reads. Everything else outside the cluster is made
by the `accounts` workflow.

### `accounts`: OpenTofu, planned and applied as read

`infra/tofu` describes what lives at Cloudflare and what the cluster's
secrets are made from:

| File | What |
|------|------|
| `versions.tf`, `.terraform.lock.hcl` | OpenTofu `~> 1.13.0`; the Cloudflare, Infisical and random providers at exact versions, their hashes for Linux on amd64 and arm64 and the Mac |
| `backend.tf` | The state, in the B2 bucket, encrypted with a key made from the passphrase; a run without it fails rather than write plain state |
| `tunnel.tf` | The tunnel `keel-prod`, remotely managed: `play.keelovertheedge.com` → `http://traefik.kube-system.svc.cluster.local:80`, anything else 404. Its token, written into Infisical |
| `dns.tf` | `play` (proxied, to the tunnel); DNSSEC; CAA for Universal SSL's authorities; a null MX, SPF and DMARC refusing all mail in the domain's name |
| `zone.tf` | TLS strict, HTTPS always, TLS 1.2 at least, no 0-RTT, WebSockets; HSTS; nothing that rewrites the page or answers in its place; no bot or AI-crawler blocking |
| `rules.tf` | `/assets/` cached as the game says; methods other than GET, HEAD and POST blocked; `POST /guest` at most 10 in 10 s per address; no script of Cloudflare's added to the page (its Web Analytics beacon, Zaraz) |
| `secrets.tf` | The database's password: ephemeral, written into Infisical write-only, in no plan or state |
| `notifications.tf` | An e-mail to the owner when the tunnel's health changes |

**Actions → accounts → Run workflow**, `mode`:

| Mode | What |
|------|------|
| `plan` | One job, approved: what `apply` would change. Changes nothing |
| `apply` | The same plan job, approved; then an `apply` job, **approved again once you have read the plan's summary**, applies that plan and nothing else |

Each job signs in to Infisical as `gha-accounts` with its own OIDC token
(only `accounts.yaml` on `main`, in `production`, may), reads
`keel-accounts`/`prod`/`/accounts` (the Cloudflare token, the B2 key, the
passphrase, the owner's address), masks each, and hands them to OpenTofu in
its environment alone. Infisical's provider signs in by itself, with a
second token. The plan travels to the apply job as an artifact of the run,
kept one day, encrypted with the state's key; the apply job refuses one
that names another run or commit, or whose digest is not the one recorded.
OpenTofu itself refuses a plan made against an older state. There is no
schedule: every run reads the state, which holds the tunnel's token.

**Reading the summary.** It lists each resource that changes, its action
(create, update, replace, delete, read), and for an update or a replacement
the names of the attributes that change: never a value. Everything OpenTofu
prints is kept from the log; when it fails, what it said on its standard
error is shown with every IP address replaced by `<address>` (the tunnel's
state holds the machine's address). What a value is, Cloudflare's dashboard
and Infisical show. A second plan after an apply shows "no changes".

Offline, on any computer, and as `pr.accounts` does on every pull request
that touches it:

```sh
go run ./tools/accounts -check   # fmt, init without the backend, validate, the lock file for every platform
go run ./tools/accounts -lock    # write .terraform.lock.hcl again, after changing a provider
```

### Where each secret lives

| Secret | Made by | Kept in | Read by | In OpenTofu's state |
|---|---|---|---|---|
| Cloudflare's API token | The owner | `keel-accounts` `/accounts` | `accounts` | No |
| The B2 key for the state | The owner | `keel-accounts` `/accounts` | `accounts` | No |
| The state's passphrase | The owner | `keel-accounts` `/accounts`, and the password manager | `accounts` | No |
| External Secrets' credential | The owner | `keel-ops` `/machine` | `machine`, which puts it in `external-secrets/infisical-universal-auth` | No |
| The tunnel's secret and token | Cloudflare, for OpenTofu | `keel-cluster` `/cloudflared/TUNNEL_TOKEN` | External Secrets → `cloudflared/tunnel-token` | Yes, encrypted |
| The database's password | OpenTofu, ephemeral | `keel-cluster` `/keel/DB_PASSWORD` | External Secrets → `keel/keel-db-app` | No |
| The password of `reader` | OpenTofu, ephemeral | `keel-cluster` `/keel/DB_READER_PASSWORD` | External Secrets → `keel/keel-db-reader`; the owner, for `psql` | No |
| The password of `grafana`, the database's role | OpenTofu, ephemeral | `keel-cluster` `/keel/DB_GRAFANA_PASSWORD` and `/monitoring/DB_GRAFANA_PASSWORD`, the same value | External Secrets → `keel/keel-db-grafana` and `monitoring/grafana-db` | No |
| Grafana's admin password | OpenTofu, ephemeral | `keel-cluster` `/monitoring/GRAFANA_ADMIN_PASSWORD` | External Secrets → `monitoring/grafana-admin`; the owner, to sign in | No |
| The B2 key that writes the backups | The owner | `keel-backups` `/keel/B2_BARMAN_KEY_ID`, `…_KEY` | External Secrets → `keel/keel-b2` | No |
| The B2 key that writes the dumps | The owner | `keel-backups` `/keel/B2_DUMPS_KEY_ID`, `…_KEY` | External Secrets → `keel/keel-dumps` | No |
| The B2 key that reads the backups | The owner | `keel-backups` `/keel-restore/B2_RESTORE_KEY_ID`, `…_KEY` | External Secrets → `keel-restore/keel-b2-read` | No |
| The local bucket's B2 key | The owner | `keel-backups` `/local/B2_KEY_ID`, `…_KEY`; copied to `.dev/backups.env` | `tools/cluster`, on the owner's Mac | No |

The backups' keys are in a project of their own because the `accounts`
workflow's identity may read `keel-cluster`'s values, and a project is the
only fence Infisical's free plan has: no workflow's identity is a member
of `keel-backups`, so no workflow can read, replace or delete a backup.

### External Secrets

Its controller alone (no admission webhook, no certificate controller)
runs on both clusters; on the local one it has no store and reads nothing,
and is there so its definitions are what the manifests are checked
against. Production's `configs` layer holds two stores, both signed in to
Infisical's API at `infisical.host` as `eso-prod`, with the credential the
machine workflow placed. The `ClusterSecretStore` **`infisical`** reads
`keel-cluster`'s `prod` environment (by the slug `infisical.cluster.slug`);
its conditions let only `keel`, `cloudflared` and `monitoring` use it.
**`infisical-backups`** reads `keel-backups` (`infisical.backups.slug`),
and only `keel` and `keel-restore` may use it. A test keeps each manifest
and `infra/production.yaml` the same, and a rule holds every
`ExternalSecret` to a store whose conditions name its namespace, and each
store's conditions to exactly the namespaces that use it. Every
`ExternalSecret` refreshes hourly.

```sh
kubectl get clustersecretstore                    # both Ready, Valid
kubectl get externalsecret -A                     # each SecretSynced
```

### cloudflared

Two replicas of Cloudflare's image, pinned by digest, `restricted`, no
service account token, a rolling update one at a time. Each holds four
connections to Cloudflare's edge, in two data centres. `/ready` on port 2000
answers once a connection is up: not ready, a replica is left out; not
ready for a minute, it is restarted. It is in the `apps` layer, which
nothing waits for: a Cloudflare outage shows as `apps` not ready, and
holds nothing back.

### What may talk to what

k3s's network policy controller enforces the NetworkPolicies. Every
namespace the manifests hold refuses what is not let in; the kubelet's
probes and the API server's calls to webhooks come from the node, which is
always let in.

| To | From |
|----|------|
| keel, 8080 | Traefik |
| keel, 9091 (the metrics alone) | the scraper |
| keel-db, 5432 | keel; CloudNativePG's operator (and 8000); its own instances; the dump's job; Grafana |
| keel-db, 9187 (its metrics) | the scraper |
| the restore test's database, 5432 | the restore test's job; CloudNativePG's operator (and 8000) |
| Traefik, 8000 | cloudflared; kube-system itself (ServiceLB, locally) |
| CoreDNS, 53 | every namespace |
| the Barman Cloud plugin, 9090 | CloudNativePG's operator |
| the metrics store, 8428 | the scraper, vmalert, Grafana, Kured (whether an alert fires) |
| the logs store, 9428 | vlagent, Grafana, the scraper |
| vmalert, 8080 | the metrics store (its rules, shown by its UI and Grafana), the scraper |
| Alertmanager, 9093 | vmalert, Grafana, the scraper |
| every metrics port a scrape names | the scraper, and nothing else outside the monitoring namespaces |
| cnpg-system, external-secrets, cert-manager, monitoring: anything else | nothing |

The owner's forwards ([Monitoring](#monitoring)) arrive from the node, as
the kubelet's probes do, so no policy names them; and node-exporter is on
the host's network, where no policy applies and the machine's firewall
does. A rule fails a scrape whose port no policy lets the scraper in to,
and a policy that lets anything else in to a metrics port.

Out, the pods that face the internet or hold a key are fenced, as none
calls the Kubernetes API (whose address, seen by a policy, is the
machine's public one): **keel** reaches DNS and its database alone;
**cloudflared** DNS, Cloudflare on TCP and UDP 7844 (anywhere but the
cluster's ranges), and Traefik's 8000; **the dump's job** DNS, the
database, and HTTPS outside the cluster's ranges, for B2. The monitoring
pods are not: the operator's configuration reloaders beside vmalert, the
scraper and Alertmanager watch their Secrets through the API. A new pod's first connections can be refused for a
moment while the controller lets its address in; `keel migrate` waits for
the database for up to a minute rather than fail.

### The limits per address

Two Traefik middlewares in `keel`, keyed on `CF-Connecting-IP`, the
address Cloudflare saw: **`per-address-rate`**, 50 requests a second with a
burst of 100, on every route but the game connection; and
**`per-address-connections`**, 200 requests open at once, on `/ws` (a game
connection is one for as long as it is open). Over either, Traefik answers
429. Only cloudflared reaches Traefik, and a player cannot choose the
header: Cloudflare refuses a request that carries its own
`CF-Connecting-IP` (403, error 1000) before it reaches the tunnel, and
writes the header itself on every other. On the local cluster nothing
writes the header, so every request counts as one address's: the amounts
there are 2000, 4000 and 4096, for the load bot's hundreds of boats.

### Checking it from outside

```sh
go run ./tools/online                                   # every check; the game connection held 10 minutes
go run ./tools/online -hold 0                           # without the long one
go run ./tools/online -page client/dist/index.html      # and the page's bytes against the build's
```

It changes nothing but one guest it makes, named `Zz Online …`: HSTS; the
asset cached at the edge and the page not; nothing injected into the page,
asked for as a browser asks;
`/api/version` naming the build `prod` holds; HEAD; a PUT blocked by
Cloudflare; `/ws` refusing a request without a session, and one from
another origin; 160 requests at once from one address meeting Traefik's
429, and the same with a different forged `CF-Connecting-IP` on each
refused by Cloudflare or meeting the 429 again; another
host refused; a game connection open for ten minutes, past Cloudflare's
100-second idle limit and Traefik's 60-second read timeout.

### When something outside is down

- **Cloudflare**: players cannot reach the game; the game and its world
  run on. Cloudflare's tunnel alert e-mails the owner. Nothing to do but
  wait; the owner reaches the machine over the tailnet as always.
- **The tunnel** (cloudflared not connected): `kubectl -n cloudflared
  logs deploy/cloudflared`. A token refused means the tunnel was replaced
  without the secret's version being raised (below).
- **Infisical**: nothing running changes; Secrets once made stay. A new
  machine, or a deleted Secret, waits until Infisical is back. `accounts`
  cannot run.
- **B2**: `accounts` cannot read its state, and stops before changing
  anything. The database keeps the WAL it cannot archive on its own disk
  and sends it when B2 is back; `WALArchivingFailing` fires after ten
  minutes, and `DiskHigh` if it lasts long enough to matter. The dump and
  the restore test fail that week, and say so.

### Rotating

- **Cloudflare's token, the B2 key, the passphrase**: infra/MANUAL-STEPS.md,
  section 12.
- **The database's password**: raise `value_wo_version` in
  `infra/tofu/secrets.tf` and run `accounts` with `apply`: a new password
  is written into Infisical, and External Secrets puts it in `keel-db-app`
  within the hour. PostgreSQL still has the old one: CloudNativePG uses the
  Secret to make the database, and for a role it manages; check how the
  operator's version handles a changed `initdb` Secret before doing this,
  and if it does not, set the new one in PostgreSQL (`ALTER ROLE keel
  PASSWORD …`, from `kubectl exec keel-db-1 -c postgres -- psql`) between
  the apply and the refresh, then restart the game. Not done casually.
- **The read-only roles' passwords, and Grafana's admin password**: raise
  that secret's `value_wo_version` in `infra/tofu/secrets.tf` and run
  `accounts` with `apply`. External Secrets brings the new value within
  the hour; CloudNativePG sets a managed role's password from its Secret
  by itself. Grafana reads its passwords when it starts: `kubectl -n
  monitoring rollout restart deploy/grafana`.
- **The backups' keys**: infra/MANUAL-STEPS.md, section 14.
- **The tunnel**: raise `tunnel_generation` in `infra/tofu/tunnel.tf` and
  run `accounts` with `apply`: the plan replaces the tunnel (a new ID, a new
  `play` record, a new token) and writes the new token into Infisical.
  External Secrets brings it to `cloudflared/tunnel-token` within the hour,
  or at once with `kubectl -n cloudflared annotate externalsecret
  tunnel-token force-sync=$(date +%s) --overwrite`; then `kubectl -n
  cloudflared rollout restart deploy/cloudflared`. About a minute without
  the game.

## Restarts and deploys

A restart of `keel serve` (a new build, a restart by hand, a pod deleted, a
crash) is a pause, not a reset: the players come back to their own boats,
where they were.

**One simulation.** Before it reads the world, `keel serve` takes the
**simulation's lease**: a session-level advisory lock (key 1866618722),
held on a connection of its own for the process's life, and the row
`sim_lease`, whose `epoch` each new holder raises by one. While another
process holds it, a new one waits, asking every 500 ms, live and not
ready. Every transaction that writes the world first reads the epoch `FOR
SHARE` and gives up if it is not its own (a *fencing token*), so a process
that lost the lease without knowing, paused or cut off, changes nothing
lasting; and the next holder's raise waits for any such transaction still
open. The holder checks its connection every second: lost, the world sails
on while it takes the lock back, for up to 10 s. Taken back with the epoch
unchanged, it carries on; if the epoch moved, or the time ran out, it stops
at once, with no bell and no final checkpoint, and exits 1. A process that
dies frees the lock as its socket closes; one that vanished without closing
it (a frozen machine) frees it when the database's keepalives give up,
about 25 s. To see who holds it:

```sh
psql … -c 'SELECT * FROM sim_lease'
psql … -c "SELECT pid, backend_start FROM pg_stat_activity WHERE application_name = 'keel sim lease'"
```

**Checkpoints.** The world's writer (`internal/persist`) records, from each
tick, the boats launched (joined, or given a boat from the queue), returned
and expired, into the table `event`, within about 200 ms; and every 300
ticks (10 s) a **checkpoint** of the whole world, the simulation's snapshot
(its format, the build, catalog and physics layout beside it), into
`checkpoint`, one row a world, replaced. Neither makes the tick wait: the
tick hands copies and held frames to an inbox of 300 items, and the writer
encodes, batches and writes them in one fenced transaction every 200 ms,
trying again from 0.5 s to 5 s when the database fails, dropping nothing.
Half full, it holds admission (the `Hold` command, in the input log like
any other, so replays agree): newcomers wait in the queue. Below a
quarter, it lets go. Full, the process stops, after a final checkpoint, and
exits 1.

A new process restores the checkpoint if its format, catalog and physics
layout are this build's and it is younger than the grace (60 s of world
time). World time resumes at the present: the boats are where they were,
none connected; each boat still sailed when the checkpoint was taken
begins its grace, and a grace already running keeps its end. A player who
comes back within it gets their boat (`rejoined`); the queue is kept too,
each place for the grace. Otherwise the world starts empty, and
`keel_sim_restores_total` and the log say why.

**The bell.** On `SIGTERM`, `keel serve`:

1. is no longer ready; the public listeners stop taking requests, beside
   the rest (at most 10 s);
2. sends every game connection `Restart` (the page shows "The harbourmaster
   rings the bell: the harbour closes for a moment. Your boat will wait for
   you.", and keeps it until the boat is back);
3. lets the world sail on for `KEEL_BELL` (3 s), so phones see it;
4. stops the scripted sailors, then the loop, after its tick;
5. writes the final checkpoint, of that last frame, and every event left
   (at most 5 s);
6. closes every game connection with 1012 (at most 3 s; a peer that has not
   answered is dropped);
7. stops the encoder, the input log and the flight recorder, closes the
   writer's pool, releases the lease, closes the main pool, and shuts the
   internal listener down.

The page waits 0.5 to 5 s and connects again. With `Recreate` the new pod
starts once the old has gone, restores the checkpoint and is ready within
seconds.

**What a restart keeps and loses.** Kept: every boat, its state, controls
and grace, the queue, a developer's weather, boat IDs. Lost: the connections, which the
pages make again; a crash (`SIGKILL`, a panic) also loses up to 10 s of the
world (the last checkpoint is restored) and the last ~200 ms of events. A
change to the snapshot's format, the catalog or the physics layout makes
the deploy that carries it a reset, as does a rollback across one. The
input log stays in memory; the new process's begins with the restored
world.

On the local cluster, each way a pod can end is one command, and the load
bot reports what it did:

```sh
go run ./tools/cluster -deploy    # a new build: the bell, then the new pod
go run ./tools/cluster -restart   # the same build again (kubectl rollout restart)
go run ./tools/cluster -kill      # the pod deleted by force: its replacement waits for the lease
go run ./tools/cluster -crash     # SIGKILL to keel in its container: no bell, the last periodic checkpoint
go run ./tools/loadbot -n 200 -url https://macbook.local -ca "$(go tool mkcert -CAROOT)/rootCA.pem" -metrics "" -for 3m
```

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
One pool, at most 17 connections, serves the API and starting up; the
world's writer has a pool of its own of 2, and the simulation's lease a
connection of its own (`application_name` `keel sim lease`): 20 in all.
Each query is timed by its sqlc name.

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

### Production's database: roles, access and what it records

Three roles log in. **`keel`** owns the database; the game and its
migrations use it, and its password never leaves the namespace `keel`.
**`reader`** is for the owner and **`grafana`** for Grafana (at most five
connections): each is a member of `pg_read_all_data` and `pg_monitor`,
PostgreSQL's own roles that read every table and every statistic and
write nothing. CloudNativePG makes and keeps both, with the passwords
OpenTofu wrote into Infisical. The superuser, `postgres`, has no password
and no way in over the network.

**To look**, open the forwards ([Monitoring](#monitoring)); the database
is on `localhost:15432`. It accepts TLS alone, and its certificate is the
cluster's own, so fetch its CA once (it changes only when the database is
rebuilt), and take `reader`'s password from Infisical (`keel-cluster`,
`/keel/DB_READER_PASSWORD`):

```sh
tailscale ssh root@keel-prod-1 k3s kubectl -n keel get secret keel-db-ca -o 'jsonpath={.data.ca\.crt}' | base64 -d > keel-db-ca.crt
psql "host=localhost port=15432 dbname=keel user=reader sslmode=verify-ca sslrootcert=keel-db-ca.crt"
```

`verify-ca`, not `verify-full`: through a forward the name is `localhost`,
which the certificate does not carry; the CA is still checked. In Grafana,
**Explore** with the data source **Database** runs SQL as `grafana`.

**What it records.** `pg_stat_statements` counts every statement by its
shape, with its time, rows and blocks: `SELECT … FROM pg_stat_statements
ORDER BY total_exec_time DESC`, or the Database dashboard's table. A
statement slower than 250 ms is logged, and `auto_explain` logs its plan
beside it; both reach VictoriaLogs, and the Database dashboard lists them.
Bound values are never logged (`log_parameter_max_length = 0`,
`auto_explain.log_parameter_max_length = 0`): a player's name or token
never reaches a log. CloudNativePG's exporter (port 9187) gives the
metrics, with three queries of the game's own
(`infra/cluster/apps/keel/database-monitoring.yaml`): each table's size,
rows and vacuum; the blocks read and written; and the locks waited for.

**To change something by hand** (break-glass: a stuck migration, a role's
password, a query to cancel), there is one way in, as `postgres` over the
pod's own socket, from the machine:

```sh
tailscale ssh root@keel-prod-1
k3s kubectl -n keel exec -it keel-db-1 -c postgres -- psql keel
```

Whoever can do that is root on the machine already. Say in the next
commit, or the pull request that follows, what was changed and why: the
journal records the session, not the statements.

## Backups

Production's database is copied off the machine three ways, and one of
them is restored every week to prove it works.

```
keel-db ──WAL, each segment or every 5 min──▶ the plugin's sidecar ──▶ B2 keel-db-backups/keel-db-g1
        ──a base backup, daily 20:00 UTC────▶        (key keel-barman)      (locked 14 days, kept 30)
        ──pg_dump, Mondays 21:00 UTC──▶ the dump's job ──(key keel-dumps, no delete)──▶ B2 keel-db-dumps/prod/
keel restore-test, Tuesdays 21:00 UTC ──(key keel-restore, read-only)──▶ a database of its own, checked, deleted
```

**The archive.** CloudNativePG's Barman Cloud plugin runs beside
PostgreSQL in `keel-db-1` and sends every WAL segment as it fills, or
after five minutes (`archive_timeout`, CloudNativePG's default): what a
lost machine loses is at most the last five minutes. A base backup is
taken daily, and at once when the database is first made. Both are
gzipped. Barman keeps what a restore to any moment of the last 30 days
needs, and removes the rest. The `ObjectStore` `keel-b2`
(`infra/cluster/apps/keel/object-store.yaml`) says where; the bucket, its
endpoint and region are `infra/production.yaml`'s, and a test keeps the
two the same.

```sh
kubectl -n keel get backups.postgresql.cnpg.io         # each base backup, and whether it completed
kubectl -n keel get cluster keel-db -o jsonpath='{.status.conditions}'   # ContinuousArchiving
kubectl -n keel logs keel-db-1 -c plugin-barman-cloud  # the archiver
```

A base backup by hand, before anything risky:

```sh
kubectl apply -f - <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: keel-db-by-hand
  namespace: keel
spec:
  cluster:
    name: keel-db
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
EOF
```

Make one that way too when the plugin is first added to a database that
already runs: the backup made "at once" is asked for before the pod has
its sidecar, fails with `requested plugin is not available`, and is not
tried again until the daily one.

**A change to the sidecar's environment** (the `ObjectStore`'s
`instanceSidecarConfiguration.env`) reaches the sidecar only when the
database's pod is made again. The plugin sets it when the pod is made,
and a changed `ObjectStore` restarts nothing: after the release, the old
sidecar runs on as it was. On the machine, once the release is applied:

```sh
k3s kubectl -n keel delete pod keel-db-1
```

CloudNativePG makes the pod again on the same volume, with the new
environment. The database is away for about half a minute (23 s on the
local cluster) and keel restarts once, as in a deploy. WAL that was
waiting in `pg_wal` is sent by itself afterwards. Check what the sidecar
runs with:

```sh
kubectl -n keel get pod keel-db-1 -o jsonpath='{range .spec.initContainers[?(@.name=="plugin-barman-cloud")].env[*]}{.name}={.value}{"\n"}{end}'
```

**Generations.** CloudNativePG refuses to archive into a folder that
already holds another database's WAL, so each database ever made writes
under a name of its own in the bucket: `keel-db-g1`, then `keel-db-g2`
for the database a rebuild recovers from `g1`, and so on.
`infra/cluster/apps/keel/generation.yaml` holds the two names, `live` and
`rebuilt`, and is the only place they are written: a component copies
`live` into the database's plugin and the restore test, and the rebuild
form recovers from `live` and archives as `rebuilt`. After a rebuild, a
commit moves both on by one ([infra/REBUILD.md](../infra/REBUILD.md)).
From that commit's release on, the rebuild form describes the next
rebuild, not the database the last one made, which Flux follows it for
until the machine workflow moves it back: so in the rebuild form Flux
applies the database and its restore test only while they are not there
(`kustomize.toolkit.fluxcd.io/ssa: IfNotPresent`), and a running
database's archive is never renamed under it. A rule holds each form to
its names, the restore test to the archive its database writes, and that
annotation to those two objects in that form alone.

**The keys.** Three B2 keys, each for one bucket: one writes and deletes
the backups (`keel/keel-b2`), one only reads them
(`keel-restore/keel-b2-read`), one writes dumps and cannot delete
(`keel/keel-dumps`). The backups' bucket and the dumps' hold every file
for 14 days whatever a key asks (Object Lock, governance mode): a stolen
key cannot destroy the last fortnight. The buckets and keys are made by
hand and kept in an Infisical project no workflow can read
([infra/MANUAL-STEPS.md](../infra/MANUAL-STEPS.md), sections 13 and 14).

**The dump.** `keel-db-dump`, a CronJob in `keel`: `pg_dump` in its custom
format, from the database's own image, so of its own version; `pg_restore
--list` to prove the file reads; then rclone copies it to
`keel-db-dumps/prod/<date>.dump`. B2's lifecycle hides a dump after 56
days. It depends on no WAL and no Barman: it restores into any
PostgreSQL 18 with `pg_restore --dbname=…`. Its last line says its size
and time.

```sh
kubectl -n keel create job --from=cronjob/keel-db-dump keel-db-dump-by-hand
kubectl -n keel logs job/keel-db-dump-by-hand --all-containers
```

**The restore test.** `keel-restore-test`, a CronJob in a namespace of its
own, runs `keel restore-test`: through the Kubernetes API, as a service
account that may make, read and delete databases there, read the one
password, and nothing else,
it makes `keel-restore-check`, one instance recovered from the live
archive with the read-only key and with no archiver of its own, so it can
never write into what it reads; waits for it, up to 45 minutes; and
checks, as the role CloudNativePG made for it, that the schema is at
least this build's, every table of the migrations exists, the world, its
lease and its checkpoint are there, and the newest checkpoint is younger
than 24 hours. Then it deletes the database, and exits 0, or 1 with the
reason. Its one line, `restore test`, has the result and the times:

```
{"level":"INFO","msg":"restore test","result":"passed","source":"keel-db-g1","made_s":2,"recovered_s":212,"checked_s":1,"total_s":221,"schema":3,"rows":{…},"checkpoint_age_s":340,"event_age_s":5200}
```

The Backups dashboard shows the last of them, and `RestoreTestFailed` and
`RestoreTestStale` fire on its Job. To run it now:

```sh
kubectl -n keel-restore create job --from=cronjob/keel-restore-test keel-restore-test-by-hand
kubectl -n keel-restore logs -f job/keel-restore-test-by-hand
```

**Restoring to a moment.** To read the data as it was (a player's boat
before a bug, a table before a bad migration), recover a second database
beside the live one, to that time, with the read-only key: the live
database is never touched, and what is needed is copied across by hand.
On the machine, or through the API's forward:

```sh
kubectl apply -f - <<'EOF'
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: keel-restore-check
  namespace: keel-restore
spec:
  instances: 1
  imageName: <keel-db's own: kubectl -n keel get cluster keel-db -o jsonpath='{.spec.imageName}'>
  enablePDB: false
  storage:
    storageClass: local-path
    size: 40Gi
  postgresql:
    parameters:
      max_connections: "<keel-db's own>"
  bootstrap:
    recovery:
      source: origin
      database: keel
      owner: keel
      recoveryTarget:
        targetTime: "2026-11-03 14:25:00+00"
  externalClusters:
    - name: origin
      plugin:
        name: barman-cloud.cloudnative-pg.io
        parameters:
          barmanObjectName: keel-b2-read
          serverName: keel-db-g1
EOF
kubectl -n keel-restore exec -it keel-restore-check-1 -c postgres -- psql keel
kubectl -n keel-restore delete cluster keel-restore-check     # when done
```

It has no `plugins` entry, so it archives nowhere. Its name is the
restore test's own: the namespace's NetworkPolicy lets CloudNativePG's
operator reach a database of that name alone, and the weekly test removes
whatever has it when it starts, so not on a Tuesday evening. Its disk is
the machine's: look at the Machine dashboard's free space first, and
delete it when done. To put the whole game back to a moment is a rebuild
with that `recoveryTarget` added to the rebuild form: a decision, and a
pull request, not a command.

**The local cluster** archives to a bucket of its own,
`keel-db-backups-local`, with a key of its own, when `.dev/backups.env`
holds it; its dump goes to rclone's memory and is thrown away.
`go run ./tools/cluster -deploy -rebuild` makes a deleted database again
from that archive, as production's rebuild does.

## Monitoring

The cluster watches itself, and the owner looks in over the tailnet.
Nothing here has a route, a login page on the internet, or a notification
going anywhere yet: the alerts are on the Overview dashboard, for whoever
opens it.

```
keel :9091 ─┐                                    ┌─▶ vmalert ──▶ Alertmanager
keel-db ────┤                                    │        (the rules)   (alerts, silences)
node-exporter (the machine, its facts) ──▶ vmagent ──▶ VictoriaMetrics, 90 days
kubelet, API server, Traefik, cloudflared,  │                    ▲
the operators, Flux ────────────────────────┘                    │
pods' logs ──▶ vlagent ──▶ VictoriaLogs, 14 days or 20 GiB ◀── Grafana (keeps nothing itself)
the machine's journal ──systemd-journal-upload──▶ ┘              │ SQL as grafana ──▶ keel-db
                                                   the owner's Mac ──tailscale ssh -L──▶ ┘
```

Everything is VictoriaMetrics' operator's custom resources, from two
charts (the operator in `controllers`; the stack in the `monitoring`
layer), in the namespace `monitoring`, `restricted`. node-exporter and
vlagent, which read the host, are in `monitoring-node`, `privileged`, and
hold nothing else. Grafana has no disk and no database: its data sources,
dashboards and plugin come from the manifests, so anything changed in its
pages is gone at its next restart, and a change that should stay is a
commit.

### Opening it

```sh
go run ./tools/ops -tunnel
```

One Tailscale SSH session to the machine, as root, forwarding these to
the Mac's loopback until interrupted. Each is a Service with an address
chosen by hand in the cluster, so the command never has to ask for it;
nothing listens for them on the machine itself, and a rule keeps the
manifests and the list the same.

| On the Mac | What |
|---|---|
| http://localhost:3000 | Grafana: `admin`, with the password in Infisical (`keel-cluster`, `/monitoring/GRAFANA_ADMIN_PASSWORD`) |
| http://localhost:8428 | VictoriaMetrics' own page (vmui), with vmalert's rules and alerts under `/vmalert` |
| http://localhost:9428 | VictoriaLogs' own page |
| localhost:15432 | the database, for `psql` as `reader` ([The database](#the-database)) |
| localhost:9090 | keel's internal listener: `go tool pprof http://localhost:9090/debug/pprof/profile`, the flight recorder, the input log |

`-tunnel -print` prints the command and runs nothing.

### The dashboards

In the folder **Keel**, written for this game (`infra/cluster/monitoring/dashboards/keel/`):

| Dashboard | What it answers |
|---|---|
| Overview | Is anything wrong? What fires, how severe, and when each alert fired in the last day; boats, connections and the tick; the database, and the last WAL, base backup, dump and restore test; the machine's CPU, steal, memory and disk, a pending reboot or update; Flux; scrape targets down |
| Game | How the simulation does: the tick and its phases, ticks late and skipped, boats, connections, joins and closes, the queue's wait, bytes a player a second, phones' round trip and frame time, persistence's oldest unwritten change and inbox, checkpoints, the lease, keel's CPU, throttling and memory, restarts and restores, its warnings and errors |
| Machine | The VM: CPU by mode, pressure, memory, the clock; the root filesystem, what grows on it and when it would be full; disk latency; the network and the month's transfer at today's rate; its upkeep (a reboot required, updates waiting, AIDE, the units, auditd's log); the journal's warnings; each pod against what it asked for |
| Database | PostgreSQL: connections, transactions, locks, the oldest transaction; tables, dead rows and vacuums; WAL, checkpoints and I/O; keel's pool and its queries' times; the statements that cost the most, and the slow ones with their plans |
| Backups | How far back a restore can go: the last WAL archived, segments archived and failed, WAL waiting on the machine, WAL written a day, the base backups, the dump's and the restore test's runs and results, the archiver's log |
| Edge | What players meet: the tunnel's connections, Traefik's requests by route and responses by code, the limits' 429s, open connections, request times, cloudflared's log, keel's refusals |

And other projects' own, kept as published and pinned
(`dashboards/index.yaml` names each one's repository, commit and
SHA-256): **Machine** (Node Exporter Full), **Kubernetes** (four views),
**Database** (CloudNativePG's), **Monitoring** (VictoriaMetrics, vmagent,
vmalert, the operator, VictoriaLogs). `go run ./tools/dashboards -check`,
in the tests, holds each of the others' files to its record, and every
dashboard to a title, an identifier of its own, and data sources that
exist.

To change one of the game's: edit it in Grafana, **Export → Export as
JSON**, and replace the file; the local cluster shows it after `go run
./tools/cluster -monitoring`.

### The logs

Every container's output and the machine's journal are in VictoriaLogs,
for 14 days or 20 GiB, whichever comes first. JSON lines are parsed: keel's
fields (`level`, `msg`, `build`, a request's `status` and `path`) are
fields there. In Grafana's **Explore**, data source **VictoriaLogs**, or
on its own page, in LogsQL:

```
kubernetes.pod_namespace:keel kubernetes.container_name:keel level:in(WARN, ERROR)
kubernetes.pod_namespace:keel kubernetes.container_name:keel status:>=500
kubernetes.pod_namespace:keel kubernetes.container_name:postgres "duration:"
kubernetes.pod_namespace:keel kubernetes.container_name:plugin-barman-cloud
kubernetes.pod_namespace:keel-restore "restore test"
kubernetes.pod_namespace:cloudflared
_SYSTEMD_UNIT:k3s.service
_SYSTEMD_UNIT:* level:in(emerg, alert, crit, err, error, warning)
_SYSTEMD_UNIT:tailscaled.service "ssh"
```

Add `| stats by (kubernetes.container_name) count()` to count, or pick a
time on the panel.

### The alerts

vmalert evaluates the rules and sends what fires to Alertmanager, which
sends it nowhere: **Overview** lists what fires, with its severity and
what it says, and Grafana's **Alerting → Alert rules** shows every rule
and its state. `Watchdog` always fires; if it is missing, the alerting
itself is down. The rules are beside what they watch
(`infra/cluster/apps/keel/rules.yaml`, `apps/cloudflared/monitoring.yaml`,
`monitoring/rules/`), and each has a test
(`infra/cluster/monitoring/rules/tests/`, run by `go test
./tools/internal/manifests -run TestAlertRules` with VictoriaMetrics'
`vmalert-tool`) that makes it fire and makes it stay quiet.

| Alert | Fires when | What to do |
|---|---|---|
| **GameDown** (critical) | keel has no ready pod for 2 minutes | Its pod and logs; then the database |
| **TickOverrun** (critical) | the tick's 99th percentile is over 25 ms for 5 minutes | Game: which phase grew. Machine: steal, throttling |
| **PersistenceLag** (critical) | a change has waited over 10 s to be written | The database: is it up, is the disk slow |
| **DatabaseDown** (critical) | the database's exporter is gone for 2 minutes | `keel-db-1`'s pod and logs, and CloudNativePG's |
| **WALArchivingFailing** (critical) | a segment failed to archive and none succeeded since, or none was archived for 15 minutes; for 10 minutes | The sidecar's log (`plugin-barman-cloud`); B2's status; the key |
| **DiskFull** (critical) | the disk is over 90% full, or on course to fill within a day | Machine: which volume grows. The database stops when it is full |
| **TunnelDown** (critical) | no cloudflared replica holds a connection for 2 minutes | cloudflared's pods and logs; Cloudflare's dashboard |
| QueueWaiting | players have waited for a boat for 10 minutes | The tick's time, before raising `KEEL_BOAT_LIMIT` |
| MemoryNearLimit | a container of keel or the database is over 90% of its limit | Its memory over days; raise the limit in a commit |
| CPUThrottled | keel is throttled in over a tenth of its CPU periods | Game: does the tick suffer |
| BackupStale | no base backup completed in 26 hours | `kubectl -n keel get backups.postgresql.cnpg.io`; the sidecar's log |
| DatabaseConnections | over 80% of `max_connections` are held | Database: who holds them |
| LongTransaction | a transaction is open for over 5 minutes | `pg_stat_activity`; cancel it if it is nobody's |
| TransactionIDAge | the oldest transaction ID is over a billion old | What keeps vacuum from freezing: a long transaction, a slot |
| DumpStale, DumpFailed | no dump in 8 days; a dump's Job failed | Its log; run it by hand once fixed |
| RestoreTestStale, RestoreTestFailed | no test passed in 8 days; a test's Job failed | Its `restore test` line says which check; run it by hand once fixed |
| DiskHigh | the disk is over 80% full | Machine: what grows |
| CPUSteal | over 10% of the CPU is stolen for 15 minutes | If it lasts, the provider |
| MemoryPressure | tasks wait for memory over 10% of the time | Machine: who uses it |
| TransferOnCourse | the month's transfer is on course past 80% of 16 TB | Game: bytes per player |
| ClockOffset | the clock is over 50 ms off | `chronyc tracking` on the machine |
| RebootPending | a reboot has been due for a week | `machine` with `apply` and **reboot** |
| UpdatesPending | security updates have waited 3 days | unattended-upgrades' log, in the journal |
| IntegrityChanged | AIDE found files changed | Its report in the journal; an update explains most |
| PodRestarting | a container restarted more than three times in 15 minutes | Its logs; `kubectl describe` |
| FluxNotReady | a Flux object is not ready for 15 minutes | `flux get all -A` |
| SecretNotSynced | an `ExternalSecret` is not synced for 15 minutes | Its conditions; Infisical |
| CertificateExpiring | a certificate expires within 14 days | cert-manager's `CertificateRequest` |

Each alert's own description, on the Overview and in Grafana, says the
same with the numbers of the moment.

**To silence one** (a known cause, being worked on): Grafana, **Alerting →
Silences**, choose the Alertmanager **Alertmanager**, **Add silence**, with
a matcher on `alertname` and an end. A critical alert that fires hides the
warnings it explains by itself (the game down hides its queue; the
database down hides its other alerts). A silence lasts until its end, or
until Alertmanager's pod is replaced: it has no volume.

**To send them somewhere** later is a receiver and a route in the stack's
values (`alertmanager.config`), its address or token an `ExternalSecret`
in `monitoring`, and a NetworkPolicy letting Alertmanager out. Until
then, `Watchdog` is what an outside check would listen for.

### What it costs

The requests and limits are in the stack's values
(`infra/cluster/monitoring/stack/release.yaml`), halved for the local
cluster. To keep the number of series small, the API server's histogram
buckets are dropped at the scrape, and the scheduler, controller manager,
etcd and kube-proxy, which k3s runs inside one process, are not scraped
apart. The **VictoriaMetrics - single-node** dashboard shows the active
series and what each scrape adds; VictoriaLogs' its disk.

## Reboots and upgrades

The machine installs its security updates every day by itself
(`unattended-upgrades`) and never reboots by itself. Two things in the
cluster finish the job, each in a two-hour window on a quiet evening, UTC,
on different days. Both are in production alone.

**Kured**, Wednesdays 20:00 to 22:00: when an update left
`/var/run/reboot-required`, and no alert fires but `Watchdog`,
`RebootPending` and `UpdatesPending`, it drains the node and reboots the
machine. It asks the metrics store, for the series `ALERTS` that vmalert
writes there; an answer it cannot get counts as an alert. The drain stops
keel as a deploy does, with its bell and its last checkpoint, and the
database after it. The game is away for about two minutes (2 min 9 s on
the local cluster, from the drain to keel ready), which is longer than a
checkpoint is good for (60 s, [Restarts and deploys](#restarts-and-deploys)):
unlike a deploy, a reboot starts the sea empty. Accounts and sailors are
untouched; players join again. A drain not done in ten minutes leaves the
machine up. `RebootPending` fires when a reboot has been due
for a week, so through a whole window; why is in Kured's log
(`kubernetes.pod_namespace:kured`). To reboot now: `machine`, `apply`,
**reboot** ticked. To hold reboots for a while (an event), remove the
day from `--reboot-days` in a commit
(`infra/cluster/infrastructure/controllers/kured/kustomization.yaml`).

**The system-upgrade controller**, Thursdays 20:00 to 22:00: a `Plan`
(`infra/cluster/clusters/prod/configs/upgrade-plan.yaml`) names the k3s
version, the same as `infra/k3s/release.yaml`'s, and the upgrade image by
digest; a test keeps them equal, and Renovate raises them together, a new
minor version only after a tick on its dashboard. When the release
production follows names a newer k3s than the machine runs, the
controller cordons the node, replaces k3s's binary and restarts it. The
node is not drained: k3s restarting leaves every container running, so
the game does not pause. The playbook's k3s role upgrades too, whenever
`machine apply` runs first.

```sh
kubectl -n system-upgrade get plans,jobs
kubectl get nodes -o wide          # the version it runs
```

Both need more than `restricted` allows (the host's process and mount
namespaces), so each has a namespace of its own, `privileged`, that holds
nothing else. Both come from their projects' release manifests, kept as
published ([Who signed it](#who-signed-it)).

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

At sea it is still the **offline sandbox**: one Jolly boat, stepped by the physics module in the page, in
weather it makes itself by the server's rules, with nothing to correct it.
It starts at the disk's centre, at rest, heading 090°, the helm centred and
the sheet half out, in a spell of the commonest regime (`trade`), drawn as
the server draws one; with `?wind`, `?sea` or `?test` it is in a steady
wind, 10 knots from the north unless told otherwise, so the tests of other
things and their pictures stay in one wind. The developer page is
`/dev.html`. Query strings:

| Query | What |
|-------|------|
| `?sandbox` | The offline sandbox alone: no server, no session, no start screen. The browser tests of the scene use it |
| `?wind=12,45` | The sandbox's wind, steady: knots 10 m up, and the degrees it comes from |
| `?weather=stormy` | The sandbox's weather: one of the catalog's regimes (`settled`, `trade`, `unsettled`, `stormy`), or `steady` |
| `?dev` | The developer panel (a lazy import, outside the first download); see below |
| `?backend=webgl2` | The WebGL 2 back end, even where WebGPU is offered |
| `?tier=low` | A tier held, `high`, `medium` or `low`, no better than the back end's; adaptive quality off (see [Tiers and adaptive quality](#tiers-and-adaptive-quality)) |
| `?compat` | A WebGPU device held to compatibility mode's limits |
| `?sea=gale` | The sandbox's wind by the sea it raises: `calm` (6 knots), `breeze` (12), `fresh` (20) or `gale` (34), from the north |
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
the true wind's arrow on the water upwind, the apparent wind's above the
masthead, and a dashed ring round each gust heading for the boat; **sail forces**: drive and side force at the sail's centre of
effort, and a clinometer), and the helm's release.

### The frame

| File | What |
|------|------|
| `client/src/game/cap.ts` | Draws on every n-th animation frame, n the smallest whole number that brings the display's measured rate (the median of the last 30 intervals) within the cap: 120 Hz draws at 60, 90 Hz at 45, 144 Hz at 48. Every drawn frame stays on screen for the same number of refreshes |
| `client/src/game/loop.ts`, `clock.ts` | Fixed steps of 1/30 s taken out of real time, at most four a frame (the rest of a stall is dropped); world time is steps ÷ 30 plus the fraction drawn |
| `client/src/predict/blend.ts` | The state before and after the latest step; the boat is drawn between them, the heading the short way round |
| `client/src/game/driver.ts`, `client/src/sandbox/` | The boat driver: controls in, states and `Out` to draw. The sandbox is the offline driver |
| `client/src/game/game.ts` | The frame: keys, steps, the pose, the instruments, the sound. Input events only move targets; the frame reads them. The frame allocates nothing |
| `client/src/render/camera.ts` | The chase camera: its yaw follows the heading through a critically damped spring (ω = 4 s⁻¹, 12 with reduced motion); it rises and falls with the boat's heave, over half a second, but not with its heel or pitch, and stays 1.6 m above the sea under the boat |
| `client/src/render/boat.ts`, `sailshape.ts`, `telltales.ts`, `pennant.ts`, `sailor.ts` | The boat from the physics: lifted by its heave, pitched and heeled about its centre of gravity; the boom, rudder and tiller; the sail's twist from `Out.Twist`, camber from `Out.Flattening`, rippling where a strip luffs; the telltales from each strip's flow (attached: both stream aft; luffing: the windward one lifts; stalled: the leeward one droops; aback: both stream forward); the pennant downwind of the apparent wind at the masthead; the stand-in sailor by mode |
| `client/src/render/overlays.ts` | The beginners' arrows, each its own shape with a label |
| `client/src/ui/` | The screen at sea in Preact: instruments, sailor line, helm, sheet, menu. Words and numbers are signals written at most ten times a second; what moves every frame moves by `style.transform` |
| `client/src/audio/` | Sound, synthesised with Web Audio from the recipes in `art/sound/` (below) |

### The developer panel

`?dev` adds a panel: the sandbox's weather (steady, or one of the catalog's
regimes, as a server's developer holds one), its wind at mid-disk (knots and
the direction it comes from), a regime's gusts and its shifts each on or
off, and the wind at the boat (the mean, the wind with its gust, the gust
factor, the gust field and the veer); the sea follows over minutes, as the
server's does;
the sea at once in one of four states (the buttons set the wind to 6, 12, 20
or 34 knots and raise its sea); another fetch than open water's; a second
wind to the east of the boat, so that two seas meet and blend; flat water;
the boat, reset to the start, placed at a position and heading, or
jumped to the rim; time, paused, stepped once or slowed to ½ or ¼; the live
`State` and `Out`; camera presets; the back end, render scale,
tile pass and antialiasing; the quality: the rung of the ladder (any can be
chosen), adaptive quality on or off, the detail band, the foam and the
wakes each on or off, and the last steps adaptive quality took; and the
frame statistics: the interval between drawn frames (median and 90th
percentile over 2 s), the main thread's work per drawn frame, the display's
measured rate and the divisor drawn at, GPU time where the device has
timestamps, draw calls, compute dispatches and triangles; the detail band
and the wind under the boat it follows; and the sea under the boat: its
significant height, its peak period and how many waves are summed. **Check
the sea** runs the server's sea file through the page's module and GPU and
says how far each is from it (see [Waves](#waves)). Its sky part sets the
hour, the moon and the sky's speed, offline and online (see
[The sky](#the-sky)).

### Recording a sail

While the panel is open the sandbox records the sail, from the moment the
panel opened or the last reset or placing: the starting state, the spells of
weather in play, and each change of control, weather or sea with the step it
applied to, in the sea the wind had raised when the recording began. **Download the sail** saves
it as a scenario file in the golden tests' format, with `end`, the state the
sandbox reached. To make it a test, put it in
`internal/physics/testdata/recordings/`: `go test ./internal/physics -run
Recordings` replays every file there and must reach `end` bit for bit, and
`go test ./internal/sim -run SandboxRecordings` sails it through the server's
tick (unless its sea was set by hand: another fetch, two winds, or flat
water, which the server's sea cannot be). Or
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
| `client/src/ocean/phases.ts`, `wave.ts` | The boat band: the physics module's waves and the amplitudes of the sea areas about the boat, laid out for the GPU; their phases at the floating origin reduced in float64 on the CPU each frame; the sum on the GPU, blended between areas (see [Waves](#waves)) |
| `client/src/ocean/tilepass.ts`, `tiles.ts` | Each tile's plane (height and slope at its centre, with the dome's drop and slope) computed once a frame into a float target, one texel per tile; every vertex of a tile reads the same texel, so the tile is a rigid flat slab. Without float render targets the vertex stage computes the same plane |
| `client/src/ocean/seamaterial.ts`, `far.ts`, `client/src/render/sky.ts` | The sea's look (seams, bevels, tint, the detail band and the foam held in each tile, crests lightened by their height against the sea's own, Fresnel, sun, haze), the far sea out past the horizon, the sky |
| `client/src/ocean/spectrum.ts`, `field.ts`, `detail.ts`, `under.ts` | The detail band: its spectrum, its fields on the CPU, the transform in compute passes or the low tier's loop, and the sea under the boat it follows (see [The sea's look](#the-seas-look)) |
| `client/src/ocean/look.ts`, `foam.ts`, `pattern.ts`, `foammap.ts`, `turn.ts` | The look's numbers and the foam by Beaufort force; the foam's sources, cover and margin; the lace and noise texture; the wakes; patterns laid over the world and turned to the wind |
| `client/src/render/quality.ts`, `shadows.ts`, `spray.ts` | The tiers, the ladder and adaptive quality; the sun's shadow map; spray |
| `client/src/ocean/hulls.ts` | No water inside a hull: the sea's fragments within a hull's volume are left out |
| `client/src/game/float.ts` | The other boats' heave and pitch, from the sea drawn under them |
| `client/src/render/boat.ts` | Loads a boat's model and its sailor from the catalog's art, replaces their materials with the factory's |

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

The script also measures the hull's volume from its mesh, eight stations
from the transom to where the stem leaves the water, each the half-beam at
the waterline and the depth of the bottom, and writes it into the model as
the `hull` node's `extras`: the sea is not drawn inside it
([Waves](#waves)).

Commit the rebuilt `.glb`. `npm test` checks each boat's model against the
catalog: its hull's volume against its waterline's length, beam and draught; its named parts sit where the physics puts them, within 1 cm, its
telltales at each sail strip's height, and it is under 15,000 triangles; and
each sailor's model has its parts and is under 2,000. A kind's `art.model`
must name a file that exists (`go run ./tools/catalog -check`). The catalog's
`sailors` list names the figures; the first is drawn.

### Sound

Sound is synthesised in the browser with Web Audio; there are no sound
files. The recipes are art, in `art/sound/*.json` (each names the art
licence in its first field): **wind**, noise through a band-pass whose
centre and level rise with the apparent wind, so it swells with the gusts
the boat feels and with nothing else; **rigging**, a narrow band at
the sheet's Aeolian tone, 0.2 × apparent wind ÷ 10 mm; **flogging**, the
cloth's band beaten at a flap rate, only while a sail strip luffs;
**water**, low-passed noise rising with speed and a bow wave's hiss past the
hull speed; **sea**, a wide, low band that rises and brightens with the
significant height of the waves under the boat, louder with its whitecaps
and with the boat's speed through the water, and silent on flat water. `client/src/audio/voices.ts` maps them onto the physics;
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
after a reload, the bell and the same boat after a restart, and a second device
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
triangles, the materials dithered, and a picture. `sky.spec.ts` finds each
named star where the GPU draws it, within 0.1° of where the module's rule
and the camera put it, from the centre, half way and the rim; no star by day
and the brightest first at dusk; a moonless night with nothing bright and
nothing black; a full moon's light on the sea toward it; looking up from the
rim and tapping the Hub Star; the lanterns' colours from the bow and astern,
none by day and none beyond the horizon; 64 boats by night within 150 draw
calls; and pictures of the hours. `worker.spec.ts`,
on Chromium and WebKit (`--project webkit`, `npx playwright install
webkit`), opens `e2e/net.html`, which runs the net worker alone. The scene's tests open `?sandbox`.
`start.spec.ts`, on WebGL 2 alone, starts as a guest: the start screen,
names refused in words (too short, a symbol, a reserved name, mixed
scripts, a name taken through the API and look-alikes of it), a name
accepted, the cookie's attributes, the sailor kept across a reload without
the start screen, and a second browser refused the same name.
`sea.spec.ts` reads back what the GPU computed and checks it against the
server's sea: the boat band at the points of `sea.json`, which Go wrote,
within what the GPU's sine is good for, in six seas, places and ticks; every
tile a rigid plane with the exact hexagon's outline, at the height and slope
the physics module gives; no sea inside a hull and no hole outside it,
sailing in a gale for ten seconds, heeled 30°, and in seven other boats; the
lattice fixed as the boat moves and the origin jumps, the tile hash, the
scene walk, recovery from a lost device, and pictures.
`wind.spec.ts` is the wind on the water: the gust field the GPU computes at
every tile against the server's (`wind.json`), a gust's tiles darker and
rougher at noon and under a full moon and none in a steady wind, the gust
ring drawn round a gust heading for the boat and travelling with it, and the
wind readout with its Beaufort force (see [Wind](#wind)).
`look.spec.ts` is the sea's look: the detail band the GPU transforms, read
back and compared with `field.ts`'s at the same time and sea (within a
thousandth of each field's size, on a core and a compatibility device, and
after a lost device); foam forming where the surface folds and fading over
its time; the low tier's loop made in slices; every fragment of a tile with
the same whole-tile tilt, the tile's own ripples gone at its rim and unlike
its neighbour's, the far sea without seams; no foam in a calm but round the
hull, whitecaps only on high crests, streaks only from force 7 and long down
the wind, foam's margin at each tile's rim, the white share rising with the
wind (recorded beside Monahan's); a wake that stays on the water as the map
follows the boat and fades in 30 s, a stopped hull's ring, the arms at
19.5°, eight boats in the draw calls of one; spray in one draw; shadows on
the boat and nowhere else; the starting tier by device, `?tier`, every rung
drawn without error; 64 boats under 150 draw calls on every tier, with the
dispatches and texture memory recorded; adaptive quality stepping a slowed
page down to the low tier and, on the Mac, back up without a frame over
100 ms (`@long`); and pictures of the four sea states from the waves
rendering's "Sea states" and "Close aboard" views. The `compat` project
(`--project compat`) runs `sea.spec.ts` and `look.spec.ts` on a WebGPU
device held to compatibility mode's limits.

On CI's software GPU (SwiftShader, on Linux) every pixel and compute pass
is the CPU's, and the sea's best tiers take seconds a frame there. So the
pages there open on the low tier (`?tier=low`), which is what the tests of
geometry, hulls, sailing and the network need; `look.spec.ts` keeps the best
tier for the device, the transform, the rungs and the memory, and runs its
pixel probes and pictures on WebGL 2 alone. On the Mac every page opens on
its device's best tier and every test runs on every back end: run the
browser tests on the Mac before merging a change to the sea's look.
`SOFTWARE_GPU=1` takes CI's paths on any machine.
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
pictures it took (the `playwright-<back end>-short` artifact of `pr.render`;
`-long` for the sky's, which are taken in one `@long` test), and those are
what to commit for `linux` once judged right.

A test that takes minutes on CI's SwiftShader is tagged `@long`
(`test(title, { tag: '@long' }, ...)`); `pr.render` runs each back end's
`@long` tests in a job of their own, beside the rest. The short tests are split over two runners
by spec file: the job's `SPECS` names the files of one half and
`SPECS_HALF` says which half it runs (1, those files; 2, every other file,
so a new file always runs), chosen from the files' measured times. To
balance them again, change the files named in `pr.render.yaml`'s matrix;
`SPECS=sea,fleet SPECS_HALF=1 npx playwright test --list` shows a half.

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

GitHub's settings for this repository are kept in `.github/settings/`: the
repository's own, Actions', the rulesets, and the `production` environment
(`environments.json`: who must approve a job that runs in it, and that
only `main`'s workflows may).

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
- **`tools/cluster`: "limactl is not installed".** `brew install lima`;
  the message names whatever else is missing.
- **`tools/cluster`: the phone cannot open `https://macbook.local`.** Some
  Android phones cannot resolve `.local` names (on a VPN, or without the
  updated resolver); use the Mac's Wi-Fi address shown by `-status`. Check
  the Mac's name with `scutil --get LocalHostName`.
- **`tools/cluster`: port 80 or 443 is in use on the Mac.** Something else
  holds it; Lima cannot forward Traefik's ports until it is stopped.
- **`tools/cluster`: a step waits and then fails.** `go run ./tools/cluster
  -status` shows the pods; `kubectl describe` and `kubectl logs` (with the
  kubeconfig above) say why. `limactl shell keel-local sudo journalctl -u
  k3s` has k3s's own log.
- **`tools/cluster`: start again from nothing.** `go run ./tools/cluster
  -delete`, then `-up`. Lima keeps Ubuntu's image in its cache.
- **`tools/cluster -release`: "the release could not be fetched by Flux".** The
  build has no release (look for its `release` run on `main`), or the
  package `keel-manifests` is still private: Flux reads it with no
  credential ([repository-settings.md](repository-settings.md)).
- **`tools/cluster -release`: "the release was refused by Flux".** Its signature
  is not the release workflow's on `main`. Nothing of it was applied; the
  message is Flux's, and names the signer it found.
- **`tools/cluster -release`: the game's pod cannot pull its image.** The
  package `keel` is still private: the node pulls it with no credential.
- **kubeconform: "could not find schema for …".** A kind the manifests did
  not use before: `go run ./tools/cluster -up`, then `-schemas`, and commit
  the new file in `infra/schemas/`.
- **`promote`: "requires nobody's approval".** The `production`
  environment is missing or has lost its reviewer: `go run ./tools/github
  -apply`.
- **Tests say "no test database".** Run `go run ./tools/dev -db` once; the
  tests read `.dev/db.env`.
