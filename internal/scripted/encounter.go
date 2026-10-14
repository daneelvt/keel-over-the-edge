// SPDX-License-Identifier: AGPL-3.0-only

package scripted

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"slices"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// Encounters a developer stages: a scripted boat placed to meet the first
// sailing player's boat in one of the situations the Articles are tested
// with, held on its course and trim, so that one person on a phone can feel
// each Article without a second player. The boat sails as any other, in
// the world's wind; the player is assumed to hold their course for the
// seconds it takes. After HoldFor it leaves.

// The situations, by name, and the Article each ends in.
var Situations = map[string]string{
	"port-starboard":   "10", // crossing on opposite tacks: port keeps clear
	"windward-leeward": "11", // overlapped to windward, sliding down onto the player
	"overtaking":       "12", // clear astern, sailing into the player's transom
	"tacking":          "13", // tacking onto the player's bow, hit while still tacking
	"luffing":          "15", // overlapping to leeward from astern and luffing at once
	"capsized":         "22", // capsized in the player's path
}

// SituationNames are the situations' names, sorted.
func SituationNames() []string {
	names := make([]string, 0, len(Situations))
	for n := range Situations {
		names = append(names, n)
	}
	slices.Sort(names)
	return names
}

// EncounterAccount is the staged boat's account: one past the scripted
// sailors' numbers any server runs.
var EncounterAccount = Account(1 << 40)

// HoldFor is how long the staged boat sails before it leaves.
const HoldFor = 30 * time.Second

// ErrNoPlayer is a world with no sailing player's boat to meet.
var ErrNoPlayer = errors.New("scripted: no player's boat is sailing")

// EncounterConfig sets up a staged encounter.
type EncounterConfig struct {
	Bus     *bus.Bus
	Weather *physics.WeatherPrepared // the world's wind's constants, to know the wind at the player
	Length  float64                  // the boats' length overall, m
	Log     *slog.Logger
}

// Staged is where a staged boat was put, and why.
type Staged struct {
	Situation string  `json:"situation"`
	Article   string  `json:"article"`
	Boat      uint64  `json:"boat"`
	Player    uint64  `json:"player"`
	East      float64 `json:"east"`
	North     float64 `json:"north"`
	Heading   float64 `json:"heading"` // degrees
}

// plan is a staged boat's start and how it is sailed.
type plan struct {
	state physics.State
	sheet float64
	// steer gives the helm at t seconds after the start, from the boat's
	// state; nil holds it amidships.
	steer func(t float64, s *physics.State) float64
}

// Encounter stages situation against the first sailing player's boat, and
// sails the staged boat until HoldFor has passed or ctx ends, on a
// goroutine of its own.
func Encounter(ctx context.Context, cfg EncounterConfig, situation string) (Staged, error) {
	article, ok := Situations[situation]
	if !ok {
		return Staged{}, fmt.Errorf("scripted: no situation %q", situation)
	}
	f := cfg.Bus.Frames.Acquire()
	player := int32(-1)
	for _, s := range f.Live {
		if f.Conn[s] != 0 && f.Grace[s] == 0 && f.State[s].SailorMode == physics.Sailing && !scriptedAccount(f.Owner[s]) {
			player = s
			break
		}
	}
	if player < 0 {
		f.Release()
		return Staged{}, ErrNoPlayer
	}
	h := f.State[player]
	playerBoat := f.Boat[player]
	w := physics.Weather{Prepared: cfg.Weather}
	w.Set(f.SpellsInPlay())
	var wt physics.WeatherTick
	physics.WeatherAt(&w, &wt, float64(f.Tick))
	f.Release()
	wind := physics.WindAt(&wt, h.X, h.Y)

	p := stage(situation, &h, wind.WindFrom, cfg.Length)
	slot, gen, boat, err := joinStaged(ctx, cfg.Bus)
	if err != nil {
		return Staged{}, err
	}
	dev := cfg.Bus.Commands.Developer()
	if err := dev.TrySend(bus.Command{Op: bus.Place, Boat: boat, State: p.state}); err != nil {
		return Staged{}, err
	}
	cfg.Log.Info("an encounter staged", "situation", situation, "boat", boat, "player", playerBoat)
	go sailStaged(ctx, cfg.Bus, slot, gen, boat, p)
	return Staged{
		Situation: situation, Article: article, Boat: boat, Player: playerBoat,
		East: p.state.X, North: p.state.Y, Heading: p.state.Heading * 180 / math.Pi,
	}, nil
}

// scriptedAccount reports whether a is a scripted sailor's.
func scriptedAccount(a bus.Account) bool {
	return a[0] == 0xff && a[1] == 0xff && a[2] == 0xff && a[3] == 0xff && a[6] == 0x7f && a[8] == 0xbf
}

// joinStaged gives the staged boat's account its boat, a new one or the one
// it has.
func joinStaged(ctx context.Context, b *bus.Bus) (slot int32, gen uint16, boat uint64, err error) {
	reply := make(chan bus.Reply, 1)
	if err := b.Commands.Developer().TrySend(bus.Command{Op: bus.Join, Account: EncounterAccount, Reply: reply}); err != nil {
		return 0, 0, 0, err
	}
	select {
	case <-ctx.Done():
		return 0, 0, 0, ctx.Err()
	case r := <-reply:
		if r.Result != bus.Joined && r.Result != bus.Rejoined {
			return 0, 0, 0, fmt.Errorf("scripted: the staged boat found no boat: %s", r.Result)
		}
		return r.Slot, r.Gen, r.Boat, nil
	}
}

// sailStaged holds the staged boat's controls, a tick at a time, then
// takes it out of the world.
func sailStaged(ctx context.Context, b *bus.Bus, slot int32, gen uint16, boat uint64, p plan) {
	defer b.Commands.Developer().TrySend(bus.Command{Op: bus.Leave, Boat: boat})
	start := time.Now()
	tick := time.NewTicker(time.Second / physics.StepsPerSecond)
	defer tick.Stop()
	sheet := uint16(math.Round(p.sheet * bus.Steps))
	for time.Since(start) < HoldFor {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		f := b.Frames.Acquire()
		if !f.Occupied[slot] || f.Boat[slot] != boat {
			f.Release()
			return
		}
		s := f.State[slot]
		seq := uint32(f.Tick + 1)
		f.Release()
		helm := 0.0
		if p.steer != nil {
			helm = p.steer(time.Since(start).Seconds(), &s)
		}
		b.Controls.Store(slot, bus.Pack(seq, uint16(math.Round((helm+1)*bus.Steps/2)), sheet, gen))
	}
}

// hold is a heading-hold: the helm toward target, damped by the yaw rate.
func hold(target float64, s *physics.State) float64 {
	off := math.Remainder(target-s.Heading, 2*math.Pi)
	return max(-1, min(1, 2*off-0.8*s.YawRate))
}

// The directions about a boat heading h: ahead, and to starboard.
func ahead(h float64) (x, y float64)     { return math.Sin(h), math.Cos(h) }
func starboard(h float64) (x, y float64) { return math.Cos(h), -math.Sin(h) }

// stage plans situation against the player's boat h in the true wind from
// windFrom, for boats length long.
func stage(situation string, h *physics.State, windFrom, length float64) plan {
	// The player's tack: the side the wind comes over, starboard positive.
	tack := 1.0
	if math.Remainder(windFrom-h.Heading, 2*math.Pi) < 0 {
		tack = -1
	}
	closeHauled := func(t float64) float64 { return windFrom - t*45*math.Pi/180 }
	speed := max(h.Surge, 1)
	fx, fy := ahead(h.Heading)
	sx, sy := starboard(h.Heading)
	at := func(along, across float64) (x, y float64) {
		return h.X + along*fx + across*sx, h.Y + along*fy + across*sy
	}
	deg := math.Pi / 180
	switch situation {
	case "port-starboard":
		// On the other tack, close-hauled, its bow meeting the player's
		// side amidships in six seconds.
		heading := closeHauled(-tack)
		const t, v = 6.0, 2.2
		mx, my := at(speed*t, 0)
		ex, ey := ahead(heading)
		back := v*t + 1
		return plan{
			state: physics.State{X: mx - back*ex, Y: my - back*ey, Heading: heading, Surge: v, SheetLimit: 0.1},
			sheet: 0.08,
			steer: func(_ float64, s *physics.State) float64 { return hold(heading, s) },
		}
	case "windward-leeward":
		// Overlapped two metres to windward, a metre back, bearing away
		// onto the player: soon, for the player slows in its dirty air.
		x, y := at(-1, 2.1*tack)
		heading := h.Heading - tack*10*deg
		return plan{
			state: physics.State{X: x, Y: y, Heading: heading, Surge: speed, SheetLimit: h.SheetLimit, Boom: h.Boom},
			sheet: 0.5,
			steer: func(_ float64, s *physics.State) float64 { return hold(heading, s) },
		}
	case "overtaking":
		// Clear astern, its bow a foot from the transom and a metre and a
		// half a second faster: straight into it.
		x, y := at(-(length + 0.3), 0)
		return plan{
			state: physics.State{X: x, Y: y, Heading: h.Heading, Surge: speed + 1.5, SheetLimit: h.SheetLimit, Boom: h.Boom},
			sheet: 0.5,
			steer: func(_ float64, s *physics.State) float64 { return hold(h.Heading, s) },
		}
	case "tacking":
		// On the other tack in the player's path, turning through head to
		// wind onto theirs, its sheet let fly: left short of close-hauled,
		// lying where the player sails into it.
		heading := windFrom + tack*5*deg
		x, y := at(speed*2.5+length, 0)
		after := windFrom - tack*25*deg
		return plan{
			state: physics.State{X: x, Y: y, Heading: heading, Surge: 0.3, YawRate: -tack * 0.5, SheetLimit: 1.5},
			sheet: 1,
			steer: func(t float64, s *physics.State) float64 {
				if t < 1.2 {
					// Up through the wind: toward the side it comes over.
					return -tack
				}
				return hold(after, s)
			},
		}
	case "luffing":
		// Clear astern to leeward, faster: it overlaps the player to
		// leeward, then luffs at once.
		x, y := at(-(length + 0.3), -1.7*tack)
		up := h.Heading + tack*25*deg
		return plan{
			state: physics.State{X: x, Y: y, Heading: h.Heading, Surge: speed + 1.2, SheetLimit: h.SheetLimit, Boom: h.Boom},
			sheet: 0.5,
			steer: func(t float64, s *physics.State) float64 {
				if t < 0.6 {
					return hold(h.Heading, s)
				}
				return hold(up, s)
			},
		}
	default: // capsized
		// Capsized and its sailor swimming, in the player's path.
		x, y := at(speed*4+length, 0)
		return plan{
			state: physics.State{X: x, Y: y, Heading: h.Heading + math.Pi/2, Heel: tack * 100 * deg,
				SailorMode: physics.InWater, SailorTimer: 20, SheetLimit: 1.6},
			sheet: 1,
		}
	}
}
