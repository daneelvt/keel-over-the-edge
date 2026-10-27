// SPDX-License-Identifier: AGPL-3.0-only

// Package helmsman sails a machine sailor to a charted place with no model
// at all: through the game's MCP tools alone, as an agent would, by the
// bearings the chart gives. It stands in for an agent in tests, and shows
// that the tools are enough to sail somewhere: the chart says where the
// place is from the boat, the report where the wind comes from, and the
// autopilot holds what it is told. Off the wind it steers for the place;
// close to it, it beats, close-hauled on the tack that points nearer the
// place, and tacks when the other points nearer by a margin. Near shoal
// water, unless the place lies across water the report's Shoal line calls
// clear, it steers for the middle of the widest clear span first.
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
	Arrived    bool
	Looks      int
	Tacks      int
	Groundings int     // times the boat went aground
	Distance   float64 // from the place at the end, m
}

// ErrNotCharted is a place the chart does not know.
var ErrNotCharted = errors.New("helmsman: no charted place of that name")

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
		rep, err := r.read(text)
		if err != nil {
			return r, err
		}
		w := rep.Wind.From
		// Off a bank first, unless the place lies across clear water.
		toward := b
		if sh := rep.Shoal; sh != nil && (sh.Here || !sh.clearAt(b)) {
			if m, ok := sh.widest(); ok {
				toward = m
			}
		}
		off := wrap(w - toward)
		var order map[string]any
		// The boom half the apparent wind's angle where the boat is, so
		// that one lying still gathers way and comes to steerage.
		boom := int(min(max(rep.Wind.Apparent/2, 18), 85))
		if math.Abs(off) >= beatWithin {
			// Free to point at it.
			order = map[string]any{"heading": int(math.Round(math.Mod(toward+360, 360))) % 360, "boom": boom}
		} else {
			// Beating: the tack that points nearer it.
			starboard := math.Abs(wrap(w - closeHauled - toward))
			port := math.Abs(wrap(w + closeHauled - toward))
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
			order = map[string]any{"wind_angle": closeHauled, "side": side, "boom": min(boom, 25), "via": "tack"}
		}
		said, refused, err := c.Call(ctx, "steer", order)
		if err != nil {
			return r, err
		}
		logf("%.0f m off at %03.0f°, steering for %03.0f°, the wind from %03.0f°: %v → %s (refused %v)", d, b, toward, w, order, said, refused)
		// A turn that stalls for want of way is given up by the autopilot,
		// which holds the side it was on: the next look orders it again.
		text, _, err = c.Call(ctx, "observe", map[string]any{"wait": waitFor, "wake_on": []string{"land", "boat", "pilot"}, "format": "json"})
		if err != nil {
			return r, err
		}
		if _, err := r.read(text); err != nil {
			return r, err
		}
	}
	return r, nil
}

// report is what the helmsman reads of a JSON report.
type report struct {
	Wind struct {
		From     float64 `json:"from"`
		Apparent float64 `json:"apparentAngle"`
	} `json:"wind"`
	Shoal *shoal `json:"shoal"`
	Since *struct {
		Events []string `json:"events"`
	} `json:"since"`
}

// shoal is the report's Shoal line: whether the boat is in shoal water, and
// the spans of bearings clear of it, degrees.
type shoal struct {
	Here  bool `json:"here"`
	Clear []struct {
		From float64 `json:"from"`
		To   float64 `json:"to"`
	} `json:"clear"`
}

// sector is how wide a span's sector is, degrees: a span runs from half of
// it before its first bearing to half after its last.
const sector = 22.5

// clearAt reports whether bearing b, degrees, lies in a clear span.
func (s *shoal) clearAt(b float64) bool {
	for _, c := range s.Clear {
		if math.Mod(b-c.From+sector/2+720, 360) <= math.Mod(c.To-c.From+360, 360)+sector {
			return true
		}
	}
	return false
}

// widest is the middle of the widest clear span, degrees.
func (s *shoal) widest() (float64, bool) {
	best, mid := -1.0, 0.0
	for _, c := range s.Clear {
		w := math.Mod(c.To-c.From+360, 360)
		if w > best {
			best, mid = w, math.Mod(c.From+w/2+360, 360)
		}
	}
	return mid, best >= 0
}

// read reads a JSON report, counting the groundings it tells of.
func (r *Result) read(text string) (*report, error) {
	var rep report
	if err := json.Unmarshal([]byte(text[jsonStart(text):]), &rep); err != nil {
		return nil, fmt.Errorf("helmsman: the report: %w", err)
	}
	if rep.Since != nil {
		for _, e := range rep.Since.Events {
			if e == "aground" {
				r.Groundings++
			}
		}
	}
	return &rep, nil
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
