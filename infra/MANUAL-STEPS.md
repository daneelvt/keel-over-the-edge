# What is done by hand

Production rests on a few accounts and one machine that no workflow can
make, and the few credentials the accounts workflow starts from: they are
what the workflows prove themselves to. This is every step
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
one project can read nothing in the other. You make two projects and two
machine identities, and put one credential in place.

The button names below are Infisical's, from its documentation; where it
names none, the step says what to look for.

### 2.1 The account

1. Sign up at infisical.com. Unless you chose the EU from Infisical's
   region picker, the account is in the **US**: the address bar shows
   `app.infisical.com` or `us.infisical.com`. Write the API's address as
   `infisical.host` in `infra/production.yaml`:
   - US: `https://us.infisical.com`
   - EU (the address bar shows `eu.infisical.com`): `https://eu.infisical.com`

### 2.2 The two projects

Do this twice, once for each project below.

1. On the organisation's overview, open **Secrets Management** and create a
   project with the name below.
2. In the project, open its settings (**Project Settings**) and, under
   **Environments**, delete **Development** and **Staging**. Keep
   **Production**: its slug must be `prod`, as `infra/production.yaml`
   says (`environment: prod`).

The projects:

- **`keel-ops`**: the workflows' credentials. In its settings, copy the
  **Project ID** and write it as `infisical.project` in
  `infra/production.yaml`.
- **`keel-cluster`**: what the cluster reads. It stays empty for now.

Then the folder the machine workflow reads:

3. In `keel-ops`, open the secrets of the **Production** environment.
4. Select the chevron next to **Add Secret**, then **Add Folder**, and name
   it `machine` (letters, numbers and dashes only). The folder's path is
   `/machine`: the secrets in 2.4 go inside it.

### 2.3 `gha-prod`: the machine workflow's identity

It signs in with the job's own GitHub token, so no secret of its own
exists anywhere.

1. In the organisation (not a project): **Access Control → Machine
   Identities → Create**.
   - **Name**: `gha-prod`
   - **Role** (the **Organization Roles** tab): **No Access**. An identity's
     organisation role gives it nothing in any project; the project role in
     step 4 is what it may do.
2. Infisical opens the identity's page. Note its **ID** there, and write it
   as `infisical.identityID` in `infra/production.yaml`.
3. In its **Authentication** section, remove **Universal Auth**, which a
   new identity starts with, and add **OIDC Auth** in its place, with:

   | Field | Value |
   |---|---|
   | OIDC Discovery URL | `https://token.actions.githubusercontent.com` |
   | Issuer | `https://token.actions.githubusercontent.com` |
   | CA Certificate | empty |
   | Subject | `repo:daneelvt@1800070/keel-over-the-edge@1402603021:environment:production` |
   | Audiences | `https://github.com/daneelvt` |
   | Claims | one claim: name `job_workflow_ref`, value `daneelvt/keel-over-the-edge/.github/workflows/machine.yaml@refs/heads/main` |
   | Access Token TTL | `600` |
   | Access Token Max TTL | `600` |
   | Access Token Max Number of Uses | `0` (no limit: a run uses its token many times) |
   | Access Token Trusted IPs | as it is (limiting them is a paid feature) |

   Type the subject and the claim exactly, with no `*`: Infisical matches
   them by pattern, and an exact value is the narrowest.
4. Open **`keel-ops`**: **Access Control → Machine Identities → Add Machine
   Identity to Project → Assign Existing**, choose `gha-prod`, role
   **Viewer**. Add it to no other project.

### 2.4 `eso-prod`: the cluster's identity

It signs in with a client ID and a client secret, which the machine
workflow places in the cluster.

1. In the organisation: **Access Control → Machine Identities → Create**.
   - **Name**: `eso-prod`
   - **Role** (the **Organization Roles** tab): **No Access**.
2. On the identity's page, **Universal Auth** is already set up. Edit it
   (the edit control on the **Authentication** section); on its
   **Configuration** tab:

   | Field | Value |
   |---|---|
   | Access Token TTL | `3600` (an hour: External Secrets signs in again whenever it needs a token) |
   | Access Token Max TTL | `3600` |
   | Access Token Max Number of Uses | `0` (no limit) |

   Leave the **Lockout** tab on as it is (3 failures, 5 minutes) and the
   **Advanced** tab's trusted IPs as they are (a paid feature).
3. Still on the identity's page, **Add Client Secret** (in the Universal
   Auth part of the page):
   - **Description**: `cluster`
   - **TTL**: `0` (it never expires; it is replaced by hand, below)
   - **Max Number of Uses**: `0` (no limit)

   Infisical shows the secret **once**. Leave that window open for step 5.
4. Open **`keel-cluster`**: **Access Control → Machine Identities → Add
   Machine Identity to Project → Assign Existing**, choose `eso-prod`, role
   **Viewer**. Add it to no other project: in particular not `keel-ops`.
5. In another tab, open **`keel-ops`**, **Production**, the folder
   **`machine`**, and **Add Secret** twice:
   - `ESO_CLIENT_ID`: the identity's **Client ID**, shown with its
     Universal Auth settings. It is not a secret, but it belongs with the
     secret.
   - `ESO_CLIENT_SECRET`: the client secret from step 3.

   Then close the window that showed the secret. It is kept nowhere else:
   not in the password manager, not in a file. The machine workflow reads
   both from here and places them in the cluster.

Check:

- [ ] **Access Control → Machine Identities** lists `gha-prod` and
      `eso-prod`, and no other. With you, that is **3 of the free plan's 5
      identities**.
- [ ] `gha-prod` has OIDC Auth alone, and is a member of `keel-ops` alone;
      `eso-prod` has Universal Auth, one client secret, and is a member of
      `keel-cluster` alone.
- [ ] Each project has the **Production** environment alone.
- [ ] `keel-ops`, Production, `/machine` holds `ESO_CLIENT_ID` and
      `ESO_CLIENT_SECRET`, and nothing else.
- [ ] `infra/production.yaml` has `infisical.host`, `infisical.identityID`
      and `infisical.project` filled in.

**Rotating the cluster's credential**: on `eso-prod`'s page, **Add Client
Secret** again (TTL `0`). Paste it over `ESO_CLIENT_SECRET` in
`keel-ops`/Production/`machine`, run `machine` with `apply`, and only then
revoke the old client secret on the identity's page. The free plan keeps no
earlier versions of a secret: an overwritten value is gone.

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

## 8. Infisical: the accounts workflow's project and identity

The `accounts` workflow reads the credentials OpenTofu needs from a third
project, so that neither the machine workflow nor the cluster can read
them; and it writes the secrets it makes into `keel-cluster`.

1. Make the project **`keel-accounts`** as in 2.2: **Production** alone,
   slug `prod`. In it, under Production, **Add Folder** `accounts`. Copy its
   **Project ID** as `infisical.accounts.project` in `infra/production.yaml`.
2. Open **`keel-cluster`**'s settings: copy its **Project ID** as
   `infisical.cluster.project`, and its **slug** as
   `infisical.cluster.slug` in `infra/production.yaml` **and** as
   `projectSlug` in `infra/cluster/clusters/prod/configs/secret-store.yaml`
   (a test keeps the two the same). Leave the project empty: OpenTofu makes
   its folders and secrets.
3. In the organisation: **Access Control → Machine Identities → Create**,
   **Name** `gha-accounts`, organisation role **No Access**. Note its **ID**
   as `infisical.accounts.identityID`.
4. Replace its **Universal Auth** with **OIDC Auth**, as in 2.3 step 3,
   with the same values but the claim:

   | Field | Value |
   |---|---|
   | Claims | one claim: name `job_workflow_ref`, value `daneelvt/keel-over-the-edge/.github/workflows/accounts.yaml@refs/heads/main` |

5. Add it to **`keel-accounts`** with the role **Viewer**, and to
   **`keel-cluster`** with the role **Member** (it writes the tunnel's
   token and the database's password there). No other project.

Check:

- [ ] **Machine Identities** lists `gha-prod`, `eso-prod` and
      `gha-accounts`: with you, **4 of the free plan's 5**.
- [ ] `gha-accounts` has OIDC Auth alone, for `accounts.yaml` on `main`;
      it is Viewer on `keel-accounts` and Member on `keel-cluster`, and in
      no other project. `gha-prod` is still in `keel-ops` alone, `eso-prod`
      in `keel-cluster` alone.

## 9. Backblaze B2: the state's key

1. **Application Keys → Add a New Application Key**:
   - **Name**: `keel-state`
   - **Allow access to Bucket(s)**: the state bucket from section 4, alone
   - **Type of Access**: Read and Write
   - **Allow List All Bucket Names**: unticked
   - **File name prefix**, **Duration**: empty (it does not expire; it is
     replaced by hand, below)
2. B2 shows the **keyID** and the **applicationKey** once. In
   `keel-accounts`, Production, folder `accounts`, **Add Secret** twice:
   `B2_KEY_ID` and `B2_KEY`. Keep them nowhere else.
3. On the bucket's page, note its **Endpoint** (as
   `s3.us-west-004.backblazeb2.com`). In `infra/production.yaml`:
   `state.bucket` (its name), `state.endpoint` (`https://` and the
   endpoint) and `state.region` (the endpoint's middle part, as
   `us-west-004`).

Check:

- [ ] **Application Keys** lists `keel-state`, for the state bucket alone,
      and no other key but the account's master key, which is used for
      nothing.

## 10. The state's passphrase

The state is encrypted with a key made from this passphrase. It is the one
secret kept in two places: without it, the state cannot be read, and
OpenTofu loses track of everything it made.

1. In the password manager, generate **48 random characters**, letters and
   digits, and save it as "keel OpenTofu state passphrase".
2. In `keel-accounts`, Production, `accounts`, **Add Secret**
   `TOFU_PASSPHRASE` with the same value.
3. **Add Secret** `NOTIFY_EMAIL`: the address Cloudflare's tunnel alerts and
   certificate authorities' reports go to (it is published in the zone's
   CAA record, as `iodef`; it is not written in the repository).

Check:

- [ ] The password manager and `keel-accounts` hold the same passphrase.

## 11. Cloudflare: Zero Trust and the API token

1. **Zero Trust** (from the account's home): if the account has no team
   yet, choose a team name and the **Free** plan. Record in the pull
   request whether Cloudflare asked for a payment method. If it asks and
   you will not give one, stop: tunnels belong to Zero Trust.
2. **Manage Account → Account API Tokens → Create Token → Custom token**
   (a token the account owns, not your profile):
   - **Name**: `accounts`
   - **Permissions**:

     | Scope | Permission | Access |
     |---|---|---|
     | Account | Cloudflare One Connector: cloudflared | Edit |
     | Account | Notifications | Edit |
     | Zone | DNS | Edit |
     | Zone | Zone | Read |
     | Zone | Zone Settings | Edit |
     | Zone | Zone WAF Rules | Edit |
     | Zone | Bot Management | Edit |
     | Zone | Cache Rules | Edit |

   - **Account Resources**: this account. **Zone Resources**: Specific
     zone, `keelovertheedge.com`.
   - **Client IP Address Filtering**: none. **TTL**: none (replaced by
     hand, below).

   "Cloudflare One Connector: cloudflared" is what Cloudflare now calls
   Cloudflare Tunnel's permission, the narrowest the provider accepts for a
   tunnel and its token; not "Argo Tunnel (Legacy)", nor "Cloudflare One
   Connectors", which covers WARP's connectors too.

   This is where the list starts: the first `plan` and `apply` show what is
   missing (an error naming the endpoint refused) or unused, and this table
   is corrected to the final list.
3. Cloudflare shows the token once. In `keel-accounts`, Production,
   `accounts`, **Add Secret** `CLOUDFLARE_API_TOKEN`.
4. On the zone's **Overview**, copy the **Account ID** and **Zone ID** as
   `cloudflare.account` and `cloudflare.zone` in `infra/production.yaml`.

Check:

- [ ] **Account API Tokens** lists `accounts` alone; **My Profile → API
      Tokens** lists none for this account.
- [ ] `keel-accounts`, Production, `/accounts` holds `B2_KEY_ID`, `B2_KEY`,
      `TOFU_PASSPHRASE`, `NOTIFY_EMAIL` and `CLOUDFLARE_API_TOKEN`, and
      nothing else.

## 12. Online: the first runs, and the DS record

1. Before anything of this is released: **`promote`** `main`'s newest
   build, so production runs the manifests it should, Traefik's Service
   `ClusterIP` among them. On the machine: `k3s kubectl -n kube-system get
   svc traefik` says `ClusterIP`; run **`machine`** with `check`.
2. Commit `infra/production.yaml` and the store's slug, by a pull request.
3. Once the release with External Secrets and cloudflared is promoted:
   External Secrets' store is `Valid`, both `ExternalSecret`s report the
   key missing, cloudflared and the game wait (docs/development.md,
   "The game waits for its database password").
4. Run **`accounts`** with `plan`, approve, and read its summary: the
   resources to make. Then with `apply`: approve the plan job, read its
   summary, approve the apply job. Within the hour (or at once:
   `kubectl -n keel annotate externalsecret keel-db-app
   force-sync=$(date +%s) --overwrite`, and the same for `tunnel-token` in
   `cloudflared`), the Secrets appear, the database is made, the game
   starts, cloudflared connects, and `play.keelovertheedge.com` answers.
5. Run **`accounts`** with `plan` again: no changes.
6. **The DS record.** In Cloudflare: the zone's **DNS → Settings →
   DNSSEC** shows the DS record (key tag, algorithm 13, digest type 2,
   digest). At Name.com, on the domain: **DNSSEC Management → Add DNSSEC
   Record**, with those four values.
7. A day later, with nothing gone wrong: in `infra/tofu/zone.tf`, raise
   `hsts_max_age` from `86400` to `15552000` (six months), by a pull
   request, and run `accounts` with `apply`.

Check:

- [ ] `dig DS keelovertheedge.com +short` answers the record;
      `dig +dnssec play.keelovertheedge.com` has the `ad` flag through a
      validating resolver (`dig @1.1.1.1 …`).
- [ ] `dig play.keelovertheedge.com +short` answers Cloudflare's addresses
      alone.
- [ ] `go run ./tools/online` passes.
- [ ] A scan of every TCP port of the machine's public address finds none
      open (recorded without the address).

### Rotating the accounts workflow's credentials

The free plan of Infisical keeps no earlier version of a secret: an
overwritten value is gone, so the old credential is revoked only once the
new one has worked.

- **Cloudflare's token**: roll it (the token's **Roll** action) or make a
  new one with the same permissions; paste it over `CLOUDFLARE_API_TOKEN`;
  run `accounts` with `plan`; then delete the old token.
- **The B2 key**: make a new key as in section 9; paste both values over
  `B2_KEY_ID` and `B2_KEY`; run `accounts` with `plan`; then delete the old
  key.
- **The passphrase** (OpenTofu's "State and plan encryption", key
  rotation): in a branch, add to `infra/tofu/backend.tf` a second
  `key_provider "pbkdf2" "old"` and `method "aes_gcm" "old"` from a
  variable `old_state_passphrase`, and a `fallback { method =
  method.aes_gcm.old }` in the `state` and `plan` blocks; have
  `tools/accounts` read `TOFU_PASSPHRASE_OLD` into
  `TF_VAR_old_state_passphrase`. Put the old passphrase in
  `TOFU_PASSPHRASE_OLD` and the new one in `TOFU_PASSPHRASE` and the
  password manager; run `accounts` with `apply` (it rewrites the state with
  the new key); then remove the fallback, the variable and
  `TOFU_PASSPHRASE_OLD`.
- **`gha-accounts`**: nothing to rotate; it holds no secret.

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
