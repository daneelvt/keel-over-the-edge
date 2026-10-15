// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"encoding/json"
	"math"
	"math/rand/v2"
	"os"
	"reflect"
	"testing"
)

// Encounters as Go computes them, for the client's module to check its
// copies against, bit for bit: testdata/encounters.json holds wakes, the
// shadow of several at a point, contacts resolved, and courses tracked,
// each from inputs drawn once and kept as data. After a deliberate change
// to the encounters, rewrite it with
//
//	go test ./internal/physics -run EncounterFile -update

const encounterFile = "testdata/encounters.json"

// Every float in the file is its IEEE 754 bits in hexadecimal.
type encounterFileData struct {
	Comment  string        `json:"comment"`
	Layout   string        `json:"layout"`
	Wakes    []wakeCase    `json:"wakes"`
	Shadows  []shadowCase  `json:"shadows"`
	Contacts []contactCase `json:"contacts"`
	Courses  []courseCase  `json:"courses"`
	Sails    []sailCase    `json:"sails"`
}

// wakeCase is WakeAt's arguments: place, heading, heel, boom, velocity and
// the true wind; and the wake.
type wakeCase struct {
	In  [9]string `json:"in"`
	Out [6]string `json:"out"`
}

// shadowCase is a wind at a point and the wakes offered, in order; and the
// wind after the shadow, with how many wakes reached.
type shadowCase struct {
	Env   [2]string   `json:"env"`
	At    [2]string   `json:"at"`
	Wakes [][6]string `json:"wakes"`
	Out   [2]string   `json:"out"`
	Reach int         `json:"reach"`
}

// contactCase is two boats' states; whether they touched, the contact,
// and the states after it was resolved.
type contactCase struct {
	A       [StateFieldCount]string `json:"a"`
	B       [StateFieldCount]string `json:"b"`
	Touched bool                    `json:"touched"`
	Contact [6]string               `json:"contact"`
	A2      [StateFieldCount]string `json:"a2"`
	B2      [StateFieldCount]string `json:"b2"`
}

// courseCase is a course and a boat's heading, boom and true wind; and
// the course after tracking.
type courseCase struct {
	Course [4]string `json:"course"`
	In     [3]string `json:"in"`
	Out    [4]string `json:"out"`
}

// StateFieldCount is a state's fields.
const StateFieldCount = 19

func hexes(v []float64) []string {
	out := make([]string, len(v))
	for i, x := range v {
		out[i] = toHex(x)
	}
	return out
}

func stateHex(s *State) (out [StateFieldCount]string) {
	copy(out[:], hexes(fields(s)))
	return out
}

func wakeHex(w *Wake) (out [6]string) {
	copy(out[:], hexes([]float64{w.X, w.Y, w.East, w.North, w.Height, w.Side}))
	return out
}

func TestEncounterFile(t *testing.T) {
	b := jolly(t)
	e := testEncounters(t)
	rng := rand.New(rand.NewPCG(19, 10))
	got := encounterFileData{
		Comment: "Written by go test ./internal/physics -run EncounterFile -update. Every float is its IEEE 754 bits in hexadecimal. The boat is the catalog's first, the encounters the catalog's.",
		Layout:  layoutHex(),
	}

	// Wakes of boats at random, some heeled past capsizing.
	for range 40 {
		in := [9]float64{
			(rng.Float64() - 0.5) * 2000, (rng.Float64() - 0.5) * 2000, (rng.Float64() - 0.5) * 7,
			(rng.Float64() - 0.5) * 3.6, (rng.Float64() - 0.5) * 3, rng.NormFloat64() * 2, rng.NormFloat64() * 2,
			rng.Float64() * 14, rng.Float64() * 7,
		}
		w := WakeAt(in[0], in[1], in[2], in[3], in[4], in[5], in[6], in[7], in[8], b, e)
		var c wakeCase
		copy(c.In[:], hexes(in[:]))
		c.Out = wakeHex(&w)
		got.Wakes = append(got.Wakes, c)
	}
	// A point among a few boats sailing near it, upwind of it mostly.
	for range 30 {
		x, y := (rng.Float64()-0.5)*200, (rng.Float64()-0.5)*200
		env := Env{WindSpeed: 2 + rng.Float64()*10, WindFrom: rng.Float64() * 2 * math.Pi}
		sw, cw := math.Sincos(env.WindFrom)
		n := 1 + rng.IntN(ClientWakes)
		c := shadowCase{At: [2]string{toHex(x), toHex(y)}, Env: [2]string{toHex(env.WindSpeed), toHex(env.WindFrom)}}
		var src Sources
		for i := range n {
			d := 3 + rng.Float64()*50
			off := rng.NormFloat64() * 0.5
			s := State{
				X: x + d*(sw*math.Cos(off)+cw*math.Sin(off)), Y: y + d*(cw*math.Cos(off)-sw*math.Sin(off)),
				Heading: rng.Float64() * 2 * math.Pi, Surge: rng.Float64() * 3, Heel: rng.NormFloat64() * 0.3, Boom: rng.NormFloat64() * 0.6,
			}
			w := WakeOf(&s, &env, b, e)
			c.Wakes = append(c.Wakes, wakeHex(&w))
			src.Consider(&w, int32(i), x, y, e)
		}
		out := env
		ShadowAt(&out, x, y, &src, e)
		c.Out = [2]string{toHex(out.WindSpeed), toHex(out.WindFrom)}
		c.Reach = int(src.Len())
		got.Shadows = append(got.Shadows, c)
	}
	// Two boats close together, moving at random.
	var h Hulls
	touched := 0
	for range 60 {
		a, o := randomPair(rng)
		c := contactCase{A: stateHex(&a), B: stateHex(&o)}
		var ct Contact
		c.Touched = h.Collide(&a, &o, b, b, e, &ct)
		if c.Touched {
			touched++
		}
		copy(c.Contact[:], hexes([]float64{ct.NormalEast, ct.NormalNorth, ct.Depth, ct.X, ct.Y, ct.Closing}))
		c.A2, c.B2 = stateHex(&a), stateHex(&o)
		got.Contacts = append(got.Contacts, c)
	}
	if touched < 10 {
		t.Fatalf("only %d of the pairs touched", touched)
	}
	// A boat's course through a turn: each case the last's course, so
	// tacks and gybes are tracked.
	var course Course
	heading := 0.3
	for i := range 80 {
		heading += rng.NormFloat64() * 0.4
		boom := -0.4 * math.Copysign(1, math.Sin(heading))
		if i%7 == 0 {
			boom = -boom
		}
		in := [3]float64{heading, boom, 0.05 * rng.NormFloat64()}
		c := courseCase{}
		copy(c.Course[:], hexes([]float64{course.Tack, course.Tacking, course.Settled, course.Course}))
		copy(c.In[:], hexes(in[:]))
		s := State{Heading: in[0], Boom: in[1]}
		TrackCourse(&course, &s, in[2], b, e)
		copy(c.Out[:], hexes([]float64{course.Tack, course.Tacking, course.Settled, course.Course}))
		got.Courses = append(got.Courses, c)
	}

	for _, sc := range sails() {
		c := sailCase{Name: sc.name, Steps: sc.steps, Env: [2]string{toHex(sc.env.WindSpeed), toHex(sc.env.WindFrom)}}
		for i := range 2 {
			c.Start[i] = stateHex(&sc.start[i])
			c.Controls[i] = [2]float64{sc.controls[i].Helm, sc.controls[i].Sheet}
		}
		c.Checkpoints, c.Touched = sailTogether(b, e, sc.env, sc.start, sc.controls, sc.steps)
		if (c.Touched > 0) != (sc.name[:4] == "bump") {
			t.Errorf("%s: %d steps touched", sc.name, c.Touched)
		}
		got.Sails = append(got.Sails, c)
	}

	if *update {
		data, err := json.Marshal(got)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(encounterFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", encounterFile)
		return
	}
	// The check recomputes every case from the inputs the file holds: the
	// inputs were drawn once, with functions that differ between machines.
	var want encounterFileData
	readJSON(t, encounterFile, &want)
	if want.Layout != got.Layout {
		t.Fatalf("encounters.json is for layout %s, the records are layout %s: rewrite it with -update", want.Layout, got.Layout)
	}
	again := recompute(t, b, e, &want)
	again.Sails = got.Sails
	for _, check := range []struct {
		name      string
		got, want any
	}{{"wakes", again.Wakes, want.Wakes}, {"shadows", again.Shadows, want.Shadows}, {"contacts", again.Contacts, want.Contacts}, {"courses", again.Courses, want.Courses}, {"sails", again.Sails, want.Sails}} {
		if !reflect.DeepEqual(check.got, check.want) {
			t.Errorf("the %s differ from encounters.json: rewrite it with -update", check.name)
		}
	}
}

// recompute is f with every output computed again from its inputs.
func recompute(t *testing.T, b *Prepared, e *EncounterPrepared, f *encounterFileData) encounterFileData {
	t.Helper()
	x := func(s string) float64 { return fromHex(t, s) }
	out := encounterFileData{Comment: f.Comment, Layout: f.Layout}
	for _, c := range f.Wakes {
		var in [9]float64
		for i, v := range c.In {
			in[i] = x(v)
		}
		w := WakeAt(in[0], in[1], in[2], in[3], in[4], in[5], in[6], in[7], in[8], b, e)
		c.Out = wakeHex(&w)
		out.Wakes = append(out.Wakes, c)
	}
	for _, c := range f.Shadows {
		px, py := x(c.At[0]), x(c.At[1])
		env := Env{WindSpeed: x(c.Env[0]), WindFrom: x(c.Env[1])}
		var src Sources
		for i, v := range c.Wakes {
			w := Wake{X: x(v[0]), Y: x(v[1]), East: x(v[2]), North: x(v[3]), Height: x(v[4]), Side: x(v[5])}
			src.Consider(&w, int32(i), px, py, e)
		}
		ShadowAt(&env, px, py, &src, e)
		c.Out = [2]string{toHex(env.WindSpeed), toHex(env.WindFrom)}
		c.Reach = int(src.Len())
		out.Shadows = append(out.Shadows, c)
	}
	var h Hulls
	for _, c := range f.Contacts {
		a, o := stateFromHex(t, c.A), stateFromHex(t, c.B)
		var ct Contact
		c.Touched = h.Collide(&a, &o, b, b, e, &ct)
		copy(c.Contact[:], hexes([]float64{ct.NormalEast, ct.NormalNorth, ct.Depth, ct.X, ct.Y, ct.Closing}))
		c.A2, c.B2 = stateHex(&a), stateHex(&o)
		out.Contacts = append(out.Contacts, c)
	}
	for _, c := range f.Courses {
		course := Course{Tack: x(c.Course[0]), Tacking: x(c.Course[1]), Settled: x(c.Course[2]), Course: x(c.Course[3])}
		s := State{Heading: x(c.In[0]), Boom: x(c.In[1])}
		TrackCourse(&course, &s, x(c.In[2]), b, e)
		copy(c.Out[:], hexes([]float64{course.Tack, course.Tacking, course.Settled, course.Course}))
		out.Courses = append(out.Courses, c)
	}
	return out
}

// stateFromHex is a state from its fields' bits, in order.
func stateFromHex(t *testing.T, bits [StateFieldCount]string) State {
	var s State
	v := reflect.ValueOf(&s).Elem()
	for i, b := range bits {
		v.Field(i).SetFloat(fromHex(t, b))
	}
	return s
}

// layoutHex is the layout version as golden.json writes it.
func layoutHex() string {
	const digits = "0123456789abcdef"
	v := LayoutVersion
	out := []byte("0x00000000")
	for i := 9; i >= 2; i-- {
		out[i] = digits[v&15]
		v >>= 4
	}
	return string(out)
}

// sailCase is two boats sailing together in a steady wind: each step, each
// boat in turn sails in the shadow of the other's wake from the step
// before, then a contact between them is resolved, then their wakes are
// made for the next: what the simulation does for every pair, here in the
// order the client's module can be driven in. Checkpoints hold both states
// every 100 steps and at the end; Touched is how many steps touched.
type sailCase struct {
	Name        string                     `json:"name"`
	Steps       int                        `json:"steps"`
	Env         [2]string                  `json:"env"`
	Start       [2][StateFieldCount]string `json:"start"`
	Controls    [2][2]float64              `json:"controls"`
	Checkpoints []sailCheckpoint           `json:"checkpoints"`
	Touched     int                        `json:"touched"`
}

type sailCheckpoint struct {
	Step   int                        `json:"step"`
	States [2][StateFieldCount]string `json:"states"`
}

type sail struct {
	name     string
	steps    int
	env      Env
	start    [2]State
	controls [2]Control
}

// sails are the two-boat sails written: two bumps, a beat with one boat
// in the other's dirty air, and a run.
func sails() []sail {
	return []sail{
		{"bump-head-on", 300, Env{WindSpeed: 5, WindFrom: math.Pi / 2},
			[2]State{{Heading: 0, Surge: 2.2, SheetLimit: 1.2}, {X: 0.4, Y: 14, Heading: math.Pi, Surge: 2.2, SheetLimit: 1.2}},
			[2]Control{{Sheet: 0.6}, {Sheet: 0.6}}},
		{"bump-glancing", 300, Env{WindSpeed: 6, WindFrom: 0},
			[2]State{{Heading: math.Pi / 2, Surge: 2.5, SheetLimit: 1}, {X: 20, Y: -3, Heading: -1.3, Surge: 2.5, SheetLimit: 1}},
			[2]Control{{Sheet: 0.55}, {Sheet: 0.55}}},
		{"shadow-beat", 1800, Env{WindSpeed: 5, WindFrom: 0},
			[2]State{{Heading: -0.75, Surge: 2, SheetLimit: 0.1}, {X: 6, Y: -11, Heading: -0.75, Surge: 2, SheetLimit: 0.1}},
			[2]Control{{Sheet: 0.05}, {Sheet: 0.05}}},
		{"shadow-run", 900, Env{WindSpeed: 7, WindFrom: 0},
			[2]State{{Y: 6, Heading: math.Pi + 0.2, Surge: 3, SheetLimit: 1.5, Boom: 1.4}, {Y: -8, Heading: math.Pi + 0.2, Surge: 3, SheetLimit: 1.5, Boom: 1.4}},
			[2]Control{{Sheet: 0.95}, {Sheet: 0.95}}},
	}
}

// sailTogether sails two boats from start, as sailCase says.
func sailTogether(b *Prepared, e *EncounterPrepared, env Env, start [2]State, controls [2]Control, steps int) (checkpoints []sailCheckpoint, touched int) {
	s := start
	var wake [2]Wake
	for i := range s {
		wake[i] = WakeOf(&s[i], &env, b, e)
	}
	var h Hulls
	var o Out
	for k := 1; k <= steps; k++ {
		for i := range s {
			other := 1 - i
			var src Sources
			src.Consider(&wake[other], int32(other), s[i].X, s[i].Y, e)
			en := env
			ShadowAt(&en, s[i].X, s[i].Y, &src, e)
			c := controls[i]
			Step(&s[i], &c, &en, nil, nil, b, &o)
		}
		var ct Contact
		if h.Collide(&s[0], &s[1], b, b, e, &ct) {
			touched++
		}
		for i := range s {
			wake[i] = WakeOf(&s[i], &env, b, e)
		}
		if k%100 == 0 || k == steps {
			checkpoints = append(checkpoints, sailCheckpoint{Step: k, States: [2][StateFieldCount]string{stateHex(&s[0]), stateHex(&s[1])}})
		}
	}
	return checkpoints, touched
}
