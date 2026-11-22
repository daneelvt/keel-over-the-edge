// SPDX-License-Identifier: AGPL-3.0-only

package physics

// TrimmedAtRest sets the sail of boat b, at rest in s, as if its sheet had
// been eased to sheet (0 hauled in, 1 let fly) in a wind from from, rad
// clockwise from north: its boom, and its headsail's, out to leeward at
// the sheet's limit, so that the sailor may hike to windward at once, and
// with hiked, there already. A
// boat set down with its boom on the centreline and its sail hauled in
// hard heels and turns up into the wind before the wind can blow the boom
// out; in a fresh wind it swings through to head to wind and stops, and in
// a gale it capsizes. A square rig's braces follow the wind themselves:
// it is left as it is.
func TrimmedAtRest(b *Prepared, s *State, sheet, from float64, hiked bool) {
	if b.square {
		return
	}
	sheet = control(sheet, 0, 1)
	// The wind over the starboard bow puts the boom to port.
	side := 1.0
	if wrapAngle(from-s.Heading) > 0 {
		side = -1
	}
	limit := b.boomIn + float64(sheet*(b.boomOut-b.boomIn))
	s.SheetLimit, s.Boom, s.BoomRate = limit, float64(side*limit), 0
	if hiked {
		s.Sailor = float64(-side * b.hikeReach)
	}
	if b.jib {
		jib := b.jibIn + float64(sheet*(b.jibOut-b.jibIn))
		s.JibLimit, s.Jib, s.JibRate = jib, float64(side*jib), 0
	}
}
