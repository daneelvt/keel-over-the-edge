// SPDX-License-Identifier: AGPL-3.0-only

package protocol

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"reflect"
	"slices"
	"strconv"
	"testing"
	"unicode"
	"unicode/utf8"

	"google.golang.org/protobuf/proto"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
)

var update = flag.Bool("update", false, "write the golden vectors in shared/protocol/testdata again")

const (
	snapshotsFile = "../../shared/protocol/testdata/snapshots.json"
	messagesFile  = "../../shared/protocol/testdata/messages.json"
)

// The golden snapshots: a chain of them, each a header with every field as
// the client names it (floats as the hexadecimal of their bits), its bytes,
// and the view its entries make of its base's, which is the view of the
// vector Base ticks before it, or none; and what the entries did.
type goldenSnapshot struct {
	Name    string            `json:"name"`
	Tick    string            `json:"tick"` // a string: JavaScript's numbers hold 53 bits
	Base    uint16            `json:"base"`
	Flags   uint8             `json:"flags"`
	Seq     uint32            `json:"seq"`
	Margin  int16             `json:"margin"`
	Helm    uint16            `json:"helm"`
	Sheet   uint16            `json:"sheet"`
	Wind    [2]string         `json:"wind"`
	State   map[string]string `json:"state"`
	Bytes   string            `json:"bytes"`
	View    []goldenBoat      `json:"view"`
	Entered []int             `json:"entered"`
	Updated []int             `json:"updated"`
	Left    []int             `json:"left"`
	Sampled []int             `json:"sampled"`
}

// goldenBoat is a boat in a golden view.
type goldenBoat struct {
	Slot    int    `json:"slot"`
	Kind    uint16 `json:"kind"`
	Flags   uint8  `json:"flags"`
	X       int32  `json:"x"`
	Y       int32  `json:"y"`
	Heading uint16 `json:"heading"`
	Heel    int16  `json:"heel"`
	Boom    int16  `json:"boom"`
	Rudder  int16  `json:"rudder"`
	Sailor  int8   `json:"sailor"`
	Sail    uint8  `json:"sail"`
}

func f64bits(v float64) string { return fmt.Sprintf("%#016x", math.Float64bits(v)) }

func fromBits(t *testing.T, s string) float64 {
	t.Helper()
	u, err := strconv.ParseUint(s, 0, 64)
	if err != nil {
		t.Fatal(err)
	}
	return math.Float64frombits(u)
}

func stateNames() []string {
	t := reflect.TypeFor[physics.State]()
	names := make([]string, t.NumField())
	for i := range names {
		r, n := utf8.DecodeRuneInString(t.Field(i).Name)
		names[i] = string(unicode.ToLower(r)) + t.Field(i).Name[n:]
	}
	return names
}

// golden is one vector to make: its header, the view after it, which of
// its boats enter rather than change, and which its entries sample.
type golden struct {
	name   string
	header Snapshot
	view   View
	enter  uint64
	sample uint64
}

func boat(kind uint16, far bool, mode uint8, x, y int32, heading uint16, heel, boom, rudder int16, sailor int8, sail uint8) Boat {
	q := Boat{Kind: kind, Flags: mode << modeShift, X: x, Y: y, Heading: heading, Heel: heel, Boom: boom, Rudder: rudder, Sailor: sailor, Sail: sail}
	if far {
		q.Flags |= FarBand
	}
	return q
}

// goldens is the chain: a full snapshot of every kind of boat; a delta two
// ticks on with every kind of update, a leave, an enter and an enter that
// replaces; a delta against the first, four ticks back; one that samples
// the far band and changes nothing; one six ticks back; and a lone full
// snapshot of awkward header values.
func goldens() []golden {
	var sailing physics.State
	for i, v := range sim.StateFields(&sailing) {
		*v = float64(i+1)*1.25 - 7.5
	}
	sailing.X, sailing.Y, sailing.Heading = 1234.5678901234, -98765.4321, 1.5707963267948966
	var awkward physics.State
	for i, v := range sim.StateFields(&awkward) {
		switch i % 4 {
		case 0:
			*v = math.Copysign(0, -1)
		case 1:
			*v = math.SmallestNonzeroFloat64
		case 2:
			*v = -math.MaxFloat64
		default:
			*v = math.Nextafter(1, 2)
		}
	}
	header := func(tick int64, base uint16, flags uint8, st physics.State) Snapshot {
		return Snapshot{Tick: tick, Base: base, Flags: flags, Seq: uint32(tick + 3), Margin: int16(tick%7) - 2,
			Helm: uint16(tick % 1025), Sheet: 1024 - uint16(tick%1025), Wind: bus.Wind{Speed: 7.25, From: 4.1}, State: st}
	}

	var v1 View
	v1.Put(0, &Boat{})
	v1.Put(1, ptr(boat(0, false, physics.Sailing, 1234, -5678, 16384, 1200, -6000, 3000, 95, 0x5f)))
	v1.Put(2, ptr(boat(300, true, physics.InWater, PositionLimit, -PositionLimit-1, 65535, math.MinInt16, math.MaxInt16, math.MinInt16, -128, 0xff)))
	v1.Put(5, ptr(boat(1, true, physics.OnBoard, -700_00, 400_00, 32768, math.MaxInt16, 0, 1, -1, 0x31)))
	v1.Put(63, ptr(boat(65535, false, physics.Climbing, 1, -1, 1, -1, 1, -1, 1, 0x80)))

	v2 := v1
	v2.Boats[0] = boat(0, false, 0, 13, -7, 0, 0, 0, 0, 0, 0)                                                     // position only
	v2.Boats[1] = boat(0, true, physics.Sailing, 1234+8000000, -5678-8000000, 16000, 1300, -6100, 3100, 94, 0x6f) // every field, positions far
	v2.Remove(63)
	v2.Put(2, ptr(boat(2, false, physics.Sailing, 5, 6, 7, 8, 9, 10, 11, 12)))  // replaces
	v2.Put(40, ptr(boat(0, false, physics.Sailing, -9, -9, 9, 9, -9, 9, 9, 9))) // enters
	// Slot 5 is far, and not sampled: unchanged.

	v3 := v1
	v3.Boats[5].X += 20000
	v3.Boats[5].Flags &^= FarBand // comes near
	v3.Remove(0)

	v4 := v3
	v5 := v2
	v5.Boats[1].Heading++

	return []golden{
		{"full", header(1000, 0, 0, physics.State{Y: -20, Heading: math.Pi / 2}), v1, v1.Used, 0},
		{"delta of every kind", header(1002, 2, 0, sailing), v2, 1<<2 | 1<<40, v2.Used &^ (1 << 5)},
		{"delta four ticks back", header(1004, 4, 0, sailing), v3, 0, v3.Used},
		{"far sampled, nothing changed", header(1006, 2, FarSampled, sailing), v4, 0, v4.Used},
		{"delta six ticks back", header(1008, 6, 0, sailing), v5, 0, v5.Used},
		{"awkward header", Snapshot{Tick: 1<<53 + 2, Seq: math.MaxUint32, Margin: NoMargin, Helm: 0, Sheet: 1024,
			Wind: bus.Wind{Speed: 0, From: 2 * math.Pi}, State: awkward}, View{}, 0, 0},
		{"negative tick", Snapshot{Tick: -30, Seq: 0xffffffe3, Margin: math.MaxInt16, Helm: 1024, Sheet: 1,
			Wind: bus.Wind{Speed: 25, From: -0.5}, State: sailing}, View{}, 0, 0},
	}
}

func ptr[T any](v T) *T { return &v }

func slotsOf(m uint64) []int {
	out := []int{}
	for slot := range ViewSlots {
		if m&(1<<slot) != 0 {
			out = append(out, slot)
		}
	}
	return out
}

func viewOf(v *View) []goldenBoat {
	out := []goldenBoat{}
	for _, slot := range slotsOf(v.Used) {
		q := v.Boats[slot]
		out = append(out, goldenBoat{Slot: slot, Kind: q.Kind, Flags: q.Flags, X: q.X, Y: q.Y, Heading: q.Heading,
			Heel: q.Heel, Boom: q.Boom, Rudder: q.Rudder, Sailor: q.Sailor, Sail: q.Sail})
	}
	return out
}

// encodeGolden writes a vector's bytes against the views before it, by
// tick.
func encodeGolden(g *golden, views map[int64]*View) []byte {
	base := &View{}
	if g.header.Base != 0 {
		base = views[g.header.Tick-int64(g.header.Base)]
	}
	b := make([]byte, HeaderSize, MaxSnapshotSize)
	b, n := AppendEntries(b, base, &g.view, g.enter, g.sample)
	h := g.header
	h.Entries = n
	h.Put(b)
	return b
}

func TestSnapshotGolden(t *testing.T) {
	cases := goldens()
	views := map[int64]*View{}
	if *update {
		var out []goldenSnapshot
		for i := range cases {
			g := &cases[i]
			b := encodeGolden(g, views)
			views[g.header.Tick] = &g.view
			h := g.header
			gs := goldenSnapshot{Name: g.name, Tick: strconv.FormatInt(h.Tick, 10), Base: h.Base, Flags: h.Flags, Seq: h.Seq,
				Margin: h.Margin, Helm: h.Helm, Sheet: h.Sheet, Wind: [2]string{f64bits(h.Wind.Speed), f64bits(h.Wind.From)},
				State: map[string]string{}, Bytes: hex.EncodeToString(b), View: viewOf(&g.view)}
			names := stateNames()
			for i, v := range sim.StateFields(&h.State) {
				gs.State[names[i]] = f64bits(*v)
			}
			// What the bytes did, read back.
			var sn Snapshot
			var ch Changes
			base := View{}
			if h.Base != 0 {
				base = *views[h.Tick-int64(h.Base)]
			}
			if err := ReadSnapshot(b, &sn); err != nil {
				t.Fatal(err)
			}
			if err := base.ApplyEntries(b[HeaderSize:], sn.Entries, &ch); err != nil {
				t.Fatal(err)
			}
			gs.Entered, gs.Updated, gs.Left = slotsOf(ch.Entered), slotsOf(ch.Updated), slotsOf(ch.Left)
			gs.Sampled = slotsOf(base.Sampled(h.Flags, &ch))
			out = append(out, gs)
		}
		writeJSON(t, snapshotsFile, out)
		clear(views)
	}
	var golden []goldenSnapshot
	readJSON(t, snapshotsFile, &golden)
	if len(golden) != len(cases) {
		t.Fatalf("%d golden snapshots, %d cases", len(golden), len(cases))
	}
	decoded := map[int64]View{}
	for i, g := range golden {
		c := &cases[i]
		want, err := hex.DecodeString(g.Bytes)
		if err != nil {
			t.Fatal(err)
		}
		if b := encodeGolden(c, views); !bytes.Equal(b, want) {
			t.Errorf("%s: written\n%x\nwant\n%s", g.Name, b, g.Bytes)
		}
		views[c.header.Tick] = &c.view
		var got Snapshot
		if err := ReadSnapshot(want, &got); err != nil {
			t.Fatalf("%s: %v", g.Name, err)
		}
		if tick, _ := strconv.ParseInt(g.Tick, 10, 64); got.Tick != tick || got.Base != g.Base || got.Flags != g.Flags ||
			got.Seq != g.Seq || got.Margin != g.Margin || got.Helm != g.Helm || got.Sheet != g.Sheet ||
			f64bits(got.Wind.Speed) != g.Wind[0] || f64bits(got.Wind.From) != g.Wind[1] {
			t.Errorf("%s: read %+v", g.Name, got)
		}
		names := stateNames()
		for i, v := range sim.StateFields(&got.State) {
			if f64bits(*v) != g.State[names[i]] || math.Float64bits(*v) != math.Float64bits(fromBits(t, g.State[names[i]])) {
				t.Errorf("%s: %s read as %s, golden %s", g.Name, names[i], f64bits(*v), g.State[names[i]])
			}
		}
		var v View
		if got.Base != 0 {
			base, ok := decoded[got.Tick-int64(got.Base)]
			if !ok {
				t.Fatalf("%s: no base", g.Name)
			}
			v = base
		}
		var ch Changes
		if err := v.ApplyEntries(want[HeaderSize:], got.Entries, &ch); err != nil {
			t.Fatalf("%s: %v", g.Name, err)
		}
		if !reflect.DeepEqual(viewOf(&v), g.View) || v != c.view {
			t.Errorf("%s: decoded view\n%+v\nwant\n%+v", g.Name, viewOf(&v), g.View)
		}
		if !slices.Equal(slotsOf(ch.Entered), g.Entered) || !slices.Equal(slotsOf(ch.Updated), g.Updated) ||
			!slices.Equal(slotsOf(ch.Left), g.Left) || !slices.Equal(slotsOf(v.Sampled(got.Flags, &ch)), g.Sampled) {
			t.Errorf("%s: entered %v, updated %v, left %v", g.Name, slotsOf(ch.Entered), slotsOf(ch.Updated), slotsOf(ch.Left))
		}
		decoded[got.Tick] = v
	}
}

// TestDeltaAgainstEveryBase: a view sent against any of the last four views
// decodes to the view a full snapshot gives.
func TestDeltaAgainstEveryBase(t *testing.T) {
	rng := rand.New(rand.NewPCG(4, 4))
	var history []View
	var v View
	for step := range 200 {
		next := v
		for slot := range ViewSlots {
			switch r := rng.IntN(40); {
			case r == 0 && next.Has(slot):
				next.Remove(slot)
			case r == 1:
				next.Put(slot, ptr(randomBoat(rng)))
			case r < 30 && next.Has(slot):
				q := &next.Boats[slot]
				q.X += int32(rng.IntN(201) - 100)
				q.Heading += uint16(rng.IntN(50))
				q.Heel = int16(rng.IntN(65536))
			}
		}
		full := make([]byte, HeaderSize, MaxSnapshotSize)
		full, n := AppendEntries(full, &View{}, &next, next.Used, 0)
		var fromFull View
		var ch Changes
		if err := fromFull.ApplyEntries(full[HeaderSize:], n, &ch); err != nil || fromFull != next {
			t.Fatalf("step %d: a full snapshot decodes to another view (%v)", step, err)
		}
		for back := 1; back <= min(4, len(history)); back++ {
			base := history[len(history)-back]
			b := make([]byte, HeaderSize, MaxSnapshotSize)
			// The boats a base does not hold, or holds as another, enter.
			var enter uint64
			for slot := range ViewSlots {
				if next.Has(slot) && (!base.Has(slot) || base.Boats[slot].Kind != next.Boats[slot].Kind) {
					enter |= 1 << slot
				}
			}
			b, n := AppendEntries(b, &base, &next, enter, ^uint64(0))
			if len(b) > MaxSnapshotSize {
				t.Fatalf("a snapshot of %d bytes", len(b))
			}
			got := base
			if err := got.ApplyEntries(b[HeaderSize:], n, &ch); err != nil || got != next {
				t.Fatalf("step %d, %d back: decoded to another view (%v)", step, back, err)
			}
		}
		history = append(history, next)
		v = next
	}
}

func randomBoat(rng *rand.Rand) Boat {
	return Boat{Kind: uint16(rng.IntN(3)), Flags: uint8(rng.IntN(8)), X: int32(rng.IntN(1<<24) - 1<<23), Y: int32(rng.IntN(1<<24) - 1<<23),
		Heading: uint16(rng.Uint32()), Heel: int16(rng.Uint32()), Boom: int16(rng.Uint32()), Rudder: int16(rng.Uint32()),
		Sailor: int8(rng.Uint32()), Sail: uint8(rng.Uint32())}
}

// TestQuantise: each field to its step, at its limits.
func TestQuantise(t *testing.T) {
	var q Boat
	st := physics.State{X: 12.345, Y: -0.004, Heading: math.Pi, Heel: -math.Pi / 2, Boom: 1.3, Rudder: -0.6, Sailor: 0.955, SailorMode: physics.OnBoard}
	Quantise(&st, 3, 0x5a, true, &q)
	want := Boat{Kind: 3, Flags: FarBand | physics.OnBoard<<modeShift, X: 1235, Y: 0, Heading: 32768, Heel: -16384,
		Boom: int16(math.Round(1.3 / AngleStep)), Rudder: int16(math.Round(-0.6 / AngleStep)), Sailor: 96, Sail: 0x5a}
	if q != want {
		t.Fatalf("quantised %+v, want %+v", q, want)
	}
	for _, tc := range []struct {
		st   physics.State
		want Boat
	}{
		{physics.State{X: 1e9, Y: -1e9}, Boat{X: PositionLimit, Y: -PositionLimit - 1}},
		{physics.State{X: math.NaN(), Heading: math.NaN(), Sailor: 9}, Boat{Sailor: math.MaxInt8}},
		{physics.State{Heading: -math.Pi, Heel: math.Pi, Boom: 3 * math.Pi, Sailor: -9}, Boat{Heading: 32768, Heel: math.MinInt16, Boom: math.MinInt16, Sailor: math.MinInt8}},
		{physics.State{Heading: 2*math.Pi - 1e-9, Heel: math.Pi - AngleStep/4, Rudder: -math.Pi + AngleStep/4}, Boat{Heading: 0, Heel: math.MinInt16, Rudder: math.MinInt16}},
		{physics.State{Heading: -AngleStep * 0.6, SailorMode: 7}, Boat{Heading: 65535, Flags: 3 << modeShift}},
	} {
		var q Boat
		Quantise(&tc.st, 0, 0, false, &q)
		if q != tc.want {
			t.Errorf("%+v quantised to %+v, want %+v", tc.st, q, tc.want)
		}
	}
}

// TestAnglesMoveEverySnapshot: a heel or boom turning as slowly as a
// degree a second, and a rudder at a third of that, change in every
// snapshot, 15 a second, so a boat drawn between two snapshots moves
// smoothly. Coarser steps hold an angle still for a few snapshots and then
// move it all at once, and the boat is drawn stopping and starting.
func TestAnglesMoveEverySnapshot(t *testing.T) {
	const rate, interval = math.Pi / 180, 1.0 / 15
	var prev Boat
	for i := range 200 {
		a := -1.5 + rate*interval*float64(i)
		st := physics.State{Heel: a, Boom: -a, Rudder: a / 3}
		var q Boat
		Quantise(&st, 0, 0, false, &q)
		if i > 0 && (q.Heel == prev.Heel || q.Boom == prev.Boom || q.Rudder == prev.Rudder) {
			t.Fatalf("snapshot %d: heel %d, boom %d, rudder %d; before it %d, %d, %d",
				i, q.Heel, q.Boom, q.Rudder, prev.Heel, prev.Boom, prev.Rudder)
		}
		prev = q
	}
}

func TestSnapshotRefusals(t *testing.T) {
	g := goldens()[1]
	var base View = goldens()[0].view
	good := encodeGolden(&g, map[int64]*View{1000: &base})
	var sn Snapshot
	if err := ReadSnapshot(good, &sn); err != nil {
		t.Fatal(err)
	}
	for name, b := range map[string][]byte{
		"empty":           nil,
		"kind 1":          append([]byte{KindMessage}, good[1:]...),
		"kind only":       good[:1],
		"header cut":      good[:HeaderSize-1],
		"layout 2":        withByte(good, offLayout, 2),
		"helm over 1024":  withUint16(good, offHelm, 1025),
		"spare flags":     withByte(good, offFlags, 2),
		"129 entries":     withByte(good, offEntries, 129),
		"layout 4":        withByte(good, offLayout, 4),
		"sheet over 1024": withUint16(good, offSheet, 2000),
	} {
		if err := ReadSnapshot(b, &sn); err == nil {
			t.Errorf("%s: read", name)
		}
	}
	// Entries refused against the base, each alone after a good header.
	header := good[:HeaderSize]
	for name, entries := range map[string][]byte{
		"op 3":                  {3<<6 | 1},
		"truncated enter":       {OpEnter<<6 | 1, 0, 0, 1, 2},
		"truncated update":      {OpUpdate<<6 | 1, ChangeHeading, 1},
		"update of nothing":     {OpUpdate<<6 | 1, 0},
		"update of empty slot":  {OpUpdate<<6 | 3, ChangeHeel, 1, 0},
		"leave of empty slot":   {OpLeave<<6 | 3},
		"spare boat flags":      {OpUpdate<<6 | 1, ChangeFlags, 8},
		"overlong varint":       {OpUpdate<<6 | 1, ChangePosition, 0x80, 0x00, 0},
		"kind above 65535":      {OpEnter<<6 | 1, 0x80, 0x80, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0},
		"beyond 24 bits":        {OpUpdate<<6 | 2, ChangePosition, 2, 0},
		"bytes after the last":  {OpLeave<<6 | 1, 0},
		"varint past its bytes": {OpUpdate<<6 | 1, ChangePosition, 0xff},
	} {
		b := append(slices.Clone(header), entries...)
		SetEntries(b, 1)
		v := base
		var ch Changes
		if err := ReadSnapshot(b, &sn); err != nil {
			t.Fatalf("%s: the header: %v", name, err)
		}
		if err := v.ApplyEntries(b[HeaderSize:], sn.Entries, &ch); err == nil {
			t.Errorf("%s: applied", name)
		}
	}
	// A snapshot whose entries number more than it holds.
	b := slices.Clone(good)
	SetEntries(b, sn.Entries+1)
	v := base
	var ch Changes
	if err := v.ApplyEntries(b[HeaderSize:], sn.Entries+1, &ch); err == nil {
		t.Error("an entry past the end was read")
	}
}

func withByte(b []byte, at int, v byte) []byte {
	c := slices.Clone(b)
	c[at] = v
	return c
}

func withUint16(b []byte, at int, v uint16) []byte {
	c := slices.Clone(b)
	c[at], c[at+1] = byte(v), byte(v>>8)
	return c
}

func TestEncodingAllocatesNothing(t *testing.T) {
	cases := goldens()
	b := make([]byte, 0, MaxSnapshotSize)
	s := cases[1].header
	word := bus.Pack(s.Seq, s.Helm, s.Sheet, 3)
	if n := testing.AllocsPerRun(100, func() {
		b = b[:HeaderSize]
		PutHeader(b, s.Tick, s.Base, s.Flags, word, s.Margin, s.Wind, &s.State)
		b, _ = AppendEntries(b, &cases[0].view, &cases[1].view, cases[1].enter, cases[1].sample)
	}); n != 0 {
		t.Fatalf("%v allocations", n)
	}
}

// FuzzApplyEntries reads what a server might send against any base: it
// never panics, and entries it accepts are written again as the same
// bytes.
func FuzzApplyEntries(f *testing.F) {
	cases := goldens()
	views := map[int64]*View{}
	for i := range cases {
		b := encodeGolden(&cases[i], views)
		views[cases[i].header.Tick] = &cases[i].view
		f.Add(b[HeaderSize:], uint8(b[offEntries]), uint64(cases[0].view.Used), uint64(1))
	}
	f.Add([]byte{OpEnter<<6 | 7, 0x80}, uint8(1), uint64(0), uint64(2))
	f.Fuzz(func(t *testing.T, entries []byte, n uint8, used, seed uint64) {
		var base View
		rng := rand.New(rand.NewPCG(seed, seed))
		for slot := range ViewSlots {
			if used&(1<<slot) != 0 {
				base.Put(slot, ptr(randomBoat(rng)))
				base.Boats[slot].Flags &= flagsUsed
			}
		}
		v := base
		var ch Changes
		if err := v.ApplyEntries(entries, int(n), &ch); err != nil {
			return
		}
		var again []byte
		var e Entry
		rest := entries
		for range n {
			var err error
			if rest, err = ReadEntry(rest, &e); err != nil {
				t.Fatalf("read once, not twice: %v", err)
			}
			again = AppendEntry(again, &e)
		}
		if !bytes.Equal(again, entries) {
			t.Fatalf("%x written again as %x", entries, again)
		}
	})
}

// messages are one of each message, with every field set.
func messages() (clients []*pb.ClientMessage, servers []*pb.ServerMessage) {
	clients = []*pb.ClientMessage{
		{Body: &pb.ClientMessage_Hello{Hello: &pb.Hello{Protocol: "0275db3b9388b186", Catalog: "0123456789abcdef", PhysicsLayout: 0x2457976f, Build: "dev"}}},
		{Body: &pb.ClientMessage_Input{Input: &pb.Input{Seq: 727706170, Helm: 1024, Sheet: 3, AckTick: 727706164}}},
		{Body: &pb.ClientMessage_Input{Input: &pb.Input{AckTick: 1 << 40, AckOnly: true}}},
		{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTimeUs: 123456789, AckTick: 42, RttMs: 200, FrameMs: 17}}},
		{Body: &pb.ClientMessage_Command{Command: &pb.Command{Body: &pb.Command_Resync{Resync: &pb.Resync{}}}}},
	}
	servers = []*pb.ServerMessage{
		{Body: &pb.ServerMessage_Welcome{Welcome: &pb.Welcome{World: "0199c2a4-5f7e-7c3a-9d0e-123456789abc", Tick: 727706164,
			WorldTimeUs: 24256872133333, Boat: 7, Kind: 0, Rejoined: true}}},
		{Body: &pb.ServerMessage_Pong{Pong: &pb.Pong{ClientTimeUs: 123456789, WorldTimeUs: 24256872133333}}},
		{Body: &pb.ServerMessage_Queued{Queued: &pb.Queued{Position: 12, Waiting: 40}}},
	}
	return clients, servers
}

// goldenMessage is a message as bytes, from the client or the server; the
// TypeScript tests build the same messages and compare.
type goldenMessage struct {
	From  string `json:"from"`
	Bytes string `json:"bytes"`
}

func TestMessagesRoundTrip(t *testing.T) {
	clients, servers := messages()
	var golden []goldenMessage
	for _, m := range clients {
		b, err := AppendClient(nil, m)
		if err != nil {
			t.Fatal(err)
		}
		var got pb.ClientMessage
		if err := DecodeClient(b, &got); err != nil || !proto.Equal(&got, m) {
			t.Errorf("%v: decoded %v, %v", m, &got, err)
		}
		golden = append(golden, goldenMessage{From: "client", Bytes: hex.EncodeToString(b)})
	}
	for _, m := range servers {
		b, err := AppendServer(nil, m)
		if err != nil {
			t.Fatal(err)
		}
		var got pb.ServerMessage
		if err := DecodeServer(b, &got); err != nil || !proto.Equal(&got, m) {
			t.Errorf("%v: decoded %v, %v", m, &got, err)
		}
		golden = append(golden, goldenMessage{From: "server", Bytes: hex.EncodeToString(b)})
	}
	if *update {
		writeJSON(t, messagesFile, golden)
	}
	// The committed bytes still decode to the same messages: the TypeScript
	// tests decode and encode the same file.
	var committed []goldenMessage
	readJSON(t, messagesFile, &committed)
	if len(committed) != len(golden) {
		t.Fatalf("%d committed messages, %d made", len(committed), len(golden))
	}
	for i, g := range committed {
		b, _ := hex.DecodeString(g.Bytes)
		if g.From == "client" {
			var got pb.ClientMessage
			if err := DecodeClient(b, &got); err != nil || !proto.Equal(&got, clients[i]) {
				t.Errorf("committed %d: %v, %v", i, &got, err)
			}
		} else {
			var got pb.ServerMessage
			if err := DecodeServer(b, &got); err != nil || !proto.Equal(&got, servers[i-len(clients)]) {
				t.Errorf("committed %d: %v, %v", i, &got, err)
			}
		}
	}
}

func TestDecodeRefusals(t *testing.T) {
	hello, _ := AppendClient(nil, &pb.ClientMessage{Body: &pb.ClientMessage_Hello{Hello: &pb.Hello{Protocol: "x"}}})
	var m pb.ClientMessage
	for name, tc := range map[string]struct {
		b    []byte
		want error
	}{
		"empty":          {nil, ErrEmpty},
		"snapshot kind":  {append([]byte{KindSnapshot}, hello[1:]...), ErrKind},
		"unknown kind":   {append([]byte{9}, hello[1:]...), ErrKind},
		"no body":        {[]byte{KindMessage}, ErrBody},
		"truncated":      {hello[:len(hello)-1], nil},
		"bad wire bytes": {[]byte{KindMessage, 0xff, 0xff, 0xff}, nil},
	} {
		err := DecodeClient(tc.b, &m)
		if err == nil || tc.want != nil && !errors.Is(err, tc.want) {
			t.Errorf("%s: %v, want %v", name, err, tc.want)
		}
	}
}

// FuzzDecodeClient decodes what a client might send: it never panics, and
// a message it accepts encodes again to a message it accepts as the same.
func FuzzDecodeClient(f *testing.F) {
	clients, _ := messages()
	for _, m := range clients {
		b, _ := AppendClient(nil, m)
		f.Add(b)
	}
	f.Add([]byte{KindMessage})
	f.Add([]byte{KindSnapshot, 1, 2, 3})
	f.Fuzz(func(t *testing.T, data []byte) {
		var m pb.ClientMessage
		if err := DecodeClient(data, &m); err != nil {
			return
		}
		again, err := AppendClient(nil, &m)
		if err != nil {
			t.Fatalf("re-encoding %v: %v", &m, err)
		}
		var m2 pb.ClientMessage
		if err := DecodeClient(again, &m2); err != nil {
			t.Fatalf("re-encoded %x is refused: %v", again, err)
		}
		if !proto.Equal(&m, &m2) {
			t.Fatalf("%v re-encoded as %v", &m, &m2)
		}
	})
}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(data, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
}

func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatal(err)
	}
}

const corpusFile = "../../shared/protocol/testdata/entries.json"

// corpusCase is a stream of entries read against one of the golden views,
// and what reading it gave: the view, or a refusal.
type corpusCase struct {
	Base    string       `json:"base"` // the golden snapshot whose view is the base; "" for none
	N       int          `json:"n"`
	Bytes   string       `json:"bytes"`
	OK      bool         `json:"ok"`
	View    []goldenBoat `json:"view,omitempty"`
	Changes string       `json:"changes,omitempty"` // a digit per slot: 0 none, 1 entered, 2 updated, 3 left
}

// TestEntriesCorpus writes, with -update, entry streams made by mutating
// the golden snapshots' (bits flipped, bytes cut, added and changed, counts
// changed) with what this package makes of each; the TypeScript tests read
// them all and must agree, refusal for refusal and view for view.
func TestEntriesCorpus(t *testing.T) {
	cases := goldens()
	views := map[int64]*View{}
	byName := map[string]*View{"": {}}
	type stream struct {
		base    string
		entries []byte
		n       int
	}
	var streams []stream
	prev := ""
	for i := range cases {
		b := encodeGolden(&cases[i], views)
		views[cases[i].header.Tick] = &cases[i].view
		byName[cases[i].name] = &cases[i].view
		base := ""
		if cases[i].header.Base != 0 {
			base = prev
			for j := range cases[:i] {
				if cases[j].header.Tick == cases[i].header.Tick-int64(cases[i].header.Base) {
					base = cases[j].name
				}
			}
		}
		streams = append(streams, stream{base, b[HeaderSize:], int(b[offEntries])})
		prev = cases[i].name
	}
	if *update {
		rng := rand.New(rand.NewPCG(5, 5))
		var out []corpusCase
		for k := range 1000 {
			s := streams[k%len(streams)]
			e := slices.Clone(s.entries)
			n := s.n
			for range 1 + rng.IntN(3) {
				switch r := rng.IntN(6); {
				case r == 0 && len(e) > 0:
					e[rng.IntN(len(e))] ^= 1 << rng.IntN(8)
				case r == 1 && len(e) > 0:
					e = e[:rng.IntN(len(e))]
				case r == 2:
					e = append(e, byte(rng.Uint32()))
				case r == 3 && len(e) > 0:
					e[rng.IntN(len(e))] = byte(rng.Uint32())
				case r == 4:
					n = rng.IntN(n + 3)
				default:
					// A varint of every length.
					e = append(e, OpUpdate<<6|byte(rng.IntN(64)), ChangePosition)
					e = binary.AppendVarint(e, rng.Int64N(1<<uint(rng.IntN(63)))-1<<uint(rng.IntN(20)))
					e = binary.AppendVarint(e, int64(rng.IntN(300))-150)
					n++
				}
			}
			out = append(out, corpusCase{Base: s.base, N: n, Bytes: hex.EncodeToString(e)})
		}
		for i := range out {
			readCorpusCase(&out[i], byName)
		}
		// One case a line.
		var lines [][]byte
		for _, c := range out {
			b, err := json.Marshal(c)
			if err != nil {
				t.Fatal(err)
			}
			lines = append(lines, b)
		}
		data := append([]byte("[\n"), bytes.Join(lines, []byte(",\n"))...)
		if err := os.WriteFile(corpusFile, append(data, "\n]\n"...), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var corpus []corpusCase
	readJSON(t, corpusFile, &corpus)
	accepted := 0
	for i, c := range corpus {
		want := c
		readCorpusCase(&c, byName)
		got, _ := json.Marshal(c)
		if wantJSON, _ := json.Marshal(want); !bytes.Equal(got, wantJSON) {
			t.Fatalf("case %d: read as %+v, the corpus has %+v", i, c, want)
		}
		if c.OK {
			accepted++
		}
	}
	if accepted < 20 || accepted > len(corpus)-20 {
		t.Fatalf("%d of %d accepted: the corpus tests too little", accepted, len(corpus))
	}
}

func readCorpusCase(c *corpusCase, bases map[string]*View) {
	e, _ := hex.DecodeString(c.Bytes)
	v := *bases[c.Base]
	var ch Changes
	c.OK = v.ApplyEntries(e, c.N, &ch) == nil
	c.View, c.Changes = nil, ""
	if c.OK {
		c.View = viewOf(&v)
		changes := make([]byte, ViewSlots)
		for slot := range ViewSlots {
			bit := uint64(1) << slot
			switch {
			case ch.Entered&bit != 0:
				changes[slot] = '1'
			case ch.Updated&bit != 0:
				changes[slot] = '2'
			case ch.Left&bit != 0:
				changes[slot] = '3'
			default:
				changes[slot] = '0'
			}
		}
		c.Changes = string(changes)
	}
}
