// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

var (
	seedOnce sync.Once
	seed1    *worldgen.Bundle
	seedCat  *catalog.Catalog
)

// world1 is seed 1's world, made once for the package's tests.
func world1(t testing.TB) (*worldgen.Bundle, *catalog.Catalog) {
	t.Helper()
	if testing.Short() {
		t.Skip("makes a whole world")
	}
	seedOnce.Do(func() {
		cat, err := catalog.Load()
		if err != nil {
			t.Fatal(err)
		}
		b, err := worldgen.Generate(1, cat)
		if err != nil {
			t.Fatal(err)
		}
		seed1, seedCat = b, cat
	})
	if seed1 == nil {
		t.Fatal("seed 1 was not made")
	}
	return seed1, seedCat
}

// TestSeed1: every island, place and feature of seed 1 is a subject; each
// island has cells and a model of its own land; the main port's island and
// what is on it are known; and it is all built within a second.
func TestSeed1(t *testing.T) {
	b, cat := world1(t)
	var before, mem runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	start := time.Now()
	w := Build(b, cat)
	took := time.Since(start)
	runtime.GC()
	runtime.ReadMemStats(&mem)
	kept := int64(mem.HeapAlloc) - int64(before.HeapAlloc)
	runtime.KeepAlive(w)
	if n := len(b.Islands) + len(b.Places) + len(b.Features); len(w.Subjects) != n {
		t.Fatalf("%d subjects, want %d", len(w.Subjects), n)
	}
	if took > time.Second {
		t.Errorf("built in %v", took)
	}
	models, bytes, empty := 0, 0, 0
	for i := range w.Subjects {
		s := &w.Subjects[i]
		if s.Kind != sight.Island {
			continue
		}
		if s.Model < 0 {
			empty++
			continue
		}
		models++
		m := w.Models[s.Model]
		bytes += len(m.Payload)
		h, heights, _, err := ReadModel(m.Payload)
		if err != nil || h.Island != s.Number {
			t.Fatalf("island %d's model: %v, island %d", s.Number, err, h.Island)
		}
		land := 0
		for _, v := range heights {
			if v > 0 {
				land++
			}
		}
		if land == 0 {
			t.Errorf("island %d's model has no land", s.Number)
		}
	}
	main := w.Index(sight.Island, b.Islands[0].Number)
	if len(w.Known) < 2 || w.Known[0] != main {
		t.Errorf("known %v, the main island %d", w.Known, main)
	}
	cells, views, awash, lights, refs := w.Table.Size()
	great := 0
	for _, s := range w.Subjects {
		if s.Worth >= cat.World.Chart.Worth.Great {
			great++
		}
	}
	t.Logf("built in %v; %d subjects, %d known, %d great; %d cells, %d views, %d awash, %d lights, %d references; %d models in %d bytes, %d islands too small for one; %.1f MB kept",
		took.Round(time.Millisecond), len(w.Subjects), len(w.Known), great, cells, views, awash, lights, refs, models, bytes, empty, float64(kept)/(1<<20))
}

// TestStartSeesOnlyPortRoyal: from the first mooring, with Port Royal's
// island known, no other island is in sight.
func TestStartSeesOnlyPortRoyal(t *testing.T) {
	b, cat := world1(t)
	w := Build(b, cat)
	charted := make([]uint64, sight.Words(len(w.Subjects)))
	for _, k := range w.Known {
		charted[k>>6] |= 1 << (k & 63)
	}
	p := b.Start.Places[0]
	l := sight.Lookout{X: p[0], Y: p[1], Eye: w.Table.Eye(2), Reach: w.Table.EyeReach(2)}
	for _, s := range w.Table.Look(&l, charted, nil, nil) {
		if w.Subjects[s.Subject].Kind == sight.Island {
			t.Errorf("%s seen from the mooring", w.Subjects[s.Subject].Title)
		}
	}
}

// BenchmarkLook is one boat's look on seed 1, along a run out from Port
// Royal.
func BenchmarkLook(bm *testing.B) {
	b, cat := world1(bm)
	w := Build(b, cat)
	charted := make([]uint64, sight.Words(len(w.Subjects)))
	lit := make([]bool, w.Table.Lights())
	out := make([]sight.Seen, 0, 64)
	l := sight.Lookout{Eye: w.Table.Eye(2), Reach: w.Table.EyeReach(2)}
	bm.ResetTimer()
	for i := range bm.N {
		d := float64(i%8000) + 300
		l.X, l.Y = d*0.6, d*0.8
		out = w.Table.Look(&l, charted, lit, out[:0])
	}
}
