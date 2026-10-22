// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
)

// A position is a latitude and a longitude, the same words everywhere. The
// pole is the disk's centre, under the Hub Star: the latitude is the Hub
// Star's height, 90° at the pole falling 10° for each nautical mile out,
// 45° at the rim, every one north; the longitude is the meridian, the true
// bearing of the position from the pole, 000° to 359°.
//
// Both are given to the minute, rounded to the nearest, a half up, and
// carried, so no position reads 60′ (Wikimedia's bug T153429: "52.4 is
// formatted as 52°23'60""). They are written as IHO S-4 writes them
// (B-131: "with a single space between the coordinates and no other
// spaces", "leading zeros for single number minutes, but not for degrees"),
// the longitude's degrees in three figures as the UKHO's warnings write
// them and with no letter, every longitude being of one kind: 67°24′N
// 045°12′. At the pole the longitude has no meaning and is left out:
// 90°00′N. The client's twin is client/src/chart/position.ts; both are
// held to testdata/positions.json.

// The marks: U+00B0 DEGREE SIGN and U+2032 PRIME, "= minutes".
const (
	degreeMark = "°"
	minuteMark = "′"
)

// nauticalMileM is a nautical mile, m; degreesPerMile how far the latitude
// falls a nautical mile from the pole.
const (
	nauticalMileM  = 1852
	degreesPerMile = 10
)

// Position is a position to the minute: the latitude in whole minutes of
// arc north, the longitude in whole minutes from 0 to 21,599, and whether
// it is at the pole, where it has no longitude.
type Position struct {
	Latitude, Longitude int
	Pole                bool
}

// PositionOf is the position of a point m east and north of the centre.
// Each product is rounded before it is added, as the page's twin rounds
// it: Go would fuse them otherwise.
func PositionOf(east, north float64) Position {
	r := math.Sqrt(float64(east*east)+float64(north*north)) / nauticalMileM
	lat := roundMinutes(float64((90 - float64(degreesPerMile*r)) * 60))
	if lat >= 90*60 {
		return Position{Latitude: 90 * 60, Pole: true}
	}
	b := float64(math.Atan2(east, north)*180) / math.Pi
	if b < 0 {
		b += 360
	}
	lon := roundMinutes(float64(b*60)) % (360 * 60)
	return Position{Latitude: lat, Longitude: lon}
}

// roundMinutes is a number of minutes to the nearest whole one, a half up.
func roundMinutes(m float64) int { return int(math.Floor(m + 0.5)) }

// String is the position as written: 67°24′N 045°12′, or 90°00′N.
func (p Position) String() string {
	lat := fmt.Sprintf("%d%s%02d%sN", p.Latitude/60, degreeMark, p.Latitude%60, minuteMark)
	if p.Pole {
		return lat
	}
	return fmt.Sprintf("%s %03d%s%02d%s", lat, p.Longitude/60, degreeMark, p.Longitude%60, minuteMark)
}

// Point is the place a position names, m east and north of the centre:
// the middle of its minutes.
func (p Position) Point() (east, north float64) {
	r := (90 - float64(p.Latitude)/60) / degreesPerMile * nauticalMileM
	if p.Pole {
		return 0, 0
	}
	b := float64(p.Longitude) / 60 * math.Pi / 180
	return r * math.Sin(b), r * math.Cos(b)
}

// Format is the position of a point m east and north of the centre, as
// written.
func Format(east, north float64) string { return PositionOf(east, north).String() }

// ParsePosition reads a position as a person might write it: the latitude
// then the longitude, each degrees and minutes, the degrees marked by ° or
// a space, the minutes by ′, ' or nothing, with a decimal part if wanted;
// the latitude's N may be left out, never an S; a latitude alone is the
// pole only at 90°. It gives the point m east and north of the centre.
func ParsePosition(s string) (east, north float64, err error) {
	fields := strings.FieldsFunc(s, func(r rune) bool {
		return r == ' ' || r == '°' || r == '′' || r == '\'' || r == ',' || r == 'º'
	})
	var parts []string
	for _, f := range fields {
		switch f {
		case "N", "n":
			continue
		case "S", "s":
			return 0, 0, errors.New("every latitude is north")
		}
		f = strings.TrimSuffix(strings.TrimSuffix(f, "N"), "n")
		if f == "" {
			continue
		}
		parts = append(parts, f)
	}
	num := func(i int) (float64, error) {
		v, err := strconv.ParseFloat(parts[i], 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			return 0, fmt.Errorf("%q is not a number of degrees or minutes", parts[i])
		}
		return v, nil
	}
	var lat, lon float64
	switch len(parts) {
	case 2, 4:
		d, err := num(0)
		if err != nil {
			return 0, 0, err
		}
		m, err := num(1)
		if err != nil {
			return 0, 0, err
		}
		if m >= 60 || d != math.Trunc(d) {
			return 0, 0, errors.New("the latitude's degrees must be whole and its minutes under 60")
		}
		lat = d + m/60
		if len(parts) == 2 {
			if lat != 90 {
				return 0, 0, errors.New("a latitude alone is the pole's, 90°00′N: give the longitude too")
			}
			return 0, 0, nil
		}
		d, err = num(2)
		if err != nil {
			return 0, 0, err
		}
		if m, err = num(3); err != nil {
			return 0, 0, err
		}
		if m >= 60 || d != math.Trunc(d) || d >= 360 {
			return 0, 0, errors.New("the longitude's degrees must be whole, under 360, and its minutes under 60")
		}
		lon = d + m/60
	default:
		return 0, 0, errors.New("write a position as degrees and minutes of latitude, then of longitude: 67°24′N 045°12′")
	}
	if lat > 90 {
		return 0, 0, errors.New("no latitude is above 90°")
	}
	r := (90 - lat) / degreesPerMile * nauticalMileM
	b := lon * math.Pi / 180
	return r * math.Sin(b), r * math.Cos(b), nil
}
