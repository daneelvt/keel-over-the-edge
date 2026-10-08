// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/testutil"
)

var update = flag.Bool("update", false, "add new migrations to migrations/SUMS (it never changes a line already there)")

const sumsFile = "migrations/SUMS"

// TestMigrationsAppendOnly fails when an applied migration is edited or
// removed: each must keep the SHA-256 recorded in migrations/SUMS. A new
// migration is added to SUMS with -update.
func TestMigrationsAppendOnly(t *testing.T) {
	sums, err := os.ReadFile(sumsFile)
	if err != nil {
		t.Fatal(err)
	}
	problems, added := checkSums(Migrations(), sums)
	for _, p := range problems {
		t.Error(p)
	}
	if len(added) == 0 {
		return
	}
	if !*update {
		t.Errorf("migrations not in %s: %v; add them with go test ./internal/store -run AppendOnly -args -update", sumsFile, added)
		return
	}
	f, err := os.OpenFile(sumsFile, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, name := range added {
		data, err := fs.ReadFile(Migrations(), name)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(data)
		fmt.Fprintf(f, "%s  %s\n", hex.EncodeToString(sum[:]), name)
	}
}

// checkSums compares the migrations in fsys with sums, lines of
// "<sha256>  <name>": a changed or missing file is a problem, and a file
// not listed is new.
func checkSums(fsys fs.FS, sums []byte) (problems, added []string) {
	listed := map[string]bool{}
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		sum, name, ok := strings.Cut(sc.Text(), "  ")
		if !ok {
			problems = append(problems, fmt.Sprintf("a malformed line in SUMS: %q", sc.Text()))
			continue
		}
		listed[name] = true
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s was removed: an applied migration stays", name))
			continue
		}
		if got := sha256.Sum256(data); hex.EncodeToString(got[:]) != sum {
			problems = append(problems, fmt.Sprintf("%s was changed: an applied migration is never edited; add a new one", name))
		}
	}
	names, _ := fs.Glob(fsys, "*.sql")
	for _, name := range names {
		if !listed[name] {
			added = append(added, name)
		}
	}
	return problems, added
}

func TestCheckSumsFindsChanges(t *testing.T) {
	one := []byte("-- +goose Up\nCREATE TABLE a ();\n")
	sum := sha256.Sum256(one)
	sums := []byte(hex.EncodeToString(sum[:]) + "  00001_a.sql\n")
	cases := map[string]struct {
		fsys          fstest.MapFS
		problem, adds bool
	}{
		"same":    {fstest.MapFS{"00001_a.sql": {Data: one}}, false, false},
		"edited":  {fstest.MapFS{"00001_a.sql": {Data: append(one, ' ')}}, true, false},
		"removed": {fstest.MapFS{}, true, false},
		"new":     {fstest.MapFS{"00001_a.sql": {Data: one}, "00002_b.sql": {Data: one}}, false, true},
	}
	for name, tc := range cases {
		problems, added := checkSums(tc.fsys, sums)
		if (len(problems) > 0) != tc.problem || (len(added) > 0) != tc.adds {
			t.Errorf("%s: problems %v, added %v", name, problems, added)
		}
	}
}

func TestMigrationsNumberedInSequence(t *testing.T) {
	names, err := fs.Glob(Migrations(), "*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i, name := range names {
		if want := fmt.Sprintf("%05d_", i+1); !strings.HasPrefix(name, want) {
			t.Errorf("migration %d is %s; want %s…", i+1, name, want)
		}
		data, _ := fs.ReadFile(Migrations(), name)
		if bytes.Contains(data, []byte("+goose Down")) {
			t.Errorf("%s has a Down section: migrations only go up", name)
		}
	}
	if Latest != int64(len(names)) {
		t.Errorf("Latest = %d with %d migrations", Latest, len(names))
	}
}

// TestOnlyStoreTalksToTheDatabase checks that no package outside
// internal/store imports the database driver or the migrations library, so
// everything lasting goes through the store.
func TestOnlyStoreTalksToTheDatabase(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	banned := []string{"github.com/jackc/pgx", "github.com/pressly/goose"}
	var found []string
	fset := token.NewFileSet()
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case ".git", ".dev", "node_modules", "testdata":
				return fs.SkipDir
			}
			if rel, _ := filepath.Rel(root, p); filepath.ToSlash(rel) == "internal/store" {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") {
			return nil
		}
		f, err := parser.ParseFile(fset, p, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imp := range f.Imports {
			path, _ := strconv.Unquote(imp.Path.Value)
			if slices.ContainsFunc(banned, func(b string) bool { return strings.HasPrefix(path, b) }) {
				rel, _ := filepath.Rel(root, p)
				found = append(found, rel+" imports "+path)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range found {
		t.Errorf("%s: only internal/store talks to the database", f)
	}
}

func TestQueryName(t *testing.T) {
	for sql, want := range map[string]string{
		"-- name: CreateGuestAccount :one\nINSERT …": "CreateGuestAccount",
		"-- name: TouchSession :exec\n":              "TouchSession",
		"begin":                                      "other",
		"SELECT 1":                                   "other",
		"-- name: \n":                                "other",
		"-- a comment\nSELECT 1":                     "other",
	} {
		if got := queryName(sql); got != want {
			t.Errorf("queryName(%q) = %q, want %q", sql, got, want)
		}
	}
}

// TestTracerResolvesLabelsOnce checks the tracer labels queries by sqlc's
// name and, once a query has run, finds its metrics without allocating.
func TestTracerResolvesLabelsOnce(t *testing.T) {
	dur := prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "d"}, []string{"query"})
	errs := prometheus.NewCounterVec(prometheus.CounterOpts{Name: "e"}, []string{"query"})
	tr := newTracer(dur, errs)
	const q = "-- name: SessionAccount :one\nSELECT …"
	first := tr.metrics(q)
	if first.name != "SessionAccount" {
		t.Fatalf("labelled %q", first.name)
	}
	if allocs := testing.AllocsPerRun(100, func() {
		if tr.metrics(q) != first {
			t.Fatal("resolved again")
		}
	}); allocs != 0 {
		t.Fatalf("%v allocations finding a query's metrics", allocs)
	}
	// Statements that are not sqlc's share one entry.
	if tr.metrics("begin") != tr.metrics("commit") {
		t.Fatal("other statements are kept apart")
	}
	first.errors.Inc()
	if got := testutil.ToFloat64(errs.WithLabelValues("SessionAccount")); got != 1 {
		t.Fatalf("errors %v", got)
	}
}
