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

Scan the game's QR code. The page loads with no warning and the first line
reads **Secure context: HTTPS**. The rest of the list shows what the phone
offers: WebGPU, the screen wake lock, passkeys and module workers. Under
**Physics**, the phone runs every golden scenario in the physics module and
shows whether it got the same bits as the server, and how long a step takes.

The certificate stays trusted until you remove it, so next time just scan the
game's QR code. To remove it later: on iPhone, Settings → General → VPN &
Device Management; on Android, Settings → Encryption & credentials → User
credentials.

## Checks

| Workflow | When | What | Locally |
|----------|------|------|---------|
| `ci.yaml` | Every pull request, every push to `main` | Go tests with the race detector on amd64 and arm64 (the physics tests also built with `GOAMD64=v3`), a short fuzz of the catalog decoder, the physics module built and its golden tests run in WebAssembly, client tests, the client build (which fails on a bundled package with a licence not in `tools/licences/allowed.txt`), and the one command started and checked over HTTPS | `go test -race ./...`, `go run ./tools/physics` then `npm test` in `client/`, `go run ./tools/dev -smoke` |
| `pr.lint.yaml` | Pull requests, not drafts | gofmt, go vet, staticcheck, Biome, tsc | `go run ./tools/dev -lint` |
| `pr.licences.yaml` | Pull requests, not drafts | The licence header in every source file; licences of Go packages linked into `keel` | `go run ./tools/licences` |
| `pr.catalog.yaml` | Pull requests, not drafts | The catalog against its schema, unique ids, art present, generated files current, no kind's id used as a string in code | `go run ./tools/catalog -check` |
| `pr.physics.yaml` | Pull requests, not drafts | The physics package's rules (imports, `math` functions, no fused multiply-add in the source or the compiled code for arm64 and amd64), its layout files current, and the module built with no heap allocation and within its size budget; each boat's polar against its original's measured data, and the trimmed sail against ORC's mainsail | `go run ./tools/physics -check`, `go run ./tools/polar -check`, `go run ./tools/polar -sail` |
| `pr.actions.yaml` | Pull requests, not drafts | actionlint and zizmor over the workflows | `go tool actionlint` |
| `pr.dependencies.yaml` | Pull requests, not drafts | GitHub's dependency review, govulncheck, npm registry signatures | `go tool govulncheck ./...`, `npm audit signatures` in `client/` |
| `pr.secrets.yaml` | Pull requests, not drafts | gitleaks over the pull request's commits | `go tool gitleaks git --log-opts="main..HEAD" .` |
| `codeql.yaml` | Pull requests (not drafts), pushes to `main`, weekly | CodeQL for Go, TypeScript and the workflows | |
| `scorecard.yaml` | Pushes to `main`, weekly | OpenSSF Scorecard | |
| `security.yaml` | Weekly | govulncheck and npm signatures on `main` | |

Every workflow pins its actions to full commit hashes; the repository refuses
any other. Each multi-job workflow ends in one job named after the workflow,
and that job is the required check.

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
