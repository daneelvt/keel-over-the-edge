// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"bytes"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/tools/internal/production"
	"go.yaml.in/yaml/v3"
)

// all renders every entry point of a cluster, with Flux's own where the
// cluster's entry points do not hold it, as a release checks them together.
func all(t *testing.T, c Cluster) []Object {
	t.Helper()
	var objs []Object
	if !slices.Contains(c.Entries, FluxEntry) {
		rm, err := readRepoTree(t).Render(FluxEntry)
		objs = objectsOf(t, rm, err)
	}
	for _, e := range c.Entries {
		objs = append(objs, release(t, c, e)...)
	}
	return objs
}

// inNamespace is the object of a kind and name in a namespace.
func inNamespace(objs []Object, kind, ns, name string) Object {
	for _, o := range objs {
		if o.Kind() == kind && o.Name() == name && Str(o, "metadata", "namespace") == ns {
			return o
		}
	}
	return nil
}

// TestClustersKeepTheirRulesTogether: what one layer names, another
// provides: every scrape's port is let in from the scraper and nothing
// else is, and every forward's Service is there. Each is broken on purpose.
func TestClustersKeepTheirRulesTogether(t *testing.T) {
	for _, c := range Clusters {
		if err := CheckCluster(all(t, c), target(t, c)); err != nil {
			t.Errorf("%s: %v", c.Name, err)
		}
	}
	cases := []struct {
		rule   string
		c      Cluster
		mutate func(objs []Object) []Object
	}{
		// The scraper is let in to keel's metrics listener, and no other.
		{"every scrape's port let in from the scraper", prod, func(objs []Object) []Object {
			p := inNamespace(objs, "NetworkPolicy", Namespace, "keel")
			Get(p, "spec", "ingress", 1, "ports", 0).(map[string]any)["port"] = 9090
			return objs
		}},
		{"every scrape's port let in from the scraper", local, func(objs []Object) []Object {
			return slices.DeleteFunc(objs, func(o Object) bool {
				return o.Kind() == "NetworkPolicy" && o.Name() == "metrics" && Str(o, "metadata", "namespace") == "cert-manager"
			})
		}},
		// A scrape of pods nothing lets the scraper in to.
		{"every scrape's port let in from the scraper", prod, func(objs []Object) []Object {
			return append(objs, Object{"apiVersion": "operator.victoriametrics.com/v1beta1", "kind": "VMPodScrape",
				"metadata": map[string]any{"name": "keel-restore-check", "namespace": RestoreNamespace},
				"spec": map[string]any{"selector": map[string]any{"matchLabels": map[string]any{"cnpg.io/cluster": "keel-restore-check"}},
					"podMetricsEndpoints": []any{map[string]any{"port": "metrics"}}}})
		}},
		// The scraper let in where nothing is scraped.
		{"every scrape's port let in from the scraper", prod, func(objs []Object) []Object {
			return slices.DeleteFunc(objs, func(o Object) bool { return o.Kind() == "VMPodScrape" && o.Name() == "cloudflared" })
		}},
		{"every scrape's port let in from the scraper", local, func(objs []Object) []Object {
			p := inNamespace(objs, "NetworkPolicy", Namespace, "keel-db")
			spec := p["spec"].(map[string]any)
			spec["ingress"] = append(spec["ingress"].([]any), map[string]any{
				"from":  []any{map[string]any{"namespaceSelector": map[string]any{"matchLabels": map[string]any{"kubernetes.io/metadata.name": "monitoring"}}}},
				"ports": []any{map[string]any{"port": 8000, "protocol": "TCP"}}})
			return objs
		}},
		{"every forward's Service is there", prod, func(objs []Object) []Object {
			return slices.DeleteFunc(objs, func(o Object) bool { return o.Kind() == "Service" && o.Name() == "keel-db-forward" })
		}},
		{"every forward's Service is there", local, func(objs []Object) []Object {
			return append(objs, inNamespace(objs, "Service", "monitoring", "grafana-forward"))
		}},
	}
	broken := map[string]bool{}
	for i, tc := range cases {
		err := CheckCluster(tc.mutate(all(t, tc.c)), target(t, tc.c))
		if err == nil || !strings.Contains(err.Error(), tc.rule+":") {
			t.Errorf("case %d, broken for %q: %v", i, tc.rule, err)
		}
		broken[tc.rule] = true
	}
	for _, r := range crossRules {
		if !broken[r.name] {
			t.Errorf("no case breaks the rule %q", r.name)
		}
	}
}

// TestRebuildFormIsProductionButItsDatabase: the rebuild form differs from
// production in the folders Flux's layers apply, in how the database is
// made and what it archives as, in the archive the restore test restores,
// and in those two being applied only while they are not there; in
// nothing else.
func TestRebuildFormIsProductionButItsDatabase(t *testing.T) {
	for _, e := range prod.Entries {
		live, re := release(t, prod, e), release(t, rebuild, e)
		if len(live) != len(re) {
			t.Fatalf("%s: %d objects, the rebuild form %d", e, len(live), len(re))
		}
		for i := range live {
			a, b := live[i], re[i]
			if a.ID() != b.ID() {
				t.Fatalf("%s: %s is the rebuild form's %s", e, a.ID(), b.ID())
			}
			switch {
			case a.Kind() == "Kustomization" && a.group() == "kustomize.toolkit.fluxcd.io":
				if p := Str(b, "spec", "path"); p != "./"+Rebuild+"/"+b.Name() {
					t.Errorf("the rebuild form's %s applies %s", b.ID(), p)
				}
				delete(a["spec"].(map[string]any), "path")
				delete(b["spec"].(map[string]any), "path")
			case a.ID() == "Cluster/"+database:
				if Str(b, "metadata", "annotations", ApplyOnce) != "IfNotPresent" {
					t.Errorf("the rebuild form's %s is applied again once it is there", b.ID())
				}
				dropApplyOnce(b)
				for _, o := range []Object{a, b} {
					spec := o["spec"].(map[string]any)
					delete(spec, "bootstrap")
					delete(spec, "externalClusters")
					delete(Get(spec, "plugins", 0, "parameters").(map[string]any), "serverName")
				}
			case a.ID() == "CronJob/"+RestoreTest:
				if Str(b, "metadata", "annotations", ApplyOnce) != "IfNotPresent" {
					t.Errorf("the rebuild form's %s is applied again once it is there", b.ID())
				}
				dropApplyOnce(b)
				for _, o := range []Object{a, b} {
					for _, env := range List(Container(PodSpec(o), "containers", "restore-test"), "env") {
						if Str(env, "name") == "KEEL_RESTORE_SOURCE" {
							delete(env.(map[string]any), "value")
						}
					}
				}
			}
			if !reflect.DeepEqual(a, b) {
				t.Errorf("%s: %s differs in the rebuild form:\n%s\nagainst\n%s", e, a.ID(), mustYAML(t, b), mustYAML(t, a))
			}
		}
	}
	// What the two databases are made from.
	db := Find(release(t, rebuild, "apps"), "Cluster", database)
	if Str(db, "spec", "bootstrap", "recovery", "secret", "name") != "keel-db-app" || Str(db, "spec", "bootstrap", "recovery", "database") != "keel" || Str(db, "spec", "bootstrap", "recovery", "owner") != "keel" {
		t.Errorf("the rebuilt database's owner: %v", Get(db, "spec", "bootstrap"))
	}
	if init := Get(Find(release(t, prod, "apps"), "Cluster", database), "spec", "bootstrap", "initdb"); init == nil {
		t.Error("production's database is not made with initdb")
	}
}

// dropApplyOnce removes the annotation the rebuild form adds, and the
// annotations with it when it was the only one.
func dropApplyOnce(o Object) {
	meta := o["metadata"].(map[string]any)
	ann, _ := meta["annotations"].(map[string]any)
	delete(ann, ApplyOnce)
	if len(ann) == 0 {
		delete(meta, "annotations")
	}
}

// TestGenerations: the archive's two names are generations one apart.
func TestGenerations(t *testing.T) {
	gen := func(live, rebuilt string) []Object {
		return []Object{{"kind": "ConfigMap", "metadata": map[string]any{"name": Generation}, "data": map[string]any{"live": live, "rebuilt": rebuilt}}}
	}
	if live, rebuilt, err := Generations(release(t, prod, "apps")); err != nil || !archiveName.MatchString(live) || !archiveName.MatchString(rebuilt) {
		t.Errorf("the repository's generations: %s, %s, %v", live, rebuilt, err)
	}
	for _, ok := range [][2]string{{"keel-db-g1", "keel-db-g2"}, {"keel-db-g9", "keel-db-g10"}, {"keel-db-g41", "keel-db-g42"}} {
		if _, _, err := Generations(gen(ok[0], ok[1])); err != nil {
			t.Errorf("%v: %v", ok, err)
		}
	}
	for _, bad := range [][2]string{{"keel-db-g1", "keel-db-g1"}, {"keel-db-g2", "keel-db-g1"}, {"keel-db-g1", "keel-db-g3"}, {"keel-db-g0", "keel-db-g1"}, {"keel-db", "keel-db-g1"}, {"keel-db-g1", ""}, {"other-g1", "other-g2"}} {
		if _, _, err := Generations(gen(bad[0], bad[1])); err == nil {
			t.Errorf("%v was accepted", bad)
		}
	}
	if _, _, err := Generations(nil); err == nil {
		t.Error("no generations at all were accepted")
	}
}

// TestBackupsAreProductions: the buckets, the endpoint and the region the
// manifests write are infra/production.yaml's, each cluster its own bucket;
// and the backups' store reads the project it names, once it is made.
func TestBackupsAreProductions(t *testing.T) {
	p, err := production.Read(filepath.Join("..", "..", "..", production.File))
	if err != nil {
		t.Fatal(err)
	}
	b := p.Backups
	if Buckets["prod"] != b.Bucket || Buckets[Rebuild] != b.Bucket || Buckets["local"] != b.Local {
		t.Errorf("the buckets the rules hold the manifests to are %v, production.yaml's %s and %s", Buckets, b.Bucket, b.Local)
	}
	for _, c := range Clusters {
		apps := release(t, c, "apps")
		stores := 0
		for _, o := range apps {
			if o.Kind() != "ObjectStore" {
				continue
			}
			stores++
			if u := Str(o, "spec", "configuration", "endpointURL"); u != b.Endpoint {
				t.Errorf("%s: %s reaches %s, production.yaml's endpoint is %s", c.Name, o.ID(), u, b.Endpoint)
			}
			env := map[string]any{"env": Get(o, "spec", "instanceSidecarConfiguration", "env")}
			if r := envValue(env, "AWS_DEFAULT_REGION"); r != b.Region {
				t.Errorf("%s: %s signs for the region %q, production.yaml's is %s", c.Name, o.ID(), r, b.Region)
			}
			// B2 is S3-compatible, not S3: a download's checksum is checked
			// only where one is required.
			if envValue(env, "AWS_RESPONSE_CHECKSUM_VALIDATION") != "when_required" {
				t.Errorf("%s: %s does not set AWS_RESPONSE_CHECKSUM_VALIDATION", c.Name, o.ID())
			}
			// An upload keeps the SDK's default, a checksum with each: the
			// bucket's Object Lock refuses an upload that has none.
			if v := envValue(env, "AWS_REQUEST_CHECKSUM_CALCULATION"); v != "" {
				t.Errorf("%s: %s sets AWS_REQUEST_CHECKSUM_CALCULATION to %q, and a locked bucket refuses an upload without a checksum", c.Name, o.ID(), v)
			}
		}
		if stores != 2 {
			t.Errorf("%s: %d object stores, want the archive's and the restore test's", c.Name, stores)
		}
		if s := Str(Find(apps, "ObjectStore", ObjectStore), "spec", "retentionPolicy"); s != "30d" {
			t.Errorf("%s: backups are kept %q", c.Name, s)
		}
		remote := envValue(Container(PodSpec(Find(apps, "CronJob", "keel-db-dump")), "containers", "upload"), "DUMP_REMOTE")
		want := "b2:" + b.Dumps + "/prod"
		if c.Name == "local" {
			// The local dump is made and read back, and uploaded nowhere.
			want = ":memory:keel-db-dumps/local"
		}
		if remote != want {
			t.Errorf("%s: the dump goes to %q, want %s", c.Name, remote, want)
		}
	}
	store := Find(release(t, prod, "configs"), "ClusterSecretStore", BackupsStore)
	inf := Get(store, "spec", "provider", "infisical")
	if h := Str(inf, "hostAPI"); h != strings.TrimSuffix(p.Infisical.Host, "/")+"/api" {
		t.Errorf("the backups' store's hostAPI %s", h)
	}
	if slug := Str(inf, "secretsScope", "projectSlug"); p.Infisical.Backups.Slug != "" && slug != p.Infisical.Backups.Slug {
		t.Errorf("the backups' store reads the project %q, production.yaml names %q", slug, p.Infisical.Backups.Slug)
	}
	if slug := Str(inf, "secretsScope", "projectSlug"); slug == p.Infisical.Cluster.Slug || Str(inf, "secretsScope", "environmentSlug") != p.Infisical.Environment {
		t.Errorf("the backups' store reads %q, the cluster's own project, or another environment", slug)
	}
	// It reads with the credential the other store reads with.
	other := Get(Find(release(t, prod, "configs"), "ClusterSecretStore", SecretStore), "spec", "provider", "infisical", "auth")
	if !reflect.DeepEqual(Get(inf, "auth"), other) {
		t.Errorf("the backups' store signs in with %v", Get(inf, "auth"))
	}
}

// TestDeployWithoutBackups: a deploy on a Mac with no key to the bucket
// leaves out everything that would reach it, and keeps the rest; one with
// the key is a release's local game.
func TestDeployWithoutBackups(t *testing.T) {
	rm, err := readRepoTree(t).RenderDeploy(Deploy{Build: "0123456789ab", Host: "harbour.local", NoBackups: true})
	objs := objectsOf(t, rm, err)
	if err := CheckRules(objs, Target{Cluster: local.Name, Deploy: true, NoBackups: true}); err != nil {
		t.Fatal(err)
	}
	for _, o := range objs {
		if o.Kind() == "ObjectStore" || o.Kind() == "ScheduledBackup" || o.ID() == "CronJob/"+RestoreTest {
			t.Errorf("%s is left", o.ID())
		}
	}
	db := Find(objs, "Cluster", database)
	if Get(db, "spec", "plugins") != nil || Get(db, "spec", "bootstrap", "initdb") == nil {
		t.Errorf("the database without backups: plugins %v", Get(db, "spec", "plugins"))
	}
	// The dump, the roles, the scrapes and the alerts stay.
	for _, id := range []string{"CronJob/keel-db-dump", "VMPodScrape/keel-db", "VMRule/keel", "Service/keel-db-forward", "Namespace/" + RestoreNamespace} {
		kind, name, _ := strings.Cut(id, "/")
		if Find(objs, kind, name) == nil {
			t.Errorf("%s is gone too", id)
		}
	}
	// Left out by mistake, the rules say so.
	full := deployed(t)
	if err := CheckRules(full, Target{Cluster: local.Name, Deploy: true, NoBackups: true}); err == nil || !strings.Contains(err.Error(), "left in a deploy without backups") {
		t.Errorf("a full deploy checked as one without backups: %v", err)
	}
	if err := CheckRules(objs, Target{Cluster: local.Name, Deploy: true}); err == nil || !strings.Contains(err.Error(), "the database's archive:") {
		t.Errorf("a deploy without backups checked as a full one: %v", err)
	}
	if err := CheckRules(release(t, prod, "apps"), Target{Cluster: prod.Name, NoBackups: true, K3s: k3s(t)}); err == nil || !strings.Contains(err.Error(), "only a deploy") {
		t.Errorf("production without backups: %v", err)
	}
}

// TestDeployRebuilt: a deploy with rebuild is the local game with its
// database recovered from the local bucket's live archive, archiving as the
// next; without a key there is nothing to recover.
func TestDeployRebuilt(t *testing.T) {
	rm, err := readRepoTree(t).RenderDeploy(Deploy{Build: "0123456789ab", Host: "harbour.local", Rebuild: true})
	objs := objectsOf(t, rm, err)
	if err := CheckRules(objs, Target{Cluster: local.Name, Deploy: true, Rebuild: true}); err != nil {
		t.Fatal(err)
	}
	live, rebuilt, err := Generations(objs)
	if err != nil {
		t.Fatal(err)
	}
	db := Find(objs, "Cluster", database)
	if Str(db, "spec", "plugins", 0, "parameters", "serverName") != rebuilt || Str(db, "spec", "externalClusters", 0, "plugin", "parameters", "serverName") != live ||
		Get(db, "spec", "bootstrap", "initdb") != nil {
		t.Errorf("the rebuilt local database: %v, %v", Get(db, "spec", "plugins"), Get(db, "spec", "externalClusters"))
	}
	if b := Str(Find(objs, "ObjectStore", ObjectStore), "spec", "configuration", "destinationPath"); b != "s3://"+Buckets["local"]+"/" {
		t.Errorf("it recovers from %s", b)
	}
	if err := CheckRules(objs, Target{Cluster: local.Name, Deploy: true}); err == nil || !strings.Contains(err.Error(), "the database's archive:") {
		t.Errorf("a rebuilt deploy checked as a live one: %v", err)
	}
	if _, err := readRepoTree(t).RenderDeploy(Deploy{Build: "0123456789ab", Host: "harbour.local", Rebuild: true, NoBackups: true}); err == nil {
		t.Error("a rebuild with no backups was rendered")
	}
}

// TestLocalMonitoringIsSmaller: the local cluster keeps less, in less.
func TestLocalMonitoringIsSmaller(t *testing.T) {
	values := func(c Cluster) any {
		return Get(Find(release(t, c, "monitoring"), "HelmRelease", "victoria-metrics-k8s-stack"), "spec", "values")
	}
	for _, tc := range []struct {
		c                     Cluster
		metrics, logs, logCap string
	}{{prod, "90d", "14d", "20GiB"}, {local, "7d", "3d", "2GiB"}} {
		v := values(tc.c)
		vl := Find(release(t, tc.c, "monitoring"), "VLSingle", "keel")
		if Str(v, "vmsingle", "spec", "retentionPeriod") != tc.metrics || Str(vl, "spec", "retentionPeriod") != tc.logs || Str(vl, "spec", "retentionMaxDiskSpaceUsageBytes") != tc.logCap {
			t.Errorf("%s keeps metrics %s and logs %s or %s", tc.c.Name, Str(v, "vmsingle", "spec", "retentionPeriod"), Str(vl, "spec", "retentionPeriod"), Str(vl, "spec", "retentionMaxDiskSpaceUsageBytes"))
		}
		// Grafana keeps nothing of its own, anywhere.
		if Get(v, "grafana", "persistence", "enabled") != false {
			t.Errorf("%s: Grafana keeps state", tc.c.Name)
		}
	}
	// Otherwise the two are one: but for sizes, nothing differs.
	a, b := release(t, prod, "monitoring"), release(t, local, "monitoring")
	var onlyProd []string
	for _, o := range a {
		if inNamespace(b, o.Kind(), Str(o, "metadata", "namespace"), o.Name()) == nil {
			onlyProd = append(onlyProd, o.ID())
		}
	}
	slices.Sort(onlyProd)
	if want := []string{"ExternalSecret/grafana-admin", "ExternalSecret/grafana-db", "VMPodScrape/kured"}; !slices.Equal(onlyProd, want) {
		t.Errorf("production's monitoring alone has %v, want %v", onlyProd, want)
	}
}

// TestKeyedSources: each source Flux cannot verify is in the manifests as
// listed, with no verify, and its publisher's key is in the repository;
// each image its values pin is one the list says to check.
func TestKeyedSources(t *testing.T) {
	controllers := release(t, prod, "controllers")
	for _, k := range KeyedSources {
		data, err := os.ReadFile(filepath.Join("..", "..", "..", k.Key))
		if err != nil {
			t.Fatal(err)
		}
		if block, rest := pem.Decode(data); block == nil || block.Type != "PUBLIC KEY" || len(bytes.TrimSpace(rest)) != 0 {
			t.Errorf("%s is not one public key", k.Key)
		}
		repo := Find(controllers, "OCIRepository", k.Name)
		if repo == nil || keyed(repo) == nil || Get(repo, "spec", "verify") != nil || k.Why == "" {
			t.Errorf("%s: %v", k.Name, Get(repo, "spec"))
		}
		got := ImageValues(Get(Find(controllers, "HelmRelease", k.Name), "spec", "values"))
		var want []string
		for p := range k.Images {
			want = append(want, p)
		}
		slices.Sort(want)
		if !slices.Equal(got, want) {
			t.Errorf("%s: its values pin images at %v, the list checks %v", k.Name, got, want)
		}
	}
	// Every other source is verified by Flux: none slipped onto no list.
	for _, c := range Clusters {
		for _, o := range all(t, c) {
			if o.Kind() == "OCIRepository" && Get(o, "spec", "verify") == nil && keyed(o) == nil {
				t.Errorf("%s: %s is verified by nothing", c.Name, o.ID())
			}
		}
	}
	// The vendored manifests' images: each named by a tag and a digest,
	// which the release workflow checks the signature of.
	for _, s := range SignedImages {
		found := false
		for _, o := range controllers {
			for _, c := range Containers(PodSpec(o)) {
				if img, _ := c["image"].(string); strings.HasPrefix(img, s.Image+":") && byDigest(img) {
					found = true
				}
			}
		}
		if !found || !strings.HasPrefix(s.Subject, "^https://github\\.com/") || !strings.HasSuffix(s.Subject, "@refs/tags/%s$") {
			t.Errorf("%s: found %v, signed by %s", s.Image, found, s.Subject)
		}
	}
}

// TestQuietWindows: what interrupts or loads the game runs in its own
// hour of the US night, UTC, no two on one day but the daily base backup: the dump
// on Monday, the restore test on Tuesday, reboots on Wednesday, k3s
// upgrades on Thursday.
func TestQuietWindows(t *testing.T) {
	apps, controllers, configs := release(t, prod, "apps"), release(t, prod, "controllers"), release(t, prod, "configs")
	if s := Str(Find(apps, "ScheduledBackup", "keel-db-daily"), "spec", "schedule"); s != "0 0 8 * * *" {
		t.Errorf("base backups at %q", s)
	}
	for name, want := range map[string]string{"keel-db-dump": "0 9 * * 1", RestoreTest: "0 9 * * 2"} {
		cj := Find(apps, "CronJob", name)
		if Str(cj, "spec", "schedule") != want || Str(cj, "spec", "timeZone") != "Etc/UTC" || Str(cj, "spec", "concurrencyPolicy") != "Forbid" {
			t.Errorf("%s runs at %q in %q", name, Str(cj, "spec", "schedule"), Str(cj, "spec", "timeZone"))
		}
	}
	// Kured asks for the series ALERTS with Prometheus' query API, which
	// the metrics store answers and vmalert does not; an answer it cannot
	// get stops every reboot. So: the store the monitoring layer makes, at
	// its own port, which its NetworkPolicy lets Kured in to.
	monitoring := release(t, prod, "monitoring")
	// The operator names a VMSingle's Service vmsingle-<its name>, and the
	// chart names the VMSingle by fullnameOverride.
	var store string
	for _, o := range monitoring {
		if name := Str(o, "spec", "values", "fullnameOverride"); o.Kind() == "HelmRelease" && Get(o, "spec", "values", "vmsingle") != nil && name != "" {
			store = "http://vmsingle-" + name + "." + Str(o, "metadata", "namespace") + ".svc:8428"
		}
	}
	kured := strings.Join(toStrings(List(Containers(PodSpec(Find(controllers, "DaemonSet", "kured")))[0], "command")), " ")
	for _, want := range []string{"--reboot-days=we", "--start-time=08:00", "--end-time=10:00", "--time-zone=UTC", "--drain-timeout=10m", "--ds-namespace=kured",
		"--prometheus-url=" + store + " ", "--alert-filter-regexp=^(Watchdog|RebootPending|UpdatesPending)$", "--alert-firing-only=true"} {
		if store == "" || !strings.Contains(kured+" ", want) {
			t.Errorf("Kured runs without %s: %s", want, kured)
		}
	}
	admitted := false
	for _, in := range List(Find(monitoring, "NetworkPolicy", "vmsingle"), "spec", "ingress") {
		for _, from := range List(in, "from") {
			if Str(from, "namespaceSelector", "matchLabels", "kubernetes.io/metadata.name") == "kured" && Str(from, "podSelector", "matchLabels", "name") == "kured" {
				for _, p := range List(in, "ports") {
					admitted = admitted || fmt.Sprint(Get(p, "port")) == "8428"
				}
			}
		}
	}
	if !admitted {
		t.Error("the metrics store's NetworkPolicy does not let Kured in to 8428")
	}
	if strings.Contains(kured, "--force-reboot") {
		t.Error("Kured forces a reboot a drain did not finish for")
	}
	w := Get(Find(configs, "Plan", "k3s-server"), "spec", "window")
	if !slices.Equal(toStrings(List(w, "days")), []string{"thursday"}) || Str(w, "startTime") != "08:00" || Str(w, "endTime") != "10:00" {
		t.Errorf("k3s upgrades in %v", w)
	}
	// Kured and the upgrade controller are production's alone.
	for _, o := range all(t, local) {
		if ns := Str(o, "metadata", "namespace"); ns == "kured" || ns == "system-upgrade" || o.Kind() == "Plan" {
			t.Errorf("the local cluster has %s", o.ID())
		}
	}
}

func toStrings(l []any) []string {
	var out []string
	for _, v := range l {
		s, _ := v.(string)
		out = append(out, s)
	}
	return out
}

// TestForwards: each forward has its own address and its own port on the
// Mac, and the machine's journal goes to VictoriaLogs' (the playbook's
// observe role names it; a test there cannot read this, so it is held
// here).
func TestForwards(t *testing.T) {
	ips, ports := map[string]bool{}, map[int]bool{}
	for _, f := range Forwards {
		if ips[f.IP] || ports[f.Local] || f.What == "" {
			t.Errorf("%s/%s shares its address or its local port, or says nothing", f.Namespace, f.Service)
		}
		ips[f.IP], ports[f.Local] = true, true
	}
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "infra", "ansible", "roles", "observe", "defaults", "main.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var defaults map[string]any
	if err := yaml.Unmarshal(data, &defaults); err != nil {
		t.Fatal(err)
	}
	i := slices.IndexFunc(Forwards, func(f Forward) bool { return f.Service == "victoria-logs" })
	if want := "http://" + Forwards[i].IP + ":9428/insert/journald"; defaults["observe_logs_url"] != want {
		t.Errorf("the journal is sent to %v, VictoriaLogs is at %s", defaults["observe_logs_url"], want)
	}
	// The scraper's port on keel is the metrics listener's, and no other.
	apps := release(t, prod, "apps")
	keel := Container(PodSpec(Find(apps, "Deployment", Deployment)), "containers", "keel")
	internal, err := internalPort(apps)
	if err != nil {
		t.Fatal(err)
	}
	if m := containerPort(keel, "metrics"); m == 0 || m == internal || Str(Find(apps, "VMPodScrape", "keel"), "spec", "podMetricsEndpoints", 0, "port") != "metrics" {
		t.Errorf("keel's metrics are scraped on %d, its internal listener is %d", m, internal)
	}
}
