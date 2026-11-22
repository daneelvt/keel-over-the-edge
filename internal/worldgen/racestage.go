// SPDX-License-Identifier: AGPL-3.0-only

package worldgen

import (
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
)

// RaceStage is what the world's races are run on: its racing areas, its
// island courses, each that starts off Port Royal with the starts a race's
// line may be moved to along its way (committee.Stage.MoveStarts: within
// the racing areas' reach of Port Royal, out of its harbour and clear of
// its mouth as the areas are, with a site's room of water as deep as the
// courses' ways keep), and the catalog's boats as races know them.
func (b *Bundle) RaceStage(cat *catalog.Catalog) *committee.Stage {
	st := &committee.Stage{}
	for i := range cat.Boats {
		st.Kinds = append(st.Kinds, committee.Kind{Polar: cat.Polar(i), Length: cat.Boats[i].LengthOverall})
	}
	for _, a := range b.Records.Areas {
		st.Areas = append(st.Areas, committee.Area{Number: a.Number, X: a.X, Y: a.Y, Radius: a.Radius})
	}
	home := int32(-1)
	if len(b.Towns) > 0 && b.Towns[0].Kind == townMain {
		home = b.Towns[0].Number
	}
	for i := range b.Records.Courses {
		wc := &b.Records.Courses[i]
		ic := committee.Course{Number: wc.Number, Way: wc.Way, Length: wc.Length,
			Start:  committee.Site{X: wc.Start.X, Y: wc.Start.Y, Room: wc.Start.Room},
			Finish: committee.Site{X: wc.Finish.X, Y: wc.Finish.Y, Room: wc.Finish.Room},
			Home:   wc.Start.Town == home, Loop: wc.Kind != CoursePassage}
		for _, r := range wc.Rays {
			ic.Rays = append(ic.Rays, committee.Ray{X: r.X, Y: r.Y, Bearing: r.Bearing, Crossings: int8(r.Crossings), Along: r.Along,
				Mark: int16(r.Round + 1)})
		}
		st.Courses = append(st.Courses, ic)
	}
	if len(b.Islands) == 0 || b.Ground == nil {
		return st
	}
	cc := cat.World.Courses
	port := committee.Port{X: b.MainPort().X, Y: b.MainPort().Y, Within: float64(cc.Areas.Within * nauticalMile), Mouth: cc.Areas.Mouth}
	if h, ok := b.Harbour(); ok {
		port.Harbour = &h
	}
	_, prepared := cat.Prepare()
	deepest := 0.0
	for i := range prepared {
		deepest = max(deepest, physics.Draught(&prepared[i]))
	}
	shoal := -float64(deepest + cc.Depth)
	st.MoveStarts(port, cc.Site.Room, func(x, y float64) bool {
		e, _ := b.Ground.At(x, y)
		return e < shoal
	})
	return st
}
