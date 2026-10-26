// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"cmp"
	"math"
	"slices"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The right-of-way overlay: of the boats within the overlay's range whose
// closest approach, by their present motions, comes within a couple of
// hull lengths within its seconds ahead, the nearest few are judged by the
// Articles, the code that judges a bump on the server: over a boat the
// sailor must keep clear of a ring with a bar, "Keep clear", over one that
// must keep clear of the sailor a diamond, "Right of way", each labelled
// with the Article that says so; and the sailor's own tack beside the
// readout. As far as the overlay knows, right of way has not changed hands
// lately, and both boats are of the sailor's own kind, as the page's
// physics module holds one kind. The page's twin is
// client/src/render/rightofway.ts; both are held to
// testdata/rightofway.json.

// Seen is a boat as the overlay sees it.
type Seen struct {
	// East and North are where it is, m; Heading, Heel and Boom its pose,
	// rad; Mode its sailor's mode, as physics.State has it.
	East, North, Heading, Heel, Boom, Mode float64
	// VEast and VNorth are how it moves, m/s.
	VEast, VNorth float64
}

// Approach is a boat that will come close: its index among those
// offered, how close, m, and in how long, s.
type Approach struct {
	Index    int     `json:"index"`
	Distance float64 `json:"distance"`
	Time     float64 `json:"time"`
}

// Approaching are the boats of others within rng m of own whose closest
// approach within ahead s, by their present motions, comes within close
// m: the closest first, at most marks of them.
func Approaching(own Seen, others []Seen, rng, ahead, close float64, marks int) []Approach {
	var out []Approach
	for i, o := range others {
		rx, ry := o.East-own.East, o.North-own.North
		if float64(rx*rx)+float64(ry*ry) > float64(rng*rng) {
			continue
		}
		vx, vy := o.VEast-own.VEast, o.VNorth-own.VNorth
		v2 := float64(vx*vx) + float64(vy*vy)
		t := 0.0
		if v2 > 0 {
			t = math.Min(ahead, math.Max(0, -(float64(rx*vx)+float64(ry*vy))/v2))
		}
		x, y := rx+float64(vx*t), ry+float64(vy*t)
		if d := math.Sqrt(float64(x*x) + float64(y*y)); d < close {
			out = append(out, Approach{Index: i, Distance: d, Time: t})
		}
	}
	slices.SortFunc(out, func(a, b Approach) int {
		if c := cmp.Compare(a.Distance, b.Distance); c != 0 {
			return c
		}
		return cmp.Compare(a.Index, b.Index)
	})
	if len(out) > marks {
		out = out[:marks]
	}
	return out
}

// Judged is a boat as the Articles judge it: as seen, its course as the
// Articles follow it, and the true wind at it, before any shadow.
type Judged struct {
	Seen
	Course   physics.Course
	WindFrom float64
}

// Mark is what the overlay shows over another boat.
type Mark struct {
	// Index is the boat's among those offered; KeepClear that the sailor
	// must keep clear of it, else it must keep clear of the sailor.
	Index     int  `json:"index"`
	KeepClear bool `json:"keepClear"`
	// Article is the Article that says so, as the rulebook numbers it
	// ("16.1"), and Label the mark's words.
	Article string `json:"article"`
	Label   string `json:"label"`
	// Distance and Time are the closest approach, m, and when, s.
	Distance float64 `json:"distance"`
	Time     float64 `json:"time"`
}

// RightOfWay is the overlay's rule for a sailor's kind of boat.
type RightOfWay struct {
	// Range, Ahead and Close are the overlay's, m, s and m: Close is its
	// hull lengths of the sailor's boat. Marks is the most it shows.
	Range, Ahead, Close float64
	Marks               int
	Kind                *physics.Prepared
	Encounters          *physics.EncounterPrepared
}

// NewRightOfWay is the overlay's rule from the catalog for a sailor in a
// boat of the catalog's kind k, kinds being the catalog's prepared kinds
// (Catalog.Prepare) and ep its encounters (Catalog.PrepareEncounters).
func NewRightOfWay(cat *catalog.Catalog, kinds []physics.Prepared, k int, ep *physics.EncounterPrepared) *RightOfWay {
	o := &cat.Encounters.Overlay
	return &RightOfWay{
		Range: o.Range, Ahead: o.Ahead, Close: o.Close * cat.Boats[k].LengthOverall, Marks: o.Marks,
		Kind: &kinds[k], Encounters: ep,
	}
}

// Show is the marks the overlay shows over others for the sailor's boat
// own, the closest approach first.
func (r *RightOfWay) Show(own Judged, others []Judged) []Mark {
	seen := make([]Seen, len(others))
	for i := range others {
		seen[i] = others[i].Seen
	}
	var out []Mark
	for _, a := range Approaching(own.Seen, seen, r.Range, r.Ahead, r.Close, r.Marks) {
		v := physics.Judge(encounterOf(&own, &others[a.Index]), r.Kind, r.Kind, r.Encounters)
		if v.Keeper == physics.Neither {
			continue
		}
		m := Mark{Index: a.Index, KeepClear: v.Keeper == physics.First, Article: ArticleName(v.Article), Distance: a.Distance, Time: a.Time}
		m.Label = "Right of way · Article " + m.Article
		if m.KeepClear {
			m.Label = "Keep clear · Article " + m.Article
		}
		out = append(out, m)
	}
	return out
}

// encounterOf is the encounter of a and b as the overlay writes it: right
// of way unchanged as far as it knows.
func encounterOf(a, b *Judged) *physics.Encounter {
	e := &physics.Encounter{Since: 1e9, By: physics.Neither}
	for i, s := range [2]*Judged{a, b} {
		e.X[i], e.Y[i], e.Heading[i] = s.East, s.North, s.Heading
		e.Heel[i], e.Boom[i], e.SailorMode[i] = s.Heel, s.Boom, s.Mode
		e.WindFrom[i] = s.WindFrom
		e.Tack[i], e.Tacking[i], e.Settled[i], e.Course[i] = s.Course.Tack, s.Course.Tacking, s.Course.Settled, s.Course.Course
	}
	return e
}

// ArticleName is an Article as the rulebook numbers it, from the physics'
// number: 16 is "16.1"; "" for none.
func ArticleName(code float64) string {
	switch code {
	case physics.Article10, physics.Article11, physics.Article12, physics.Article13, physics.Article15, physics.Article22:
		return strconv.Itoa(int(code))
	case physics.Article16:
		return "16.1"
	}
	return ""
}

// TackText is a boat's tack as the readout shows it beside the overlay.
func TackText(c physics.Course) string {
	switch {
	case c.Tacking != 0:
		return "Tacking"
	case c.Tack < 0:
		return "Port tack"
	}
	return "Starboard tack"
}
