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
in `go.mod` and run with `go tool`.

## The one command

```sh
go run ./tools/dev
```

It checks Node and npm, installs the client's packages when the lock file
has changed, regenerates the catalog, makes a local HTTPS certificate,
builds and starts `keel serve`, starts Vite, and prints the game's address
with a QR code. Changing a Go file rebuilds and restarts the server; changing
a client file reloads the page. Ctrl-C stops everything.

The first run asks for your computer's password once, to trust the local
certificate authority that signs the certificate (mkcert). On macOS it also
asks to allow incoming connections, so phones can reach Vite.

The game is served at your computer's local network address, for example
`https://192.168.1.20:5173`. Use that address on the computer too, so the
computer and phones share one origin.

## On a phone

The phone must be on the same network, and must trust the local certificate
authority once. `tools/dev` serves its certificate (never its key) at the
`http://…:5174/` address it prints.

- **iPhone**: open that address in Safari and allow the download. Install the
  profile in Settings → General → VPN & Device Management. Then turn on full
  trust for it in Settings → General → About → Certificate Trust Settings.
  The last step is easy to miss.
- **Android**: download the file, then install it in Settings → Security →
  Encryption & credentials → Install a certificate → CA certificate. The menu
  names vary by maker. Chrome trusts user-installed authorities for web
  pages.

Then scan the QR code. The page shows "Secure context: HTTPS" when it worked,
and lists what the phone offers: WebGPU, the wake lock, passkeys and module
workers.

## Checks

| Workflow | When | What | Locally |
|----------|------|------|---------|
| `ci.yaml` | Every pull request, every push to `main` | Go tests with the race detector, a short fuzz of the catalog decoder, client tests, the client build (which fails on a bundled package with a licence not in `tools/licences/allowed.txt`), and the one command started and checked over HTTPS | `go test -race ./...`, `npm test` in `client/`, `go run ./tools/dev -smoke` |
| `pr.lint.yaml` | Pull requests, not drafts | gofmt, go vet, staticcheck, Biome, tsc | `go run ./tools/dev -lint` |
| `pr.licences.yaml` | Pull requests, not drafts | The licence header in every source file; licences of Go packages linked into `keel` | `go run ./tools/licences` |
| `pr.catalog.yaml` | Pull requests, not drafts | The catalog against its schema, unique ids, art present, generated files current, no kind's id used as a string in code | `go run ./tools/catalog -check` |
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

## Commits

Changes reach `main` only through pull requests, merged by squashing. Every
commit must be signed. To sign with an SSH key:

```sh
git config gpg.format ssh
git config user.signingkey ~/.ssh/id_ed25519.pub
git config commit.gpgsign true
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
- **The page loads but is not a secure context.** The certificate authority
  is not trusted on the phone; on an iPhone, check Certificate Trust
  Settings.
- **"node is …; this repository needs …".** Run `nvm install && nvm use`.
- **Port 5173, 5174 or 8080 is in use.** Another copy of `tools/dev`, or
  another Vite, is running.
