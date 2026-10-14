// SPDX-License-Identifier: AGPL-3.0-only

package physics

import "math"

// The Articles are the game's right-of-way rules: the Racing Rules of
// Sailing 2025–2028 (World Sailing), Part 2, Sections A and B, and rule
// 22, numbered as the rulebook numbers them, between every two boats. They
// decide which of two boats keeps clear, and at a contact whose fault it
// is.
//
// Section A gives right of way. On opposite tacks, a port-tack boat keeps
// clear of a starboard-tack boat (rule 10). On the same tack and
// overlapped, the windward boat keeps clear (11); not overlapped, the boat
// clear astern (12). After a boat passes head to wind she keeps clear
// until she is on a close-hauled course; if two are, the one on the
// other's port side or the one astern (13). Section B limits the
// right-of-way boat: a boat that acquires right of way must initially give
// the other room to keep clear, unless she acquired it by the other's
// actions (15), and one that changes course must give the other room to
// keep clear (16.1). Rule 22 asks every boat to avoid one that is capsized
// or has not regained control after capsizing.
//
// A contact is the keep-clear boat's fault: a right-of-way boat is
// exonerated for breaking rule 14, avoiding contact, when the contact
// causes no damage (rule 43.1(c)), and a bump causes none. But a
// right-of-way boat that broke 15 or 16.1 compelled the other's breach,
// which exonerates the other (43.1(a); Case Book, Case 93): the fault is
// then hers.
//
// The definitions decide the cases. A boat's tack is her windward side's,
// the side the wind comes over; sailing by the lee or dead downwind, the
// side opposite her mainsail. She is clear astern of another when her hull
// and equipment in normal position are behind a line abeam from the
// other's aftermost point; overlapped when neither is clear astern. Here
// the hull alone, as for contacts.
// "Room" and "initially" are a protest committee's judgement: here they are
// a window of the articles' room seconds, and a change of course one of
// more than their turn from her course, her heading smoothed.

// The Articles, by the rule's number: Article16 is rule 16.1.
const (
	Article10 = 10
	Article11 = 11
	Article12 = 12
	Article13 = 13
	Article15 = 15
	Article16 = 16
	Article22 = 22
)

// TrackCourse brings boat s's course, c, to the tick after its step: her
// tack in the true wind from windFrom at her place, before any shadow,
// whether she is tacking, how long since her tack changed, and her heading
// smoothed. A course of a boat's first tick, its tack 0, is started here.
func TrackCourse(c *Course, s *State, windFrom float64, b *Prepared, ep *EncounterPrepared) {
	twa := wrapAngle(windFrom - s.Heading)
	tack := tackOf(twa, s.Boom, c.Tack, ep)
	if c.Tack == 0 {
		if tack == 0 {
			tack = 1
		}
		*c = Course{Tack: tack, Settled: CourseSettled, Course: s.Heading}
		return
	}
	if tack != c.Tack {
		// Passing head to wind is a tack, under rule 13 until she is
		// close-hauled; passing dead downwind is a gybe.
		c.Tack, c.Settled, c.Tacking = tack, 0, 0
		if math.Abs(twa) < math.Pi/2 {
			c.Tacking = 1
		}
	} else if c.Settled < CourseSettled {
		c.Settled++
	}
	// On a close-hauled course, whatever her speed or the trim of her
	// sails (Case Book, Case 17).
	if c.Tacking != 0 && math.Abs(twa) >= b.closeHauled {
		c.Tacking = 0
	}
	c.Course = wrapAngle(c.Course + float64(wrapAngle(s.Heading-c.Course)*ep.courseRate))
}

// tackOf is a boat's tack with the true wind twa off her bow, positive from
// starboard, and her boom at boom: the side the wind comes over, or,
// aft of the beam with the boom on that side (by the lee) or within the
// head-to-wind margin of dead astern, the side opposite the boom. Within
// that margin of head to wind, or dead astern with the boom amidships, she
// keeps the tack she had.
func tackOf(twa, boom, had float64, ep *EncounterPrepared) float64 {
	a := math.Abs(twa)
	if a < ep.headToWind {
		return had
	}
	if a > math.Pi-ep.headToWind || a > math.Pi/2 && sign(boom) == sign(twa) {
		if boom == 0 {
			return had
		}
		return -sign(boom)
	}
	return sign(twa)
}

// capsized reports whether boat i of e is capsized or has not regained
// control after capsizing: her masthead in the water, or her sailor not
// aboard and sailing.
func (e *Encounter) capsized(i int) bool {
	return e.SailorMode[i] != Sailing || math.Abs(e.Heel[i]) >= math.Pi/2
}

// Relate says which boat of e keeps clear, and by which Article; with both
// capsized, neither.
func Relate(e *Encounter, pa, pb *Prepared) Verdict {
	ca, cb := e.capsized(0), e.capsized(1)
	switch {
	case ca && cb:
		return Verdict{Keeper: Neither, Article: Article22}
	case ca:
		return Verdict{Keeper: Second, Article: Article22}
	case cb:
		return Verdict{Keeper: First, Article: Article22}
	}
	ahead := clearAhead(e, pa, pb)
	ta, tb := e.Tacking[0] != 0, e.Tacking[1] != 0
	switch {
	case ta && tb:
		// The one astern, or the one on the other's port side.
		switch ahead {
		case First:
			return Verdict{Keeper: Second, Article: Article13}
		case Second:
			return Verdict{Keeper: First, Article: Article13}
		}
		if onPortSide(e) {
			return Verdict{Keeper: Second, Article: Article13}
		}
		return Verdict{Keeper: First, Article: Article13}
	case ta:
		return Verdict{Keeper: First, Article: Article13}
	case tb:
		return Verdict{Keeper: Second, Article: Article13}
	}
	if e.Tack[0] != e.Tack[1] {
		if e.Tack[0] < 0 {
			return Verdict{Keeper: First, Article: Article10}
		}
		return Verdict{Keeper: Second, Article: Article10}
	}
	switch ahead {
	case First:
		return Verdict{Keeper: Second, Article: Article12}
	case Second:
		return Verdict{Keeper: First, Article: Article12}
	}
	if secondToLeeward(e) {
		return Verdict{Keeper: First, Article: Article11}
	}
	return Verdict{Keeper: Second, Article: Article11}
}

// clearAhead says which boat of e is clear ahead of the other, or Neither
// when they are overlapped. One is clear astern of the other when her bow
// and her aftermost point, projected on the other's heading, both lie
// behind the other's aftermost point.
func clearAhead(e *Encounter, pa, pb *Prepared) float64 {
	dx, dy := e.X[1]-e.X[0], e.Y[1]-e.Y[0]
	sa, ca := SinCos(e.Heading[0])
	sb, cb := SinCos(e.Heading[1])
	// The second's extents along the first's heading, from the first's
	// centre; and the first's along the second's, from the second's.
	along := float64(dx*sa) + float64(dy*ca)
	turn := float64(sb*sa) + float64(cb*ca) // the cosine between the headings
	bForward := max2(along+float64(pb.outline.bow*turn), along-float64(pb.outline.aft*turn))
	bAstern := bForward < -pa.outline.aft
	back := -(float64(dx*sb) + float64(dy*cb))
	aForward := max2(back+float64(pa.outline.bow*turn), back-float64(pa.outline.aft*turn))
	aAstern := aForward < -pb.outline.aft
	switch {
	case bAstern && !aAstern:
		return First
	case aAstern && !bAstern:
		return Second
	}
	return Neither
}

// onPortSide reports whether the second boat of e is on the first's port
// side, across their mean heading.
func onPortSide(e *Encounter) bool {
	sa, ca := SinCos(e.Heading[0])
	sb, cb := SinCos(e.Heading[1])
	// Their mean starboard side; if they head opposite ways, the first's.
	rx, ry := ca+cb, -(sa + sb)
	if float64(rx*rx)+float64(ry*ry) < 0.25 {
		rx, ry = ca, -sa
	}
	dx, dy := e.X[1]-e.X[0], e.Y[1]-e.Y[0]
	return float64(dx*rx)+float64(dy*ry) < 0
}

// secondToLeeward reports whether the second boat of e, on the same tack
// as the first, lies on the first's leeward side: the side away from the
// wind, starboard on port tack and port on starboard, across the two
// boats' mean heading, so that either boat gives the same answer. Dead
// ahead of each other, across the true winds at the two, the one further
// downwind.
func secondToLeeward(e *Encounter) bool {
	sa, ca := SinCos(e.Heading[0])
	sb, cb := SinCos(e.Heading[1])
	rx, ry := ca+cb, -(sa + sb)
	if float64(rx*rx)+float64(ry*ry) < 0.25 {
		// Heading more than about 150° apart: the first's side.
		rx, ry = ca, -sa
	}
	dx, dy := e.X[1]-e.X[0], e.Y[1]-e.Y[0]
	across := float64(dx*rx) + float64(dy*ry)
	if across != 0 {
		return (across > 0) == (e.Tack[0] < 0)
	}
	sa, ca = SinCos(e.WindFrom[0])
	sb, cb = SinCos(e.WindFrom[1])
	return -(float64(dx*(sa+sb)) + float64(dy*(ca+cb))) > 0
}

// Judge is the Articles' verdict on a contact between the boats of e:
// Fault of their relation as it stands.
func Judge(e *Encounter, pa, pb *Prepared, ep *EncounterPrepared) Verdict {
	return Fault(Relate(e, pa, pb), e, ep)
}

// Fault is the verdict on a contact between the boats of e whose relation
// is v: the keep-clear boat's fault, unless the right-of-way boat acquired
// right of way by her own action within the room window (15) or has
// changed course toward the other (16.1); with both capsized, no one's.
// The simulation gives the relation as the pair remembered it before the
// contact, from the tick before: a bow that touches a transom has just
// crossed the line abeam from it.
func Fault(v Verdict, e *Encounter, ep *EncounterPrepared) Verdict {
	v.Fault, v.FaultArticle = v.Keeper, v.Article
	if v.Keeper == Neither || v.Article == Article22 {
		return v
	}
	row := float64(First)
	if v.Keeper == First {
		row = Second
	}
	if e.By == row && e.Since <= ep.room {
		v.Fault, v.FaultArticle = row, Article15
		return v
	}
	if turnedToward(e, row, ep) {
		v.Fault, v.FaultArticle = row, Article16
	}
	return v
}

// turnedToward reports whether boat who of e has changed course by more
// than the articles' turn, her heading off her course, toward the other.
func turnedToward(e *Encounter, who float64, ep *EncounterPrepared) bool {
	i, j := 0, 1
	if who == Second {
		i, j = 1, 0
	}
	d := wrapAngle(e.Heading[i] - e.Course[i])
	if !(math.Abs(d) > ep.turn) {
		return false
	}
	s, c := SinCos(e.Heading[i])
	dx, dy := e.X[j]-e.X[i], e.Y[j]-e.Y[i]
	starboard := float64(dx*c)-float64(dy*s) > 0
	return (d > 0) == starboard
}

// ActionOf says whose action made the keep-clear boat of now the one it
// is, where before it was keeper by article (Neither for none): the boat
// whose tack or gybe changed most recently, within the room window; or a
// boat that was clear astern and now has right of way overlapped, having
// overlapped the other from astern (Case Book, Case 7); else neither's.
func ActionOf(keeper, article float64, now *Verdict, e *Encounter, ep *EncounterPrepared) float64 {
	if now.Keeper == Neither {
		return Neither
	}
	sa, sb := e.Settled[0], e.Settled[1]
	switch {
	case sa <= ep.room && sa < sb:
		return First
	case sb <= ep.room && sb < sa:
		return Second
	case sa <= ep.room && sa == sb:
		return Neither
	}
	row := float64(First)
	if now.Keeper == First {
		row = Second
	}
	if article == Article12 && keeper == row && now.Article == Article11 {
		return row
	}
	return Neither
}

// Near reports whether boats a and b, of kinds pa and pb, are near enough
// that the Articles remember them as a pair: within the articles' pairs of
// the longer one's length.
func Near(a, b *State, pa, pb *Prepared, ep *EncounterPrepared) bool {
	r := float64(ep.pairs * max2(pa.length, pb.length))
	dx, dy := b.X-a.X, b.Y-a.Y
	return float64(dx*dx)+float64(dy*dy) < float64(r*r)
}
