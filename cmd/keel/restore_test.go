// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/pem"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/store/storetest"
)

// fakeAPI is the Kubernetes API as the restore test sees it: Clusters in
// one namespace, made, read and deleted, and the Secret the operator makes
// for a cluster's owner. A cluster made becomes ready after readyAfter
// reads, or never, when readyAfter is 0.
type fakeAPI struct {
	t          *testing.T
	readyAfter int

	mu       sync.Mutex
	clusters map[string]map[string]any
	reads    int
	made     []map[string]any
	deleted  int
}

const fakeToken = "the-pods-token"

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+fakeToken {
		http.Error(w, `{"message":"Unauthorized"}`, http.StatusUnauthorized)
		return
	}
	const clusters = "/apis/postgresql.cnpg.io/v1/namespaces/keel-restore/clusters"
	name := strings.TrimPrefix(r.URL.Path, clusters+"/")
	switch {
	case r.Method == http.MethodPost && r.URL.Path == clusters:
		var c map[string]any
		if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		n := c["metadata"].(map[string]any)["name"].(string)
		if f.clusters[n] != nil {
			http.Error(w, `{"message":"already exists"}`, http.StatusConflict)
			return
		}
		f.clusters[n] = c
		f.made = append(f.made, c)
		f.reads = 0
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(c)
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, clusters+"/"):
		c := f.clusters[name]
		if c == nil {
			http.Error(w, `{"message":"clusters.postgresql.cnpg.io \"`+name+`\" not found"}`, http.StatusNotFound)
			return
		}
		f.reads++
		status := map[string]any{"phase": "Setting up primary", "phaseReason": "Creating primary instance"}
		if f.readyAfter > 0 && f.reads >= f.readyAfter {
			status = map[string]any{"phase": "Cluster in healthy state", "conditions": []any{map[string]any{"type": "Ready", "status": "True"}}}
		}
		c["status"] = status
		json.NewEncoder(w).Encode(c)
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, clusters+"/"):
		if f.clusters[name] == nil {
			http.Error(w, `{"message":"not found"}`, http.StatusNotFound)
			return
		}
		delete(f.clusters, name)
		f.deleted++
		json.NewEncoder(w).Encode(map[string]any{"status": "Success"})
	case r.Method == http.MethodGet && r.URL.Path == "/api/v1/namespaces/keel-restore/secrets/keel-restore-check-app":
		if f.clusters[restoreCluster] == nil {
			http.Error(w, `{"message":"not found"}`, http.StatusNotFound)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"data": map[string][]byte{
			"username": []byte("keel"), "password": []byte("made-by-the-operator"), "dbname": []byte("keel"),
		}})
	default:
		f.t.Errorf("an unexpected request: %s %s", r.Method, r.URL.Path)
		http.Error(w, `{"message":"forbidden"}`, http.StatusForbidden)
	}
}

// restoreRig is a restorer against a fake API server, whose restored
// database is a test database of the case's own.
type restoreRig struct {
	api *fakeAPI
	r   *restorer
	log *bytes.Buffer
}

func newRestoreRig(t *testing.T, readyAfter int, database string) *restoreRig {
	t.Helper()
	api := &fakeAPI{t: t, readyAfter: readyAfter, clusters: map[string]map[string]any{}}
	srv := httptest.NewTLSServer(api)
	t.Cleanup(srv.Close)
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw})
	dir := t.TempDir()
	for name, data := range map[string]string{"ca.crt": string(ca), "token": fakeToken + "\n", "namespace": "keel-restore\n"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	host, port, _ := strings.Cut(strings.TrimPrefix(srv.URL, "https://"), ":")
	k, err := inCluster(env(map[string]string{"KUBERNETES_SERVICE_HOST": host, "KUBERNETES_SERVICE_PORT": port}), dir)
	if err != nil {
		t.Fatal(err)
	}
	var log bytes.Buffer
	r := &restorer{
		kube: k, log: slog.New(slog.NewJSONHandler(&log, nil)), poll: time.Millisecond,
		cfg: restoreConfig{
			Source: "keel-db-g3", ObjectStore: "keel-b2-read", MaxConnections: "100",
			Image: "ghcr.io/cloudnative-pg/postgresql:18.6-minimal-trixie@sha256:37ade18dbdddba430858c72725aceeec66f33fa5333e82ea1df4942f6c1c83a3",
			Wait:  2 * time.Second, MaxAge: 24 * time.Hour,
		},
	}
	r.read = func(ctx context.Context, user, password, db string) (store.Restored, error) {
		if user != "keel" || password != "made-by-the-operator" || db != "keel" {
			t.Errorf("connected as %s/%s to %s", user, password, db)
		}
		return store.ReadRestored(ctx, store.RestoredDB{URL: database})
	}
	return &restoreRig{api: api, r: r, log: &log}
}

// played makes a test database as one the game has run: a world, its
// partitions, a checkpoint written ago and an event.
func played(t *testing.T, checkpointAgo string) string {
	t.Helper()
	u := storetest.URL(t)
	pool := storetest.PoolOn(t, u)
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO world (number, epoch, state) VALUES (1, now(), 'active');
		SELECT create_world_partitions(id) FROM world;
		INSERT INTO checkpoint (world_id, tick, format, build, catalog, layout, epoch, boats, data, written_at)
		  SELECT id, 1, 1, 'b', 'c', 1, 1, 0, '', now() - interval '`+checkpointAgo+`' FROM world;
		INSERT INTO event (world_id, tick, kind, account_id, boat, written_at)
		  SELECT id, 1, 'launched', uuidv7(), 1, now() - interval '5 days' FROM world`); err != nil {
		t.Fatal(err)
	}
	return u
}

func TestRestorePasses(t *testing.T) {
	rig := newRestoreRig(t, 3, played(t, "1 minute"))
	// A cluster left by a run that was stopped goes first.
	rig.api.clusters[restoreCluster] = map[string]any{"metadata": map[string]any{"name": restoreCluster}}
	res := rig.r.run(context.Background())
	if !res.passed() {
		t.Fatalf("failed: %s\n%s", res.reason, rig.log)
	}
	if len(rig.api.made) != 1 || rig.api.deleted != 2 || len(rig.api.clusters) != 0 {
		t.Fatalf("made %d clusters, deleted %d, %d left", len(rig.api.made), rig.api.deleted, len(rig.api.clusters))
	}
	if res.eventAge < 5*24*time.Hour-time.Minute || res.checkpointAge > time.Hour {
		t.Errorf("the event's age %v, the checkpoint's %v", res.eventAge, res.checkpointAge)
	}
	var line map[string]any
	lines := strings.Split(strings.TrimSpace(rig.log.String()), "\n")
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &line); err != nil {
		t.Fatal(err)
	}
	if line["msg"] != "restore test" || line["result"] != "passed" || line["source"] != "keel-db-g3" || line["schema"] != float64(store.Latest) {
		t.Errorf("the result's line: %v", line)
	}
	if rows, _ := line["rows"].(map[string]any); rows["checkpoint"] != float64(1) {
		t.Errorf("the rows logged: %v", line["rows"])
	}
}

// TestRestoreCluster: the cluster made recovers from the source through
// the plugin, with the read-only object store, has no plugins of its own,
// so never archives, and keeps the schema of a Cluster.
func TestRestoreCluster(t *testing.T) {
	rig := newRestoreRig(t, 1, played(t, "1 minute"))
	if res := rig.r.run(context.Background()); !res.passed() {
		t.Fatalf("failed: %s", res.reason)
	}
	c := rig.api.made[0]
	spec := c["spec"].(map[string]any)
	if _, ok := spec["plugins"]; ok {
		t.Errorf("the restore test's cluster has plugins: %v", spec["plugins"])
	}
	if _, ok := spec["backup"]; ok {
		t.Errorf("the restore test's cluster backs up: %v", spec["backup"])
	}
	rec := spec["bootstrap"].(map[string]any)["recovery"].(map[string]any)
	if rec["source"] != "origin" || rec["database"] != "keel" || rec["owner"] != "keel" || rec["secret"] != nil {
		t.Errorf("the recovery %v", rec)
	}
	ext := spec["externalClusters"].([]any)[0].(map[string]any)
	plugin := ext["plugin"].(map[string]any)
	params := plugin["parameters"].(map[string]any)
	if ext["name"] != "origin" || plugin["name"] != barmanPlugin || params["serverName"] != "keel-db-g3" || params["barmanObjectName"] != "keel-b2-read" {
		t.Errorf("the source %v", ext)
	}
	if p := spec["postgresql"].(map[string]any)["parameters"].(map[string]any); p["max_connections"] != "100" {
		t.Errorf("max_connections %v", p["max_connections"])
	}

	raw, err := os.ReadFile("../../infra/schemas/postgresql.cnpg.io/cluster_v1.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	comp := jsonschema.NewCompiler()
	if err := comp.AddResource("cluster.json", doc); err != nil {
		t.Fatal(err)
	}
	sch, err := comp.Compile("cluster.json")
	if err != nil {
		t.Fatal(err)
	}
	// As JSON, as the API server reads it.
	b, _ := json.Marshal(rig.r.clusterSpec())
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if err := sch.Validate(inst); err != nil {
		t.Errorf("the cluster does not keep the Cluster's schema: %v", err)
	}
}

func TestRestoreFails(t *testing.T) {
	for name, tc := range map[string]struct {
		readyAfter int
		database   func(t *testing.T) string
		want       string
	}{
		"the recovery never finishes": {0, func(t *testing.T) string { return played(t, "1 minute") }, `did not finish in 2s: the cluster is "Setting up primary"`},
		"a table missing": {2, func(t *testing.T) string {
			u := played(t, "1 minute")
			if _, err := storetest.PoolOn(t, u).Exec(context.Background(), "DROP TABLE session"); err != nil {
				t.Fatal(err)
			}
			return u
		}, "it has no table session"},
		"an old checkpoint": {2, func(t *testing.T) string { return played(t, "2 days") }, "its newest checkpoint is 48h0m0s old, more than 24h0m0s"},
		"no world":          {2, func(t *testing.T) string { return storetest.URL(t) }, "its table world is empty; its table checkpoint is empty"},
		"an old schema": {2, func(t *testing.T) string {
			u := storetest.Empty(t)
			if _, err := store.Migrate(context.Background(), u, store.Latest-1); err != nil {
				t.Fatal(err)
			}
			return u
		}, "its schema is at migration"},
	} {
		t.Run(name, func(t *testing.T) {
			rig := newRestoreRig(t, tc.readyAfter, tc.database(t))
			res := rig.r.run(context.Background())
			if res.passed() || !strings.Contains(res.reason, tc.want) {
				t.Fatalf("reason %q, want %q", res.reason, tc.want)
			}
			if len(rig.api.clusters) != 0 {
				t.Errorf("a failed run left its cluster")
			}
			if !strings.Contains(rig.log.String(), `"result":"failed"`) {
				t.Errorf("the log: %s", rig.log)
			}
		})
	}
}

func TestRestoreTestConfig(t *testing.T) {
	var out, errOut bytes.Buffer
	status := run(context.Background(), []string{"restore-test"}, env(map[string]string{"KEEL_RESTORE_WAIT": "soon"}), &out, &errOut)
	for _, want := range []string{"KEEL_RESTORE_SOURCE: required", "KEEL_RESTORE_OBJECT_STORE", "KEEL_RESTORE_IMAGE", "KEEL_RESTORE_MAX_CONNECTIONS", "KEEL_RESTORE_WAIT"} {
		if status != 1 || !strings.Contains(errOut.String(), want) {
			t.Errorf("status %d, stderr %q, want %q", status, errOut.String(), want)
		}
	}
	errOut.Reset()
	status = run(context.Background(), []string{"restore-test"}, env(map[string]string{
		"KEEL_RESTORE_SOURCE": "keel-db-g1", "KEEL_RESTORE_OBJECT_STORE": "keel-b2-read",
		"KEEL_RESTORE_IMAGE": "postgres", "KEEL_RESTORE_MAX_CONNECTIONS": "100",
	}), io.Discard, &errOut)
	if status != 1 || !strings.Contains(errOut.String(), "not in a Kubernetes pod") {
		t.Errorf("outside a pod: status %d, %q", status, errOut.String())
	}
}
