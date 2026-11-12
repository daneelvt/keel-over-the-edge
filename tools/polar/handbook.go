// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"fmt"
	"math"
	"os"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The machine sailors' handbook prints, for each boat, a table of the
// fastest sheet: the boom at a few true wind angles in three strengths,
// from the polar; and when to reef. -check fails when the physics has moved
// a number, and -handbook writes them into the page.
const handbookPath = "internal/agentapi/handbook/trim.md"

// The handbook's winds are the game's, 10 m up, in knots.
var (
	trimWinds  = []float64{6, 12, 20}
	trimAngles = []float64{40, 60, 90, 120, 150, 170, 180}
)

// The page's words about the tables and the reefs: the generated part runs
// from trimIntro to the end of the reefing paragraph.
const (
	trimIntro   = "The fastest boom by angle off the true wind, in 6, 12 and 20 knots"
	squareIntro = "The fastest braces, the yards' angle off the centreline, by angle off the true wind, in 6, 12 and 20 knots"
	reefIntro   = "Reef (trim or steer with reef 1 or 2; 0 shakes the reefs out) when close-hauled the sheet hauled in hard heels the boat past its trim: from there only easing holds her up, and reefed she heels less and stands up."
)

// trimTable is a kind's table, under a line naming it, a line for each angle
// with the boom in each of trimWinds, "- 40°: 4, 4, 10", from polars that
// include them.
//
// A ship's is of the braces, the yards' angle off the centreline, from
// braced up sharp to square, under its own line, with "aback" where she
// cannot sail.
func trimTable(k *kind, polars []polar) (string, error) {
	var b strings.Builder
	if k.square {
		fmt.Fprintf(&b, "%s (%s, flat water):\n\n", squareIntro, k.name)
	} else {
		fmt.Fprintf(&b, "%s (%s, flat water):\n\n", trimIntro, k.name)
	}
	for _, a := range trimAngles {
		fmt.Fprintf(&b, "- %g°:", a)
		for i, w := range trimWinds {
			p, ok := polarAt(polars, k.atHeight(w))
			if !ok {
				return "", fmt.Errorf("no polar for %g knots", w)
			}
			pt := at(p, a)
			sep := ","
			if i == 0 {
				sep = ""
			}
			switch {
			case pt.Aback:
				fmt.Fprintf(&b, "%s aback", sep)
			case !pt.OK:
				return "", fmt.Errorf("the boat capsizes at %g° in %g knots", a, w)
			case k.square:
				fmt.Fprintf(&b, "%s %d", sep, bracesRounded(pt.Boom, k.in))
			default:
				fmt.Fprintf(&b, "%s %d", sep, boomRounded(pt.Boom))
			}
		}
		b.WriteString("\n")
	}
	return b.String(), nil
}

// atHeight is the wind at the kind's reference height, knots, that blows
// knots 10 m up.
func (k *kind) atHeight(knots10 float64) float64 {
	if k.height == 10 {
		return knots10
	}
	return knots10 * knot / k.wind10(1)
}

// boomRounded is a boom's angle as the handbook gives it, to whichever
// side it is: 4 hauled in hard, otherwise to the nearest 5°.
func boomRounded(deg float64) int {
	deg = math.Abs(deg)
	if deg < 4.5 {
		return 4
	}
	return 5 * int(math.Round(deg/5))
}

// bracesRounded is a ship's yards' angle as the handbook gives it: braced
// up sharp, at sharp degrees, within half the table's step of it, and
// otherwise to the nearest 5°.
func bracesRounded(deg, sharp float64) int {
	if deg < sharp+easedOver {
		return int(math.Round(sharp))
	}
	return 5 * int(math.Round(deg/5))
}

func polarAt(polars []polar, wind float64) (polar, bool) {
	for _, p := range polars {
		if p.Wind == wind {
			return p, true
		}
	}
	return polar{}, false
}

// The winds the reef is looked for in, knots 10 m up, and how far off
// hauled in hard a boom must be to count as eased, degrees: half the
// trim table's step, so that a boom it gives as hauled in hard is.
const (
	reefFrom  = 4
	reefTo    = 30
	easedOver = 2.5
)

// shipReefHeel is the heel close-hauled past which a ship reefs, degrees.
const shipReefHeel = 10

// reefWind is the least wind, knots 10 m up, in which the kind heels past
// its trim at full sail: close-hauled, its fastest sheet is no longer
// hauled in hard, or a ship's braces no longer braced up sharp, because
// hauled in it heels further than the sailor can hold and loses more to
// the heel than the sail gains. Zero if it never
// does up to reefTo. The sheet eases as the wind rises, so the wind is
// found by halving.
//
// A ship's yards stay braced up sharp close-hauled in any wind her stability
// lets her carry sail in: hers is the least wind in which, close-hauled at
// full sail, she heels past shipReefHeel, where her crew takes the
// topgallants in (Beaufort's man-of-war scale, force 6).
func reefWind(k *kind) float64 {
	eased := func(w float64) bool {
		pt := best(k, k.atHeight(w), k.p.CloseHauled, 0)
		if k.square {
			return pt.OK && pt.Heel > shipReefHeel
		}
		return !pt.OK || pt.Boom > k.in+easedOver
	}
	lo, hi := float64(reefFrom), float64(reefTo)
	if eased(lo) {
		return lo
	}
	if !eased(hi) {
		return 0
	}
	for hi-lo > 1 {
		mid := math.Floor((lo + hi) / 2)
		if eased(mid) {
			hi = mid
		} else {
			lo = mid
		}
	}
	return hi
}

// kiteWind is the least wind, knots 10 m up, in which the kind sails
// slower at its crew's set angle with its downwind sail set than kept in,
// at the fastest sheet of each, or capsizes at every sheet with it set:
// from there the sailor keeps it in with the reef. Zero if it never does up
// to reefTo. Found by halving, as reefWind.
func kiteWind(k *kind) float64 {
	worse := func(w float64) bool {
		set := best(k, k.atHeight(w), k.p.SetAngle, 0)
		in := best(k, k.atHeight(w), k.p.SetAngle, 1)
		return !set.OK || in.OK && in.Speed > set.Speed
	}
	lo, hi := float64(reefFrom), float64(reefTo)
	if worse(lo) {
		return lo
	}
	if !worse(hi) {
		return 0
	}
	for hi-lo > 1 {
		mid := math.Floor((lo + hi) / 2)
		if worse(mid) {
			hi = mid
		} else {
			lo = mid
		}
	}
	return hi
}

// kiteAdvice is the page's paragraph on a kind's downwind sail: where its
// crew sets it and takes it in, and from what wind to keep it in, wind
// the kiteWind.
func kiteAdvice(k *kind, wind float64) string {
	var b strings.Builder
	fmt.Fprintf(&b, "The %s's crew sets its gennaker bearing away past %g° off the true wind and takes it in coming up forward of %g°. Set, the sheet trims it with the main and the sail word is its own. Reef 1 (%s) keeps it in.",
		k.name, k.p.SetAngle, k.p.DropAngle, k.reefWords[1])
	if wind > 0 {
		fmt.Fprintf(&b, " From %g knots it no longer pays at %g°: bear away further, or keep it in.", wind, k.p.SetAngle)
	} else {
		fmt.Fprintf(&b, " It pays at %g° in every wind to %d knots.", k.p.SetAngle, reefTo)
	}
	b.WriteString("\n")
	return b.String()
}

// hullsAdvice is the page's paragraph on a boat of two hulls, or one whose
// rig pitches her: her windward hull flying, and her bows burying.
func hullsAdvice(k *kind) string {
	var b strings.Builder
	if k.p.HullSpacing > 0 {
		fmt.Fprintf(&b, "The %s lifts her windward hull when pressed (\"hull flying\" on the Boat line), fastest just clear; ease before it rises further.", k.name)
	}
	if k.p.RigPitch != 0 {
		if b.Len() > 0 {
			b.WriteString(" ")
		}
		b.WriteString("In a gust on a broad reach her bows bury (\"bows burying\") and she can pitchpole, throwing her sailor off over them; her sailor steps aft by herself. Ease, reef, or bear off to a run.")
	}
	if b.Len() == 0 {
		return ""
	}
	b.WriteString("\n")
	return b.String()
}

// reefAdvice is the page's paragraph on reefing, every kind's wind in it.
func reefAdvice(kinds []*kind, winds []float64) string {
	var b strings.Builder
	b.WriteString(reefIntro)
	b.WriteString(" Reef ")
	for i, k := range kinds {
		switch {
		case i == 0:
		case i == len(kinds)-1:
			b.WriteString(" and ")
		default:
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "the %s from %g knots", k.name, winds[i])
		if k.p != nil && k.p.DownwindArea > 0 && k.p.Reefs[1] == 1 && k.p.HeadsailReefs[1] == 1 {
			b.WriteString(" (reef 2: its reef 1 shortens nothing)")
		}
	}
	b.WriteString(".\n")
	return b.String()
}

// handbookBlock is the page's generated part: every kind's table, then the
// reefing advice.
func handbookBlock(kinds []*kind) (string, error) {
	var b strings.Builder
	winds := make([]float64, len(kinds))
	for i, k := range kinds {
		t, err := trimTable(k, sailPolars(k, k.trimWinds(), chartAngles))
		if err != nil {
			return "", fmt.Errorf("%s: %w", k.name, err)
		}
		b.WriteString(t)
		b.WriteString("\n")
		if k.p.DownwindArea > 0 {
			b.WriteString(kiteAdvice(k, kiteWind(k)))
			b.WriteString("\n")
		}
		if a := hullsAdvice(k); a != "" {
			b.WriteString(a)
			b.WriteString("\n")
		}
		if winds[i] = reefWind(k); winds[i] == 0 {
			return "", fmt.Errorf("%s: close-hauled at full sail it never heels past its trim up to %d knots", k.name, reefTo)
		}
	}
	b.WriteString(reefAdvice(kinds, winds))
	return b.String(), nil
}

// trimWinds are the handbook's winds at the kind's reference height.
func (k *kind) trimWinds() []float64 {
	w := make([]float64, len(trimWinds))
	for i, x := range trimWinds {
		w[i] = k.atHeight(x)
	}
	return w
}

// pageBlock finds the generated part in the page: from the first table's
// line to the end of the reefing paragraph.
func pageBlock(page string) (from, to int, err error) {
	from = strings.Index(page, trimIntro)
	r := strings.Index(page, reefIntro)
	if from < 0 || r < from {
		return 0, 0, fmt.Errorf("%s has no trim tables and reefing advice where -handbook writes them", handbookPath)
	}
	to = r + strings.Index(page[r:], "\n") + 1
	return from, to, nil
}

// checkHandbook fails unless the handbook's page carries the kind's table
// and its reefing wind as the polars, which include the handbook's winds,
// give them.
func checkHandbook(k *kind, polars []polar) error {
	t, err := trimTable(k, polars)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(handbookPath)
	if err != nil {
		return err
	}
	page := string(data)
	if !strings.Contains(page, t) {
		return fmt.Errorf("%s's trim table for the %s is not the polar's: rewrite it with go run ./tools/polar -handbook, which gives\n%s", handbookPath, k.name, t)
	}
	if k.p.DownwindArea > 0 {
		if a := kiteAdvice(k, kiteWind(k)); !strings.Contains(page, a) {
			return fmt.Errorf("%s's advice on the %s's gennaker is not the polar's: rewrite it with go run ./tools/polar -handbook, which gives\n%s", handbookPath, k.name, a)
		}
	}
	if a := hullsAdvice(k); !strings.Contains(page, a) {
		return fmt.Errorf("%s's advice on the %s's hulls and bows is not the polar's: rewrite it with go run ./tools/polar -handbook, which gives\n%s", handbookPath, k.name, a)
	}
	w := reefWind(k)
	if want := fmt.Sprintf("the %s from %g knots", k.name, w); w == 0 || !strings.Contains(page, want) {
		return fmt.Errorf("%s's reefing advice is not the polar's: rewrite it with go run ./tools/polar -handbook, which gives %q", handbookPath, want)
	}
	fmt.Printf("  ok   the handbook's trim table and reefing wind\n")
	return nil
}

// checkWords fails unless the sail says drawing at the fastest sheet at
// every angle and strength the boat sails without capsizing, from 10°
// inside her close-hauled angle: pinched closer, a big boat's main lifts,
// the genoa backing it, and the word is not held there.
func checkWords(polars []polar, closeHauled float64) error {
	var bad []string
	for _, p := range polars {
		for _, pt := range p.Points {
			if pt.TWA < closeHauled-10 {
				continue
			}
			if pt.OK && pt.Word != physics.SailDrawing {
				bad = append(bad, fmt.Sprintf("%g knots at %g°, boom %.0f°, apparent %.0f°: %s", p.Wind, pt.TWA, pt.Boom, pt.Apparent, sailWords[pt.Word]))
			}
		}
	}
	if len(bad) > 0 {
		return fmt.Errorf("the sail's word at the fastest sheet is not drawing:\n  %s", strings.Join(bad, "\n  "))
	}
	fmt.Printf("  ok   the sail says drawing at the fastest sheet, %g to %g knots\n", polars[0].Wind, polars[len(polars)-1].Wind)
	return nil
}

// runHandbook writes every kind's trim table and the reefing advice into
// the handbook's page, and prints them, with how each kind heels close-hauled
// at its fastest sheet past its reefing wind at each reef.
func runHandbook(kinds []*kind) error {
	block, err := handbookBlock(kinds)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(handbookPath)
	if err != nil {
		return err
	}
	page := string(data)
	from, to, err := pageBlock(page)
	if err != nil {
		return err
	}
	page = page[:from] + block + page[to:]
	if err := os.WriteFile(handbookPath, []byte(page), 0o644); err != nil {
		return err
	}
	fmt.Print(block)
	fmt.Printf("wrote %s\n", handbookPath)
	for _, k := range kinds {
		w := reefWind(k)
		fmt.Printf("\n%s close-hauled at its fastest sheet, by the reef (wind 10 m up):\n", k.name)
		fmt.Println("  wind  reef  speed   VMG  heel  boom sheet")
		for _, wind := range []float64{w, w + 4, w + 8} {
			for reef := 0.0; reef <= 2; reef++ {
				pt := best(k, k.atHeight(wind), k.p.CloseHauled, reef)
				if !pt.OK {
					fmt.Printf("  %4g  %4g  capsizes at every sheet\n", wind, reef)
					continue
				}
				fmt.Printf("  %4g  %4g %6.2f %5.2f %5.1f %5.1f %5.2f\n", wind, reef, pt.Speed, pt.VMG, pt.Heel, pt.Boom, pt.Sheet)
			}
		}
	}
	return nil
}
