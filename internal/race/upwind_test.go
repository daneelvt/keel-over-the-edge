// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"math"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
)

// TestNoRaceStartsUpwind: every harbour race the timetable makes is a
// Dash; a sailor may make a race with others on the Dash, the long Dash,
// the reach and the island courses and on no course with a beat in it,
// which is sailed alone, as a time trial or a race of one's own; Make a
// race offers those only to be sailed alone; and every buoy race the
// timetable or the service makes, laid in eight winds, has no leg within
// 70° of the wind.
func TestNoRaceStartsUpwind(t *testing.T) {
	s := newSea(t)
	if _, _, err := s.svc.Harbour(s.ctx, s.lease, s.now); err != nil {
		t.Fatal(err)
	}
	rows, err := s.db.HarbourRaces(s.ctx, s.world.ID, s.world.Number, s.now, 8)
	if err != nil || len(rows) == 0 {
		t.Fatalf("%d harbour races: %v", len(rows), err)
	}
	var laid []*bus.RaceCall
	clerk := &Clerk{s: s.svc, cfg: ClerkConfig{TickAt: func(time.Time) int64 { return 0 }}}
	for i := range rows {
		if rows[i].Shape != ShapeDash {
			t.Errorf("%s: a harbour race on the %s", rows[i].Name, rows[i].Shape)
		}
		call, ok := clerk.callOf(&rows[i], 0)
		if !ok {
			t.Fatalf("%s: no call", rows[i].Name)
		}
		laid = append(laid, call)
	}
	by := s.human()
	for _, id := range []string{"buoy:triangle:short", "buoy:triangle:long", "buoy:windward-leeward:short", "buoy:windward-leeward:long"} {
		_, err := s.svc.Make(s.ctx, by, Making{Kind: KindRace, Course: id, Boat: s.jolly(), At: s.now.Add(time.Hour), Who: WhoEveryone})
		refused(t, err, RefuseUpwind)
		if _, err := s.svc.Make(s.ctx, s.human(), Making{Kind: KindTrial, Course: id, Boat: s.jolly(), Who: WhoEveryone}); err != nil {
			t.Errorf("a time trial on %s: %v", id, err)
		}
		// Each in a racing area of its own, the areas a start AreaApart.
		s.now = s.now.Add(AreaApart)
		if card, err := s.svc.Make(s.ctx, s.human(), Making{Kind: KindRace, Course: id, Boat: s.jolly(), Now: true, Who: WhoEveryone}); err != nil {
			t.Errorf("a race of one's own on %s: %v", id, err)
		} else if !card.Course.Upwind {
			t.Errorf("a race of one's own on %s without the upwind sign", id)
		}
	}
	for i, c := range []struct {
		id      string
		minutes int
	}{{"buoy:dash:short", DashMinutes}, {"buoy:dash:long", LongDashMinutes}, {"buoy:reach:short", ReachMinutes}} {
		at := s.now.Add(time.Hour + time.Duration(i)*AreaApart)
		card, err := s.svc.Make(s.ctx, s.human(), Making{Kind: KindRace, Course: c.id, Boat: s.jolly(), At: at, Who: WhoEveryone})
		if err != nil || card.Course.ID != c.id || card.Course.Upwind || card.Minutes != c.minutes {
			t.Fatalf("a race on %s: %+v, %d minutes, %v", c.id, card.Course, card.Minutes, err)
		}
		row, err := s.db.RaceByCode(s.ctx, card.Code)
		if err != nil {
			t.Fatal(err)
		}
		call, _ := clerk.callOf(&row, 0)
		laid = append(laid, call)
	}
	b, err := s.svc.Board(s.ctx, by)
	if err != nil {
		t.Fatal(err)
	}
	for _, cc := range b.Make.Courses {
		if cc.Kind == CourseBuoy && !cc.AloneOnly && UpwindShape(cc.Shape) {
			t.Errorf("Make a race offers the %s for a race with others", cc.Shape)
		}
	}
	// Laid as the committee lays them, in eight winds.
	st := &committee.Stage{Areas: []committee.Area{{Number: 1, Radius: 450}, {Number: 2, X: 2000, Radius: 450}}}
	for i := range s.cat.Boats {
		st.Kinds = append(st.Kinds, committee.Kind{Polar: s.cat.Polar(i), Length: s.cat.Boats[i].LengthOverall})
	}
	for _, call := range laid {
		if call.Course == 0 {
			call.Course = 1
		}
		for w := range 8 {
			from := float64(w) * math.Pi / 4
			c := st.Lay(bus.NewFrame(4), call, 12*physics.Knot, from, 8)
			if c == nil || !c.Across {
				t.Fatalf("laid %+v", c)
			}
			for i := 1; i < len(c.Way); i++ {
				a, b := c.Way[i-1], c.Way[i]
				off := math.Abs(math.Remainder(from-physics.Atan2(b[0]-a[0], b[1]-a[1]), 2*math.Pi))
				if off < 70*math.Pi/180-1e-9 {
					t.Errorf("a race's leg %d lies %.0f° off the wind", i, off*180/math.Pi)
				}
			}
		}
	}
}

// TestTheBoardSaysWhatANewcomerNeeds: a new sailor's board says they wear
// the green ribbon; a limit's refusal carries its number.
func TestTheBoardSaysWhatANewcomerNeeds(t *testing.T) {
	s := newSea(t)
	by := s.human()
	b, err := s.svc.Board(s.ctx, by)
	if err != nil || !b.Newcomer {
		t.Fatalf("a new sailor's board: newcomer %v, %v", b.Newcomer, err)
	}
	limits, err := s.db.RaceSettings(s.ctx)
	if err != nil {
		t.Fatal(err)
	}
	var codes []string
	for i := range limits.Ahead + 1 {
		codes = append(codes, s.make(s.human(), time.Duration(i+1)*time.Hour, WhoEveryone).Code)
	}
	for _, code := range codes[:limits.Ahead] {
		if _, err := s.svc.Enter(s.ctx, by, code, false); err != nil {
			t.Fatal(err)
		}
	}
	_, err = s.svc.Enter(s.ctx, by, codes[limits.Ahead], false)
	if r := refused(t, err, RefuseAhead); r.Most != limits.Ahead {
		t.Errorf("the refusal's number %d, the limit %d", r.Most, limits.Ahead)
	}
	if c, err := s.svc.Card(s.ctx, by, codes[limits.Ahead]); err != nil || c.Enter.Reason != RefuseAhead || c.Enter.Most != limits.Ahead {
		t.Errorf("the card's Enter: %+v, %v", c.Enter, err)
	}
}

// TestMakeARaceTellsTodaysMinutes: Make a race tells each buoy course's
// minutes as laid in the wind today, where the service can say; and
// offers the long Dash to a boat only where it is LongerBy longer than
// the Dash.
func TestMakeARaceTellsTodaysMinutes(t *testing.T) {
	s := newSea(t)
	jolly := s.jolly()
	long := 7
	s.svc.cfg.BuoyMinutes = func(shape string, l bool, boat string) (int, bool) {
		switch {
		case boat != jolly:
			return 0, false
		case shape == ShapeDash && l:
			return long, true
		case shape == ShapeDash:
			return 6, true
		}
		return 3, true
	}
	offered := func() map[string]CourseChoice {
		b, err := s.svc.Board(s.ctx, s.human())
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]CourseChoice{}
		for _, cc := range b.Make.Courses {
			out[cc.ID] = cc
		}
		return out
	}
	c := offered()
	if _, ok := c["buoy:dash:long"].Boats[jolly]; ok {
		t.Errorf("a long Dash a minute longer than the Dash offered: %+v", c["buoy:dash:long"])
	}
	if c["buoy:dash:short"].Boats[jolly] != 6 || c["buoy:reach:short"].Boats[jolly] != 3 || c["buoy:triangle:long"].Boats[jolly] != 3 {
		t.Errorf("today's minutes: %+v", c)
	}
	long = 11
	if c := offered(); c["buoy:dash:long"].Boats[jolly] != 11 {
		t.Errorf("a long Dash of 11 minutes offered as %+v", c["buoy:dash:long"])
	}
}
