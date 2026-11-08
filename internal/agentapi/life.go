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
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// The sea's life as the lookout sees it: each group in the frame whose
// middle, where every phone draws it, is within its kind's reach of the
// boat and within the visibility there, while the sun is up over it, and
// for life in the water seen less as the sea rises, while the sea there
// shows it at all. Groups are told by what they are and do, "two brown
// boobies flying low", "a pod of spotted dolphins passing", and where
// they are, by compass point and range; a group with the boat is
// "following your boat" or "riding your bow". The fish flushed from a
// ground are the ground's: told once, nearest, however often a boat
// flushes them.

// lifeSeen is a group of the sea's life in sight: its id, or for fish
// flushed from a ground the ground's, its range, m, and its line.
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

// lifeAtBow is how near the own boat's bow fish flushed are, as they
// break the surface, to be flushed from it, m.
const lifeAtBow = 40.0

// lifeLeaps is the speed above which dolphins leap as they go, m/s:
// leaping costs less than swimming above about 3.5 m/s (Au and Weihs
// 1980).
const lifeLeaps = 3.5

// bowOf is where the bow of the boat in slot sl is, m east and north.
func (s *Sea) bowOf(f *bus.Frame, sl int32) (x, y float64) {
	st := &f.State[sl]
	bow := 4.0
	if k := int(f.Kind[sl]); k < len(s.Kinds) {
		bow = s.Kinds[k].Bow()
	}
	sin, cos := math.Sincos(st.Heading)
	return st.X + bow*sin, st.Y + bow*cos
}

// lifeInSight are the groups of the sea's life the lookout of the boat in
// slot sl sees, nearest first.
func (s *Sea) lifeInSight(f *bus.Frame, sl int32) []lifeSeen {
	if s.Life == nil || len(f.Life) == 0 {
		return nil
	}
	kinds := s.Life.Kinds()
	p := s.Life.Params()
	st := &f.State[sl]
	own := f.Boat[sl]
	wt := s.weatherAt(f)
	hasWeather := wt != nil && wt.Prepared() != nil
	bx, by := s.bowOf(f, sl)
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
		if d > k.Reach || hasWeather && d > physics.VisibilityAt(wt, x, y) {
			continue
		}
		sun := s.Life.Sun(f.Tick, x, y)
		if k.Form == catalog.LifeFormGlow {
			// Seen only from inside it, on a dark night, in the wake.
			if dx, dy := st.X-e.East, st.Y-e.North; float64(dx*dx)+float64(dy*dy) > float64(life.Patch(k, e.Seed)*life.Patch(k, e.Seed)) || !s.Life.Dark(k, f.Tick, st.X, st.Y) {
				continue
			}
			out = append(out, lifeSeen{id: e.ID, d: 0, text: "the water glowing blue-green where your wake breaks"})
			continue
		}
		if life.Aboard(e) {
			if e.Boat == own {
				out = append(out, lifeSeen{id: e.ID, d: 0, text: "a flying fish landed on your deck"})
			}
			continue
		}
		if !(sun > 0) {
			// By night only what glowing water lights is seen: a pod
			// swimming through it, close by.
			if d > lifeTrails || k.Form != catalog.LifeFormPod || !s.glowing(f, x, y) {
				continue
			}
			out = append(out, lifeSeen{id: e.ID, d: d, text: fmt.Sprintf("%s trailing light through the glowing water to the %s, %s",
				lifeName(k.Plural), point16(physics.Atan2(dx, dy)), rangeWords(d))})
			continue
		}
		if k.BySea && hasWeather && len(p.Sea) > 0 {
			mean, _ := physics.MeanWindAt(wt, x, y)
			if !(p.Sea[min(weather.ForceOf(mean), len(p.Sea)-1)] > 0) {
				continue
			}
		}
		id := e.ID
		var line string
		near := false
		switch {
		case k.Form == catalog.LifeFormBird && k.Perches() && e.Boat != 0:
			line = groupWords(k, e) + " " + perchDoing(k, e, f.Tick, e.Boat == own)
			near = e.Boat == own
		case k.Form == catalog.LifeFormBird:
			doing := s.lifeDoing(k, e, sun, own)
			line = groupWords(k, e) + " " + doing
			near = e.Boat != 0 && e.Boat == own
		case k.Form == catalog.LifeFormWhale:
			doing := whaleDoing(k, e, f.Tick)
			if doing == "" {
				// Down on a dive: nothing shows.
				continue
			}
			line = groupWords(k, e) + " " + doing
		case k.Form == catalog.LifeFormFin:
			line = "the fin of " + groupWords(k, e) + " cutting the water"
		case k.Flushes():
			id = e.Over
			if fx, fy := e.East-bx, e.North-by; float64(fx*fx)+float64(fy*fy) <= lifeAtBow*lifeAtBow {
				line, near = lifeName(k.Plural)+" skittering away from your bow", true
			} else {
				line = lifeName(k.Plural) + " gliding"
			}
		case k.Rides() && e.Boat != 0 && e.Boat == own:
			line, near = lifeName(k.Plural)+" riding your bow", true
		default:
			line = groupWords(k, e)
			if doing := swimDoing(k, e); doing != "" {
				line += " " + doing
			}
		}
		if !near {
			line += fmt.Sprintf(" to the %s, %s", point16(physics.Atan2(dx, dy)), rangeWords(d))
		}
		out = append(out, lifeSeen{id: id, d: d, text: line})
	}
	slices.SortFunc(out, func(a, b lifeSeen) int {
		if c := cmp.Compare(a.d, b.d); c != 0 {
			return c
		}
		return cmp.Compare(a.id, b.id)
	})
	// The fish of a ground once, the nearest.
	return slices.CompactFunc(out, func(a, b lifeSeen) bool { return a.id == b.id })
}

// groupWords are a group by its count and kind: "a laughing gull", "two
// brown boobies", "a few sooty terns", "a flock of Audubon's
// shearwaters"; a kind with a word for its groups by it, "a pod of
// spotted dolphins", "a boil of bait".
func groupWords(k *life.Kind, e *bus.LifeEncounter) string {
	n := e.Count
	if k.Collective != "" && (n > 1 || k.Name == k.Plural) {
		return "a " + k.Collective + " of " + lifeName(k.Plural)
	}
	switch {
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

// lifeTrails is how near a pod swimming through glowing water at night is
// seen by the light it trails, m.
const lifeTrails = 300.0

// glowing says whether glowing water shows at (x, y) now: inside a patch
// of it, on a dark night.
func (s *Sea) glowing(f *bus.Frame, x, y float64) bool {
	kinds := s.Life.Kinds()
	for i := range f.Life {
		e := &f.Life[i]
		if int(e.Kind) >= len(kinds) || kinds[e.Kind].Form != catalog.LifeFormGlow {
			continue
		}
		k := &kinds[e.Kind]
		r := life.Patch(k, e.Seed)
		if dx, dy := x-e.East, y-e.North; float64(dx*dx)+float64(dy*dy) <= float64(r*r) && s.Life.Dark(k, f.Tick, x, y) {
			return true
		}
	}
	return false
}

// perchDoing is what a booby that perches on boats is doing with its
// boat, the own or another: flying in to it, perched on it, or leaving it.
func perchDoing(k *life.Kind, e *bus.LifeEncounter, tick int64, own bool) string {
	boat := "a boat"
	if own {
		boat = "your boat"
	}
	u := float64(tick-e.Start) / physics.StepsPerSecond
	a := k.Arrive(e.Speed)
	switch {
	case u < a:
		return "flying in to perch on " + boat
	case u > float64(e.End-e.Start)/physics.StepsPerSecond-a:
		return "leaving " + boat
	}
	return "perched on " + boat
}

// whaleSeen is how long after a blow, a breach or a dive with its flukes
// raised a whale is seen by it, s: a blow hangs a second or two, but a
// lookout who saw it keeps the place.
const whaleSeen = 60.0

// whaleDoing is what a group of whales is seen doing now: breaching,
// slapping, fluking up, blowing; or "" while every one of them is down.
// A group that logs at the surface is logging between its blows.
func whaleDoing(k *life.Kind, e *bus.LifeEncounter, tick int64) string {
	u := float64(tick-e.Start) / physics.StepsPerSecond
	var blew, breached, slapped, fluked bool
	for i := range min(int(e.Count), 24) {
		life.WhaleEvents(k, e, i, u-whaleSeen, u+1e-9, func(ev int, at float64) {
			switch ev {
			case life.WhaleBlow:
				blew = true
			case life.WhaleBreach:
				breached = breached || u-at < 20
			case life.WhaleSlap:
				slapped = slapped || u-at < 20
			case life.WhaleFluke:
				fluked = fluked || u-at < 20
			}
		})
	}
	logs := k.Swim != nil && k.Swim.Logs != nil && *k.Swim.Logs
	switch {
	case breached:
		return "breaching"
	case slapped:
		return "slapping the water with its tail"
	case fluked:
		return "diving, flukes raised"
	case blew && logs:
		return "logging at the surface, blowing"
	case blew:
		return "blowing"
	}
	return ""
}

// whaleHeard are how far a whale's blow and its breach or slap are heard,
// m: a blow's low rush to 600 m, a breach's boom to 1,500 m.
const (
	whaleBlowHeard  = 600.0
	whaleBoomHeard  = 1500.0
	whaleHeardAfter = 20.0 // s: what a report listens back for
)

// whaleLines are the whales heard about the boat in slot sl, by day or
// night: blowing, breaching or slapping the water, and where.
func (s *Sea) whaleLines(f *bus.Frame, sl int32) []string {
	if s.Life == nil {
		return nil
	}
	kinds := s.Life.Kinds()
	st := &f.State[sl]
	var out []string
	for i := range f.Life {
		e := &f.Life[i]
		if int(e.Kind) >= len(kinds) || kinds[e.Kind].Form != catalog.LifeFormWhale {
			continue
		}
		k := &kinds[e.Kind]
		x, y, _, alive := life.FlockAt(e, k, float64(f.Tick), nil)
		dx, dy := x-st.X, y-st.Y
		d := math.Sqrt(float64(dx*dx) + float64(dy*dy))
		if !alive || d > whaleBoomHeard {
			continue
		}
		u := float64(f.Tick-e.Start) / physics.StepsPerSecond
		var blew, boomed, slapped bool
		for w := range min(int(e.Count), 24) {
			life.WhaleEvents(k, e, w, u-whaleHeardAfter, u+1e-9, func(ev int, _ float64) {
				blew = blew || ev == life.WhaleBlow && d <= whaleBlowHeard
				boomed = boomed || ev == life.WhaleBreach
				slapped = slapped || ev == life.WhaleSlap
			})
		}
		name := lifeName(k.Name)
		where := " to the " + point16(physics.Atan2(dx, dy))
		for _, l := range []struct {
			ok   bool
			line string
		}{
			{boomed, "a " + name + " breaching" + where + ", a boom"},
			{slapped, "a " + name + "'s tail slapping the water" + where},
			{blew, "a " + name + " blowing" + where},
		} {
			if l.ok && !slices.Contains(out, l.line) {
				out = append(out, l.line)
			}
		}
	}
	return out
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

// lifeDoing is what a group of birds is doing as seen: following a boat;
// flying home at dusk, for a kind that does; else as its path goes.
func (s *Sea) lifeDoing(k *life.Kind, e *bus.LifeEncounter, sun float64, own uint64) string {
	switch {
	case e.Boat != 0 && e.Boat == own:
		return "following your boat"
	case e.Boat != 0:
		return "following a boat"
	case k.Homeward && s.Life.Dusk(sun):
		return "flying homeward"
	}
	switch k.PathOf(e) {
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

// swimDoing is what a group in the water is doing as seen, "" for nothing
// to tell (a boil of bait is its own news): riding another boat's bow;
// feeding over another's patch; surfacing, for a turtle; leaping and
// spinning, or rolling at the surface, for one that stays about its
// patch; passing, or leaping as it passes when fast.
func swimDoing(k *life.Kind, e *bus.LifeEncounter) string {
	switch {
	case k.Form == catalog.LifeFormBait:
		return ""
	case e.Boat != 0:
		return "riding a boat's bow"
	case e.Over != 0:
		return "feeding"
	case k.Form == catalog.LifeFormTurtle:
		return "surfacing"
	case k.Lingers():
		if k.Swim != nil && len(k.Swim.Spins) > 0 {
			return "leaping and spinning"
		}
		return "rolling at the surface"
	case e.Speed > lifeLeaps:
		if e.Count <= 1 && k.Name != k.Plural {
			return "leaping as it passes"
		}
		return "leaping as they pass"
	}
	return "passing"
}

// lifeForget is how long a group, or a ground of fish, is gone from the
// frame before coming into sight again is news again, ticks: a ground's
// fish are flushed again and again, with gaps between.
const lifeForget = 120 * physics.StepsPerSecond

// lifeMoments are the groups of the sea's life come into sight of the
// boat in slot sl since the helm last looked, as events: each group once,
// and each ground of fish once. told is false at the helm's first look,
// when what is in sight already is no news. With mu held.
func (h *helm) lifeMoments(s *Sea, f *bus.Frame, sl int32, told bool) []event {
	seen := s.lifeInSight(f, sl)
	if len(seen) == 0 && len(h.lifeSeen) == 0 {
		return nil
	}
	if h.lifeSeen == nil {
		h.lifeSeen = map[uint64]int64{}
	}
	var out []event
	for _, g := range seen {
		if _, ok := h.lifeSeen[g.id]; !ok && told {
			out = append(out, event{Tick: f.Tick, Kind: evLife, Words: "life in sight: " + g.text})
		}
		h.lifeSeen[g.id] = f.Tick
	}
	// A group gone from the frame a while is let go: its id is not used
	// again, and a ground's fish flushed again later are news again.
	if len(h.lifeSeen) > len(seen) {
		for i := range f.Life {
			e := &f.Life[i]
			if _, ok := h.lifeSeen[e.ID]; ok {
				h.lifeSeen[e.ID] = f.Tick
			}
			if _, ok := h.lifeSeen[e.Over]; ok && e.Over != 0 {
				h.lifeSeen[e.Over] = f.Tick
			}
		}
		for id, at := range h.lifeSeen {
			if f.Tick-at > lifeForget {
				delete(h.lifeSeen, id)
			}
		}
	}
	return out
}

// lifeBreath is how near a group that breathes at the surface is heard
// blowing, m.
const lifeBreath = 40.0

// breathLines are the breaths of the groups in the water heard about the
// boat in slot sl, by day or night: "dolphins breathing close by", by the
// last word of their kind's plural.
func (s *Sea) breathLines(f *bus.Frame, sl int32) []string {
	if s.Life == nil {
		return nil
	}
	kinds := s.Life.Kinds()
	st := &f.State[sl]
	var out []string
	for i := range f.Life {
		e := &f.Life[i]
		if int(e.Kind) >= len(kinds) {
			continue
		}
		k := &kinds[e.Kind]
		if k.Swim == nil || k.Swim.Call != catalog.SwimLookCallBreath {
			continue
		}
		pose, ok := poseOf(f, e)
		if !ok {
			continue
		}
		x, y, _, alive := life.FlockAt(e, k, float64(f.Tick), pose)
		if dx, dy := x-st.X, y-st.Y; !alive || float64(dx*dx)+float64(dy*dy) > lifeBreath*lifeBreath {
			continue
		}
		words := strings.Fields(lifeName(k.Plural))
		if line := words[len(words)-1] + " breathing close by"; !slices.Contains(out, line) {
			out = append(out, line)
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
