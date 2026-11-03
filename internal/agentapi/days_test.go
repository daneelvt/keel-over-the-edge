// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A day at sea in seed 1's scenes: the orders' answers after a stall and
// for a long turn, the sky and its moments, the wind's force, the place a
// wait watches, and who is watching.

// helmAt is the machine sailor's helm of the boat in slot sl, at sea.
func (sc *scene) helmAt(sl int32) *helm {
	h := sc.core.helmOf(sailor(byte(sl)+1, "Iron Mary"))
	f := sc.w.Latest()
	h.mu.Lock()
	h.sea, h.slot, h.boat = sc.sea, sl, f.Boat[sl]
	h.mu.Unlock()
	return h
}

// look ticks the world for seconds, the hub looking at the helm as it
// does: ten times a second, and its lookout every sightEvery ticks.
func (sc *scene) look(h *helm, seconds float64) {
	for i := range int(seconds * physics.StepsPerSecond) {
		sc.w.Tick()
		if i%checkEvery == 0 {
			f := sc.w.Bus().Frames.Acquire()
			h.look(sc.sea, f, i%sightEvery == 0)
			f.Release()
		}
	}
}

// order steers the helm's boat as the steer tool does, and returns the
// order's answer.
func (sc *scene) order(h *helm, o *steerOrder) string {
	sc.t.Helper()
	f := sc.w.Bus().Frames.Acquire()
	w, refused := h.steer(sc.sea, f, h.slot, o)
	f.Release()
	if refused != "" {
		sc.t.Fatal(refused)
	}
	f = sc.w.Bus().Frames.Acquire()
	defer f.Release()
	return orderLine(sc.sea, f, h.slot, w)
}

// reportSince is the helm's report of events after since.
func (sc *scene) reportSince(h *helm, detail string, since int64) (string, *report) {
	f := sc.w.Bus().Frames.Acquire()
	defer f.Release()
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.reportFor(sc.sea, f, h.slot, detail, since)
	return r.text(), r
}

// A tack from rest in 3 knots stalls; the agent bears away on the side
// the boat is held on, as the handbook says: the answer says what it
// ordered, and the autopilot steers for it.
func TestSceneBearAwayAfterAStall(t *testing.T) {
	sc := newScene(t, 3, 0)
	st := sc.start()
	st.X, st.Y, st.Heading, st.Surge = 1500, -1500, wrap(rad(-45)), 0
	me := sc.boat(st, true)
	sc.steer(me, 45, 50)
	h := sc.helmAt(me)
	sc.look(h, 1)
	a := 45
	sc.order(h, &steerOrder{WindAngle: &a, Side: sidePort, Via: viaTack})
	sc.look(h, 12)
	if _, r := sc.reportSince(h, detailBrief, 0); !strings.HasSuffix(r.Pilot.Holds, "tack stalled") {
		t.Fatalf("no stall: %s", r.Pilot.Holds)
	}
	b, boom := 75, 30
	answer := sc.order(h, &steerOrder{WindAngle: &b, Side: sideStarboard, Boom: &boom})
	if !strings.Contains(answer, "holding wind 75° starboard") || strings.Contains(answer, "stalled") {
		t.Errorf("the answer: %s", answer)
	}
	sc.look(h, 1)
	text, r := sc.reportSince(h, detailBrief, h.ring.last())
	if r.Pilot.Holds != "wind 75° starboard" {
		t.Errorf("a second on:\n%s", text)
	}
	golden(t, "stall-bear", answer+"\n"+text)
}

// A course across the wind more than half a turn away, via auto: the
// answer says how far round the tack goes, and how far a gybe would.
func TestSceneATurnsSize(t *testing.T) {
	sc := newScene(t, 6, 0)
	st := sc.start()
	st.X, st.Y, st.Heading, st.Surge = 1500, -1500, wrap(rad(-59)), 2
	me := sc.boat(st, true)
	sc.steer(me, 59, 25)
	h := sc.helmAt(me)
	sc.look(h, 2)
	hd := 161
	answer := sc.order(h, &steerOrder{Heading: &hd})
	if !strings.Contains(answer, "tacking to heading 161°, 220° round through the wind (via gybe would be 140°)") {
		t.Errorf("the answer: %s", answer)
	}
	golden(t, "turn-size", answer)
}

// At sea through a sunrise: a wait on the default wakes is woken by it, the
// events tell it, and the Sky line says the sun is rising.
func TestSceneSunrise(t *testing.T) {
	sc := newScene(t, 8, 0)
	st := sc.start()
	st.X, st.Y, st.Heading, st.Surge = 1500, -1500, math.Pi/2, 2
	me := sc.boat(st, true)
	sc.steer(me, -90, 30)
	sc.at(st.X, st.Y, -0.5, true)
	h := sc.helmAt(me)
	sc.look(h, 1)
	text, r := sc.reportSince(h, detailBrief, 0)
	if r.Sky == nil || r.Sky.Light != "dawn" {
		t.Errorf("before sunrise:\n%s", text)
	}
	w := newWaiter(time.Now(), wakeDefault)
	h.wait(w)
	sc.look(h, 60)
	select {
	case why := <-w.done:
		if why != "sunrise" {
			t.Errorf("woke for %q", why)
		}
	default:
		t.Fatal("the sunrise woke no wait")
	}
	text, r = sc.reportSince(h, detailBrief, 0)
	if r.Since == nil || !strings.Contains(strings.Join(r.Since.Events, " · "), "sunrise, the sun rising") ||
		r.Sky == nil || !strings.HasPrefix(r.Sky.Sun, "sun rising") {
		t.Errorf("after sunrise:\n%s", text)
	}
	golden(t, "sunrise", text)
	// Nothing new: the brief report leaves the sky out.
	if text, r := sc.reportSince(h, detailBrief, h.ring.last()); r.Sky != nil {
		t.Errorf("a brief report with the sky unchanged:\n%s", text)
	}
}

// Off Port Royal at sunset: the light on Table Head is lit, and told.
func TestSceneDusk(t *testing.T) {
	sc := newScene(t, 6, 0)
	st := sc.start()
	st.Surge = 0
	me := sc.boat(st, true)
	sc.at(st.X, st.Y, 0.4, false)
	h := sc.helmAt(me)
	sc.look(h, 2)
	sc.look(h, 90)
	text, r := sc.reportSince(h, detailFull, 0)
	events := ""
	if r.Since != nil {
		events = strings.Join(r.Since.Events, " · ")
	}
	if !strings.Contains(events, "sunset") || !strings.Contains(events, "Table Head Light lit") {
		t.Errorf("at dusk:\n%s", text)
	}
	golden(t, "dusk", text)
}

// The wind freshening a force, held a minute, is told once, and wakes a
// wait on the weather.
func TestSceneTheWindFreshens(t *testing.T) {
	sc := newScene(t, 6, 0)
	st := sc.start()
	st.X, st.Y, st.Heading, st.Surge = 1500, -1500, math.Pi/2, 2
	me := sc.boat(st, true)
	h := sc.helmAt(me)
	sc.look(h, 1)
	sc.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.SetWeather,
		Weather: bus.Weather{Mode: bus.WeatherSteady, Speed: uint32(math.Round(12 * nm / 3600 / physics.SeaSpeedStep))}})
	w := newWaiter(time.Now(), []string{wakeWeather})
	h.wait(w)
	sc.look(h, 50)
	if evs, _ := h.ring.after(0); len(evs) > 0 {
		t.Errorf("told before a minute: %+v", evs)
	}
	sc.look(h, 15)
	evs, _ := h.ring.after(0)
	if len(evs) != 1 || evs[0].Kind != evForce || evs[0].Words != "the wind up to force 4, 12 kn" {
		t.Fatalf("the events: %+v", evs)
	}
	select {
	case why := <-w.done:
		if why != "the wind's force" {
			t.Errorf("woke for %q", why)
		}
	default:
		t.Fatal("no wake on the weather")
	}
}

// The place a wait watched is told in every brief report, however far:
// at night, a light seen far off.
func TestSceneTheWatchedPlace(t *testing.T) {
	sc := newScene(t, 12, 0)
	own := sc.start()
	own.X, own.Y, own.Heading, own.Surge = 1500, -1500, math.Pi/2, 2
	me := sc.boat(own, true)
	sc.at(own.X, own.Y, -20, false)
	sc.steer(me, -90, 40)
	h := sc.helmAt(me)
	sc.sail(3 * time.Second)
	sc.reportSince(h, detailBrief, 0)
	text, _ := sc.reportSince(h, detailBrief, 0)
	if strings.Contains(text, "Table Head Light") {
		t.Fatalf("a brief report told a light seen before:\n%s", text)
	}
	e, ok := placeNamed(charted(sc.sea), "Table Head Light")
	if !ok {
		t.Fatal("Table Head Light is not charted")
	}
	h.goal, h.hasGoal = e.subject, true
	if text, _ := sc.reportSince(h, detailBrief, 0); !strings.Contains(text, "Table Head Light") {
		t.Errorf("the place watched, left out:\n%s", text)
	}
}

// Watched: the first line says by how many, and the first watcher coming
// and the last going are told, waking no one.
func TestSceneWatched(t *testing.T) {
	sc := newScene(t, 8, 0)
	st := sc.start()
	st.X, st.Y, st.Heading, st.Surge = 1500, -1500, math.Pi/2, 2
	me := sc.boat(st, true)
	watching := 0
	sc.sea.Watchers = func(bus.Account) int { return watching }
	h := sc.helmAt(me)
	sc.look(h, 1)
	w := newWaiter(time.Now(), wakeDefault)
	h.wait(w)
	watching = 2
	sc.look(h, 2)
	text, r := sc.reportSince(h, detailBrief, 0)
	if r.Watched != 2 || !strings.Contains(strings.SplitN(text, "\n", 2)[0], " · watched by 2") {
		t.Errorf("watched:\n%s", text)
	}
	golden(t, "watched", text)
	watching = 0
	sc.look(h, 2)
	evs, _ := h.ring.after(0)
	var words []string
	for _, e := range evs {
		words = append(words, e.Words)
	}
	if got := fmt.Sprint(words); got != "[someone is watching no one watching now]" {
		t.Errorf("the events: %s", got)
	}
	select {
	case why := <-w.done:
		t.Errorf("woke for %q", why)
	default:
	}
}
