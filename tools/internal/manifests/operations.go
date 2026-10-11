// SPDX-License-Identifier: AGPL-3.0-only

package manifests

import (
	"errors"
	"fmt"
	"maps"
	"net"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// The database's backups, as the manifests name them.
const (
	// BarmanPlugin is the Barman Cloud plugin's name in a Cluster.
	BarmanPlugin = "barman-cloud.cloudnative-pg.io"
	// ObjectStore is the live cluster's object store, and RestoreStore the
	// restore test's, which reads the same bucket with another key.
	ObjectStore  = "keel-b2"
	RestoreStore = "keel-b2-read"
	// Generation is the ConfigMap that names the archive generations.
	Generation = "keel-db-archive"
	// RestoreTest is the restore test's CronJob, and RestoreNamespace its
	// namespace.
	RestoreTest      = "keel-restore-test"
	RestoreNamespace = "keel-restore"
)

// archiveName is an archive generation's name: keel-db-g1, keel-db-g2 …
var archiveName = regexp.MustCompile(`^keel-db-g([1-9][0-9]*)$`)

// Buckets are the buckets the database's object stores write to: the
// local cluster's own, and production's.
var Buckets = map[string]string{"local": "keel-db-backups-local", "prod": "keel-db-backups", Rebuild: "keel-db-backups"}

// Generations reads the live and rebuilt archive names from the
// generation's ConfigMap in objs, and checks rebuilt is the generation
// after live.
func Generations(objs []Object) (live, rebuilt string, err error) {
	g := Find(objs, "ConfigMap", Generation)
	if g == nil {
		return "", "", fmt.Errorf("no ConfigMap %s", Generation)
	}
	live, rebuilt = Str(g, "data", "live"), Str(g, "data", "rebuilt")
	l, r := archiveName.FindStringSubmatch(live), archiveName.FindStringSubmatch(rebuilt)
	if l == nil || r == nil {
		return live, rebuilt, fmt.Errorf("%s: live %q and rebuilt %q must be keel-db-g<N>", g.ID(), live, rebuilt)
	}
	ln, _ := strconv.Atoi(l[1])
	rn, _ := strconv.Atoi(r[1])
	if rn != ln+1 {
		return live, rebuilt, fmt.Errorf("%s: rebuilt %s is not the generation after live %s", g.ID(), rebuilt, live)
	}
	return live, rebuilt, nil
}

// barman is a Cluster's entry for the Barman Cloud plugin, or nil.
func barman(list []any) map[string]any {
	for _, p := range list {
		if m, ok := p.(map[string]any); ok && m["name"] == BarmanPlugin {
			return m
		}
	}
	return nil
}

// envValue is the value of the variable name in a container.
func envValue(c map[string]any, name string) string {
	for _, e := range List(c, "env") {
		if Str(e, "name") == name {
			return Str(e, "value")
		}
	}
	return ""
}

// databaseArchive: the game's database archives its WAL, and takes its
// base backups, to keel-b2 under the live generation's name, or, rebuilt,
// recovers from the live generation and archives under the next. It alone
// archives. A base backup is taken daily and as soon as it is made. The
// restore test restores the archive the database writes, with the
// database's image and max_connections, through an object store of its
// own namespace.
func databaseArchive(objs []Object, t Target) error {
	db := Find(objs, "Cluster", database)
	if db == nil {
		return nil
	}
	var errs []error
	fail := func(format string, a ...any) { errs = append(errs, fmt.Errorf(format, a...)) }
	if t.NoBackups {
		// A deploy with no key to the bucket: nothing may be left that
		// would try to reach it.
		if !t.Deploy {
			return errors.New("only a deploy from the working tree may leave the backups out")
		}
		for _, o := range objs {
			switch {
			case o.Kind() == "ObjectStore", o.Kind() == "ScheduledBackup", o.Kind() == "CronJob" && o.Name() == RestoreTest,
				o.Kind() == "Cluster" && len(List(o, "spec", "plugins")) > 0:
				fail("%s is left in a deploy without backups", o.ID())
			}
		}
		return errors.Join(errs...)
	}
	live, rebuilt, err := Generations(objs)
	if err != nil {
		return err
	}
	writes := live
	if t.Rebuild {
		writes = rebuilt
	}
	plugins := List(db, "spec", "plugins")
	p := barman(plugins)
	if len(plugins) != 1 || p == nil || p["isWALArchiver"] != true ||
		Str(p, "parameters", "barmanObjectName") != ObjectStore || Str(p, "parameters", "serverName") != writes {
		fail("%s: its one plugin must be %s, archiving WAL to %s as %s: %v", db.ID(), BarmanPlugin, ObjectStore, writes, plugins)
	}
	for _, o := range objs {
		if o.Kind() == "Cluster" && o.ID() != db.ID() && barman(List(o, "spec", "plugins")) != nil {
			fail("%s archives too: only %s may", o.ID(), db.ID())
		}
	}
	rec := Get(db, "spec", "bootstrap", "recovery")
	ext := List(db, "spec", "externalClusters")
	if t.Rebuild {
		origin := ext
		if Str(rec, "source") != "origin" || Get(db, "spec", "bootstrap", "initdb") != nil || len(origin) != 1 ||
			Str(origin[0], "name") != "origin" || Str(origin[0], "plugin", "name") != BarmanPlugin ||
			Str(origin[0], "plugin", "parameters", "barmanObjectName") != ObjectStore || Str(origin[0], "plugin", "parameters", "serverName") != live {
			fail("%s: rebuilt, it must recover from %s's %s, through %s, and nothing else", db.ID(), ObjectStore, live, BarmanPlugin)
		}
	} else if rec != nil || len(ext) > 0 {
		fail("%s: recovers from backups outside the rebuild form", db.ID())
	}
	sb := Find(objs, "ScheduledBackup", "keel-db-daily")
	if sb == nil || Str(sb, "spec", "cluster", "name") != database || Str(sb, "spec", "method") != "plugin" ||
		Str(sb, "spec", "pluginConfiguration", "name") != BarmanPlugin || Get(sb, "spec", "immediate") != true {
		fail("no daily base backup of %s through the plugin, taken at once when it is made too", database)
	}
	if cj := Find(objs, "CronJob", RestoreTest); cj != nil {
		c := Container(PodSpec(cj), "containers", "restore-test")
		if v := envValue(c, "KEEL_RESTORE_SOURCE"); v != writes {
			fail("%s restores %q, not %s, the archive the database writes", cj.ID(), v, writes)
		}
		if v := envValue(c, "KEEL_RESTORE_IMAGE"); v != Str(db, "spec", "imageName") {
			fail("%s restores with the image %q, not the database's", cj.ID(), v)
		}
		if v := envValue(c, "KEEL_RESTORE_MAX_CONNECTIONS"); v != Str(db, "spec", "postgresql", "parameters", "max_connections") {
			fail("%s restores with max_connections %q, not the database's", cj.ID(), v)
		}
		if v := envValue(c, "KEEL_RESTORE_OBJECT_STORE"); v != RestoreStore || Str(cj, "metadata", "namespace") != RestoreNamespace {
			fail("%s must run in %s and read through %s, not %q", cj.ID(), RestoreNamespace, RestoreStore, v)
		}
	}
	return errors.Join(errs...)
}

// objectStores: no object store names a server, which each cluster names
// for itself (the plugin's documentation); each writes to its cluster's
// bucket; and the restore test's reads what the live one writes, with a key
// of its own and no retention policy.
func objectStores(objs []Object, t Target) error {
	var errs []error
	live := Find(objs, "ObjectStore", ObjectStore)
	for _, o := range objs {
		if o.Kind() != "ObjectStore" {
			continue
		}
		c := Get(o, "spec", "configuration")
		if Get(c, "serverName") != nil {
			errs = append(errs, fmt.Errorf("%s names a server: each cluster names its own", o.ID()))
		}
		if want := "s3://" + Buckets[t.Cluster] + "/"; Str(c, "destinationPath") != want {
			errs = append(errs, fmt.Errorf("%s writes to %s, not %s's %s", o.ID(), Str(c, "destinationPath"), t.Cluster, want))
		}
		if o.Name() != RestoreStore {
			continue
		}
		if Get(o, "spec", "retentionPolicy") != nil {
			errs = append(errs, fmt.Errorf("%s has a retention policy: the restore test removes nothing", o.ID()))
		}
		if live == nil {
			continue
		}
		strip := func(o Object) string {
			c := maps.Clone(Get(o, "spec", "configuration").(map[string]any))
			delete(c, "s3Credentials")
			return fmt.Sprint(c, Get(o, "spec", "instanceSidecarConfiguration", "env"))
		}
		if strip(o) != strip(live) || Str(o, "spec", "configuration", "s3Credentials", "accessKeyId", "name") == Str(live, "spec", "configuration", "s3Credentials", "accessKeyId", "name") {
			errs = append(errs, fmt.Errorf("%s must read what %s writes, the same but for its key", o.ID(), live.ID()))
		}
	}
	return errors.Join(errs...)
}

// walkStrings calls f with every string under v, and the path to it.
func walkStrings(v any, path string, f func(path, s string)) {
	switch v := v.(type) {
	case string:
		f(path, v)
	case map[string]any:
		for _, k := range slices.Sorted(maps.Keys(v)) {
			walkStrings(v[k], path+"."+k, f)
		}
	case []any:
		for i, e := range v {
			walkStrings(e, fmt.Sprintf("%s[%d]", path, i), f)
		}
	}
}

// pluginRelease is a plugin's file from its release on GitHub, by its
// version's tag.
var pluginRelease = regexp.MustCompile(`^https://github\.com/[^/]+/[^/]+/releases/download/v[0-9][^/]*/[^/]+$`)

// nothingFetched: nothing is fetched as the cluster deploys but what is
// pinned. No chart value names a branch on raw.githubusercontent.com; the
// monitoring stack's job that downloads dashboards and rules is off, as
// are its own; Grafana installs no plugin from its catalog, and the one
// fetched from its release is checked against its SHA-256 first.
func nothingFetched(objs []Object, _ Target) error {
	var errs []error
	for _, o := range objs {
		if o.Kind() != "HelmRelease" {
			continue
		}
		values := Get(o, "spec", "values")
		walkStrings(values, "values", func(path, s string) {
			if strings.Contains(s, "raw.githubusercontent.com") {
				errs = append(errs, fmt.Errorf("%s: %s names %s", o.ID(), path, s))
			}
		})
		if o.Name() != "victoria-metrics-k8s-stack" {
			continue
		}
		for _, off := range [][]any{{"syncJob", "enabled"}, {"defaultDashboards", "enabled"}, {"defaultRules", "enabled"}} {
			if Get(values, off...) != false {
				errs = append(errs, fmt.Errorf("%s: %v is not false: it would fetch at deploy time", o.ID(), off))
			}
		}
		if p := List(values, "grafana", "plugins"); len(p) > 0 {
			errs = append(errs, fmt.Errorf("%s: Grafana installs %v from its catalog, unpinned", o.ID(), p))
		}
		for _, c := range List(values, "grafana", "extraInitContainers") {
			m, _ := c.(map[string]any)
			if !pluginRelease.MatchString(envValue(m, "PLUGIN_URL")) || !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(envValue(m, "PLUGIN_SHA256")) {
				errs = append(errs, fmt.Errorf("%s: Grafana's init container %s fetches %q without its SHA-256", o.ID(), Str(m, "name"), envValue(m, "PLUGIN_URL")))
			}
		}
	}
	return errors.Join(errs...)
}

// monitoringNamespace is whether ns is one of the monitoring layer's.
func monitoringNamespace(ns string) bool { return ns == "monitoring" || ns == "monitoring-node" }

// noMonitoringRoute: nothing the monitoring layer runs is routed to from
// outside the cluster: no route, Ingress or grant in its namespaces, and no
// route reaching into them. The owner reaches it by the forwards alone.
func noMonitoringRoute(objs []Object, _ Target) error {
	var errs []error
	for _, o := range objs {
		switch o.Kind() {
		case "HTTPRoute", "GRPCRoute", "TCPRoute", "TLSRoute", "UDPRoute", "Ingress", "ReferenceGrant", "IngressRoute", "IngressRouteTCP":
		default:
			continue
		}
		if monitoringNamespace(Str(o, "metadata", "namespace")) {
			errs = append(errs, fmt.Errorf("%s is in %s", o.ID(), Str(o, "metadata", "namespace")))
		}
		for _, r := range List(o, "spec", "rules") {
			for _, b := range List(r, "backendRefs") {
				if monitoringNamespace(Str(b, "namespace")) {
					errs = append(errs, fmt.Errorf("%s routes to %s/%s", o.ID(), Str(b, "namespace"), Str(b, "name")))
				}
			}
		}
	}
	return errors.Join(errs...)
}

// k3sPlan: the plan the upgrade controller upgrades k3s by names the k3s
// release the machines run, and k3s's own upgrade image of that release by
// digest; it cordons the node, never drains it, and runs in its window.
func k3sPlan(objs []Object, t Target) error {
	var errs []error
	for _, o := range objs {
		if o.Kind() != "Plan" || o.group() != "upgrade.cattle.io" {
			continue
		}
		if t.K3s == "" {
			errs = append(errs, fmt.Errorf("%s: no k3s release given to check it against", o.ID()))
			continue
		}
		// k3s's upgrade image is tagged with the release, its + a -.
		want := "rancher/k3s-upgrade:" + strings.ReplaceAll(t.K3s, "+", "-")
		if v := Str(o, "spec", "version"); v != t.K3s {
			errs = append(errs, fmt.Errorf("%s: version %s, but the machines run %s", o.ID(), v, t.K3s))
		}
		if img, _, _ := strings.Cut(Str(o, "spec", "upgrade", "image"), "@"); img != want {
			errs = append(errs, fmt.Errorf("%s: upgrade image %s, want %s", o.ID(), img, want))
		}
		if Get(o, "spec", "cordon") != true || Get(o, "spec", "drain") != nil {
			errs = append(errs, fmt.Errorf("%s: it must cordon the node and never drain it", o.ID()))
		}
		w := Get(o, "spec", "window")
		if len(List(w, "days")) == 0 || Str(w, "startTime") == "" || Str(w, "endTime") == "" || Str(w, "timeZone") != "UTC" {
			errs = append(errs, fmt.Errorf("%s: no window of days, start and end in UTC", o.ID()))
		}
	}
	return errors.Join(errs...)
}

// Forward is a fixed address the owner's Mac forwards a local port to,
// over Tailscale SSH (go run ./tools/ops -tunnel).
type Forward struct {
	Namespace, Service, IP string
	Port, Local            int
	What                   string
}

// Forwards are the fixed addresses, each a Service of its own: what the
// owner reaches from the Mac, and the journal's way to VictoriaLogs.
var Forwards = []Forward{
	{"monitoring", "grafana-forward", "10.43.0.51", 80, 3000, "Grafana"},
	{"monitoring", "vmsingle-forward", "10.43.0.52", 8428, 8428, "VictoriaMetrics' UI (vmui), with vmalert's rules and alerts"},
	{"monitoring", "victoria-logs", "10.43.0.50", 9428, 9428, "VictoriaLogs' UI"},
	{"keel", "keel-db-forward", "10.43.0.53", 5432, 15432, "the database, for psql as reader"},
	{"keel", "keel-internal-forward", "10.43.0.54", 9090, 9090, "keel's internal listener: profiles, the flight recorder"},
}

// staticBand is the part of k3s's Service range (10.43.0.0/16) Kubernetes
// keeps for addresses chosen by hand: the first 256 (KEP-3070).
var staticBand = &net.IPNet{IP: net.IPv4(10, 43, 0, 0), Mask: net.CIDRMask(24, 32)}

// fixedAddresses: a Service whose address is chosen by hand is one of
// Forwards, with its address, in the band kept for them, and its port.
func fixedAddresses(objs []Object, _ Target) error {
	var errs []error
	for _, o := range objs {
		ip := Str(o, "spec", "clusterIP")
		if o.Kind() != "Service" || ip == "" || ip == "None" {
			continue
		}
		ns := Str(o, "metadata", "namespace")
		i := slices.IndexFunc(Forwards, func(f Forward) bool { return f.Namespace == ns && f.Service == o.Name() })
		switch {
		case i < 0:
			errs = append(errs, fmt.Errorf("%s/%s has the address %s chosen by hand, and is not one of the forwards", ns, o.ID(), ip))
		case ip != Forwards[i].IP || !staticBand.Contains(net.ParseIP(ip)):
			errs = append(errs, fmt.Errorf("%s/%s has the address %s, not %s", ns, o.ID(), ip, Forwards[i].IP))
		case len(List(o, "spec", "ports")) != 1 || Get(o, "spec", "ports", 0, "port") != Forwards[i].Port:
			errs = append(errs, fmt.Errorf("%s/%s must have one port, %d", ns, o.ID(), Forwards[i].Port))
		}
	}
	return errors.Join(errs...)
}

// crossRule is a rule a cluster's entry points keep together: what one
// layer names, another provides.
type crossRule struct {
	name  string
	check func(all []Object, t Target) error
}

// crossRules are checked on every cluster's entry points together.
var crossRules = []crossRule{
	{"every forward's Service is there", forwardsThere},
	{"every scrape's port let in from the scraper", scrapesLetIn},
}

// CheckCluster checks a cluster's entry points, all, against the rules
// they keep together.
func CheckCluster(all []Object, t Target) error {
	var errs []error
	for _, r := range crossRules {
		if err := r.check(all, t); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", r.name, err))
		}
	}
	return errors.Join(errs...)
}

// forwardsThere: each forward's Service is in the cluster, once, and no
// two have one address.
func forwardsThere(all []Object, _ Target) error {
	var errs []error
	seen := map[string]string{}
	for _, f := range Forwards {
		if prev, ok := seen[f.IP]; ok {
			errs = append(errs, fmt.Errorf("%s/%s and %s share %s", f.Namespace, f.Service, prev, f.IP))
		}
		seen[f.IP] = f.Namespace + "/" + f.Service
		n := 0
		for _, o := range all {
			if o.Kind() == "Service" && o.Name() == f.Service && Str(o, "metadata", "namespace") == f.Namespace {
				n++
			}
		}
		if n != 1 {
			errs = append(errs, fmt.Errorf("%s/%s is there %d times", f.Namespace, f.Service, n))
		}
	}
	return errors.Join(errs...)
}

// scraper is how a NetworkPolicy names the scraper: vmagent's pods, in
// monitoring.
const scraperName = "vmagent"

// admitsScraper is whether a policy's peer lets the scraper in: vmagent's
// pods in monitoring, or any pod there, or any namespace's.
func admitsScraper(peer any, policyNS string) bool {
	nsSel, hasNS := Get(peer, "namespaceSelector").(map[string]any)
	podSel, hasPod := Get(peer, "podSelector").(map[string]any)
	if Get(peer, "ipBlock") != nil {
		return false
	}
	nsOK := (!hasNS && policyNS == "monitoring") || (hasNS && (len(nsSel) == 0 || Str(nsSel, "matchLabels", "kubernetes.io/metadata.name") == "monitoring"))
	podOK := !hasPod || len(podSel) == 0 || Str(podSel, "matchLabels", "app.kubernetes.io/name") == scraperName
	return nsOK && podOK
}

// selects is whether a pod selector's labels are all among labels.
func selects(sel any, labels map[string]string) bool {
	ml, _ := Get(sel, "matchLabels").(map[string]any)
	for k, v := range ml {
		if labels[k] != v {
			return false
		}
	}
	return len(List(sel, "matchExpressions")) == 0
}

// scrapeTargets are the label sets a pod scrape selects, one for each value
// of an In expression.
func scrapeTargets(o Object) []map[string]string {
	base := map[string]string{}
	if ml, ok := Get(o, "spec", "selector", "matchLabels").(map[string]any); ok {
		for k, v := range ml {
			base[k], _ = v.(string)
		}
	}
	sets := []map[string]string{base}
	for _, e := range List(o, "spec", "selector", "matchExpressions") {
		if Str(e, "operator") != "In" {
			continue
		}
		var next []map[string]string
		for _, set := range sets {
			for _, v := range List(e, "values") {
				m := maps.Clone(set)
				m[Str(e, "key")], _ = v.(string)
				next = append(next, m)
			}
		}
		sets = next
	}
	return sets
}

// workloadPort is the number of the port name on the containers of a
// workload in ns whose pods carry labels, if the manifests hold it.
func workloadPort(all []Object, ns string, labels map[string]string, name string) int {
	for _, o := range all {
		spec := PodSpec(o)
		if spec == nil || Str(o, "metadata", "namespace") != ns {
			continue
		}
		podLabels := map[string]string{}
		if l, ok := Get(o, "spec", "template", "metadata", "labels").(map[string]any); ok {
			for k, v := range l {
				podLabels[k], _ = v.(string)
			}
		}
		match := true
		for k, v := range labels {
			if podLabels[k] != v {
				match = false
			}
		}
		if !match {
			continue
		}
		for _, c := range Containers(spec) {
			if n := containerPort(c, name); n != 0 {
				return n
			}
		}
	}
	return 0
}

// scrapesLetIn: every pod a scrape selects lets the scraper in, by a
// NetworkPolicy beside it, on the scrape's port (its number, when the
// manifests hold the pod); and outside the monitoring layer's own
// namespaces, a policy lets the scraper in only to pods a scrape reads.
func scrapesLetIn(all []Object, _ Target) error {
	var errs []error
	type grant struct {
		policy Object
		ports  []int
	}
	grants := map[string][]grant{} // by namespace
	for _, o := range all {
		if o.Kind() != "NetworkPolicy" {
			continue
		}
		ns := Str(o, "metadata", "namespace")
		for _, r := range List(o, "spec", "ingress") {
			admitted := slices.ContainsFunc(List(r, "from"), func(p any) bool { return admitsScraper(p, ns) })
			if !admitted {
				continue
			}
			var ports []int
			for _, p := range List(r, "ports") {
				n, _ := Get(p, "port").(int)
				ports = append(ports, n)
			}
			grants[ns] = append(grants[ns], grant{o, ports})
		}
	}
	used := map[*grant]bool{}
	for _, o := range all {
		if o.Kind() != "VMPodScrape" {
			continue
		}
		namespaces := []string{Str(o, "metadata", "namespace")}
		if names := List(o, "spec", "namespaceSelector", "matchNames"); len(names) > 0 {
			namespaces = nil
			for _, n := range names {
				s, _ := n.(string)
				namespaces = append(namespaces, s)
			}
		}
		for _, ns := range namespaces {
			for _, labels := range scrapeTargets(o) {
				for _, ep := range List(o, "spec", "podMetricsEndpoints") {
					port := Str(ep, "port")
					number := workloadPort(all, ns, labels, port)
					ok := false
					for i := range grants[ns] {
						g := &grants[ns][i]
						if !selects(Get(g.policy, "spec", "podSelector"), labels) {
							continue
						}
						if (number != 0 && slices.Contains(g.ports, number)) || (number == 0 && len(g.ports) == 1) || len(g.ports) == 0 {
							ok = true
							used[g] = true
						}
					}
					if !ok {
						errs = append(errs, fmt.Errorf("%s reads %s %v on %s, which no NetworkPolicy there lets the scraper in to", o.ID(), ns, labels, port))
					}
				}
			}
		}
	}
	for ns, gs := range grants {
		if monitoringNamespace(ns) || ns == FluxNamespace {
			continue
		}
		for i := range gs {
			// CoreDNS is read by the monitoring stack's own scrape, which
			// its chart makes.
			if ns == "kube-system" && Str(gs[i].policy, "spec", "podSelector", "matchLabels", "k8s-app") == "kube-dns" {
				continue
			}
			if !used[&gs[i]] {
				errs = append(errs, fmt.Errorf("%s/%s lets the scraper in to %v, which no scrape reads", ns, gs[i].policy.ID(), gs[i].ports))
			}
		}
	}
	return errors.Join(errs...)
}
