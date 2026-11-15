// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"encoding/json"
	"math"
	"slices"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// A machine sailor's course: set by a position for a pin, by a charted
// place's name and by an open course's for its start; refused for a name
// not charted, a malformed position and one past the rim; replaced and
// cleared; told by observe in brief, full and JSON; reached, waking a
// wait and clearing; and lost with a new world.

// placeAt moves a's boat to (x, y), heading north at rest, and waits for
// the hub to look at it there.
func (h *harness) placeAt(t *testing.T, a *oauth.Accepted, x, y float64) {
	t.Helper()
	boat := h.boatOf(a)
	reply := make(chan bus.Reply, 1)
	if err := h.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Place, Boat: boat, State: physics.State{X: x, Y: y}, Reply: reply}); err != nil {
		t.Fatal(err)
	}
	if r := <-reply; r.Result != bus.Done {
		t.Fatalf("placed: %+v", r)
	}
}

// waitWhile calls observe with o as a, and does do two seconds into its
// wait; it returns the wait's answer.
func (h *harness) waitWhile(t *testing.T, a *oauth.Accepted, o map[string]any, do func()) string {
	t.Helper()
	answer := make(chan string, 1)
	go func() {
		text, _ := h.call(t, a, "observe", o)
		answer <- text
	}()
	time.Sleep(2 * time.Second)
	do()
	return <-answer
}

// pinFrom is a position d m from (x, y) on bearing deg, as written.
func pinFrom(x, y, deg, d float64) string {
	s, c := physics.SinCos(rad(deg))
	return chart.Format(x+d*s, y+d*c)
}

func TestACourseToAPin(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, 8, 10, 0)
		a := sailor(1, "Iron Mary")
		if text, refused := h.call(t, a, "course", nil); refused || !strings.Contains(text, "\nNo course set. course takes place") {
			t.Fatalf("no course: %v %s", refused, text)
		}
		h.call(t, a, "observe", nil)
		x, y, _ := h.boatAt(a)
		pin := pinFrom(x, y, 90, 1200)
		text, refused := h.call(t, a, "course", map[string]any{"position": pin})
		if refused || !strings.HasPrefix(text, "Course set: your pin 090° 0.6 NM · at "+pin+". A bearing, never a steering order") {
			t.Fatalf("set: %v %s", refused, text)
		}
		if text, _ := h.call(t, a, "course", map[string]any{"position": pin}); !strings.Contains(text, "already") {
			t.Errorf("the same again: %s", text)
		}
		// Told at every look, brief and full, in text and JSON alike.
		for _, detail := range []string{detailBrief, detailFull} {
			text, _ := h.call(t, a, "observe", map[string]any{"detail": detail})
			if !strings.Contains(text+"\n", "\nCourse: your pin 090° 0.6 NM · at "+pin+"\n") {
				t.Errorf("%s: no course line:\n%s", detail, text)
			}
		}
		text, _ = h.call(t, a, "observe", map[string]any{"format": "json"})
		var r struct {
			Course *courseFacts `json:"course"`
		}
		if err := json.Unmarshal([]byte(text), &r); err != nil || r.Course == nil ||
			*r.Course != (courseFacts{Name: "your pin", Bearing: 90, NM: 0.6, Position: pin}) {
			t.Errorf("JSON: %v %s", err, text)
		}

		// Another replaces it; clear clears it. (A wait for the looks'
		// budget first.)
		time.Sleep(3 * time.Second)
		other := pinFrom(x, y, 200, 3000)
		if text, _ := h.call(t, a, "course", map[string]any{"position": other}); !strings.Contains(text, "Course set: your pin 200° 1.6 NM") ||
			!strings.Contains(text, "(it replaces your pin)") {
			t.Errorf("replaced: %s", text)
		}
		if text, _ := h.call(t, a, "course", nil); text != "Your course: your pin 200° 1.6 NM · at "+other+"." {
			t.Errorf("told: %s", text)
		}
		if text, _ := h.call(t, a, "course", map[string]any{"clear": true}); text != "Course cleared: it was your pin." {
			t.Errorf("cleared: %s", text)
		}
		if text, _ := h.call(t, a, "observe", map[string]any{"detail": "full"}); strings.Contains(text, "Course:") {
			t.Errorf("a course line with none set:\n%s", text)
		}
		if text, _ := h.call(t, a, "course", map[string]any{"clear": true}); text != "No course was set: nothing to clear." {
			t.Errorf("cleared twice: %s", text)
		}
		// One within a tenth of a mile is not set: the boat is there.
		if text, _ := h.call(t, a, "course", map[string]any{"position": pinFrom(x, y, 0, 100)}); !strings.HasPrefix(text, "You are at your pin already, within 0.1 NM: no course set.") {
			t.Errorf("one where the boat is: %s", text)
		}
	})
}

func TestCourseRefusals(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, 8, 10, 0)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		edge := h.sea.Timeline.Prepared().Edge()
		beyond := chart.Format(0, -(edge + 400))
		for _, c := range []struct {
			args map[string]any
			want string
		}{
			{map[string]any{"position": "67°24′N 045°"}, `Not a position, "67°24′N 045°": write a position as degrees and minutes`},
			{map[string]any{"position": "somewhere east"}, `"somewhere" is not a number of degrees or minutes`},
			{map[string]any{"position": "67°24′S 045°12′"}, "every latitude is north"},
			{map[string]any{"position": beyond}, beyond + " is beyond the edge, past the lip of the falls, 4.5 NM from the pole"},
			{map[string]any{"place": "Gull Rock"}, `No charted place or open course called "Gull Rock".`},
			{map[string]any{"place": "Gull Rock", "clear": true}, "Give one of place, position or clear"},
			{map[string]any{"heading": 90}, "The arguments are not this tool's"},
		} {
			text, refused := h.call(t, a, "course", c.args)
			if !refused || !strings.Contains(text, c.want) {
				t.Errorf("%v: %v %s", c.args, refused, text)
			}
		}
		if text, _ := h.call(t, a, "course", nil); !strings.HasPrefix(text, "No course set.") {
			t.Errorf("set by a refusal: %s", text)
		}
	})
}

// Reached within a tenth of a mile: a wait on the default wakes for it,
// the event says so, and the course clears; a wait not on course is not
// woken, but the course clears all the same.
func TestACourseReached(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, 8, 10, 0)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		x, y, _ := h.boatAt(a)
		px, py := x+1000, y
		if _, refused := h.call(t, a, "course", map[string]any{"position": chart.Format(px, py)}); refused {
			t.Fatal("not set")
		}
		h.call(t, a, "observe", nil)
		text := h.waitWhile(t, a, map[string]any{"wait": 25}, func() { h.placeAt(t, a, px-150, py) })
		if !strings.Contains(strings.SplitN(text, "\n", 2)[0], "woke: course") || !strings.Contains(text, "you've reached your pin: the course is cleared") ||
			strings.Contains(text, "Course:") {
			t.Fatalf("reached:\n%s", text)
		}
		if text, _ := h.call(t, a, "course", nil); !strings.HasPrefix(text, "No course set.") {
			t.Errorf("after: %s", text)
		}

		// Not woken without course in wake_on, and cleared all the same.
		x, y, _ = h.boatAt(a)
		px, py = x, y+1000
		h.call(t, a, "course", map[string]any{"position": chart.Format(px, py)})
		text = h.waitWhile(t, a, map[string]any{"wait": 5, "wake_on": []string{"chat"}}, func() { h.placeAt(t, a, px, py-100) })
		if !strings.Contains(text, "waited 5 s, nothing new") || !strings.Contains(text, "you've reached your pin") {
			t.Fatalf("not waking on course:\n%s", text)
		}
		if text, _ := h.call(t, a, "course", nil); !strings.HasPrefix(text, "No course set.") {
			t.Errorf("after: %s", text)
		}
	})
}

// A course is kept for the world it was set in: the next world's opening
// lets it go, and the course tool and observe tell none.
func TestACourseLostWithTheWorld(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		h := newHarness(t, 8, 10, 0)
		a := sailor(1, "Iron Mary")
		h.call(t, a, "observe", nil)
		x, y, _ := h.boatAt(a)
		h.call(t, a, "course", map[string]any{"position": pinFrom(x, y, 45, 2000)})
		// A helm forgotten while idle keeps it: it is the account's.
		h.core.Stop(a.Account, "stopped")
		if text, _ := h.call(t, a, "course", nil); !strings.Contains(text, "Your course: your pin, at ") {
			t.Fatalf("kept: %s", text)
		}
		old := h.sea
		next := &Sea{Number: 2, Epoch: old.Epoch, Bus: old.Bus, Boats: old.Boats, Limit: old.Limit, AICap: old.AICap, AIReserve: old.AIReserve,
			Timeline: old.Timeline, Waves: old.Waves, Words: old.Words, Catalog: old.Catalog, Kinds: old.Kinds, Encounters: old.Encounters}
		h.core.Open(next)
		if text, _ := h.call(t, a, "course", nil); !strings.HasPrefix(text, "No course set.") {
			t.Errorf("in the next world: %s", text)
		}
		if k := h.core.courseOf(a.Account, old); k != nil {
			t.Errorf("the old world's course kept: %+v", k)
		}
		f := h.w.Bus().Frames.Acquire()
		defer f.Release()
		hm := h.core.helmOf(a)
		hm.mu.Lock()
		defer hm.mu.Unlock()
		for _, sl := range f.Live {
			if f.Owner[sl] == bus.Account(a.Account) {
				if r := hm.reportFor(next, f, sl, detailFull, 0); r.Course != nil {
					t.Errorf("a course told in the next world: %+v", r.Course)
				}
			}
		}
	})
}

// In seed 1's world: by a charted place's name, an island's reached at its
// nearest shore, by an open course's name for its start, and a name not
// charted or a course not open refused.
func TestSceneACourse(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		ls := newLookSea(t)
		a := sailor(1, "Iron Mary")
		call := func(args map[string]any) (string, bool) {
			t.Helper()
			// The looks' budget, a call at a time.
			time.Sleep(time.Second)
			return ls.call(t, a, "course", args)
		}
		ls.call(t, a, "observe", nil)
		// The start is in Port Royal's island's bounds.
		if text, _ := call(map[string]any{"place": "Port Royal"}); text != "You are at Port Royal already, within 0.1 NM: no course set." {
			t.Errorf("Port Royal from the start: %s", text)
		}
		if text, refused := call(map[string]any{"place": "table head light"}); refused || !strings.HasPrefix(text, "Course set: Table Head Light ") {
			t.Errorf("by a place's name: %v %s", refused, text)
		}
		if text, refused := call(map[string]any{"place": "Table Hed Light"}); !refused || !strings.Contains(text, "Did you mean Table Head Light (") {
			t.Errorf("misspelt: %v %s", refused, text)
		}
		// A course not open has no start to sail to; open, it has.
		if text, refused := call(map[string]any{"place": "Round Shipstern Cay"}); !refused || !strings.Contains(text, `No charted place or open course called "Round Shipstern Cay"`) {
			t.Errorf("a course not open: %v %s", refused, text)
		}
		w := ls.sc.cw
		k := slices.IndexFunc(w.Courses, func(c worldgen.Course) bool { return c.Name == "Round Shipstern Cay" })
		var rows []store.Charting
		for _, s := range w.CourseSubjects[k] {
			rows = append(rows, store.Charting{Subject: chart.KindWord(w.Subjects[s].Kind), Number: w.Subjects[s].Number})
		}
		ls.sc.sea.Chart.Add(rows)
		start := w.Courses[k].Start
		text, refused := call(map[string]any{"place": "Start of Round Shipstern Cay"})
		if refused || !strings.HasPrefix(text, "Course set: Start of Round Shipstern Cay ") || !strings.Contains(text, "(it replaces Table Head Light)") {
			t.Fatalf("by a course's name: %v %s", refused, text)
		}
		got := waitWhileIn(t, ls, a, func() { ls.place(t, a, start.X+120, start.Y) })
		if !strings.Contains(got, "woke: course") || !strings.Contains(got, "you've reached the start of Round Shipstern Cay: the course is cleared") {
			t.Fatalf("the start reached:\n%s", got)
		}

		// Port Royal from the east: aimed at its shore, and reached there,
		// short of its middle by far more than a tenth of a mile.
		is, _ := placeNamed(charted(ls.sc.sea), "Port Royal")
		b := is.sub.Bounds
		y := (b[1] + b[3]) / 2
		ls.place(t, a, b[2]+1000, y)
		if text, _ := call(map[string]any{"place": "Port Royal"}); !strings.HasPrefix(text, "Course set: Port Royal 270° 0.5 NM.") {
			t.Fatalf("Port Royal from the east: %s", text)
		}
		got = waitWhileIn(t, ls, a, func() { ls.place(t, a, b[2]+150, y) })
		if !strings.Contains(got, "you've reached Port Royal: the course is cleared") {
			t.Fatalf("Port Royal's shore reached:\n%s", got)
		}
		if d := math.Hypot(b[2]+150-is.sub.X, y-is.sub.Y); d < 2*chart.Arrive {
			t.Fatalf("the shore is %.0f m from the middle", d)
		}
	})
}

// waitWhileIn waits with observe as a in ls's world, and does do as it
// waits; it returns the wait's answer.
func waitWhileIn(t *testing.T, ls *lookSea, a *oauth.Accepted, do func()) string {
	t.Helper()
	answer := make(chan string, 1)
	go func() {
		text, _ := callCore(t, t.Context(), ls.core, a, "observe", map[string]any{"wait": 25})
		answer <- text
	}()
	do()
	return <-answer
}
