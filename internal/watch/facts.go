// SPDX-License-Identifier: AGPL-3.0-only

package watch

import "github.com/daneelvt/keel-over-the-edge/internal/bus"

// What the list and the card tell of a boat: only what a spectator of
// that boat would see on its sailor's screen or out of its window. The
// sky and the wind at the boat, its speed and whether it is upright; how
// far it is inside the lip, its closest pass to it and what it last
// charted, which are where it is, and so are withheld from a viewer whose
// own boat is in the water; and, on the card alone, the sea and the
// weather in the words the machine sailors are told them, the nearest
// island on the chart, and the land its lookout sees now. Never its
// position as numbers, never uncharted land it cannot see.

// The thresholds of the reasons a boat ranks high on the list.
const (
	// LivelyEdge is how near the lip a boat must be, NM.
	LivelyEdge = 1.0
	// LivelyCharted is how lately it must have charted, minutes.
	LivelyCharted = 15
)

// The states of a boat on the list.
const (
	StateSailing  = "sailing"
	StateCapsized = "capsized"
	StateRighting = "righting"
)

// Facts are what the world says of a boat in the water, made once a
// cache window for every boat.
type Facts struct {
	// Sky is the decal of the weather at the boat (weather.SkyOf); Night,
	// that the sun is down there.
	Sky   string
	Night bool
	// Force is the true wind's mean at the boat, Beaufort; Knots its
	// speed through the water.
	Force int
	Knots float64
	State string
	// Edge is how far inside the lip it is, NM; negative for not known.
	Edge float64
	// Approaching: an approach to the lip is under way. Skimmed is the
	// closest pass to the lip the voyage survived, m; 0 for none.
	Approaching bool
	Skimmed     float64
	// Charted is the subject the boat last charted this voyage, "" for
	// none, Minutes how long ago.
	Charted string
	Minutes int
}

// Card is what the card about a boat adds to its row.
type Card struct {
	Weather CardWeather
	Where   CardWhere
}

// CardWeather is the weather at the boat: the wind's direction, the
// waves, and the barometer, the visibility, the rain and the clouds about
// in the machine sailors' words.
type CardWeather struct {
	WindFrom   int     `json:"windFrom"`
	Waves      float64 `json:"waves"`
	Barometer  string  `json:"barometer"`
	Visibility string  `json:"visibility"`
	Rain       string  `json:"rain,omitempty"`
	Clouds     string  `json:"clouds,omitempty"`
}

// CardWhere is where the boat is: how far inside the lip, the nearest
// charted island, and the land its lookout sees.
type CardWhere struct {
	EdgeNM  *float64 `json:"edgeNM,omitempty"`
	Island  *Island  `json:"island,omitempty"`
	InSight []string `json:"inSight,omitempty"`
}

// Island is a charted island from a boat: its name, its bearing, degrees
// true, and how far, NM.
type Island struct {
	Name    string  `json:"name"`
	Bearing int     `json:"bearing"`
	NM      float64 `json:"nm"`
}

// Sea is the world sailed, as the list's facts are made from it.
type Sea interface {
	// Facts are the facts of the boats in the slots of f, in order.
	Facts(f *bus.Frame, slots []int32, out []Facts)
	// Card is the card's facts of the boat in slot sl of f.
	Card(f *bus.Frame, sl int32) Card
}

// Lively is a reason a boat ranks high: why, and for a charting what and
// how many minutes ago.
type Lively struct {
	Why     string `json:"why"`
	Subject string `json:"subject,omitempty"`
	Minutes *int   `json:"minutes,omitempty"`
}

// The reasons.
const (
	WhyStorm    = "storm"
	WhySqualls  = "squalls"
	WhyEdge     = "edge"
	WhyApproach = "approach"
	WhyCharted  = "charted"
	WhyCapsized = "capsized"
)

// lively are the reasons a boat with facts x ranks high, each a point;
// withheld leaves out where it is: its nearness to the lip and what it
// charted.
func lively(x *Facts, withheld bool) []Lively {
	var out []Lively
	switch x.Sky {
	case "storm":
		out = append(out, Lively{Why: WhyStorm})
	case "squalls":
		out = append(out, Lively{Why: WhySqualls})
	}
	if !withheld && x.Edge >= 0 && x.Edge <= LivelyEdge {
		out = append(out, Lively{Why: WhyEdge})
	}
	if x.Approaching {
		out = append(out, Lively{Why: WhyApproach})
	}
	if x.Charted != "" && x.Minutes <= LivelyCharted {
		m := x.Minutes
		l := Lively{Why: WhyCharted, Minutes: &m}
		if !withheld {
			l.Subject = x.Charted
		}
		out = append(out, l)
	}
	if x.State == StateCapsized || x.State == StateRighting {
		out = append(out, Lively{Why: WhyCapsized})
	}
	return out
}

// roughness ranks a sky for Roughest weather, after the wind's force.
func roughness(sky string) int {
	switch sky {
	case "storm":
		return 5
	case "squalls":
		return 4
	case "rain":
		return 3
	case "showers":
		return 2
	case "fog":
		return 1
	}
	return 0
}
