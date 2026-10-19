// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"encoding/json"
	"math"

	"github.com/daneelvt/keel-over-the-edge/internal/light"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The world's places and lighthouses on the world page: every place with
// its kind and name, where it is and what its kind measures; every light
// with its lighthouse's name, its character as charts write it and its
// steps, so that the page shows each flashing by the world's clock as every
// phone does. Names are the world page's alone: no phone is sent one.

// PlaceKind is a kind of place as the page lists and marks it, with the
// rule its sites are found by.
type PlaceKind struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Site string `json:"site"`
	Mark string `json:"mark"`
}

// Character is a light's character as the page shows it.
type Character struct {
	Notation string `json:"notation"`
	Colour   string `json:"colour"`
	Steps    []int  `json:"steps"` // ms, light and dark in turn
}

// placesList is places.json: the kinds of place, every place, and every
// light.
func placesList(cfg *Config) []byte {
	type placeJSON struct {
		Number   int32           `json:"number"`
		Kind     string          `json:"kind"`
		Name     string          `json:"name"`
		Island   int32           `json:"island"`
		East     float64         `json:"east"`
		North    float64         `json:"north"`
		Zone     string          `json:"zone"`
		Details  json.RawMessage `json:"details"`
		Approach *[2]float64     `json:"approach"`
	}
	type lightJSON struct {
		Number    int32   `json:"number"`
		Place     int32   `json:"place"`
		Name      string  `json:"name"`
		Role      string  `json:"role"`
		East      float64 `json:"east"`
		North     float64 `json:"north"`
		Focal     float64 `json:"focal"`
		Tower     float64 `json:"tower"`
		Range     float64 `json:"range"`
		Character int32   `json:"character"`
		Notation  string  `json:"notation"`
		Chart     string  `json:"chart"`
		Phase     int64   `json:"phase"`
	}
	out := struct {
		Kinds      []PlaceKind `json:"kinds"`
		Characters []Character `json:"characters"`
		Places     []placeJSON `json:"places"`
		Lights     []lightJSON `json:"lights"`
	}{Kinds: cfg.PlaceKinds, Characters: cfg.Characters, Places: []placeJSON{}, Lights: []lightJSON{}}
	if out.Kinds == nil {
		out.Kinds = []PlaceKind{}
	}
	if out.Characters == nil {
		out.Characters = []Character{}
	}
	b := cfg.Bundle
	if b != nil {
		names := map[int32]string{}
		for _, p := range b.Places {
			details, err := json.Marshal(p.Details)
			if err != nil {
				panic(err)
			}
			j := placeJSON{Number: p.Number, Kind: p.Kind, Name: p.Name, Island: p.Island, East: round2(p.X), North: round2(p.Y),
				Zone: p.Zone, Details: details}
			if x, y, ok := placeApproach(b.Ground, p.X, p.Y, cfg.Rules.Approach); ok {
				j.Approach = &[2]float64{round2(x), round2(y)}
			}
			out.Places = append(out.Places, j)
			names[p.Number] = p.Name
		}
		for _, l := range b.Lights {
			out.Lights = append(out.Lights, lightJSON{
				Number: l.Number, Place: l.Place, Name: names[l.Place], Role: l.Role, East: round2(l.X), North: round2(l.Y),
				Focal: l.Focal, Tower: l.Tower, Range: l.Range, Character: l.Character, Notation: l.Notation,
				Chart: light.Notation(l.Notation, l.Focal, l.Range), Phase: l.Phase,
			})
		}
	}
	body, err := json.Marshal(&out)
	if err != nil {
		panic(err)
	}
	return body
}

// placeApproach is where a boat is put to sail to a place at (x, y): the
// place itself if its water is deep enough, else the first point that deep
// on the line from it toward the centre of the disk, a metre at a time, or
// away from it if the place is the centre. ok is false if there is none
// within 5 km.
func placeApproach(g *physics.Ground, x, y, deep float64) (float64, float64, bool) {
	dx, dy := -x, -y
	if d := math.Hypot(dx, dy); d > 1 {
		dx, dy = dx/d, dy/d
	} else {
		dx, dy = 0, -1
	}
	for k := range 5000 {
		px, py := x+float64(k)*dx, y+float64(k)*dy
		if e, _ := g.At(px, py); -e >= deep {
			return px, py, true
		}
	}
	return 0, 0, false
}
