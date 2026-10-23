# Rebuilding the machine from nothing

What to do when `keel-prod-1` is lost, or to prove it can be: a new
Ubuntu, the playbook, and the game back with its database recovered from
the backups. Everything the machine holds is in the repository, in
Infisical or in B2; nothing is copied from the old machine.

Done as a drill, it is the same steps with the old machine still there
at step 1. Time it: write the hour beside each step, and count **from
step 3 to step 7**. The target is under an hour.

What is lost: at most the last five minutes before the machine went (the
WAL not yet archived); and the boats at sea, as after any stop longer
than the 60 seconds a checkpoint is good for: the sea starts empty, and
players join again. What is not: accounts, their sailors and passkeys, the
world.

## Before

Nothing here can be done once the machine is gone; it is what keeps a
rebuild possible, and the Backups dashboard shows it every day.

- [ ] **Backups** dashboard: WAL archived within the last five minutes, a
      base backup within the day, the last restore test passed.
- [ ] The last rebuild, if there was one, was finished: Flux follows
      `./prod` (`machine` with `check`: its log's line `flux follows
      […]`), and
      `infra/cluster/apps/keel/generation.yaml` names as `live` the
      archive the database writes.

## 1. A last backup, if the machine still answers

Skip this when it does not. For a drill, do all of it, and note the
answers: they are what step 7 compares.

```sh
tailscale ssh root@keel-prod-1
k3s kubectl -n keel exec keel-db-1 -c postgres -- psql keel -Atc \
  "select 'accounts', count(*) from account union all select 'events', count(*) from event union all select 'newest event', extract(epoch from max(written_at))::bigint from event"
k3s kubectl -n keel exec keel-db-1 -c postgres -- psql keel -Atc "select pg_switch_wal()"
k3s kubectl -n keel create job --from=cronjob/keel-db-dump keel-db-dump-before-rebuild
k3s kubectl -n keel get cluster keel-db -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")].status}'
```

`pg_switch_wal()` closes the current segment, so it is archived at once
and not in up to five minutes. Wait for the dump's job to complete, and
for the Backups dashboard to show the segment archived.

## 2. Remove the old machine from the tailnet

In Tailscale's admin page, **Machines**: `keel-prod-1` → **Remove**. The
new machine takes its name; left there, the new one would join as
`keel-prod-1-1`, and no workflow would find it.

## 3. Reinstall Ubuntu

**Start the clock.** In InterServer's panel: **Reinstall OS**, Ubuntu
26.04 ([MANUAL-STEPS.md](MANUAL-STEPS.md), section 5; what to do if 26.04
is not offered is there). The disk is erased. The panel shows the new
root password.

If the provider lost the machine altogether, order a new one as section 5
says. Its public address changes, and nothing in the repository knows it:
the tunnel dials out.

## 4. Join the tailnet

[MANUAL-STEPS.md](MANUAL-STEPS.md), section 6, whole: a fresh one-off key
tagged `tag:keel-prod`, `join.sh join`, then `join.sh close-openssh` over
Tailscale. Check `tailscale ssh root@keel-prod-1` works.

## 5. `machine`, `apply`, with **rebuild** ticked

Actions → machine → Run workflow: `apply`, **rebuild** and **reboot**
ticked. Approve it.

It runs the same playbook as ever on an empty machine: the hardening, the
firewall, k3s, the cluster's credential for Infisical from `keel-ops`.
The one difference: Flux is started on the release's **rebuild form**
(`./prod-rebuild`), which is production in every way but how the database
is made. The run's summary says so, and names the archive the database
recovers from and the one it will write.

It refuses, changing nothing, on a machine whose database is already
there and is not one a rebuild made: **rebuild** is for an empty machine.

## 6. Wait, and watch

Nothing to do. On the machine (`tailscale ssh root@keel-prod-1`), in
order:

```sh
k3s kubectl get kustomizations -A          # flux-system, controllers, configs, then apps and monitoring: Ready
k3s kubectl get externalsecrets -A         # each SecretSynced: the passwords, the tunnel's token, the backups' keys
k3s kubectl -n keel get cluster keel-db    # "Setting up primary", then "Cluster in healthy state"
k3s kubectl -n keel logs -f -l cnpg.io/jobRole=full-recovery -c full-recovery   # the recovery, while it runs
k3s kubectl -n keel get backups.postgresql.cnpg.io   # a base backup of the new archive, taken at once
k3s kubectl -n keel get pods               # keel Running; its init container migrated nothing
k3s kubectl -n cloudflared get pods        # two, Ready: the tunnel is the same one, reconnected
```

The database's passwords are the ones in Infisical, set again after the
recovery; the tunnel, its DNS record and every secret live outside the
machine, so `accounts` has nothing to do and is not run.

If the recovery fails, its job's log says why; the usual reasons are a
backups' key missing from Infisical (`externalsecrets`), or a release
promoted from before the backups existed (step 5 would have refused).
A recovery only reads the old archive: nothing a failed one does can
damage it, and deleting the cluster (`k3s kubectl -n keel delete cluster
keel-db`) makes Flux start it again. One that got as far as archiving
under the new name before it was deleted leaves that folder in the
bucket, and the next attempt will refuse to archive into it
(CloudNativePG's "Expected empty archive"): remove the folder from a
session as in MANUAL-STEPS.md section 14, bypassing the lock, and delete
the cluster once more.

## 7. Check it

```sh
go run ./tools/online
```

**Stop the clock** when it passes. Then, on the machine, the same query
as step 1: the accounts are all there, and the newest event is at most
five minutes older than the one noted (or than the moment the machine
was lost). Sail from a phone.

Open the tunnel (`go run ./tools/ops -tunnel`): Grafana's password is the
same; the dashboards start empty, as the metrics and logs lived on the
old disk and are not backed up. The Backups dashboard shows WAL archived
under the new name.

## 8. Raise the generation, and go back to the ordinary form

The rebuilt database writes the archive `rebuilt` named; the release
still calls the old one `live`. Until this step is done, Flux leaves the
database and its restore test exactly as the rebuild made them (they are
applied only while they are not there), so a change to either in a
release waits; everything else deploys as ever. Do it the same day.

1. A pull request raising both names in
   `infra/cluster/apps/keel/generation.yaml` by one (`live: keel-db-g2`,
   `rebuilt: keel-db-g3`, after the first rebuild). Nothing else.
2. Merge it; when its release is built, **promote** it. Nothing changes
   on the machine: Flux still follows the rebuild form, and leaves the
   database alone.
3. **`machine`** with `apply`, **rebuild** not ticked. It moves Flux back
   to `./prod`, whose database is now described as it runs. It refuses,
   changing nothing, if the release `prod` names does not have the
   running database's archive as its live one: before step 2, or if the
   generation was raised twice.
4. **`machine`** with `check`: nothing to change.

The old archive (`keel-db-g1`) stays in the bucket: Barman's retention
only looks after the archive it writes. It is what a restore to a moment
before the rebuild would read. Delete it by hand, from a session as in
MANUAL-STEPS.md section 14, once nothing that old matters (B2's lock
holds each file for 14 days whatever is asked).

## What to write down

In the pull request of step 8, for a drill and for the real thing alike:
the time of each step, the total from 3 to 7, the newest event before and
after, how long the recovery itself took and how much it read, and
anything this page got wrong.
