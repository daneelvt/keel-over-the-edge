// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"slices"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

func TestRulesFindEachBreak(t *testing.T) {
	problems, err := checkRules("testdata/impure", allowedImports)
	if err != nil {
		t.Fatal(err)
	}
	// The import list is checked first, on its own; the rest needs the
	// package type-checked, which an unknown import does not stop.
	text := strings.Join(problems, "\n")
	for _, want := range []string{
		"impure.go:5:2: imports fmt",
		"impure.go:9:8: a channel",
		"impure.go:12:2: a goroutine",
		"impure.go:12:5: a function literal",
		"impure.go:13:2: defer",
		"impure.go:14:7: a map",
		"impure.go:16:7: make",
		"impure.go:18:7: converts a float to int",
		"impure.go:20:2: a channel",
		"impure.go:21:7: a product added to or subtracted from",
		"impure.go:22:9: math.Sin does not give the same bits",
		"impure.go:22:23: a product added to or subtracted from",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("no problem %q in:\n%s", want, text)
		}
	}
}

func TestRulesPassCleanCode(t *testing.T) {
	problems, err := checkRules("testdata/pure", allowedImports)
	if err != nil {
		t.Fatal(err)
	}
	if len(problems) > 0 {
		t.Errorf("clean code reported:\n%s", strings.Join(problems, "\n"))
	}
}

func TestRulesHoldForPhysics(t *testing.T) {
	for dir, imports := range map[string][]string{"../../" + physicsDir: allowedImports, "../../" + wasmPkg: wasmImports} {
		problems, err := checkRules(dir, imports)
		if err != nil {
			t.Fatal(err)
		}
		if len(problems) > 0 {
			t.Errorf("%s:\n%s", dir, strings.Join(problems, "\n"))
		}
	}
}

func TestFusedFindsFusion(t *testing.T) {
	if testing.Short() {
		t.Skip("compiles for two machines")
	}
	found, err := checkFused(context.Background(), "./testdata/fused")
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 2 {
		t.Fatalf("want one fusion on each machine, found:\n%s", strings.Join(found, "\n"))
	}
	for _, f := range found {
		if !strings.Contains(f, "fused.go:5:") {
			t.Errorf("fusion reported in the wrong place: %s", f)
		}
	}
}

func TestFusedInObjdump(t *testing.T) {
	dump := `TEXT fused.Fused(SB) /src/fused.go
  fused.go:5		0x1de9			1f400820		FMADDD F0, F2, F1, F0
  fused.go:5		0x1ded			d65f03c0		RET
TEXT fused.F(SB) /src/f.go
  f.go:9		0x2000			c4e2f1a9c2		VFMADD231SD X2, X1, X0
  f.go:10		0x2005			f20f59c1		MULSD X1, X0
  f.go:11		0x2009			1f408820		FMSUBD F0, F2, F1, F0
`
	got := fusedIn([]byte(dump))
	want := []fused{{"fused.go:5", "FMADDD"}, {"f.go:9", "VFMADD231SD"}, {"f.go:11", "FMSUBD"}}
	if !slices.Equal(got, want) {
		t.Errorf("fusedIn = %v, want %v", got, want)
	}
}

func TestHeapAllocations(t *testing.T) {
	out := `/src/internal/physics/body.go:78:33: object allocated on the heap: size is not constant
some other line
/src/main.go:3:1: object allocated on the heap: escapes at line 4
`
	if got := heapAllocations(strings.NewReader(out)); len(got) != 2 {
		t.Errorf("heapAllocations = %q", got)
	}
}

func TestLayout(t *testing.T) {
	l, err := describe()
	if err != nil {
		t.Fatal(err)
	}
	if l.version != physics.LayoutVersion {
		t.Errorf("the records describe layout %#08x but layout.gen.go says %#08x: run go run ./tools/physics",
			l.version, physics.LayoutVersion)
	}
	if l.records[0].name != "state" || l.records[0].fields[5] != "yawRate" {
		t.Errorf("unexpected layout %+v", l.records)
	}
	changed := l
	changed.records = slices.Clone(l.records)
	changed.records[1] = recordLayout{name: "control", fields: []string{"trim", "helm"}}
	if versionOf(changed) == l.version {
		t.Error("reordering fields left the version unchanged")
	}
	ts := string(l.tsFile())
	for _, want := range []string{"export const LAYOUT_VERSION = 0x", "state: { x: 0, y: 1,", "export const FN = { sin: 0,"} {
		if !strings.Contains(ts, want) {
			t.Errorf("layout.gen.ts lacks %q:\n%s", want, ts)
		}
	}
}

func TestJSName(t *testing.T) {
	for in, want := range map[string]string{"X": "x", "YawRate": "yawRate", "WindFrom": "windFrom"} {
		if got := jsName(in); got != want {
			t.Errorf("jsName(%q) = %q, want %q", in, got, want)
		}
	}
}
