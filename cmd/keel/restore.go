// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"crypto/x509"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

const restoreTestUsage = `usage: keel restore-test

Restores the database from its backups into a throwaway CloudNativePG
cluster, checks what it holds, and deletes it. It runs in a pod whose
service account may make, read and delete Clusters, and read their
Secrets, in its own namespace. The cluster it makes never archives.

It passes, and exits 0, when the database it restored has this build's
schema or a newer one, every table this build's migrations make, a world,
the lease and a checkpoint, the newest checkpoint written less than
KEEL_RESTORE_MAX_AGE before; otherwise it exits 1, saying why. Either way
it logs one line, "restore test", with the result and how long each step
took.

Configured from the environment:
  KEEL_RESTORE_SOURCE           the archive to restore: the live cluster's
                                server name in the object store (required)
  KEEL_RESTORE_OBJECT_STORE     the ObjectStore, in this namespace, that reads
                                the backups (required)
  KEEL_RESTORE_IMAGE            PostgreSQL's image: the live cluster's (required)
  KEEL_RESTORE_MAX_CONNECTIONS  the live cluster's max_connections, which a
                                recovering server must have at least (required)
  KEEL_RESTORE_WAIT             how long the recovery may take (default 45m)
  KEEL_RESTORE_MAX_AGE          how old the newest checkpoint may be (default 24h)
`

// restoreCluster is the cluster the test makes. CloudNativePG names its
// Services and Secrets after it.
const restoreCluster = "keel-restore-check"

// barmanPlugin is the Barman Cloud plugin's name, as a Cluster names it.
const barmanPlugin = "barman-cloud.cloudnative-pg.io"

// restoreConfig is what the test restores, and how long it waits.
type restoreConfig struct {
	Source, ObjectStore, Image, MaxConnections string
	Wait, MaxAge                               time.Duration
}

func loadRestoreConfig(getenv func(string) string) (restoreConfig, error) {
	c := restoreConfig{
		Source:         getenv("KEEL_RESTORE_SOURCE"),
		ObjectStore:    getenv("KEEL_RESTORE_OBJECT_STORE"),
		Image:          getenv("KEEL_RESTORE_IMAGE"),
		MaxConnections: getenv("KEEL_RESTORE_MAX_CONNECTIONS"),
		Wait:           45 * time.Minute,
		MaxAge:         24 * time.Hour,
	}
	var errs []error
	for name, v := range map[string]string{
		"KEEL_RESTORE_SOURCE": c.Source, "KEEL_RESTORE_OBJECT_STORE": c.ObjectStore,
		"KEEL_RESTORE_IMAGE": c.Image, "KEEL_RESTORE_MAX_CONNECTIONS": c.MaxConnections,
	} {
		if v == "" {
			errs = append(errs, fmt.Errorf("%s: required", name))
		}
	}
	for name, d := range map[string]*time.Duration{"KEEL_RESTORE_WAIT": &c.Wait, "KEEL_RESTORE_MAX_AGE": &c.MaxAge} {
		if v := getenv(name); v != "" {
			p, err := time.ParseDuration(v)
			if err != nil || p <= 0 {
				errs = append(errs, fmt.Errorf("%s: %q is not a positive duration", name, v))
			}
			*d = p
		}
	}
	return c, errors.Join(errs...)
}

// errRestoreFailed is a restore test that ran and failed: it has said why.
var errRestoreFailed = errors.New("the restore test failed")

func restoreTest(ctx context.Context, args []string, getenv func(string) string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("restore-test", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { io.WriteString(stderr, restoreTestUsage) }
	if err := fs.Parse(args); err != nil {
		return errUsage
	}
	if fs.NArg() > 0 {
		fs.Usage()
		return errUsage
	}
	cfg, err := loadRestoreConfig(getenv)
	if err != nil {
		return err
	}
	k, err := inCluster(getenv, serviceAccountDir)
	if err != nil {
		return err
	}
	r := &restorer{kube: k, cfg: cfg, log: obs.NewLogger(stdout, slog.LevelInfo, buildID()), poll: 5 * time.Second}
	r.read = r.readTLS
	if !r.run(ctx).passed() {
		return errRestoreFailed
	}
	return nil
}

// restorer makes the cluster, waits for it, checks it and deletes it.
type restorer struct {
	kube *kube
	cfg  restoreConfig
	log  *slog.Logger
	// poll is how often the cluster is looked at while it is made or
	// deleted.
	poll time.Duration
	// read reads the restored database as its owner; tests replace it.
	read func(ctx context.Context, user, password, database string) (store.Restored, error)
}

// restoreResult is what one run found.
type restoreResult struct {
	reason                   string // why it failed; "" when it passed
	made, recovered, checked time.Duration
	restored                 store.Restored
	checkpointAge, eventAge  time.Duration
}

func (r restoreResult) passed() bool { return r.reason == "" }

// clusterPath is the API's path of the namespace's Clusters, or of one.
func (r *restorer) clusterPath(name string) string {
	p := "/apis/postgresql.cnpg.io/v1/namespaces/" + url.PathEscape(r.kube.Namespace) + "/clusters"
	if name != "" {
		p += "/" + url.PathEscape(name)
	}
	return p
}

// clusterSpec is the cluster the test makes: one instance, recovered from
// the source's archive through the Barman Cloud plugin, as the live
// cluster's owner and database, with a password the operator makes. It has
// no plugins of its own: it never archives, and so can never write into
// the archive it reads. It takes the live cluster's image, and its
// max_connections, which a recovering server must match at least
// (PostgreSQL's "Hot Standby": it is among the settings a standby checks
// against the primary's). Small otherwise: it is checked, not served from.
func (r *restorer) clusterSpec() map[string]any {
	return map[string]any{
		"apiVersion": "postgresql.cnpg.io/v1",
		"kind":       "Cluster",
		"metadata": map[string]any{
			"name":      restoreCluster,
			"namespace": r.kube.Namespace,
			"labels":    map[string]any{"app.kubernetes.io/name": restoreCluster, "app.kubernetes.io/part-of": "keel"},
		},
		"spec": map[string]any{
			"instances":             1,
			"imageName":             r.cfg.Image,
			"enableSuperuserAccess": false,
			"enablePDB":             false,
			"smartShutdownTimeout":  10,
			"storage":               map[string]any{"storageClass": "local-path", "size": "40Gi"},
			"resources": map[string]any{
				"requests": map[string]any{"cpu": "250m", "memory": "1Gi"},
				"limits":   map[string]any{"memory": "1Gi"},
			},
			"postgresql": map[string]any{
				"parameters": map[string]any{
					"shared_buffers":  "256MB",
					"max_connections": r.cfg.MaxConnections,
				},
				"pg_hba": []any{"hostnossl all all all reject"},
			},
			"bootstrap": map[string]any{
				"recovery": map[string]any{"source": "origin", "database": "keel", "owner": "keel"},
			},
			"externalClusters": []any{map[string]any{
				"name": "origin",
				"plugin": map[string]any{
					"name":       barmanPlugin,
					"parameters": map[string]any{"barmanObjectName": r.cfg.ObjectStore, "serverName": r.cfg.Source},
				},
			}},
		},
	}
}

// run runs the test and logs its result, and leaves no cluster behind.
func (r *restorer) run(ctx context.Context) restoreResult {
	start := time.Now()
	res := r.restore(ctx)
	// A cancelled run still deletes what it made.
	dctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Minute)
	defer cancel()
	if err := r.remove(dctx); err != nil && res.passed() {
		res.reason = "deleting the cluster: " + err.Error()
	}
	attrs := []any{
		"source", r.cfg.Source,
		"made_s", res.made.Seconds(), "recovered_s", res.recovered.Seconds(), "checked_s", res.checked.Seconds(),
		"total_s", time.Since(start).Round(time.Second).Seconds(),
	}
	if res.restored.Rows != nil {
		attrs = append(attrs, "schema", res.restored.Version, "rows", res.restored.Rows,
			"checkpoint_age_s", res.checkpointAge.Round(time.Second).Seconds(), "event_age_s", res.eventAge.Round(time.Second).Seconds())
	}
	if res.passed() {
		r.log.Info("restore test", append([]any{"result", "passed"}, attrs...)...)
	} else {
		r.log.Error("restore test", append([]any{"result", "failed", "reason", res.reason}, attrs...)...)
	}
	return res
}

// restore makes the cluster, waits for its recovery, and checks it.
func (r *restorer) restore(ctx context.Context) (res restoreResult) {
	fail := func(format string, a ...any) restoreResult {
		res.reason = fmt.Sprintf(format, a...)
		return res
	}
	// What a run that was stopped left.
	if err := r.remove(ctx); err != nil {
		return fail("removing a cluster left from before: %v", err)
	}
	start := time.Now()
	if err := r.kube.do(ctx, http.MethodPost, r.clusterPath(""), r.clusterSpec(), nil); err != nil {
		return fail("making the cluster: %v", err)
	}
	res.made = time.Since(start)
	r.log.Info("restoring", "cluster", restoreCluster, "source", r.cfg.Source, "object_store", r.cfg.ObjectStore)
	if err := r.waitReady(ctx); err != nil {
		res.recovered = time.Since(start)
		return fail("%v", err)
	}
	res.recovered = time.Since(start)
	checked := time.Now()
	defer func() { res.checked = time.Since(checked) }()

	var app struct{ Data map[string][]byte }
	if err := r.kube.do(ctx, http.MethodGet, "/api/v1/namespaces/"+url.PathEscape(r.kube.Namespace)+"/secrets/"+restoreCluster+"-app", nil, &app); err != nil {
		return fail("reading the restored database's password: %v", err)
	}
	var err error
	res.restored, err = r.read(ctx, string(app.Data["username"]), string(app.Data["password"]), string(app.Data["dbname"]))
	if err != nil {
		return fail("reading the restored database: %v", err)
	}
	now := time.Now()
	if !res.restored.Checkpoint.IsZero() {
		res.checkpointAge = now.Sub(res.restored.Checkpoint)
	}
	if !res.restored.Event.IsZero() {
		res.eventAge = now.Sub(res.restored.Event)
	}
	return checkRestored(res, r.cfg.MaxAge)
}

// checkRestored fails res when what was restored is not what a database
// that has run the game holds: this build's schema at least, every table,
// a world, the lease and a checkpoint, and that checkpoint recent. The game
// writes its checkpoint every few seconds while it runs, so an old one
// means the archive stopped. Events are written only when boats launch and
// return, which an empty sea may not see for days: their age is reported,
// not judged.
func checkRestored(res restoreResult, maxAge time.Duration) restoreResult {
	d := res.restored
	var why []string
	if d.Version < store.Latest {
		why = append(why, fmt.Sprintf("its schema is at migration %d, this build's is %d", d.Version, store.Latest))
	}
	if len(d.Missing) > 0 {
		why = append(why, "it has no table "+strings.Join(d.Missing, ", "))
	}
	for _, t := range []string{"world", "sim_lease", "checkpoint"} {
		if n, ok := d.Rows[t]; ok && n == 0 {
			why = append(why, "its table "+t+" is empty")
		}
	}
	if !d.Checkpoint.IsZero() && res.checkpointAge > maxAge {
		why = append(why, fmt.Sprintf("its newest checkpoint is %s old, more than %s", res.checkpointAge.Round(time.Minute), maxAge))
	}
	res.reason = strings.Join(why, "; ")
	return res
}

// waitReady waits for the cluster's Ready condition, as long as the
// recovery may take, logging each phase it passes through.
func (r *restorer) waitReady(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, r.cfg.Wait)
	defer cancel()
	var c struct {
		Status struct {
			Phase, PhaseReason string
			Conditions         []struct{ Type, Status, Message string }
		}
	}
	last := ""
	for {
		err := r.kube.do(ctx, http.MethodGet, r.clusterPath(restoreCluster), nil, &c)
		if err != nil && ctx.Err() == nil {
			return fmt.Errorf("reading the cluster: %w", err)
		}
		if p := c.Status.Phase; p != last {
			r.log.Info("restoring", "phase", p, "reason", c.Status.PhaseReason)
			last = p
		}
		for _, cond := range c.Status.Conditions {
			if cond.Type == "Ready" && cond.Status == "True" {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("the recovery did not finish in %s: the cluster is %q (%s)", r.cfg.Wait, c.Status.Phase, c.Status.PhaseReason)
		case <-time.After(r.poll):
		}
	}
}

// remove deletes the cluster, if it is there, and waits until it is gone:
// CloudNativePG deletes its instance and its volume with it.
func (r *restorer) remove(ctx context.Context) error {
	err := r.kube.do(ctx, http.MethodDelete, r.clusterPath(restoreCluster), nil, nil)
	if notFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for {
		err := r.kube.do(ctx, http.MethodGet, r.clusterPath(restoreCluster), nil, nil)
		if notFound(err) {
			return nil
		}
		if err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(r.poll):
		}
	}
}

// readTLS reads the restored cluster's primary through its Service,
// checking its certificate against the CA CloudNativePG made for it, as the
// game checks its own database's.
func (r *restorer) readTLS(ctx context.Context, user, password, database string) (store.Restored, error) {
	var ca struct{ Data map[string][]byte }
	if err := r.kube.do(ctx, http.MethodGet, "/api/v1/namespaces/"+url.PathEscape(r.kube.Namespace)+"/secrets/"+restoreCluster+"-ca", nil, &ca); err != nil {
		return store.Restored{}, fmt.Errorf("reading its CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca.Data["ca.crt"]) {
		return store.Restored{}, errors.New("its CA holds no certificate")
	}
	host := restoreCluster + "-rw." + r.kube.Namespace + ".svc"
	return store.ReadRestored(ctx, store.RestoredDB{
		URL:  "postgres://" + host + ":5432/" + url.PathEscape(database) + "?application_name=keel%20restore-test",
		User: user, Password: password, RootCAs: pool,
	})
}
