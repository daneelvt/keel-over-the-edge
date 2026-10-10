# Repository settings checked by hand

Most of this repository's GitHub settings are kept in `.github/settings/`
and checked with `go run ./tools/github -check`. GitHub has no API for the
ones below, so they are checked by hand, against this list, from time to
time.

## Repository: Settings → Advanced Security

- [ ] Malware alerts: **on**
- [ ] Dependabot auto-triage rules: GitHub's presets **off** (including the
      one that dismisses low-impact alerts in npm development dependencies)
- [ ] Grouped security updates: **off**, one pull request per fix
- [ ] Automatic dependency submission: **off** (GitHub builds the Go
      dependency graph itself)
- [ ] Copilot Autofix: **on**

## Packages: the owner's profile → Packages

GitHub makes a new package private, and has no API a workflow's token may
change that with. Flux and the cluster's node read these with no
credential.

- [ ] `keel` (the game's image): **public**; Manage Actions access lists
      this repository, with the role Write
- [ ] `keel-manifests` (the releases): **public**; Manage Actions access
      lists this repository, with the role Write
- [ ] `keel-manifests-check` (one artifact nobody signed, which Flux must
      refuse; see docs/development.md, "Releases"): **public**

## The owner's account

- [ ] At least two passkeys or security keys; no SMS or authenticator-app
      codes; recovery codes kept offline
- [ ] An SSH signing key registered; vigilant mode on
- [ ] Push protection for yourself on
- [ ] No classic personal access tokens; any token fine-grained, for this
      repository only, short-lived
- [ ] Installed apps: Renovate only, on this repository only; no deploy keys,
      no webhooks
- [ ] Renovate's mode for this repository, in Mend's Developer Portal
      (developer.mend.io, signed in with GitHub): **Interactive**. Installed
      on all of an account's repositories, the hosted app starts in Silent
      mode: it runs, and opens no issue and no pull request, so there is no
      Dependency Dashboard
- [ ] The security log and authorised apps reviewed monthly

## Tailscale: the admin page

The tailnet policy is written from `infra/tailnet/policy.hujson` by the
`tailnet` workflow; the rest of the tailnet is checked here.

- [ ] **Access controls**: the policy is the repository's (run `tailnet` by
      hand: its summary says "unchanged")
- [ ] **Trust credentials**: `ci-prod-join` (Auth Keys, tag `tag:ci-prod`,
      claim `machine.yaml` on `main`) and `ci-prod-policy` (Policy File,
      claim `tailnet.yaml` on `main`), both for the subject of this
      repository's `production` environment, and **no other credential,
      OAuth client or API key**
- [ ] **Keys**: no auth key left
- [ ] **Machines**: `keel-prod-1`, tagged `tag:keel-prod`, key expiry
      disabled; the owner's two devices; no `ci-…` node left over from a run
- [ ] **Users**: the owner alone, as admin

## Infisical: the organisation

- [ ] **Identities**: the owner, `gha-prod` (OIDC Auth alone, for this
      repository's `production` subject and `machine.yaml` on `main`,
      tokens of 10 minutes, Viewer on `keel-ops` alone) and `eso-prod`
      (Universal Auth, Viewer on `keel-cluster` alone): 3 of the free plan's
      5, and no other
- [ ] **Projects**: `keel-ops` and `keel-cluster`, each with `prod` alone
- [ ] `eso-prod`'s client secrets: the one in use alone (an old one is
      revoked once `machine apply` has placed the new)

## Not available to this repository

A public repository on a personal account cannot have these at any price:
generic and AI-detected secret patterns, validity checks, custom secret
patterns and delegated bypass; AI Scan for pull requests and Code Quality;
merge queues, push rulesets, commit-message rules and required workflows.
Generic secrets are covered by gitleaks in `pr.secrets.yaml` instead.

## OpenSSF Scorecard

With one maintainer some checks cannot reach 10. These are expected:

| Check | Expected | Why |
|-------|----------|-----|
| Code-Review | about 0 | No second reviewer; reviews by bots and AI do not count |
| Contributors | low | Needs contributors from three or more organisations |
| Branch-Protection | 3 | A higher score needs a required reviewer |
| CII-Best-Practices | 5 | The passing badge; higher levels need more than one maintainer |
| Maintained | 0 for the first 90 days | Scorecard needs 90 days of history |
| Signed-Releases | inconclusive | Releases are signed OCI artifacts in the registry; Scorecard looks at GitHub Releases, and there are none |

Every other check should score 10.
