// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"encoding/json"
	"math"
	"os"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// overWatch notes, from each frame, when a slot's boat went over the lip
// and when it started again.
type overWatch struct {
	mu      sync.Mutex
	account bus.Account
	over    int64
	back    int64
}

func (o *overWatch) Record(f *bus.Frame) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for _, s := range f.Live {
		if f.Owner[s] != o.account {
			continue
		}
		v := &f.Voyage[s]
		switch {
		case v.Falling() && o.over == 0:
			o.over = v.Over
		case !v.Falling() && o.over != 0 && o.back == 0:
			o.back = f.Tick
		}
	}
}

func (o *overWatch) ticks() (over, back int64) {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.over, o.back
}

// TestOverTheLipOnline: a boat lying 84 m inside the lip with its sheet let
// fly is carried over it by the drain and the falls' draft. The page's
// prediction goes over on the same tick as the server, with no correction
// on the way; another sailor's view shows the boat falling for exactly the
// ticks it falls; and when it starts again at the start the prediction
// starts again from there, once.
func TestOverTheLipOnline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cat, err := catalog.Load()
		if err != nil {
			t.Fatal(err)
		}
		// 12 knots from the south: onto the lip north of the centre.
		wind := weather.FixedIn(cat.PrepareWeather(), physics.SteadySpell(12*1852.0/3600, math.Pi, 0))
		watch := &overWatch{}
		srv := NewServer(t, Config{Weather: wind, Terrain: &sim.Terrain{Circulation: 1}, Record: watch})
		annToken, annID := srv.Guest("Ann")
		bobToken, bobID := srv.Guest("Bob")
		watch.account = bus.Account(annID)
		ann := srv.NewSailor(DialOptions{Cookie: annToken}, letGo)
		ann.Trace = &client.Trace{}
		bob := srv.NewSailor(DialOptions{Cookie: bobToken}, letGo)
		falling := map[int64]bool{} // Bob's sampled views of Ann, by tick
		bob.OnView = func(ev *client.Event) {
			v := ev.View
			for slot := range 64 {
				if v.Has(slot) && ev.Sampled&(1<<slot) != 0 {
					falling[ev.Snapshot.Tick] = v.Boats[slot].IsFalling()
				}
			}
		}
		for _, s := range []*client.Sailor{ann, bob} {
			if err := s.Connect(t.Context()); err != nil {
				t.Fatal(err)
			}
		}
		sailFor(t, []*client.Sailor{ann, bob}, time.Second)
		if len(ann.Welcomes) == 0 || ann.Predictor.Circulation != 1 {
			t.Fatalf("Ann's Welcome: %+v, circulation %v", ann.Welcomes, ann.Predictor.Circulation)
		}
		srv.Place(boatOf(srv, bus.Account(annID)), physics.State{Y: 8250, Heading: math.Pi / 2, SheetLimit: 1.6})
		// Bob lies 500 m off, inside the mist band's edge, watching.
		srv.Place(boatOf(srv, bus.Account(bobID)), physics.State{Y: 7750, Heading: -math.Pi / 2, SheetLimit: 1.6})
		// The place is a correction of its own; what follows is the drain's.
		sailFor(t, []*client.Sailor{ann, bob}, time.Second)
		ann.Stats.Sizes = nil
		resets := 0
		var predicted int64
		for range 400 {
			sailFor(t, []*client.Sailor{ann, bob}, time.Second)
			if predicted == 0 && ann.Predictor.Over != 0 {
				predicted, resets = ann.Predictor.Over, ann.Stats.Resets
			}
			if _, back := watch.ticks(); back != 0 {
				break
			}
		}
		over, back := watch.ticks()
		if over == 0 || back != over+CatalogEdge.Fall {
			t.Fatalf("over at tick %d, back at %d", over, back)
		}
		if predicted != over {
			t.Errorf("the page's prediction went over at tick %d, the server's boat at %d", predicted, over)
		}
		for i, d := range ann.Stats.Sizes {
			if d > 0.01 {
				t.Errorf("correction %d moved the boat %.3f m", i, d)
			}
		}
		sailFor(t, []*client.Sailor{ann, bob}, 3*time.Second)
		if ann.Predictor.Over != 0 || ann.Stats.Resets != resets+1 {
			t.Errorf("after starting again: over %d, %d resets since going over", ann.Predictor.Over, ann.Stats.Resets-resets)
		}
		if st := ann.Predictor.State; math.Hypot(st.X, st.Y) > 1900 {
			t.Errorf("after starting again the page's boat is at (%.0f, %.0f)", st.X, st.Y)
		}
		seen := 0
		for tick, f := range falling {
			if want := tick >= over && tick < back; f != want {
				t.Errorf("Bob's view at tick %d: falling %v", tick, f)
			}
			if f {
				seen++
			}
		}
		if seen == 0 {
			t.Error("Bob never saw Ann fall")
		}
		t.Logf("over at tick %d, back at %d; Bob saw Ann falling in %d samples; %d corrections", over, back, seen, ann.Stats.Corrections)
		// The page's tests replay Ann's trace through the page's own
		// prediction.
		if *update {
			if err := ann.Trace.Write(overTrace); err != nil {
				t.Fatal(err)
			}
		}
	})
	data, err := os.ReadFile(overTrace)
	if err != nil {
		t.Fatal(err)
	}
	var trace client.Trace
	if err := json.Unmarshal(data, &trace); err != nil {
		t.Fatal(err)
	}
	replayTrace(t, &trace)
}

// overTrace is TestOverTheLipOnline's sailor's trace.
const overTrace = "../../../shared/protocol/testdata/trace-over.json"
