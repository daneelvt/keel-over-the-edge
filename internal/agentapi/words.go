// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"math"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// The report's words: a sailor's, in a fixed order, with the precision a
// phone gives. The boat's own instruments are read to the degree and the
// tenth of a knot, as on its screen; what is seen by eye, to 5° of bearing
// and a range rounded as a lookout judges one, 5 m within 50 m, 10 m to
// 200 m and 50 m beyond; anything ahead in real seconds, to 5. Sides are
// words, never signs, and every bearing is true, with the angle off the bow
// said beside it where it helps.

// articles are what each Article asks, by its number, as the phone says
// them.
var articles = map[uint8]string{
	physics.Article10: "port tack keeps clear of starboard",
	physics.Article11: "windward keeps clear of leeward",
	physics.Article12: "clear astern keeps clear of clear ahead",
	physics.Article13: "a boat tacking keeps clear",
	physics.Article15: "a boat gaining right of way gives room",
	physics.Article16: "a boat with right of way changing course gives room",
	physics.Article22: "keep clear of a capsized boat",
}

// articleName is an Article's number as the rulebook writes it.
func articleName(a uint8) string {
	if a == physics.Article16 {
		return "16.1"
	}
	return strconv.Itoa(int(a))
}

// bumpWords are a bump's line for the sailor of boat A (side 0) or B (1),
// as the phone's: "bump · port tack keeps clear of starboard (Article 10)
// · yours".
func bumpWords(b *bus.Bump, side int) string {
	if b.Fault == physics.Neither {
		return "bump · no fault"
	}
	why := ""
	if rule, ok := articles[b.Article]; ok {
		why = " · " + rule + " (Article " + articleName(b.Article) + ")"
	}
	mine := b.Fault == physics.First && side == 0 || b.Fault == physics.Second && side == 1
	if mine {
		return "bump" + why + " · yours"
	}
	return "bump" + why + " · theirs"
}

// degrees is a direction in rad as whole degrees true, 0 to 359.
func degrees(rad float64) int {
	d := int(math.Floor(math.Mod(rad*180/math.Pi, 360) + 0.5))
	for d < 0 {
		d += 360
	}
	return d % 360
}

// bearing5 is a direction seen by eye, to 5°.
func bearing5(rad float64) int {
	return (int(math.Floor(float64(degrees(rad))/5+0.5)) * 5) % 360
}

// three writes a bearing as three figures: "045°".
func three(d int) string { return fmt.Sprintf("%03d°", d) }

// point16 is the compass point of a direction: "WSW".
func point16(rad float64) string { return weather.Point16(rad) }

// rangeWords is a distance seen by eye, rounded as a lookout judges it:
// "120 m", "~450 m", "0.6 NM" beyond a kilometre.
func rangeWords(m float64) string {
	switch {
	case m < 50:
		return fmt.Sprintf("%d m", int(math.Floor(m/5+0.5))*5)
	case m < 200:
		return fmt.Sprintf("%d m", int(math.Floor(m/10+0.5))*10)
	case m < 1000:
		return fmt.Sprintf("~%d m", int(math.Floor(m/50+0.5))*50)
	}
	return fmt.Sprintf("~%.1f NM", m/nm)
}

// nm is a nautical mile, m.
const nm = 1852.0

// knots is a speed in m/s in knots.
func knots(ms float64) float64 { return ms * 3600 / nm }

// knots1 is a speed to the tenth of a knot, as the screen shows it.
func knots1(ms float64) string {
	return strconv.FormatFloat(math.Floor(knots(ms)*10+0.5)/10, 'f', 1, 64) + " kn"
}

// knots0 is a speed in whole knots.
func knots0(ms float64) int { return int(math.Floor(knots(ms) + 0.5)) }

// seconds5 is a time ahead in real seconds, to 5: "~15 s".
func seconds5(s float64) string { return fmt.Sprintf("~%d s", max(int(math.Floor(s/5+0.5))*5, 5)) }

// side is the side the wind or something else is on, by the sign of an
// angle positive to starboard.
func side(angle float64) string {
	if angle < 0 {
		return "port"
	}
	return "starboard"
}

// wrap is an angle in [−π, π).
func wrap(a float64) float64 { return math.Remainder(a, 2*math.Pi) }

// rad is degrees in rad.
func rad(d float64) float64 { return d * math.Pi / 180 }

// deg is rad in degrees.
func deg(r float64) float64 { return r * 180 / math.Pi }

// estimateTokens estimates a text's length in o200k tokens: about three
// bytes a token in the report's English, figures and signs (the reports'
// golden scenes measure 2.8 to 3.4).
func estimateTokens(s string) int { return (len(s) + 2) / 3 }
