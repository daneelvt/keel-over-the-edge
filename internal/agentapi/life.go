// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
	"github.com/daneelvt/keel-over-the-edge/internal/lookout"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The sea's life as the lookout sees it: each group in the frame whose
// middle, where every phone draws it, is within its kind's reach of the
// boat and within the visibility there, and, for birds, while the sun is
// up over it. Groups are told by what they are and do, "two brown boobies
// flying low", and where they are, by compass point and range; a group
// with the boat is "following your boat".

// lifeSeen is a group of the sea's life in sight: its id, its range, m,
// and its line.
type lifeSeen struct {
	id   uint64
	d    float64
	text string
}

// poseOf is the pose of the boat a group is with, from the frame: nil for
// a group with none, or whose boat has left its slot.
func poseOf(f *bus.Frame, e *bus.LifeEncounter) (*life.Pose, bool) {
	if e.Boat == 0 {
		return nil, true
	}
	if e.Slot < 0 || int(e.Slot) >= f.Capacity() || !f.Occupied[e.Slot] || f.Boat[e.Slot] != e.Boat {
		return nil, false
	}
	st := &f.State[e.Slot]
	return &life.Pose{X: st.X, Y: st.Y, Heading: st.Heading}, true
}

// lifeInSight are the groups of the sea's life the lookout of the boat in
// slot sl sees, nearest first.
func (s *Sea) lifeInSight(f *bus.Frame, sl int32) []lifeSeen {
	if s.Life == nil || len(f.Life) == 0 {
		return nil
	}
	kinds := s.Life.Kinds()
	st := &f.State[sl]
	own := f.Boat[sl]
	wt := s.weatherAt(f)
	weather := wt != nil && wt.Prepared() != nil
	var out []lifeSeen
	for i := range f.Life {
		e := &f.Life[i]
		if int(e.Kind) >= len(kinds) {
			continue
		}
		k := &kinds[e.Kind]
		pose, ok := poseOf(f, e)
		if !ok {
			continue
		}
		x, y, _, alive := life.FlockAt(e, k, float64(f.Tick), pose)
		if !alive {
			continue
		}
		dx, dy := x-st.X, y-st.Y
		d := math.Sqrt(float64(dx*dx) + float64(dy*dy))
		if d > k.Reach || weather && d > physics.VisibilityAt(wt, x, y) {
			continue
		}
		sun := s.Life.Sun(f.Tick, x, y)
		if k.Form == catalog.LifeFormBird && !(sun > 0) {
			continue
		}
		line := groupWords(k, e) + " " + s.lifeDoing(k, e, sun, own)
		if e.Boat != own || own == 0 {
			line += fmt.Sprintf(" to the %s, %s", point16(physics.Atan2(dx, dy)), rangeWords(d))
		}
		out = append(out, lifeSeen{id: e.ID, d: d, text: line})
	}
	slices.SortFunc(out, func(a, b lifeSeen) int {
		if c := cmp.Compare(a.d, b.d); c != 0 {
			return c
		}
		return cmp.Compare(a.id, b.id)
	})
	return out
}

// groupWords are a group by its count and kind: "a laughing gull", "two
// brown boobies", "a few sooty terns", "a flock of Audubon's
// shearwaters".
func groupWords(k *life.Kind, e *bus.LifeEncounter) string {
	switch n := e.Count; {
	case n <= 1:
		name := lifeName(k.Name)
		if strings.ContainsRune("aeiou", rune(name[0])) {
			return "an " + name
		}
		return "a " + name
	case n == 2:
		return "two " + lifeName(k.Plural)
	case n == 3:
		return "three " + lifeName(k.Plural)
	case n <= 6:
		return "a few " + lifeName(k.Plural)
	}
	return "a flock of " + lifeName(k.Plural)
}

// lifeName is a kind's name within a line: lower case but for a name of
// a person, as in "Audubon's shearwater".
func lifeName(n string) string {
	first, _, _ := strings.Cut(n, " ")
	if n == "" || strings.HasSuffix(first, "'s") {
		return n
	}
	r, size := utf8.DecodeRuneInString(n)
	return string(unicode.ToLower(r)) + n[size:]
}

// lifeDoing is what a group is doing as seen: following a boat; flying
// home at dusk, for a kind that does; else as its path goes.
func (s *Sea) lifeDoing(k *life.Kind, e *bus.LifeEncounter, sun float64, own uint64) string {
	switch {
	case e.Boat != 0 && e.Boat == own:
		return "following your boat"
	case e.Boat != 0:
		return "following a boat"
	case k.Homeward && s.Life.Dusk(sun):
		return "flying homeward"
	}
	switch k.Path {
	case life.PathSoar:
		return "soaring high"
	case life.PathWork:
		return "working the water"
	case life.PathSkim:
		if k.Line {
			return "skimming the swell in a line"
		}
		return "skimming the waves"
	}
	switch h := life.Height(k, e.Seed); {
	case h < 10:
		return "flying low"
	case h < 30:
		return "flying by"
	}
	return "flying high"
}

// lifeMoments are the groups of the sea's life come into sight of the
// boat in slot sl since the helm last looked, as events: each group once.
// told is false at the helm's first look, when what is in sight already
// is no news. With mu held.
func (h *helm) lifeMoments(s *Sea, f *bus.Frame, sl int32, told bool) []event {
	seen := s.lifeInSight(f, sl)
	if len(seen) == 0 && len(h.lifeSeen) == 0 {
		return nil
	}
	if h.lifeSeen == nil {
		h.lifeSeen = map[uint64]bool{}
	}
	var out []event
	for _, g := range seen {
		if h.lifeSeen[g.id] {
			continue
		}
		h.lifeSeen[g.id] = true
		if told {
			out = append(out, event{Tick: f.Tick, Kind: evLife, Words: "life in sight: " + g.text})
		}
	}
	// A group gone from the frame is let go: its id is not used again.
	if len(h.lifeSeen) > len(seen) {
		alive := make(map[uint64]bool, len(f.Life))
		for i := range f.Life {
			alive[f.Life[i].ID] = true
		}
		for id := range h.lifeSeen {
			if !alive[id] {
				delete(h.lifeSeen, id)
			}
		}
	}
	return out
}

// lifeHeard are the groups of the sea's life the boat in slot sl may hear,
// each with the pose of the boat it is with: those whose middle is now
// within the calls' reach and the way a group goes in the time a report
// listens back.
func (s *Sea) lifeHeard(f *bus.Frame, sl int32) []lookout.LifeHeard {
	if s.Life == nil {
		return nil
	}
	kinds := s.Life.Kinds()
	st := &f.State[sl]
	var out []lookout.LifeHeard
	for i := range f.Life {
		e := &f.Life[i]
		if int(e.Kind) >= len(kinds) {
			continue
		}
		pose, ok := poseOf(f, e)
		if !ok {
			continue
		}
		x, y, _, alive := life.FlockAt(e, &kinds[e.Kind], float64(f.Tick), pose)
		if dx, dy := x-st.X, y-st.Y; !alive || float64(dx*dx)+float64(dy*dy) > lifeHeardWithin*lifeHeardWithin {
			continue
		}
		out = append(out, lookout.LifeHeard{Group: *e, Pose: pose})
	}
	return out
}

// lifeHeardWithin is how near a group's middle is now for its calls to be
// listened for, m: the calls' reach, and the way a group flies in the time
// a report listens back.
const lifeHeardWithin = 300 + 20*thunderBack
