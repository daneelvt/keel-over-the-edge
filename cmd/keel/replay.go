// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"reflect"
	"runtime"
	"strconv"
	"unicode"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/replay"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

const replayUsage = `usage: keel replay [-dump TICK] [-workers N] [-world FILE] FILE

Replays an input log through the simulation and checks every digest and
snapshot in it. Prints "replayed N ticks: identical", or the first tick at
which the replay differs from the log and exits 1. The world's terrain is
made again from the seed the log names, when this build's generator is the
one that made it, and checked against the log's digest of it.

  -dump TICK   write the world's boats and queue at TICK to stdout as JSON
  -workers N   goroutines stepping boats (default GOMAXPROCS); the result
               never depends on it
  -world FILE  the world's terrain from a bundle keel worldgen -out wrote,
               instead of made again
`

// errDiverged is a replay that differed from its log.
var errDiverged = errors.New("the replay differs from the log")

func replayCmd(args []string, stdout, stderr io.Writer) error {
	fs := flag.NewFlagSet("replay", flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { io.WriteString(stderr, replayUsage) }
	dump := fs.Int64("dump", math.MinInt64, "")
	workers := fs.Int("workers", runtime.GOMAXPROCS(0), "")
	worldFile := fs.String("world", "", "")
	if err := fs.Parse(args); err != nil {
		return errUsage
	}
	if fs.NArg() != 1 || *workers < 1 {
		fs.Usage()
		return errUsage
	}
	data, err := os.ReadFile(fs.Arg(0))
	if err != nil {
		return err
	}
	f, err := replay.Read(data)
	if errors.Is(err, replay.ErrTruncated) {
		fmt.Fprintln(stderr, "keel replay: the log ends partway through a record; replaying what is whole")
	} else if err != nil {
		return err
	}
	h := f.Header
	if b := buildID(); h.Build != b || h.Catalog != catalog.Version || h.Layout != physics.LayoutVersion {
		fmt.Fprintf(stderr, "keel replay: warning: the log was made by build %s, catalog %s, physics layout %#08x; "+
			"this is build %s, catalog %s, layout %#08x, and may replay it differently\n",
			h.Build, h.Catalog, h.Layout, b, catalog.Version, physics.LayoutVersion)
	}
	cat, err := catalog.Load()
	if err != nil {
		return err
	}
	waves, kinds := cat.Prepare()
	timeline, err := weather.FromCatalog(cat)
	if err != nil {
		return err
	}

	terrain, err := replayTerrain(h, cat, *worldFile)
	if err != nil {
		return err
	}

	var dumped bool
	var dumpErr error
	opt := replay.Options{Kinds: kinds, Waves: waves, Weather: timeline, Encounters: cat.PrepareEncounters(), Workers: *workers, Terrain: terrain}
	if *dump != math.MinInt64 {
		opt.At = func(fr *bus.Frame) {
			if fr.Tick == *dump && !dumped {
				dumped = true
				dumpErr = writeDump(stdout, fr)
			}
		}
	}
	res, err := replay.Run(f, opt)
	if err != nil {
		return err
	}
	if dumpErr != nil {
		return dumpErr
	}
	if *dump != math.MinInt64 && !dumped {
		return fmt.Errorf("the replay never reached tick %d: it covers ticks %d to %d", *dump, res.From, res.To)
	}
	out := stdout
	if *dump != math.MinInt64 {
		out = stderr // keep stdout for the JSON
	}
	if res.Diverged != nil {
		fmt.Fprintf(stderr, "replayed %d ticks: differs at %v\n", res.Ticks(), res.Diverged)
		return errDiverged
	}
	fmt.Fprintf(out, "replayed %d ticks: identical\n", res.Ticks())
	return nil
}

// errTerrain is a log whose terrain this build cannot make again.
var errTerrain = errors.New("the log's terrain")

// replayTerrain is the terrain the log's world sailed: none if it sailed
// open sea; the bundle in file if given; or else made again from the log's
// seed, which only the generator that made it can. Either way its digest
// must be the log's.
func replayTerrain(h replay.Header, cat *catalog.Catalog, file string) (*sim.Terrain, error) {
	if h.Terrain == [32]byte{} {
		return nil, nil
	}
	var b *worldgen.Bundle
	switch {
	case file != "":
		data, err := os.ReadFile(file)
		if err != nil {
			return nil, err
		}
		if b, err = worldgen.ReadFile(data); err != nil {
			return nil, err
		}
	case h.Generator != worldgen.Version:
		return nil, fmt.Errorf("%w was made by generator %d, and this build has generator %d: give it with -world", errTerrain, h.Generator, worldgen.Version)
	default:
		var err error
		b, err = worldgen.Generate(h.Seed, cat)
		if err != nil && !errors.Is(err, worldgen.ErrInvalid) {
			return nil, err
		}
	}
	if b.Digest != h.Terrain {
		return nil, fmt.Errorf("%w: its digest is %x, the terrain's %s", errTerrain, h.Terrain, b.DigestHex())
	}
	return b.Terrain(cat.PrepareGround()), nil
}

// exact is a float that JSON shows exactly: the shortest decimal that reads
// back as the same bits, or a string for NaN and the infinities.
type exact float64

func (x exact) MarshalJSON() ([]byte, error) {
	f := float64(x)
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return json.Marshal(strconv.FormatFloat(f, 'g', -1, 64))
	}
	return strconv.AppendFloat(nil, f, 'g', -1, 64), nil
}

type dumpedControl struct {
	Word  string      `json:"word"`
	Seq   uint32      `json:"seq"`
	Helm  exact       `json:"helm"`
	Sheet exact       `json:"sheet"`
	Pilot dumpedPilot `json:"pilot"`
}

// dumpedPilot is the pilot word in force.
type dumpedPilot struct {
	Word   string `json:"word"`
	Mode   uint8  `json:"mode"`
	Way    uint8  `json:"way"`
	Order  uint8  `json:"order"`
	Target uint16 `json:"target"`
}

type dumpedBoat struct {
	Slot       int32            `json:"slot"`
	Boat       uint64           `json:"boat"`
	Generation uint16           `json:"generation"`
	Owner      string           `json:"owner"`
	Connection uint64           `json:"connection"`
	Grace      int64            `json:"grace"`
	Kind       uint16           `json:"kind"`
	Control    dumpedControl    `json:"control"`
	State      map[string]exact `json:"state"`
}

type dumpedWaiting struct {
	Account    string `json:"account"`
	Connection uint64 `json:"connection"`
	Since      int64  `json:"since"`
	Grace      int64  `json:"grace"`
}

// dumpedWeather is a developer's weather.
type dumpedWeather struct {
	From   int64  `json:"from"`
	Mode   uint8  `json:"mode"`
	Regime uint16 `json:"regime"`
	Speed  uint32 `json:"speed"`
	Dir    uint32 `json:"dir"`
}

type dumpedWorld struct {
	Tick     int64           `json:"tick"`
	Weathers []dumpedWeather `json:"weathers"`
	Held     bool            `json:"held"`
	Boats    []dumpedBoat    `json:"boats"`
	Queue    []dumpedWaiting `json:"queue"`
}

// writeDump writes a frame's boats and queue as JSON, for comparing two
// runs field by field.
func writeDump(w io.Writer, f *bus.Frame) error {
	names := stateNames()
	d := dumpedWorld{
		Tick:     f.Tick,
		Weathers: []dumpedWeather{},
		Held:     f.Held,
		Boats:    []dumpedBoat{},
		Queue:    []dumpedWaiting{},
	}
	for _, w := range f.Weathers {
		d.Weathers = append(d.Weathers, dumpedWeather{From: w.From, Mode: uint8(w.Mode), Regime: w.Regime, Speed: w.Speed, Dir: w.Dir})
	}
	for _, q := range f.Queue {
		d.Queue = append(d.Queue, dumpedWaiting{Account: q.Account.String(), Connection: q.Conn, Since: q.Since, Grace: q.Grace})
	}
	for _, s := range f.Live {
		c, p := f.Control[s], f.Pilot[s]
		b := dumpedBoat{
			Slot: s, Boat: f.Boat[s], Generation: f.Gen[s], Owner: f.Owner[s].String(),
			Connection: f.Conn[s], Grace: f.Grace[s], Kind: f.Kind[s],
			Control: dumpedControl{Word: fmt.Sprintf("%#016x", uint64(c)), Seq: c.Seq(), Helm: exact(c.Helm()), Sheet: exact(c.Sheet()),
				Pilot: dumpedPilot{Word: fmt.Sprintf("%#016x", uint64(p)), Mode: p.Mode(), Way: p.Way(), Order: p.Order(), Target: p.Target()}},
			State: map[string]exact{},
		}
		for i, v := range sim.StateFields(&f.State[s]) {
			b.State[names[i]] = exact(*v)
		}
		d.Boats = append(d.Boats, b)
	}
	enc := json.NewEncoder(w)
	enc.SetIndent("", " ")
	return enc.Encode(d)
}

// stateNames are State's fields as the client names them.
func stateNames() []string {
	t := reflect.TypeFor[physics.State]()
	names := make([]string, t.NumField())
	for i := range names {
		n := t.Field(i).Name
		r, size := utf8.DecodeRuneInString(n)
		names[i] = string(unicode.ToLower(r)) + n[size:]
	}
	return names
}
