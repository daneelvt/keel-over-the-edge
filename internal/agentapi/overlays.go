// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/lookout"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
)

// The phone's overlays and sounds, in words: the beginners' overlays are
// open to every human at any time (the gust ring, right of way, dirty
// air), so an agent always gets what they show, by the phone's own rules
// (package lookout); and the sounds the phone plays, each with its
// bearing. Nothing the phone does not show or play: the phone plays no
// surf, so neither is it heard here.

// overlays are a world's overlays' rules, made once.
type overlays struct {
	once  sync.Once
	right []*lookout.RightOfWay // by the sailor's kind of boat
	dirty []*lookout.DirtyAir
	hear  *lookout.Hearing
}

// rules are the world's overlays' rules: none for a world given no
// catalog.
func (s *Sea) rules() *overlays {
	o := &s.overlays
	o.once.Do(func() {
		if s.Catalog == nil {
			return
		}
		o.hear = lookout.NewHearing(s.Catalog)
		if s.Encounters == nil {
			return
		}
		for k := range s.Kinds {
			o.right = append(o.right, lookout.NewRightOfWay(s.Catalog, s.Kinds, k, s.Encounters))
			o.dirty = append(o.dirty, lookout.NewDirtyAir(s.Catalog, s.Kinds, k, s.Encounters))
		}
	})
	return o
}

// seenOf is a boat as the overlays take it: its pose, and its velocity:
// its own over the ground for the sailor's boat, along its heading at its
// speed for another, as the phone draws them.
func seenOf(f *bus.Frame, sl int32, own bool) lookout.Seen {
	st := &f.State[sl]
	v := lookout.Seen{East: st.X, North: st.Y, Heading: st.Heading, Heel: st.Heel, Boom: st.Boom, Mode: st.SailorMode}
	if own {
		in := &f.Instruments[sl]
		sn, cs := physics.SinCos(float64(in.CourseOverGround))
		v.VEast, v.VNorth = float64(in.SpeedOverGround)*sn, float64(in.SpeedOverGround)*cs
	} else {
		sn, cs := physics.SinCos(st.Heading)
		v.VEast, v.VNorth = st.Surge*sn, st.Surge*cs
	}
	return v
}

// judgedOf is a boat as the Articles take it.
func judgedOf(f *bus.Frame, sl int32, own bool) lookout.Judged {
	return lookout.Judged{Seen: seenOf(f, sl, own), Course: f.Course[sl], WindFrom: f.Wind[sl].WindFrom}
}

// marks are the right-of-way overlay's and dirty air's words for the
// boats in sight of the boat in slot sl, by their slots.
func (s *Sea) marks(f *bus.Frame, sl int32, seen []seenBoat) map[int32]string {
	o := s.rules()
	k := int(f.Kind[sl])
	if k >= len(o.right) || len(seen) == 0 {
		return nil
	}
	out := map[int32]string{}
	add := func(o int32, w string) {
		if out[o] != "" {
			out[o] += " · "
		}
		out[o] += w
	}
	wt := s.weatherAt(f)
	wind := func(x int32) (speed, from float64) {
		var p physics.WindPoint
		physics.WindPointAt(wt, f.State[x].X, f.State[x].Y, &p, s.Shelter)
		return p.Speed, p.From
	}
	judged := make([]lookout.Judged, len(seen))
	aired := make([]lookout.Aired, len(seen))
	for i, c := range seen {
		judged[i] = judgedOf(f, c.slot, false)
		aired[i].Seen = judged[i].Seen
		aired[i].WindSpeed, aired[i].WindFrom = wind(c.slot)
	}
	own := judgedOf(f, sl, true)
	for _, m := range o.right[k].Show(own, judged) {
		if m.Index < 0 || m.Index >= len(seen) {
			continue
		}
		if m.KeepClear {
			add(seen[m.Index].slot, "you keep clear (Article "+m.Article+")")
		} else {
			add(seen[m.Index].slot, "you have right of way (Article "+m.Article+")")
		}
	}
	ownAir := lookout.Aired{Seen: own.Seen}
	ownAir.WindSpeed, ownAir.WindFrom = wind(sl)
	fouled := o.dirty[k].Foul(ownAir, aired)
	for _, i := range fouled.In {
		if i >= 0 && i < len(seen) {
			add(seen[i].slot, "you are in its wind shadow")
		}
	}
	for _, i := range fouled.Covering {
		if i >= 0 && i < len(seen) {
			add(seen[i].slot, "it is in your wind shadow")
		}
	}
	return out
}

// rightOfWayMarked are the boats, by their IDs, the right-of-way overlay
// would mark for the boat in slot sl, of the boats seen from it.
func (h *helm) rightOfWayMarked(s *Sea, f *bus.Frame, sl int32, seen []seenBoat) []uint64 {
	o := s.rules()
	k := int(f.Kind[sl])
	if k >= len(o.right) {
		return nil
	}
	var judged []lookout.Judged
	for _, c := range seen {
		if c.d > 60 {
			break
		}
		judged = append(judged, judgedOf(f, c.slot, false))
	}
	if len(judged) == 0 {
		return nil
	}
	var out []uint64
	for _, m := range o.right[k].Show(judgedOf(f, sl, true), judged) {
		if m.Index >= 0 && m.Index < len(judged) {
			out = append(out, f.Boat[seen[m.Index].slot])
		}
	}
	return out
}

// gusts are the gust ring's patches coming down on the boat in slot sl.
func (s *Sea) gusts(f *bus.Frame, sl int32) []lookout.Gust {
	if s.Catalog == nil {
		return nil
	}
	st := &f.State[sl]
	in := &f.Instruments[sl]
	sn, cs := physics.SinCos(float64(in.CourseOverGround))
	b := lookout.GustBoat{East: st.X, North: st.Y, VelEast: float64(in.SpeedOverGround) * sn, VelNorth: float64(in.SpeedOverGround) * cs,
		MeanFrom: f.Wind[sl].MeanFrom}
	return lookout.GustRings(s.weatherAt(f), s.Shelter, b, &s.Catalog.Weather.Ring)
}

// gustSoon is how near a ringed patch's arrival is, s, for a wait to wake
// for it: time to ease the sheet before it comes.
const gustSoon = 20.0

// gustComing reports whether the gust ring shows a patch arriving on the
// boat in slot sl within gustSoon.
func (h *helm) gustComing(s *Sea, f *bus.Frame, sl int32) bool {
	for _, g := range s.gusts(f, sl) {
		if g.Arrives <= gustSoon {
			return true
		}
	}
	return false
}

// gustLines are the gust ring's patches in words: "dark patch 220° ~150
// m, arriving ~15 s, ~30% stronger (~19 kn)".
func (h *helm) gustLines(s *Sea, f *bus.Frame, sl int32) []string {
	gs := s.gusts(f, sl)
	if len(gs) == 0 {
		return nil
	}
	var p physics.WindPoint
	physics.WindPointAt(s.weatherAt(f), f.State[sl].X, f.State[sl].Y, &p, s.Shelter)
	var out []string
	for _, g := range gs {
		where := "on you"
		if g.Distance > 0 {
			where = three(int(math.Floor(g.Bearing/5+0.5))*5%360) + " " + rangeWords(g.Distance)
		}
		arrives := "arriving now"
		if g.Arrives > 2 {
			arrives = "arriving " + seconds5(g.Arrives)
		}
		out = append(out, fmt.Sprintf("dark patch %s, %s, ~%d%% stronger (~%d kn)", where, arrives, g.Stronger,
			knots0(p.MeanSpeed*(1+float64(g.Stronger)/100))))
	}
	return out
}

// thunderBack is how far back a report listens for thunder, s: the time
// a sound takes from where thunder is still heard, 3 NM.
const thunderBack = 3 * nm / 343

// featuresHeard is the furthest a feature is heard from, m, with a margin.
const featuresHeard = 1100.0

// hearLines are what the boat's sailor hears now, by the phone's rules:
// each sound with where it comes from.
func (h *helm) hearLines(s *Sea, f *bus.Frame, sl int32) []string {
	o := s.rules()
	if o.hear == nil {
		return nil
	}
	cat := s.Catalog
	st := &f.State[sl]
	now := float64(f.Tick) / physics.StepsPerSecond
	in := &lookout.Heard{Seconds: now, East: st.X, North: st.Y, Falling: f.Voyage[sl].Falling()}
	in.Lip = cat.World.Disk.Radius - math.Sqrt(st.X*st.X+st.Y*st.Y)
	if end := s.ends(); !end.IsZero() {
		in.EndNear = lookout.EndRoar(math.Max(0, time.Until(end).Seconds()), &cat.World.Edge.End)
	}
	if s.Sky != nil {
		t := sky.Time(s.Sky, float64(s.Epoch.UnixMicro()), float64(int64(now*1e6)))
		in.Day = sky.SunAltitude(s.Sky, t, st.X, st.Y) > 0
		in.Harbour.Hour = lookout.HourAt(t, s.Sky.Day())
	}
	if sea := seaOf(s, f, st.X, st.Y); sea != nil {
		in.SeaHeight = sea.Waves
	}
	if b := s.Bundle; b != nil {
		kinds := cat.World.Features.Kinds
		for _, p := range b.Parts {
			if dx, dy := p.X-st.X, p.Y-st.Y; dx*dx+dy*dy > featuresHeard*featuresHeard || int(p.Kind) >= len(kinds) {
				continue
			}
			k := &kinds[p.Kind]
			fh := lookout.FeatureHeard{Site: k.Site, East: p.X, North: p.Y, Drop: p.Level, Seed: float64(p.Seed)}
			if k.Birds != nil {
				fh.Call = k.Birds.Call
			}
			in.Features = append(in.Features, fh)
		}
		var signals []int
		if s.Chart != nil {
			signals = s.Chart.World().FogSignals
		}
		for i, l := range b.Lights {
			sig := -1
			if i < len(signals) {
				sig = signals[i]
			}
			in.Lights = append(in.Lights, lookout.FogLight{Number: int(l.Number), East: l.X, North: l.Y, Phase: l.Phase, Signal: sig})
		}
	}
	wt := s.weatherAt(f)
	in.Visibility = func(east, north, _ float64) float64 { return physics.VisibilityAt(wt, east, north) }
	if p := wt.Prepared(); p != nil && p.SlotTicks() > 0 {
		var buf [physics.MaxFlashes]physics.Flash
		last := p.FlashSlot(float64(f.Tick))
		for slot := p.FlashSlot(float64(f.Tick) - thunderBack*physics.StepsPerSecond); slot <= last; slot++ {
			at := s.weatherAtTick(f, int64(slot*p.SlotTicks()))
			for _, fl := range buf[:physics.Flashes(at, slot, buf[:])] {
				in.Flashes = append(in.Flashes, lookout.Flash{Tick: fl.Tick, East: fl.East, North: fl.North, Sea: fl.Sea != 0, Base: fl.Base, Seed: fl.Seed})
			}
		}
	}
	var out []string
	said := map[string]bool{}
	for _, snd := range o.hear.Sounds(in, now-thunderBack, now) {
		line := snd.Kind.String()
		if snd.Kind == lookout.SoundGull || snd.Kind == lookout.SoundFalls && in.Lip > 1000 {
			// A gull is about the boat; the end's roar comes from
			// everywhere.
		} else {
			line += " to the " + point16(rad(snd.Degrees))
		}
		if snd.Kind == lookout.SoundThunder && snd.Delay > 0 {
			line += fmt.Sprintf(", %d s after its flash", int(math.Floor(snd.Delay+0.5)))
		}
		if !said[line] {
			said[line] = true
			out = append(out, line)
		}
	}
	return out
}

// countdown is the time left as the phone's countdown reads it: "4d 6h",
// "5h 3m", "9m 12s".
func countdown(d time.Duration) string { return lookout.Countdown(d) }
