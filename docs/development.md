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
| `pr.physics.yaml` | Pull requests, not drafts | The physics package's rules (imports, `math` functions, no fused multiply-add in the source or the compiled code for arm64 and amd64), its layout files current, and the module built with no heap allocation and within its size budget | `go run ./tools/physics -check` |
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

## The physics package

`internal/physics` steps boats. The server runs it natively, and the client
runs the same code compiled to WebAssembly by TinyGo to predict the player's
own boat, so both must get the same bits from the same inputs. The package's
rules, at the top of `physics.go`, make that hold:

- It calls only the `math` functions that IEEE 754 rounds exactly, and has
  its own sine, cosine, exponential, logarithm and arctangent (`fmath.go`).
- Any product that is added to or subtracted from is written `float64(x*y)`,
  so Go cannot fuse it into a multiply-add on arm64. The check disassembles
  the package to make sure.
- Floats become integers only through `toInt32`; a step never allocates.

```sh
go run ./tools/physics          # write the layout files, build client/src/predict/physics.wasm
go run ./tools/physics -check   # the rules, the layout files, the module's allocations and size
```

The records a step reads and writes (`records.go`) are all `float64`, and
the client reads them through typed arrays at indices generated into
`client/src/predict/layout.gen.ts`. Changing a record changes the layout
version; the client refuses a module whose version differs.

The golden tests run the scenarios in `internal/physics/testdata/scenarios.json`
natively (`go test ./internal/physics`) and in the module (`npm test` in
`client/`), and compare every step's state, and a table of function values,
with `testdata/golden.json`. CI runs them on amd64 and arm64. After a
deliberate change to the physics, rewrite the file and review the diff:

```sh
go test ./internal/physics -run Golden -update
```

`go test ./internal/physics -run Accuracy -samples 100000` measures the
functions against values computed with `math/big` on a hundred thousand
inputs each; CI draws four thousand.

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
- **The developer page says the physics differs from the server.** Note the
  phone, browser and first difference shown, and open an issue: the golden
  tests should have caught it.
- **Port 5173, 5174 or 8080 is in use.** Another copy of `tools/dev`, or
  another Vite, is running.
