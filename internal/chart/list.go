// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"cmp"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
)

// The chart's list, its readable twin: everything charted, the islands,
// then the places, then the features, each nearest the boat first, and
// where each is from the boat and on the chart: "045° 1.2 NM · 67°24′N
// 045°12′", the bearing in three figures, the distance in nautical miles to
// a tenth, or in metres under a tenth of a mile. The page's twin is
// client/src/chart/store.ts's chartList; both are held to
// testdata/list.json.

// ListEntry is a charted subject as the list reads it: its kind
// (sight.Island, sight.Place or sight.Feature), its title and its kind's
// word as the list names them, and where it is, m east and north.
type ListEntry struct {
	Kind        uint8
	Title, Word string
	East, North float64
}

// ListLine is a line of the list: the entry's index among those given,
// how far it is from the boat, m, and where it is, as written.
type ListLine struct {
	Entry    int     `json:"entry"`
	Distance float64 `json:"distance"`
	Where    string  `json:"where"`
}

// ListGroup is a group of the list: its heading and its lines, nearest
// first.
type ListGroup struct {
	Title string     `json:"title"`
	Lines []ListLine `json:"lines"`
}

// List is the chart's list of entries for a boat at (east, north): its
// three groups in order, an empty one with no lines, which the page
// leaves out.
func List(entries []ListEntry, east, north float64) []ListGroup {
	groups := []ListGroup{{Title: "Islands", Lines: []ListLine{}}, {Title: "Places", Lines: []ListLine{}}, {Title: "Features", Lines: []ListLine{}}}
	for i, e := range entries {
		g := 2
		switch e.Kind {
		case sight.Island:
			g = 0
		case sight.Place:
			g = 1
		}
		de, dn := e.East-east, e.North-north
		d := math.Sqrt(float64(de*de) + float64(dn*dn))
		groups[g].Lines = append(groups[g].Lines, ListLine{
			Entry: i, Distance: d,
			Where: BearingText(physics.Atan2(de, dn)) + " " + DistanceText(d) + " · " + Format(e.East, e.North),
		})
	}
	for i := range groups {
		slices.SortStableFunc(groups[i].Lines, func(a, b ListLine) int { return cmp.Compare(a.Distance, b.Distance) })
	}
	return groups
}

// BearingText is a bearing in rad clockwise from north as three figures:
// "045°".
func BearingText(rad float64) string {
	d := int(jsRound(rad*180/math.Pi)) % 360
	if d < 0 {
		d += 360
	}
	return fmt.Sprintf("%03d%s", d, degreeMark)
}

// DistanceText is a distance as sailors give it: nautical miles to a
// tenth, "1.2 NM", or metres under a tenth of a mile, "120 m".
func DistanceText(m float64) string {
	if m < tenthMile {
		return strconv.Itoa(int(math.Max(jsRound(m), 0))) + " m"
	}
	return toFixed1(m/nauticalMileM) + " NM"
}

// tenthMile is a tenth of a nautical mile as the page reckons it, a tenth
// in binary times a mile, a little over 185.2 m.
var tenthMile = func() float64 {
	tenth := 0.1
	return tenth * nauticalMileM
}()

// jsRound is x to the nearest whole number, a half up, as the page rounds.
func jsRound(x float64) float64 {
	f := math.Floor(x)
	if x-f >= 0.5 {
		return f + 1
	}
	return f
}

// toFixed1 is a positive x to a tenth as the page writes it: of the two
// tenths nearest x's exact value, the nearer, and at a tie the larger.
func toFixed1(x float64) string {
	// Its exact value: a float64 of this size has under 80 decimals.
	s := strconv.FormatFloat(x, 'f', 80, 64)
	dot := strings.IndexByte(s, '.')
	whole, tenths, rest := s[:dot], s[dot+1:dot+2], s[dot+2:]
	n, _ := strconv.ParseInt(whole+tenths, 10, 64)
	if rest[0] >= '5' {
		n++
	}
	return strconv.FormatInt(n/10, 10) + "." + strconv.FormatInt(n%10, 10)
}
