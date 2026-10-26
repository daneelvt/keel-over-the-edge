// SPDX-License-Identifier: AGPL-3.0-only

// Package helmsman sails a machine sailor to a charted place with no model
// at all: through the game's MCP tools alone, as an agent would, by the
// bearings the chart gives. It stands in for an agent in tests, and shows
// that the tools are enough to sail somewhere: the chart says where the
// place is from the boat, the report where the wind comes from, and the
// autopilot holds what it is told. Off the wind it steers for the place;
// close to it, it beats, close-hauled on the tack that points nearer the
// place, and tacks when the other points nearer by a margin.
package helmsman

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"time"
)

// A Caller calls the game's tools: their answers' text, and whether they
// were refused.
type Caller interface {
	Call(ctx context.Context, tool string, args map[string]any) (text string, refused bool, err error)
}

// The helmsman's sailing.
const (
	// closeHauled is the angle off the wind it beats at, degrees, and
	// beatWithin how close to the wind the place may lie before it beats.
	closeHauled = 45
	beatWithin  = 55
	// tackMargin is how much nearer the place the other tack must point,
	// degrees, before it tacks: a tack costs way.
	tackMargin = 20
	// waitFor is how long it rests between looks, s.
	waitFor = 10
)

// Result is how a passage went.
type Result struct {
	Arrived  bool
	Looks    int
	Tacks    int
	Distance float64 // from the place at the end, m
}

// ErrNotCharted is a place the chart does not know.
var ErrNotCharted = errors.New("helmsman: no charted place of that name")

// A turn has stalled when the answer to an order still says the boat is
// turning, at under stallKnots, stallLooks times running.
const (
	stallKnots = 1.0
	stallLooks = 3
)

var (
	turning = regexp.MustCompile(`(tacking|gybing) to`)
	knots   = regexp.MustCompile(` ([0-9.]+) kn · heel`)
)

// speedOf is the boat's speed in an order's answer, knots.
func speedOf(said string) float64 {
	g := knots.FindStringSubmatch(said)
	if g == nil {
		return math.Inf(1)
	}
	v, _ := strconv.ParseFloat(g[1], 64)
	return v
}

var whereFrom = regexp.MustCompile(`(\d{3})° ([0-9.]+) (NM|m) from you`)

// bearing reads the place's bearing and distance from the chart's answer.
func bearing(text string) (deg, m float64, ok bool) {
	g := whereFrom.FindStringSubmatch(text)
	if g == nil {
		return 0, 0, false
	}
	b, _ := strconv.ParseFloat(g[1], 64)
	d, _ := strconv.ParseFloat(g[2], 64)
	if g[3] == "NM" {
		d *= 1852
	}
	return b, d, true
}

// wrap is an angle in degrees in [−180, 180).
func wrap(d float64) float64 { return math.Mod(math.Mod(d+180, 360)+360, 360) - 180 }

var overBudget = regexp.MustCompile(`^Too many \w+:.* Wait ([0-9.]+) s`)

// polite is c, waiting out a refusal for being over a budget and asking
// again, as the refusal says to.
type polite struct{ c Caller }

func (p polite) Call(ctx context.Context, tool string, args map[string]any) (string, bool, error) {
	for {
		text, refused, err := p.c.Call(ctx, tool, args)
		g := overBudget.FindStringSubmatch(text)
		if err != nil || !refused || g == nil {
			return text, refused, err
		}
		s, _ := strconv.ParseFloat(g[1], 64)
		select {
		case <-ctx.Done():
			return text, refused, ctx.Err()
		case <-time.After(time.Duration((s + 0.05) * float64(time.Second))):
		}
	}
}

// Sail sails to place until within arrive m of it, looking at most looks
// times; logf, if not nil, is told of each order.
func Sail(ctx context.Context, c Caller, place string, arrive float64, looks int, logf func(format string, args ...any)) (Result, error) {
	var r Result
	if logf == nil {
		logf = func(string, ...any) {}
	}
	c = polite{c}
	side := ""
	stalled := 0
	for r.Looks = 0; r.Looks < looks; r.Looks++ {
		text, refused, err := c.Call(ctx, "chart", map[string]any{"place": place})
		if err != nil {
			return r, err
		}
		if refused {
			return r, fmt.Errorf("%w: %s", ErrNotCharted, text)
		}
		b, d, ok := bearing(text)
		if !ok {
			// Not at sea yet: a look puts the boat in the water.
			if _, _, err := c.Call(ctx, "observe", nil); err != nil {
				return r, err
			}
			continue
		}
		r.Distance = d
		if d <= arrive {
			r.Arrived = true
			return r, nil
		}
		text, _, err = c.Call(ctx, "observe", map[string]any{"format": "json"})
		if err != nil {
			return r, err
		}
		var rep struct {
			Wind struct {
				From float64 `json:"from"`
			} `json:"wind"`
		}
		if err := json.Unmarshal([]byte(text[jsonStart(text):]), &rep); err != nil {
			return r, fmt.Errorf("helmsman: the report: %w", err)
		}
		w := rep.Wind.From
		off := wrap(w - b)
		var order map[string]any
		if math.Abs(off) >= beatWithin {
			// Free to point at it: the boom half the angle off the wind.
			order = map[string]any{"heading": int(math.Round(math.Mod(b+360, 360))) % 360, "boom": int(min(max(math.Abs(off)/2, 18), 85))}
		} else {
			// Beating: the tack that points nearer the place.
			starboard := math.Abs(wrap(w - closeHauled - b))
			port := math.Abs(wrap(w + closeHauled - b))
			want := "starboard"
			if port < starboard {
				want = "port"
			}
			switch {
			case side == "":
				side = want
			case want != side && math.Abs(starboard-port) > tackMargin:
				side = want
				r.Tacks++
			}
			order = map[string]any{"wind_angle": closeHauled, "side": side, "boom": 18, "via": "tack"}
		}
		said, refused, err := c.Call(ctx, "steer", order)
		if err != nil {
			return r, err
		}
		logf("%.0f m off at %03.0f°, the wind from %03.0f°: %v → %s (refused %v)", d, b, w, order, said, refused)
		// A boat with no way on cannot turn through the wind: its turn
		// stalls. The helm in hand ends it; on the tack it is on, it
		// gathers way, and the next order turns it.
		if turning.MatchString(said) && speedOf(said) < stallKnots {
			stalled++
		} else {
			stalled = 0
		}
		if stalled >= stallLooks {
			logf("the turn has stalled: gathering way on this tack")
			for _, o := range []map[string]any{{"rudder": 0, "boom": 40}, {"wind_angle": 100, "side": "same", "boom": 40}} {
				if _, _, err := c.Call(ctx, "steer", o); err != nil {
					return r, err
				}
			}
			if _, _, err := c.Call(ctx, "observe", map[string]any{"wait": 20, "wake_on": []string{"land"}}); err != nil {
				return r, err
			}
			stalled, side = 0, ""
			continue
		}
		if _, _, err := c.Call(ctx, "observe", map[string]any{"wait": waitFor, "wake_on": []string{"land", "boat"}}); err != nil {
			return r, err
		}
	}
	return r, nil
}

// jsonStart is where a JSON report begins in an answer: after a primer.
func jsonStart(text string) int {
	for i := len(text) - 1; i >= 0; i-- {
		if text[i] == '\n' && i+1 < len(text) && text[i+1] == '{' {
			return i + 1
		}
	}
	return 0
}
