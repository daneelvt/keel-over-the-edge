// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// The developer's route raises each kind of the sea's life: a boil of
// bait with the groups that come with it, a ground of fish unseen but for
// what boats flush from it, and a pod that rides bows.
func TestLifeRoute(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	waves, kinds := cat.Prepare()
	p, lk := life.Prepare(cat)
	ls := life.NewSchedule(&life.Config{Params: p, Kinds: lk, Habitat: life.NewHabitat(p, nil, life.Places{}, cat.World.Disk.Radius), Seed: 5})
	w, err := sim.New(sim.Config{Capacity: 4, Kinds: kinds, Waves: waves, Weather: weather.FixedIn(cat.PrepareWeather(), physics.SteadySpell(6, 0, 0)),
		Tick: 1000, Life: ls})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	route := lifeRoute(w.Bus(), cat, slog.New(slog.DiscardHandler))
	raise := func(kind int) {
		t.Helper()
		rec := httptest.NewRecorder()
		route.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/debug/life?kind="+cat.Life.Kinds[kind].ID+"&east=100&north=200", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("raising %s: %d %s", cat.Life.Kinds[kind].ID, rec.Code, rec.Body)
		}
		w.Tick()
	}
	find := func(ok func(*life.Kind) bool) int {
		for i := range lk {
			if ok(&lk[i]) {
				return i
			}
		}
		t.Fatal("no such kind")
		return -1
	}
	bait := find(func(k *life.Kind) bool { return len(k.Brings) > 0 })
	raise(bait)
	f := w.Latest()
	var parent uint64
	brought := 0
	for _, e := range f.Life {
		switch {
		case int(e.Kind) == bait && e.Over == 0:
			parent = e.ID
		case parent != 0 && e.Over == parent:
			brought++
		}
	}
	if parent == 0 || brought == 0 {
		t.Errorf("the bait raised %x brought %d", parent, brought)
	}
	n := len(f.Life)
	raise(find((*life.Kind).Flushes))
	if f := w.Latest(); len(f.Life) != n {
		t.Errorf("a ground of fish is in the frame: %d encounters, were %d", len(f.Life), n)
	}
	rides := find((*life.Kind).Rides)
	raise(rides)
	if f := w.Latest(); int(f.Life[len(f.Life)-1].Kind) != rides {
		t.Errorf("no pod raised: %+v", f.Life[len(f.Life)-1])
	}
	rec := httptest.NewRecorder()
	route.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/debug/life?kind="+cat.Life.Kinds[rides].ID+"&at=boat", nil))
	if rec.Code != http.StatusConflict {
		t.Errorf("at a boat in an empty sea: %d", rec.Code)
	}
}
