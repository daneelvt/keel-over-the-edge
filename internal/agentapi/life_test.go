// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// quietLife is the catalog's life over open sea that begins nothing by
// itself, under a sun always up: only what a test raises is met.
func quietLife(cat *catalog.Catalog) *life.Schedule {
	p, kinds := life.Prepare(cat)
	for i := range kinds {
		kinds[i].Rate = 0
	}
	h := life.NewHabitat(p, nil, life.Places{}, cat.World.Disk.Radius)
	return life.NewSchedule(&life.Config{Params: p, Kinds: kinds, Habitat: h, Seed: 5})
}

// lifeKind is the first of the sea's life's kinds that holds, by its
// index.
func lifeKind(t *testing.T, s *Sea, ok func(*life.Kind) bool) int {
	t.Helper()
	for i := range s.Life.Kinds() {
		if ok(&s.Life.Kinds()[i]) {
			return i
		}
	}
	t.Fatal("no kind of the sea's life")
	return 0
}

// own is the world's one boat: its slot and pose.
func (h *harness) own(t *testing.T) (int32, physics.State) {
	t.Helper()
	f := h.w.Bus().Frames.Acquire()
	defer f.Release()
	if len(f.Live) != 1 {
		t.Fatalf("%d boats", len(f.Live))
	}
	return f.Live[0], f.State[f.Live[0]]
}

// raise begins a group of the kind at (x, y), and lets the world take it.
func (h *harness) raise(t *testing.T, kind int, x, y float64) bus.LifeEncounter {
	t.Helper()
	reply := make(chan bus.Reply, 1)
	if err := h.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.RaiseLife, LifeKind: uint16(kind), State: physics.State{X: x, Y: y}, Reply: reply}); err != nil {
		t.Fatal(err)
	}
	if r := <-reply; r.Result != bus.Done {
		t.Fatalf("raised: %v", r.Result)
	}
	time.Sleep(time.Second)
	f := h.w.Bus().Frames.Acquire()
	defer f.Release()
	for _, e := range f.Life {
		if int(e.Kind) == kind && e.ID>>63 == 1 {
			return e
		}
	}
	t.Fatal("the group raised is not in the frame")
	return bus.LifeEncounter{}
}

// lineOf is the line of a report that holds want, "" for none.
func lineOf(text, want string) string {
	for l := range strings.SplitSeq(text, "\n") {
		if strings.Contains(l, want) {
			return l
		}
	}
	return ""
}

// The lookout names the sea's life in sight by what it is and does, and
// where, by compass point and range; a group with the boat follows it.
func TestLifeInSight(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarnessOf(t, 8, 12, 0, quietLife)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		_, st := h.own(t)
		soars := lifeKind(t, h.sea, func(k *life.Kind) bool { return k.Path == life.PathSoar })
		k := &h.sea.Life.Kinds()[soars]
		e := h.raise(t, soars, st.X+500, st.Y)
		// In from its range, and over its patch, the boat kept by a call
		// now and then.
		for range int(k.Arrive(e.Speed)/30) + 1 {
			time.Sleep(30 * time.Second)
			h.call(t, a, "observe", nil)
		}
		text, _ := h.call(t, a, "observe", map[string]any{"detail": "full"})
		line := lineOf(text, "soaring high")
		if line == "" || !strings.Contains(line, groupWords(k, &e)) || !strings.Contains(line, " to the E, ~") {
			t.Fatalf("a group soaring 500 m E: %q in\n%s", line, text)
		}
		// A brief report names it only once.
		h.call(t, a, "observe", nil)
		if text, _ := h.call(t, a, "observe", nil); strings.Contains(text, "soaring high") {
			t.Fatalf("told again: %s", text)
		}

		// Under way, a gull that follows boats takes the boat.
		h.call(t, a, "steer", map[string]any{"wind_angle": 90, "boom": 45})
		time.Sleep(20 * time.Second)
		follows := lifeKind(t, h.sea, func(k *life.Kind) bool { return k.Follows })
		_, st = h.own(t)
		e = h.raise(t, follows, st.X+60, st.Y+60)
		if e.Boat == 0 {
			t.Fatalf("the group took no boat, the boat at %.1f m/s", st.Surge)
		}
		text, _ = h.call(t, a, "observe", nil)
		if line := lineOf(text, "following your boat"); line == "" || strings.Contains(line, " to the ") {
			t.Fatalf("a group following the boat: %q in\n%s", line, text)
		}
		// And is heard, by day, from astern, a few times a minute.
		heard := ""
		for range 20 {
			text, _ = h.call(t, a, "observe", map[string]any{"detail": "full"})
			if heard = lineOf(text, "Hear:"); strings.Contains(heard, "a gull's laugh to the ") {
				break
			}
			time.Sleep(5 * time.Second)
		}
		if !strings.Contains(heard, "a gull's laugh to the ") {
			t.Fatalf("no laugh heard: %s", text)
		}
	})
}

// A wait that asks for life wakes as a group comes into sight; one that
// does not, by default, does not.
func TestLifeWakes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarnessOf(t, 8, 12, 0, quietLife)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		passes := lifeKind(t, h.sea, func(k *life.Kind) bool { return k.Path == life.PathPass && !k.Follows })
		woke := make(chan string, 1)
		go func() {
			text, _ := h.call(t, a, "observe", map[string]any{"wait": 30, "wake_on": []string{"life"}})
			woke <- text
		}()
		time.Sleep(2 * time.Second)
		_, st := h.own(t)
		h.raise(t, passes, st.X+100, st.Y+100)
		if text := <-woke; !strings.Contains(text, "woke: life in sight") || !strings.Contains(text, "life in sight: ") {
			t.Fatalf("the wait for life: %s", text)
		}
		go func() {
			text, _ := h.call(t, a, "observe", map[string]any{"wait": 10})
			woke <- text
		}()
		time.Sleep(2 * time.Second)
		h.raise(t, passes, st.X-100, st.Y-100)
		if text := <-woke; !strings.Contains(text, "waited 10 s, nothing new") || !strings.Contains(text, "life in sight: ") {
			t.Fatalf("a wait by default: %s", text)
		}
	})
}
