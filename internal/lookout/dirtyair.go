// SPDX-License-Identifier: AGPL-3.0-only

package lookout

import (
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Dirty air, drawn with the wind overlay: a wedge downwind of the sailor's
// boat and of each boat within the overlay's wedges metres of it, along the
// wake its sail leaves as the physics lays it (along its apparent wind,
// turned toward its windward side, as long as its rig is tall), out to
// where the wind it takes falls under the overlay's wedge deficit. The
// wedge's outline is the shadow's own formula, in the source's rig
// heights. On the page it is a shape on the water; here, which boats sit
// in which wedge, as the shape lies. The page's twin is
// client/src/render/dirtyair.ts; both are held to testdata/dirtyair.json.

// stations is how many stretches the wedge's outline is drawn in.
const stations = 32

// mostWedges is the most wedges the page draws at once, the sailor's own
// among them.
const mostWedges = 12

// Outline is a wedge's outline, in its source's rig heights: at each
// station S along the wake, its half-width C, straight between them.
type Outline struct {
	S []float64 `json:"s"`
	C []float64 `json:"c"`
}

// WedgeOutline is the wedge's outline: at each station along the wake
// its half-width, out to where the loss of wind falls under least: the
// shadow's loss, A s̄^(−2/3) e^(−c² s̄^(−2/3) / w²), faded in over its
// first stretch and out toward its reach, solved for c.
func WedgeOutline(n *catalog.EncountersShadow, least float64) Outline {
	smooth := func(t float64) float64 {
		x := math.Min(1, math.Max(0, t))
		return float64(x * x * (3 - float64(2*x)))
	}
	var o Outline
	for i := 0; i <= stations; i++ {
		at := n.Reach * float64(i) / stations
		g := physics.Exp(float64(physics.Log(math.Max(at, n.Near)) * (-2.0 / 3)))
		peak := n.Deficit * g * smooth(at/n.Near) * (1 - smooth((at-n.Taper)/(n.Reach-n.Taper)))
		c := 0.0
		if peak > least {
			c = n.Width * math.Sqrt(physics.Log(peak/least)/g)
		}
		o.S = append(o.S, at)
		o.C = append(o.C, c)
	}
	return o
}

// halfWidth is the outline's half-width s rig heights along it, straight
// between its stations; and whether s is within it.
func (o Outline) halfWidth(s float64) (float64, bool) {
	if !(s >= 0) || len(o.S) < 2 || s > o.S[len(o.S)-1] {
		return 0, false
	}
	for i := 1; i < len(o.S); i++ {
		if s <= o.S[i] {
			f := (s - o.S[i-1]) / (o.S[i] - o.S[i-1])
			return o.C[i-1] + float64(f*(o.C[i]-o.C[i-1])), true
		}
	}
	return 0, false
}

// Covers reports whether a point (east, north) lies in the wedge of the
// wake w as the outline draws it.
func (o Outline) Covers(w *physics.Wake, east, north float64) bool {
	if !(w.Height > 0) {
		return false
	}
	dx, dy := east-w.X, north-w.Y
	along := (float64(dx*w.East) + float64(dy*w.North)) / w.Height
	across := math.Abs(float64(dx*w.North)-float64(dy*w.East)) / w.Height
	c, ok := o.halfWidth(along)
	return ok && across < c
}

// Aired is a boat as dirty air reads it: as seen, and the true wind at it
// in full, its gusts and the land's shelter in it and no shadow, m/s and
// rad.
type Aired struct {
	Seen
	WindSpeed, WindFrom float64
}

// Wedge is a wedge the page draws: its source, −1 the sailor's own boat,
// else its index among the others offered, and its wake.
type Wedge struct {
	Source int
	Wake   physics.Wake
}

// DirtyAir is the overlay's rule for dirty air.
type DirtyAir struct {
	// Range is how near a boat must be to the sailor's for its wedge to be
	// drawn, m; Outline the wedge's outline.
	Range   float64
	Outline Outline
	// Kind is the kind every wake is laid for: the sailor's own, as the
	// page's physics module holds one kind.
	Kind       *physics.Prepared
	Encounters *physics.EncounterPrepared
}

// NewDirtyAir is the rule from the catalog for a sailor in a boat of the
// catalog's kind k, kinds being the catalog's prepared kinds and ep its
// encounters.
func NewDirtyAir(cat *catalog.Catalog, kinds []physics.Prepared, k int, ep *physics.EncounterPrepared) *DirtyAir {
	o := &cat.Encounters.Overlay
	return &DirtyAir{
		Range: o.Wedges, Outline: WedgeOutline(&cat.Encounters.Shadow, o.WedgeDeficit),
		Kind: &kinds[k], Encounters: ep,
	}
}

// Wedges are the wedges the page draws for the sailor's boat own among
// others, in the order it draws them: its own first, then each other
// within range, at most twelve, a boat that casts no wake none.
func (d *DirtyAir) Wedges(own Aired, others []Aired) []Wedge {
	var out []Wedge
	add := func(source int, b *Aired) {
		w := physics.WakeAt(b.East, b.North, b.Heading, b.Heel, b.Boom, b.VEast, b.VNorth, b.WindSpeed, b.WindFrom, d.Kind, d.Encounters)
		if w.Height > 0 {
			out = append(out, Wedge{Source: source, Wake: w})
		}
	}
	add(-1, &own)
	for i := range others {
		if len(out) >= mostWedges {
			break
		}
		b := &others[i]
		dx, dy := b.East-own.East, b.North-own.North
		if math.Sqrt(float64(dx*dx)+float64(dy*dy)) > d.Range {
			continue
		}
		add(i, b)
	}
	return out
}

// Fouled is which boats sit in whose dirty air, as the wedges lie.
type Fouled struct {
	// In are the others, by index, in whose wedge the sailor's boat sits.
	In []int
	// Covering are the others the sailor's own wedge lies over.
	Covering []int
}

// Foul is which wedges the sailor's boat own sits in, and which others its
// own wedge covers, each boat at its own place.
func (d *DirtyAir) Foul(own Aired, others []Aired) Fouled {
	var f Fouled
	for _, w := range d.Wedges(own, others) {
		if w.Source < 0 {
			for i := range others {
				if d.Outline.Covers(&w.Wake, others[i].East, others[i].North) {
					f.Covering = append(f.Covering, i)
				}
			}
			continue
		}
		if d.Outline.Covers(&w.Wake, own.East, own.North) {
			f.In = append(f.In, w.Source)
		}
	}
	return f
}
