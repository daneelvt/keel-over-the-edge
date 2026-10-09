// SPDX-License-Identifier: AGPL-3.0-only

package protocol

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"math"
	"os"
	"reflect"
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

// The golden snapshots: each field as the client names it, floats as the
// hexadecimal of their bits, and the bytes.
type goldenSnapshot struct {
	Name   string            `json:"name"`
	Tick   string            `json:"tick"` // a string: JavaScript's numbers hold 53 bits
	Seq    uint32            `json:"seq"`
	Margin int16             `json:"margin"`
	Helm   uint16            `json:"helm"`
	Sheet  uint16            `json:"sheet"`
	Wind   [2]string         `json:"wind"`
	State  map[string]string `json:"state"`
	Bytes  string            `json:"bytes"`
}

func bits(v float64) string { return fmt.Sprintf("%#016x", math.Float64bits(v)) }

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

// snapshots are the golden cases: ordinary, extreme and awkward values.
func snapshots() map[string]Snapshot {
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
	return map[string]Snapshot{
		"start": {Tick: 0, Seq: 0, Margin: NoMargin, Helm: 512, Sheet: 512,
			Wind: bus.Wind{Speed: 10 * 1852.0 / 3600}, State: physics.State{Y: -20, Heading: math.Pi / 2}},
		"sailing": {Tick: 727706164, Seq: 727706170, Margin: 3, Helm: 300, Sheet: 1024,
			Wind: bus.Wind{Speed: 7.25, From: 4.1}, State: sailing},
		"late": {Tick: 1<<53 + 2, Seq: math.MaxUint32, Margin: -12, Helm: 0, Sheet: 0,
			Wind: bus.Wind{Speed: 0, From: 2 * math.Pi}, State: awkward},
		"negative tick": {Tick: -30, Seq: 0xffffffe3, Margin: math.MaxInt16, Helm: 1024, Sheet: 1,
			Wind: bus.Wind{Speed: 25, From: -0.5}, State: sailing},
	}
}

func TestSnapshotGolden(t *testing.T) {
	cases := snapshots()
	if *update {
		var out []goldenSnapshot
		for _, name := range []string{"start", "sailing", "late", "negative tick"} {
			s := cases[name]
			b := make([]byte, SnapshotSize)
			s.Put(b)
			g := goldenSnapshot{Name: name, Tick: strconv.FormatInt(s.Tick, 10), Seq: s.Seq, Margin: s.Margin,
				Helm: s.Helm, Sheet: s.Sheet, Wind: [2]string{bits(s.Wind.Speed), bits(s.Wind.From)},
				State: map[string]string{}, Bytes: hex.EncodeToString(b)}
			names := stateNames()
			for i, v := range sim.StateFields(&s.State) {
				g.State[names[i]] = bits(*v)
			}
			out = append(out, g)
		}
		writeJSON(t, snapshotsFile, out)
	}
	var golden []goldenSnapshot
	readJSON(t, snapshotsFile, &golden)
	if len(golden) != len(cases) {
		t.Fatalf("%d golden snapshots, %d cases", len(golden), len(cases))
	}
	for _, g := range golden {
		want, err := hex.DecodeString(g.Bytes)
		if err != nil || len(want) != SnapshotSize {
			t.Fatalf("%s: bytes %v (%d)", g.Name, err, len(want))
		}
		s := cases[g.Name]
		b := make([]byte, SnapshotSize)
		s.Put(b)
		if hex.EncodeToString(b) != g.Bytes {
			t.Errorf("%s: written\n%x\nwant\n%s", g.Name, b, g.Bytes)
		}
		var got Snapshot
		if err := ReadSnapshot(want, &got); err != nil {
			t.Fatalf("%s: %v", g.Name, err)
		}
		if tick, _ := strconv.ParseInt(g.Tick, 10, 64); got.Tick != tick || got.Seq != g.Seq || got.Margin != g.Margin ||
			got.Helm != g.Helm || got.Sheet != g.Sheet ||
			bits(got.Wind.Speed) != g.Wind[0] || bits(got.Wind.From) != g.Wind[1] {
			t.Errorf("%s: read %+v", g.Name, got)
		}
		names := stateNames()
		for i, v := range sim.StateFields(&got.State) {
			if bits(*v) != g.State[names[i]] || math.Float64bits(*v) != math.Float64bits(fromBits(t, g.State[names[i]])) {
				t.Errorf("%s: %s read as %s, golden %s", g.Name, names[i], bits(*v), g.State[names[i]])
			}
		}
	}
}

func TestSnapshotRefusals(t *testing.T) {
	good := make([]byte, SnapshotSize)
	s := snapshots()["sailing"]
	s.Put(good)
	var got Snapshot
	if err := ReadSnapshot(good, &got); err != nil {
		t.Fatal(err)
	}
	for name, b := range map[string][]byte{
		"empty":          nil,
		"kind 1":         append([]byte{KindMessage}, good[1:]...),
		"kind 3":         append([]byte{3}, good[1:]...),
		"kind only":      good[:1],
		"cut short":      good[:SnapshotSize-1],
		"too long":       append(append([]byte{}, good...), 0),
		"layout 2":       append([]byte{KindSnapshot, 2}, good[2:]...),
		"helm over 1024": withUint16(good, 16, 1025),
	} {
		if err := ReadSnapshot(b, &got); err == nil {
			t.Errorf("%s: read", name)
		}
	}
}

func withUint16(b []byte, at int, v uint16) []byte {
	c := append([]byte{}, b...)
	c[at], c[at+1] = byte(v), byte(v>>8)
	return c
}

func TestPutSnapshotAllocatesNothing(t *testing.T) {
	b := make([]byte, SnapshotSize)
	s := snapshots()["sailing"]
	word := bus.Pack(s.Seq, s.Helm, s.Sheet, 3)
	if n := testing.AllocsPerRun(100, func() { PutSnapshot(b, s.Tick, word, s.Margin, s.Wind, &s.State) }); n != 0 {
		t.Fatalf("%v allocations", n)
	}
}

// messages are one of each message, with every field set.
func messages() (clients []*pb.ClientMessage, servers []*pb.ServerMessage) {
	clients = []*pb.ClientMessage{
		{Body: &pb.ClientMessage_Hello{Hello: &pb.Hello{Protocol: "0275db3b9388b186", Catalog: "0123456789abcdef", PhysicsLayout: 0x2457976f, Build: "dev"}}},
		{Body: &pb.ClientMessage_Input{Input: &pb.Input{Seq: 727706170, Helm: 1024, Sheet: 3, AckTick: 727706164}}},
		{Body: &pb.ClientMessage_Input{Input: &pb.Input{AckTick: 1 << 40, AckOnly: true}}},
		{Body: &pb.ClientMessage_Ping{Ping: &pb.Ping{ClientTimeUs: 123456789, AckTick: 42, RttMs: 200, FrameMs: 17}}},
	}
	servers = []*pb.ServerMessage{
		{Body: &pb.ServerMessage_Welcome{Welcome: &pb.Welcome{World: "0199c2a4-5f7e-7c3a-9d0e-123456789abc", Tick: 727706164,
			WorldTimeUs: 24256872133333, Boat: 7, Kind: 0, Rejoined: true}}},
		{Body: &pb.ServerMessage_Pong{Pong: &pb.Pong{ClientTimeUs: 123456789, WorldTimeUs: 24256872133333}}},
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
