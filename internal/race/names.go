// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"fmt"
	"math/rand/v2"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Names with character: the harbour races named by their hour, the same
// in every world, so each becomes a race sailors talk of from week to
// week; the newcomers' harbour race the Greenhorn Cup whatever its hour;
// a sailor's race offered a name of the day and the shape, or of the
// course and a word of pace that shares its first sound; a time trial the
// course's Challenge.

// hourNames are the harbour races' names by their hour in the schedule's
// zone; an hour not here is named by the clock.
var hourNames = map[int]string{
	0:  "the Midnight Run",
	3:  "the Graveyard Watch",
	6:  "the Dawn Dash",
	9:  "the Morning Gun",
	12: "the Noon Gun",
	15: "the Teatime Trophy",
	18: "the Sundowner",
	21: "the Lantern Race",
}

// Greenhorn is the newcomers' harbour race's name.
const Greenhorn = "the Greenhorn Cup"

// HourName is the name of the harbour race at an hour of the day; plural,
// if not "", the boats of a race not of the usual boat ("skiffs"), added
// to it.
func HourName(hour int, plural string) string {
	name, ok := hourNames[hour]
	if !ok {
		h := hour % 12
		if h == 0 {
			h = 12
		}
		half := "am"
		if hour >= 12 {
			half = "pm"
		}
		name = fmt.Sprintf("the %d %s Harbour Race", h, half)
	}
	if plural != "" {
		name += ", " + plural
	}
	return name
}

// Plural is a boat kind's name for several, lower case: "jolly boats".
func Plural(name string) string {
	if name == "" {
		return ""
	}
	return strings.ToLower(name) + "s"
}

// paceWords are words of pace for a race's name, each tried for a course
// whose name begins with its first letter.
var paceWords = []string{
	"Bolt", "Breeze", "Bustle", "Caper", "Chase", "Canter", "Dash", "Derby", "Dart",
	"Flight", "Fling", "Frolic", "Gallop", "Gambol", "Hurry", "Hustle", "Jaunt", "Jig",
	"Lark", "Lope", "Muster", "Medley", "Pelt", "Pursuit", "Romp", "Rattle", "Rush",
	"Scamper", "Scramble", "Sprint", "Spurt", "Tear", "Trot", "Tumble", "Whirl", "Whizz",
	"Kick", "Nip", "Outing", "Quickstep", "Volley", "Yomp", "Zip", "Amble", "Escapade",
	"Gadabout", "Lunge", "Whoosh",
}

// anyPace are the words of pace for a course no word above begins as.
var anyPace = []string{"Dash", "Race", "Scramble", "Sprint", "Chase"}

// shapeWords are the buoy courses' shapes as a name says them: a
// windward–leeward course is the club racer's sausage.
var shapeWords = map[string]string{
	ShapeTriangle:        "Triangle",
	ShapeWindwardLeeward: "Sausage",
}

// shapeNames are the buoy courses' shapes as a card says them.
var shapeNames = map[string]string{
	ShapeTriangle:        "triangle",
	ShapeWindwardLeeward: "windward–leeward",
}

// BuoyName is a buoy course's name: "Short triangle off Port Royal"; port
// "" leaves the place off.
func BuoyName(shape string, long bool, port string) string {
	length := "Short"
	if long {
		length = "Long"
	}
	name := length + " " + shapeNames[shape]
	if port != "" {
		name += " off " + port
	}
	return name
}

// placeOf is the place a course's name turns on: "Round Gannet Holm" →
// "Gannet Holm", "Port Royal to Saltcliff" → "Saltcliff", "The Three
// Sisters" → "Three Sisters", a tour → its first island.
func placeOf(course string) string {
	s := course
	for _, p := range []string{"Round the ", "Round ", "The ", "the "} {
		if strings.HasPrefix(s, p) {
			s = s[len(p):]
			break
		}
	}
	if i := strings.LastIndex(s, " to "); i >= 0 {
		s = s[i+len(" to "):]
	}
	if i := strings.Index(s, " from "); i >= 0 {
		s = s[:i]
	}
	if i := strings.IndexAny(s, ","); i >= 0 {
		s = s[:i]
	}
	if i := strings.Index(s, " and "); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// firstLetter is s's first letter, upper case.
func firstLetter(s string) rune {
	r, _ := utf8.DecodeRuneInString(s)
	return unicode.ToUpper(r)
}

// paceFor is a word of pace for a place, sharing its first sound where
// one does.
func paceFor(place string, rnd *rand.Rand) string {
	first := firstLetter(place)
	var fits []string
	for _, w := range paceWords {
		if firstLetter(w) == first {
			fits = append(fits, w)
		}
	}
	if len(fits) == 0 {
		fits = anyPace
	}
	return fits[rnd.IntN(len(fits))]
}

// Suggest is a name for a race on a course, starting at start in zone:
// for a trial the course's Challenge; for a race on a buoy course the day
// and the shape ("Tuesday Triangle") or the port and a word of pace; for
// a race on an island course, the course's place and a word of pace that
// shares its first sound ("the Gannet Holm Gallop"). seed varies the
// choice.
func Suggest(kind, courseKind, shape, courseName, port string, start time.Time, zone *time.Location, seed uint64) string {
	rnd := rand.New(rand.NewPCG(seed, 0x6e616d6573))
	if zone == nil {
		zone = time.UTC
	}
	if courseKind == CourseBuoy {
		if kind == KindTrial {
			return fmt.Sprintf("the %s %s Challenge", port, shapeWords[shape])
		}
		if rnd.IntN(3) < 2 {
			return start.In(zone).Weekday().String() + " " + shapeWords[shape]
		}
		return fmt.Sprintf("the %s %s", port, paceFor(port, rnd))
	}
	place := placeOf(courseName)
	if place == "" {
		place = courseName
	}
	if kind == KindTrial {
		return fmt.Sprintf("the %s Challenge", place)
	}
	return fmt.Sprintf("the %s %s", place, paceFor(place, rnd))
}
