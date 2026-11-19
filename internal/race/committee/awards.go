// SPDX-License-Identifier: AGPL-3.0-only

package committee

import (
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// The awards of a race, given as it ends, only in a race whose boats came
// from at least three accounts (each machine sailor its own): at most
// three, never two to one boat. The wooden spoon always goes, to the last
// boat still racing at the end, finished or placed by its progress, never
// one that retired. Then, in turn, while there are fewer than three: the
// photo finish, to both boats of the closest finish within two seconds;
// the best start, to the first boat across the line after the gun, not
// over early; the biggest comeback, to the boat that gained most places
// after the first mark, two at least; and the crowd's favourite, to the
// boat cheered most.

// MostAwards is the most awards a race gives.
const MostAwards = 3

// comebackLeast is the fewest places gained for the biggest comeback.
const comebackLeast = 2

// award gives race r's awards, its boats in order its standings.
func award(f *bus.Frame, r *bus.Race, order []int) {
	given := 0
	free := func(j int) bool { return f.Racers[j].Awards == 0 }
	placed := func(j int) bool { return f.Racers[j].Place > 0 }
	// The wooden spoon: the last placed.
	for k := len(order) - 1; k >= 0; k-- {
		if j := order[k]; placed(j) {
			f.Racers[j].Awards |= bus.AwardSpoon
			given++
			break
		}
	}
	// The photo finish: the closest pair home within PhotoTicks.
	a, b := -1, -1
	var gap int64
	for x := range order {
		for y := x + 1; y < len(order); y++ {
			ja, jb := order[x], order[y]
			ra, rb := &f.Racers[ja], &f.Racers[jb]
			if ra.State != bus.RacerFinished || rb.State != bus.RacerFinished || !free(ja) || !free(jb) {
				continue
			}
			d := corrected(r, ra) - corrected(r, rb)
			if d < 0 {
				d = -d
			}
			if d <= PhotoTicks && (a < 0 || d < gap) {
				a, b, gap = ja, jb, d
			}
		}
	}
	if given < MostAwards && a >= 0 {
		f.Racers[a].Awards |= bus.AwardPhoto
		f.Racers[b].Awards |= bus.AwardPhoto
		given++
	}
	// The best start: the first across the line after the gun.
	best := -1
	for _, j := range order {
		rc := &f.Racers[j]
		if !placed(j) || !free(j) || rc.Over || rc.Crossed == 0 || rc.Crossed < r.Start {
			continue
		}
		if best < 0 || rc.Crossed < f.Racers[best].Crossed {
			best = j
		}
	}
	if given < MostAwards && best >= 0 {
		f.Racers[best].Awards |= bus.AwardBestStart
		given++
	}
	// The biggest comeback: the most places gained after the first mark.
	best, most := -1, int16(comebackLeast-1)
	for _, j := range order {
		rc := &f.Racers[j]
		if !placed(j) || !free(j) || rc.First == 0 {
			continue
		}
		if g := rc.First - rc.Place; g > most {
			best, most = j, g
		}
	}
	if given < MostAwards && best >= 0 {
		f.Racers[best].Awards |= bus.AwardComeback
		given++
	}
	// The crowd's favourite: the most cheered.
	best = -1
	for _, j := range order {
		rc := &f.Racers[j]
		if rc.State == bus.RacerDNS || !free(j) || rc.Cheers == 0 {
			continue
		}
		if best < 0 || rc.Cheers > f.Racers[best].Cheers {
			best = j
		}
	}
	if given < MostAwards && best >= 0 {
		f.Racers[best].Awards |= bus.AwardCrowd
	}
}

// AwardNames are the awards' names, by their bits, as the results keep
// them.
var AwardNames = []struct {
	Bit  uint8
	Name string
}{
	{bus.AwardBestStart, "best-start"},
	{bus.AwardComeback, "comeback"},
	{bus.AwardPhoto, "photo-finish"},
	{bus.AwardCrowd, "crowd"},
	{bus.AwardSpoon, "spoon"},
}

// Awards are an award's bits by name, in AwardNames's order.
func Awards(bits uint8) []string {
	out := []string{}
	for _, a := range AwardNames {
		if bits&a.Bit != 0 {
			out = append(out, a.Name)
		}
	}
	return out
}

// MedalNames are the medals' names, by their numbers less one.
var MedalNames = []string{"bronze", "silver", "gold", "harbourmaster"}

// MedalName is a medal's name, "" for none.
func MedalName(m uint8) string {
	if m == 0 || int(m) > len(MedalNames) {
		return ""
	}
	return MedalNames[m-1]
}
