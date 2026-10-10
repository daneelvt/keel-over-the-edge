# What is done by hand

Production rests on a few accounts and one machine that no workflow can
make: they are what the workflows prove themselves to. This is every step
taken by hand, once, in order, and what to check after each. Everything
after it is a commit and a workflow run.

Nothing made here is written into the repository but the identifiers
`infra/production.yaml` asks for, none of them secret. **The machine's
public address is never written anywhere in the repository or a pull
request**, nor the provider's host name for it.

Keep a password manager open: every password and the one stored credential
go there, and nowhere else.

## 1. Tailscale

The tailnet is how the owner and the workflows reach the machine. Nothing
else does.

1. Sign up at tailscale.com with the owner's GitHub account (the Personal
   plan). The owner is the tailnet's admin: `autogroup:admin` in the policy.
2. **DNS**: MagicDNS on. Note the tailnet's DNS name (`tail1234.ts.net`)
   as `tailnet` in `infra/production.yaml`.
3. **Access controls**: replace the policy with `infra/tailnet/policy.hujson`,
   whole, and save. Its tags must exist before an identity can carry them.
   From now on the `tailnet` workflow writes it; a change made here is
   replaced by the next run, which shows it.
4. **Settings → Trust credentials → add a credential**, OpenID Connect,
   for GitHub (issuer `https://token.actions.githubusercontent.com`):
   - Name `ci-prod-join`.
   - Subject, exactly:
     `repo:daneelvt@1800070/keel-over-the-edge@1402603021:environment:production`
   - Custom claim `job_workflow_ref`, exactly:
     `daneelvt/keel-over-the-edge/.github/workflows/machine.yaml@refs/heads/main`
   - Scope: **Auth Keys**, write. Tag: **`tag:ci-prod`**.
   - Note its client ID and audience as `tailscale.join` in
     `infra/production.yaml`.
5. A second credential the same way:
   - Name `ci-prod-policy`; the same subject.
   - Custom claim `job_workflow_ref`:
     `daneelvt/keel-over-the-edge/.github/workflows/tailnet.yaml@refs/heads/main`
   - Scopes: **Policy File**, write, and what it requires: **Devices: Core**,
     read, and **Devices: Posture attributes**. No tag.
   - Note its client ID and audience as `tailscale.policy`.
6. Install Tailscale on the owner's computer and on a second device (the
   phone, with an SSH client), each signed in as the owner. Losing one then
   never locks the owner out.

Check:

- [ ] Trust credentials lists `ci-prod-join` and `ci-prod-policy`, and no
      other. A credential's client ID and audience are not secrets: each
      only names the identity, which accepts only the one workflow it was
      made for, on `main`, after the owner approved the run.
- [ ] **Keys** lists no auth key.
- [ ] Both of the owner's devices are listed, as the owner's, untagged.

## 2. Infisical

Infisical keeps the credentials the workflows and the cluster read. The
free plan has no custom roles, so each project is a fence: what may read
one project can read nothing in the other.

1. Sign up at infisical.com, in the region of your choice: US
   (`https://us.infisical.com`) or EU (`https://eu.infisical.com`). Note
   it as `infisical.host`.
2. Make two projects, each of the kind Secrets Management, and in each
   delete the environments `dev` and `staging`, leaving `prod`:
   - **`keel-ops`**: the workflows' credentials. Note its project ID as
     `infisical.project`. In `prod`, make the folder `/machine`.
   - **`keel-cluster`**: what the cluster reads. It stays empty for now.
3. **Organisation → Access Control → Identities → create** `gha-prod`, the
   machine workflow's identity:
   - Authentication: **OIDC Auth** (and no other method).
   - OIDC Discovery URL and Issuer: `https://token.actions.githubusercontent.com`
   - Subject, exactly:
     `repo:daneelvt@1800070/keel-over-the-edge@1402603021:environment:production`
   - Audiences: `https://github.com/daneelvt`
   - Claims: `job_workflow_ref` =
     `daneelvt/keel-over-the-edge/.github/workflows/machine.yaml@refs/heads/main`
   - Access token TTL and max TTL: **600** seconds.
   - Add it to `keel-ops` with the role **Viewer**, and to no other project.
   - Note its identity ID as `infisical.identityID`.
4. Create `eso-prod`, the cluster's identity:
   - Authentication: **Universal Auth**; its client secret with no expiry.
   - Add it to `keel-cluster` with the role **Viewer**, and to no other
     project.
   - Create a client secret. Put its client ID and the secret into
     `keel-ops`, `prod`, `/machine`, as `ESO_CLIENT_ID` and
     `ESO_CLIENT_SECRET`, and nowhere else: not the password manager, not a
     file. The machine workflow reads them from there and places them in
     the cluster.

Check:

- [ ] The organisation's identities, human and machine together: the owner,
      `gha-prod`, `eso-prod`. **3 of the free plan's 5.**
- [ ] `gha-prod` is in `keel-ops` alone, `eso-prod` in `keel-cluster` alone.
- [ ] Each project has `prod` only.

**Rotating the cluster's credential**: create a new client secret for
`eso-prod`, put it into `/machine/ESO_CLIENT_SECRET`, run `machine` with
`apply`, and only then revoke the old one. The free plan keeps no earlier
versions of a secret: an overwritten value is gone.

## 3. Cloudflare

The domain's DNS moves to Cloudflare now, because it can take a day to be
active; nothing points anywhere yet.

1. Sign up at cloudflare.com. **Add a domain**: `keelovertheedge.com`, the
   Free plan. If Cloudflare imports records it found, delete them all: the
   zone holds no record yet.
2. Note the two nameservers Cloudflare gives.
3. At Name.com, on the domain: if DNSSEC is on, turn it off first. Then
   replace the nameservers with Cloudflare's two.
4. Make no API token yet: each is made with the code that uses it, with
   exactly the permissions that code needs.

Check:

- [ ] `dig NS keelovertheedge.com +short` answers with Cloudflare's two
      names.
- [ ] Cloudflare shows the zone **Active**.

## 4. Backblaze B2

The bucket that will hold the infrastructure's state.

1. Sign up at backblaze.com, in the region of your choice (it is chosen
   with the account and cannot change).
2. **Create a bucket**: a name of your own that nobody else has (names are
   global), **Private**, keeping all versions (the default), with
   **server-side encryption** (SSE-B2) on.
3. Make no application key yet, for the same reason as Cloudflare's tokens.

Check:

- [ ] The bucket is private, keeps all versions, and is encrypted.

## 5. InterServer: the machine

1. Sign up at interserver.net. Order a **VPS** of **8 slices** (4 cores,
   16 GB, 320 GB), in **New York City**, billed monthly, with **Ubuntu
   26.04**.
2. Leave the panel's time zone alone (the machine keeps UTC itself). Do not
   set up VNC. Leave **Backup VPS** off: a copy of the disk would hold the
   cluster's encryption key and its credential with the provider; the
   database's backups go elsewhere.
3. The provider makes the root password and may show it in the panel or an
   e-mail: it is used once, for the first login below, and replaced there.

If **Reinstall OS** ever offers no 26.04: install from Ubuntu's own 26.04
server ISO (**Insert CD/DVD**, the ISO checked against Ubuntu's
`SHA256SUMS`, through **View Desktop**); failing that, 24.04, then
`do-release-upgrade` to 26.04, before step 6.

## 6. Joining the machine to the tailnet

The machine answers OpenSSH, with root's password, from the whole internet,
until this step closes it. Do it in one sitting.

1. In Tailscale's admin page, **Keys → Generate auth key**: **one-off** (not
   reusable), **not ephemeral**, **pre-approved**, tagged **`tag:keel-prod`**,
   expiring in **1 day** (the shortest Tailscale allows).
2. From the owner's computer, with the address from InterServer's panel
   (typed, never pasted into anything kept):

   ```sh
   scp infra/bootstrap/join.sh root@<address>:
   ssh root@<address>
   ```

3. On the machine: `passwd`, with a new long password from the password
   manager. Root keeps a password only for the provider's console, the way
   back if Tailscale ever fails.
4. On the machine: `bash join.sh join`, and paste the key when asked. It
   installs Tailscale from Tailscale's own repository, with the signing
   key checked by its digest, and joins as `keel-prod-1`.
5. Log out. From the owner's computer: `tailscale ssh root@keel-prod-1`.
   Tailscale asks for a fresh sign-in (the policy's `check`). There:
   `bash join.sh close-openssh`. It refuses unless that session comes over
   the tailnet, then stops OpenSSH for good.

Check:

- [ ] The admin page lists `keel-prod-1`, tagged `tag:keel-prod`, key
      expiry **disabled** (tagged machines' keys do not expire).
- [ ] **Keys** no longer lists the key (it was one-off). If it was never
      used, revoke it.
- [ ] `ssh root@<address>` from the owner's computer no longer connects.
- [ ] `tailscale ssh root@keel-prod-1` works, from home and from the phone.

## 7. The identifiers, then the first runs

1. Commit `infra/production.yaml` with the values noted above, by a pull
   request. None is secret; the address is not among them.
2. Run **`tailnet`** by hand (Actions → tailnet → Run workflow) and approve
   it: its summary should say the live policy is the repository's already.
3. Run **`machine`** with `audit`: Lynis's report of the machine as the
   provider installed it, the baseline.
4. Run **`machine`** with `check`: what `apply` would change.
5. Run **`machine`** with `apply`, then with `apply` and **reboot**
   ticked, then `check` again: nothing should change.
6. Run **`machine`** with `audit`: Lynis's report again, beside the first.

docs/development.md, "The machine", says what each run does and how to read
it.

## If something fails

- **Tailscale is down, or the machine is off the tailnet**: InterServer's
  panel, from any browser, has the machine's console (**View Desktop**),
  where root's password works.
- **The machine is beyond repair**: **Reinstall OS** in the panel, then
  steps 5.3 and 6 again, and `machine` with `apply`. The machine holds
  nothing the repository and Infisical cannot rebuild.
- **A device is lost**: remove it in Tailscale's admin page, from the other
  device. The `check` rule asks for the owner's GitHub sign-in every 12
  hours, so a stolen, unlocked laptop does not keep root on the machine.
