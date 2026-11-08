// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"math"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
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
	// The last raised of the kind, not one that came with another.
	for i := len(f.Life) - 1; i >= 0; i-- {
		if e := f.Life[i]; int(e.Kind) == kind && e.ID>>63 == 1 && e.Over == 0 {
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
		h.call(t, a, "observe", nil)
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

// raiseUnseen begins a group of the kind at (x, y) that is not in the
// frame itself, a ground of fish, and lets the world take it.
func (h *harness) raiseUnseen(t *testing.T, kind int, x, y float64) {
	t.Helper()
	reply := make(chan bus.Reply, 1)
	if err := h.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.RaiseLife, LifeKind: uint16(kind), State: physics.State{X: x, Y: y}, Reply: reply}); err != nil {
		t.Fatal(err)
	}
	if r := <-reply; r.Result != bus.Done {
		t.Fatalf("raised: %v", r.Result)
	}
}

// waitFor calls observe every 30 s for up to s seconds until a full
// report holds every one of want, and returns the last.
func (h *harness) waitFor(t *testing.T, a *oauth.Accepted, s int, want ...string) string {
	t.Helper()
	text := ""
	for range s/30 + 1 {
		text, _ = h.call(t, a, "observe", map[string]any{"detail": "full"})
		all := true
		for _, w := range want {
			all = all && strings.Contains(text, w)
		}
		if all {
			return text
		}
		time.Sleep(30 * time.Second)
	}
	return text
}

// The lookout names the life in the water by what it is and does, by its
// kind's word for its groups: turtles surfacing, pods passing, leaping
// and spinning, tarpon rolling, a boil of bait; a pod at the boat's own
// bow, heard breathing; fish flushed from its bow, told once a ground.
func TestWaterLifeInSight(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarnessOf(t, 8, 12, 0, quietLife)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		_, st := h.own(t)
		kinds := h.sea.Life.Kinds()
		turtle := lifeKind(t, h.sea, func(k *life.Kind) bool { return k.Form == catalog.LifeFormTurtle })
		spins := lifeKind(t, h.sea, func(k *life.Kind) bool { return k.Swim != nil && len(k.Swim.Spins) > 0 && k.Lingers() })
		rolls := lifeKind(t, h.sea, func(k *life.Kind) bool {
			return k.Form == catalog.LifeFormPod && k.Lingers() && k.Swim != nil && len(k.Swim.Spins) == 0
		})
		rides := lifeKind(t, h.sea, func(k *life.Kind) bool { return k.Rides() && k.Path == life.PathPass })
		bait := lifeKind(t, h.sea, func(k *life.Kind) bool { return k.Form == catalog.LifeFormBait })
		flush := lifeKind(t, h.sea, (*life.Kind).Flushes)
		et := h.raise(t, turtle, st.X-80, st.Y)
		es := h.raise(t, spins, st.X+300, st.Y)
		er := h.raise(t, rolls, st.X, st.Y-300)
		wantTurtle := groupWords(&kinds[turtle], &et) + " surfacing to the "
		wantSpins := groupWords(&kinds[spins], &es) + " leaping and spinning to the "
		wantRolls := groupWords(&kinds[rolls], &er) + " rolling at the surface to the "
		if !strings.HasPrefix(groupWords(&kinds[rolls], &er), "a "+kinds[rolls].Collective+" of ") {
			t.Errorf("a group of %d %s is %q", er.Count, kinds[rolls].Plural, groupWords(&kinds[rolls], &er))
		}
		text := h.waitFor(t, a, 450, wantTurtle, wantSpins, wantRolls)
		for _, w := range []string{wantTurtle, wantSpins, wantRolls} {
			if !strings.Contains(text, w) {
				t.Errorf("no %q in\n%s", w, text)
			}
		}
		// A boil of bait, and a pod passing the boat at rest.
		h.raise(t, bait, st.X-354, st.Y-354)
		ep := h.raise(t, rides, st.X+424, st.Y+424)
		if ep.Boat != 0 {
			t.Fatalf("a pod took a boat at rest: %+v", ep)
		}
		passing := " passing to the "
		if ep.Speed > lifeLeaps {
			passing = " leaping as they pass to the "
		}
		text, _ = h.call(t, a, "observe", map[string]any{"detail": "full"})
		for _, w := range []string{"a boil of bait to the SW, ~", groupWords(&kinds[rides], &ep) + passing, "working the water"} {
			if !strings.Contains(text, w) {
				t.Errorf("no %q in\n%s", w, text)
			}
		}

		// Under way, a pod rides the bow, and is heard breathing there.
		h.call(t, a, "steer", map[string]any{"wind_angle": 90, "boom": 45})
		time.Sleep(20 * time.Second)
		h.call(t, a, "observe", nil)
		time.Sleep(20 * time.Second)
		_, st = h.own(t)
		eb := h.raise(t, rides, st.X+150*math.Sin(st.Heading), st.Y+150*math.Cos(st.Heading))
		if eb.Boat == 0 {
			t.Fatalf("the pod took no boat at %.1f m/s", st.Surge)
		}
		want := lifeName(kinds[rides].Plural) + " riding your bow"
		if text, _ = h.call(t, a, "observe", nil); !strings.Contains(text, want) || strings.Contains(lineOf(text, want), " to the ") {
			t.Fatalf("no %q in\n%s", want, text)
		}
		text = h.waitFor(t, a, 400, "dolphins breathing close by")
		if heard := lineOf(text, "Hear:"); !strings.Contains(heard, "dolphins breathing close by") {
			t.Errorf("no breathing heard at the bow: %s", text)
		}

		// Fish flushed from the bow, told once for their ground.
		_, st = h.own(t)
		h.raiseUnseen(t, flush, st.X, st.Y)
		events := 0
		flushed := false
		for range 30 {
			time.Sleep(2 * time.Second)
			text, _ = h.call(t, a, "observe", nil)
			events += strings.Count(text, "life in sight: flying fish")
			flushed = flushed || strings.Contains(text, "flying fish skittering away from your bow")
		}
		if !flushed || events != 1 {
			t.Errorf("fish flushed from the bow: %v, told %d times", flushed, events)
		}
	})
}

// Life in the water is not seen in a sea of force 6 or more.
func TestNoWaterLifeInAHeavySea(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarnessOf(t, 8, 25, 0, quietLife)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		_, st := h.own(t)
		turtle := lifeKind(t, h.sea, func(k *life.Kind) bool { return k.Form == catalog.LifeFormTurtle })
		h.raise(t, turtle, st.X-80, st.Y)
		if text := h.waitFor(t, a, 240, "surfacing"); strings.Contains(text, "surfacing") {
			t.Fatalf("a turtle seen in a near gale:\n%s", text)
		}
	})
}

// swimDoing tells each way of a group in the water.
func TestSwimDoing(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	_, kinds := life.Prepare(cat)
	var pod *life.Kind
	for i := range kinds {
		if kinds[i].Rides() && kinds[i].Path == life.PathPass {
			pod = &kinds[i]
		}
	}
	for _, c := range []struct {
		e    bus.LifeEncounter
		want string
	}{
		{bus.LifeEncounter{Count: 9, Speed: 3}, "passing"},
		{bus.LifeEncounter{Count: 9, Speed: 4}, "leaping as they pass"},
		{bus.LifeEncounter{Count: 9, Speed: 3, Boat: 4}, "riding a boat's bow"},
		{bus.LifeEncounter{Count: 9, Speed: 3, Over: 77}, "feeding"},
	} {
		if got := swimDoing(pod, &c.e); got != c.want {
			t.Errorf("%+v: %q, want %q", c.e, got, c.want)
		}
	}
	if got := groupWords(pod, &bus.LifeEncounter{Count: 9}); got != "a pod of "+lifeName(pod.Plural) {
		t.Errorf("a group of nine is %q", got)
	}
}
