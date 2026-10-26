// SPDX-License-Identifier: AGPL-3.0-only

package scripted

import (
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
)

// TestHandSteeringAgainstTheAutopilot measures how often a boat needs
// correcting in strong wind: sailors steering by hand, a correction of
// the helm so many times a second from what they see of the boat, against
// the autopilot, in the catalog's windiest regime, each at the same
// angles off the wind and with the same sheet, set for the regime's mean
// wind and never eased. A machine sailor's limit
// on orders is set at or below the rate under which hand steering holds
// a course worse than the autopilot, or capsizes more, so that no program
// steering by hand within it does better than the autopilot every sailor
// has.
func TestHandSteeringAgainstTheAutopilot(t *testing.T) {
	if testing.Short() {
		t.Skip("sails half an hour of world time")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	regime := 0
	for i, r := range cat.Weather.Regimes {
		if r.Wind.Speed[1] > cat.Weather.Regimes[regime].Wind.Speed[1] {
			regime = i
		}
	}
	waves, kinds := cat.Prepare()
	ap := &cat.Boats[0].Physics.Autopilot
	rates := []float64{1, 2, 5, 10}
	angles := []float64{60, 90, 120, 150}
	const perConfig = 4
	const minutes = 30
	// Slots: the autopilot's, then each rate's, each angle perConfig
	// times, on both tacks.
	configs := len(rates) + 1
	n := configs * len(angles) * perConfig
	w, err := sim.New(sim.Config{Capacity: n, Kinds: kinds, Waves: waves, Weather: tl, Workers: 4, Tick: 0})
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	dev := w.Bus().Commands.Developer()
	dev.TrySend(bus.Command{Op: bus.SetWeather, Weather: bus.Weather{Mode: bus.WeatherHeld, Regime: uint16(regime)}})
	type sailor struct {
		slot   int32
		gen    uint16
		config int     // 0 the autopilot, else rates[config-1]
		angle  float64 // degrees off the wind, signed: positive on starboard
		err2   float64
		speed  float64
		count  int
		capsiz int
		mode   float64
	}
	sailors := make([]sailor, 0, n)
	replies := make([]chan bus.Reply, n)
	for i := range n {
		replies[i] = make(chan bus.Reply, 1)
		dev.TrySend(bus.Command{Op: bus.Join, Account: Account(i), Conn: uint64(i + 1), Reply: replies[i]})
	}
	w.Tick()
	for i := range n {
		r := <-replies[i]
		config := i / (len(angles) * perConfig)
		angle := angles[i/perConfig%len(angles)]
		if i%2 == 1 {
			angle = -angle
		}
		sailors = append(sailors, sailor{slot: r.Slot, gen: r.Gen, config: config, angle: angle})
	}
	// Spread out, in open water, each heading at its angle from the
	// spell's wind.
	w.Tick()
	f := w.Latest()
	for i, s := range sailors {
		mean := f.Wind[s.slot].MeanFrom
		st := physics.State{X: float64(i%16) * 150, Y: float64(i/16) * 150, Heading: mean - s.angle*math.Pi/180, Surge: 3}
		dev.TrySend(bus.Command{Op: bus.Place, Boat: f.Boat[s.slot], State: st})
	}
	w.Tick()
	// Every boat holds one sheet, set for the regime's mean wind: steering
	// alone differs.
	speeds := cat.Weather.Regimes[regime].Wind.Speed
	breeze := (speeds[0] + speeds[1]) / 2 * 1852 / 3600
	ticks := minutes * 60 * physics.StepsPerSecond
	settle := 60 * physics.StepsPerSecond
	for k := range ticks {
		f := w.Latest()
		seq := uint32(f.Tick + 1)
		for i := range sailors {
			s := &sailors[i]
			st := &f.State[s.slot]
			mean := f.Wind[s.slot].MeanFrom
			target := mean - s.angle*math.Pi/180
			off := math.Remainder(target-st.Heading, 2*math.Pi)
			sheet := SheetIndex(s.angle, breeze)
			if k >= settle && st.SailorMode == physics.Sailing {
				s.err2 += off * off
				s.speed += math.Sqrt(st.Surge*st.Surge + st.Sway*st.Sway)
				s.count++
			}
			if st.SailorMode != physics.Sailing && s.mode == physics.Sailing {
				s.capsiz++
			}
			s.mode = st.SailorMode
			if k > 0 && s.config == 0 {
				continue
			}
			if s.config == 0 {
				w.Bus().Controls.Store(s.slot, bus.Pack(seq, bus.Steps/2, sheet, s.gen),
					bus.PackPilot(seq, bus.PilotWind, bus.WayHold, 0, Target(s.angle), s.gen))
				continue
			}
			every := int(math.Round(physics.StepsPerSecond / rates[s.config-1]))
			if k%every != 0 {
				continue
			}
			// The autopilot's own law, from what the sailor sees: how far
			// off the bow points, and how fast it turns.
			helm := math.Max(-1, math.Min(1, ap.Gain*off-ap.Damping*st.YawRate))
			w.Bus().Controls.StoreHand(s.slot, bus.Pack(seq, uint16(math.Round((helm+1)/2*bus.Steps)), sheet, s.gen))
		}
		w.Tick()
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d minutes in the %s regime, %d boats a row:\n", minutes, cat.Weather.Regimes[regime].ID, len(angles)*perConfig)
	b.WriteString("steering        off course (RMS °, sailing)   speed (kn)   capsizes an hour\n")
	type result struct{ rms, speed, capsizes float64 }
	results := make([]result, configs)
	for c := range configs {
		var e2, sp float64
		var cnt, caps int
		for _, s := range sailors {
			if s.config == c {
				e2 += s.err2
				sp += s.speed
				cnt += s.count
				caps += s.capsiz
			}
		}
		results[c] = result{rms: math.Sqrt(e2/float64(cnt)) * 180 / math.Pi, speed: sp / float64(cnt) * 3600 / 1852,
			capsizes: float64(caps) / float64(len(angles)*perConfig) * 60 / minutes}
		name := "the autopilot"
		if c > 0 {
			name = fmt.Sprintf("by hand, %g a s", rates[c-1])
		}
		fmt.Fprintf(&b, "%-15s %6.1f                        %5.1f        %5.2f\n", name, results[c].rms, results[c].speed, results[c].capsizes)
	}
	t.Log(b.String())
	// At the machine sailors' limit on orders, two a second, and at five,
	// hand steering holds a course worse than the autopilot.
	for c, rate := range rates {
		if rate <= 5 && results[c+1].rms <= results[0].rms {
			t.Errorf("by hand at %g a second, %.1f° off course; the autopilot %.1f°", rate, results[c+1].rms, results[0].rms)
		}
	}
}
