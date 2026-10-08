// SPDX-License-Identifier: AGPL-3.0-only

package sim

import (
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The rules that keep a tick deterministic, checked on the package's source:
// a replay of the same inputs must reach the same world.

// bannedImports read the clock, do I/O or draw from a generator nobody
// seeded; the database's driver and the store are I/O too, and a tick never
// waits on the database. A prefix ending in "/" bans the packages under it.
var bannedImports = []string{
	"time", "os", "os/", "net", "net/", "syscall", "io/fs", "io/ioutil",
	"log", "log/", "math/rand", "crypto/rand", "runtime/pprof", "unsafe",
	"database/sql", "database/sql/", "github.com/jackc/pgx/",
	"github.com/daneelvt/keel-over-the-edge/internal/store", "github.com/daneelvt/keel-over-the-edge/internal/store/",
}

// iterMaps are the functions of package maps that iterate over a map, in its
// varying order.
var iterMaps = []string{"All", "Keys", "Values"}

func TestRules(t *testing.T) {
	problems, err := checkDeterminism(".")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range problems {
		t.Error(p)
	}
}

// TestRulesFindViolations plants each kind of violation and checks the rules
// report it.
func TestRulesFindViolations(t *testing.T) {
	cases := map[string]string{
		"clock":    "imports time",
		"database": "imports github.com/daneelvt/keel-over-the-edge/internal/store",
		"maprange": "ranges over a map",
		"pool":     "sync.Pool",
		"random":   "rand.Float64",
		"pure":     "",
	}
	for dir, want := range cases {
		t.Run(dir, func(t *testing.T) {
			problems, err := checkDeterminism(filepath.Join("testdata", "rules", dir))
			if err != nil {
				t.Fatal(err)
			}
			if want == "" {
				if len(problems) > 0 {
					t.Fatalf("found problems in a package that keeps the rules: %v", problems)
				}
				return
			}
			if len(problems) != 1 || !strings.Contains(problems[0], want) {
				t.Fatalf("want one problem mentioning %q, got %v", want, problems)
			}
		})
	}
}

// checkDeterminism checks the Go files of the package in dir, tests aside.
func checkDeterminism(dir string) ([]string, error) {
	fset := token.NewFileSet()
	names, err := filepath.Glob(filepath.Join(dir, "*.go"))
	if err != nil {
		return nil, err
	}
	var files []*ast.File
	for _, name := range names {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, name, nil, parser.SkipObjectResolution)
		if err != nil {
			return nil, err
		}
		files = append(files, f)
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no Go files in %s", dir)
	}
	info := &types.Info{
		Types: map[ast.Expr]types.TypeAndValue{},
		Uses:  map[*ast.Ident]types.Object{},
	}
	conf := types.Config{Importer: importer.ForCompiler(fset, "source", nil)}
	if _, err := conf.Check(files[0].Name.Name, fset, files, info); err != nil {
		return nil, err
	}

	var problems []string
	report := func(pos token.Pos, format string, args ...any) {
		p := fset.Position(pos)
		problems = append(problems, fmt.Sprintf("%s:%d: %s", p.Filename, p.Line, fmt.Sprintf(format, args...)))
	}
	for _, f := range files {
		for _, imp := range f.Imports {
			path := strings.Trim(imp.Path.Value, `"`)
			if slices.ContainsFunc(bannedImports, func(b string) bool {
				return path == b || strings.HasSuffix(b, "/") && strings.HasPrefix(path, b)
			}) {
				report(imp.Pos(), "imports %s: a tick must not read the clock, do I/O or draw unseeded numbers", path)
			}
		}
		ast.Inspect(f, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.RangeStmt:
				if tv, ok := info.Types[n.X]; ok {
					if _, isMap := tv.Type.Underlying().(*types.Map); isMap {
						report(n.Pos(), "ranges over a map, whose order differs from run to run")
					}
				}
			case *ast.SelectorExpr:
				obj := info.Uses[n.Sel]
				if obj == nil || obj.Pkg() == nil {
					return true
				}
				switch path, name := obj.Pkg().Path(), obj.Name(); {
				case path == "sync" && name == "Pool":
					report(n.Pos(), "uses sync.Pool, which drops entries at random under the race detector and the collector")
				case path == "maps" && slices.Contains(iterMaps, name):
					report(n.Pos(), "maps.%s iterates over a map, whose order differs from run to run", name)
				case path == "math/rand/v2":
					// A package-level function, not a seeded generator's method.
					if fn, ok := obj.(*types.Func); ok && fn.Signature().Recv() == nil && !strings.HasPrefix(name, "New") {
						report(n.Pos(), "rand.%s draws from a generator nobody seeded", name)
					}
				}
			}
			return true
		})
	}
	return problems, nil
}
