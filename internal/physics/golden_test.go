// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"math/rand/v2"
	"os"
	"reflect"
	"strconv"
	"testing"
	"unicode"
	"unicode/utf8"
)

// The golden tests: the scenarios of testdata/scenarios.json, and a table of
// function values, run here and compared bit for bit with testdata/golden.json.
// A scenario's digest covers the state and Out after every step.
// CI runs them on amd64 and arm64, and the client runs the same files through
// the WebAssembly module (client/src/predict/golden.test.ts), so all three
// agree with each other by agreeing with the file. After a deliberate change
// to the physics, rewrite the file with
//
//	go test ./internal/physics -run Golden -update

var update = flag.Bool("update", false, "rewrite testdata/golden.json from this machine's results")

const (
	scenariosFile = "testdata/scenarios.json"
	goldenFile    = "testdata/golden.json"
	// checkpointEvery is how often the golden file records the whole state.
	checkpointEvery = 600
)

type scenarioFile struct {
	Description string             `json:"description"`
	Sea         map[string]float64 `json:"sea"`
	Params      map[string]any     `json:"params"`
	// Wind is WeatherParams, for the scenarios that sail in spells of
	// weather.
	Wind      map[string]any `json:"wind,omitempty"`
	Scenarios []scenario     `json:"scenarios"`
}

type scenario struct {
	Name    string             `json:"name"`
	Steps   int                `json:"steps"`
	State   map[string]float64 `json:"state"`
	Control map[string]float64 `json:"control"`
	Env     map[string]float64 `json:"env"`
	Sea     *scenarioSea       `json:"sea"`
	// Weather, if not nil, is the spells the scenario sails in: each
	// step's Env is the wind at the boat, at the tick the step makes.
	Weather *scenarioWeather `json:"weather,omitempty"`
	Changes []change         `json:"changes"`
}

// scenarioWeather is the spells a scenario sails in, and the tick of its
// first step, which is its sea's if it has one.
type scenarioWeather struct {
	Tick   float64          `json:"tick"`
	Spells []map[string]any `json:"spells"`
}

// scenarioSea is the sea a scenario sails in: a window of areas, each with
// its inputs in whole steps (wind speed, the direction it comes from, fetch),
// row by row from the south-west, and the tick of the first step.
type scenarioSea struct {
	Tick  float64     `json:"tick"`
	Col   int32       `json:"col"`
	Row   int32       `json:"row"`
	Size  int32       `json:"size"`
	Areas [][3]uint32 `json:"areas"`
}

type change struct {
	At      int                `json:"at"`
	Control map[string]float64 `json:"control"`
	Env     map[string]float64 `json:"env"`
	// Areas replaces the inputs of the sea's areas; Window, with it, moves
	// the sea's window to another first area, column and row.
	Areas  [][3]uint32 `json:"areas"`
	Window *[2]int32   `json:"window"`
	// Steer starts the scenarios' heading-hold toward this heading; a
	// change that sets the helm stops it.
	Steer *float64 `json:"steer"`
	// Spells replaces the spells of weather the scenario sails in.
	Spells []map[string]any `json:"spells,omitempty"`
}

type golden struct {
	Comment   string           `json:"comment"`
	Layout    string           `json:"layout"`
	Scenarios []goldenScenario `json:"scenarios"`
	Functions []goldenFunction `json:"functions"`
}

type goldenScenario struct {
	Name string `json:"name"`
	// Digest is the SHA-256 of the state and Out after every step, each
	// record's float64s in little-endian order, one record after another.
	Digest      string       `json:"digest"`
	Checkpoints []checkpoint `json:"checkpoints"`
}

type checkpoint struct {
	Step  int               `json:"step"`
	State map[string]string `json:"state"`
}

type goldenFunction struct {
	Name    string     `json:"name"`
	Args    [][]string `json:"args"`
	Results []string   `json:"results"`
}

func TestGolden(t *testing.T) {
	var sf scenarioFile
	readJSON(t, scenariosFile, &sf)
	var want golden
	if !*update {
		readJSON(t, goldenFile, &want)
		if v := fmt.Sprintf("%#08x", LayoutVersion); want.Layout != v {
			t.Fatalf("golden.json is for layout %s, the records are layout %s: rewrite it with -update", want.Layout, v)
		}
	}

	got := golden{
		Comment: "Written by go test ./internal/physics -run Golden -update. Floats are their IEEE 754 bits in hexadecimal.",
		Layout:  fmt.Sprintf("%#08x", LayoutVersion),
	}
	for i, sc := range sf.Scenarios {
		g, err := runScenario(sf.Sea, sf.Params, sf.Wind, sc)
		if err != nil {
			t.Fatalf("%s: %v", sc.Name, err)
		}
		got.Scenarios = append(got.Scenarios, g)
		if *update {
			continue
		}
		if i >= len(want.Scenarios) || want.Scenarios[i].Name != sc.Name {
			t.Fatalf("golden.json has no results for %s: rewrite it with -update", sc.Name)
		}
		compareScenario(t, g, want.Scenarios[i])
	}

	if *update {
		got.Functions = functionTable()
		data, err := json.MarshalIndent(got, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(goldenFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("wrote %s", goldenFile)
		return
	}
	for _, f := range want.Functions {
		compareFunction(t, f)
	}
}

func compareScenario(t *testing.T, got, want goldenScenario) {
	t.Helper()
	if got.Digest == want.Digest {
		return
	}
	for j, cp := range got.Checkpoints {
		if j < len(want.Checkpoints) && !reflect.DeepEqual(cp, want.Checkpoints[j]) {
			t.Errorf("%s: differs from golden.json by step %d:\n got  %v\n want %v", got.Name, cp.Step, cp.State, want.Checkpoints[j].State)
			return
		}
	}
	t.Errorf("%s: the digest differs from golden.json, though every checkpoint matches", got.Name)
}

func compareFunction(t *testing.T, f goldenFunction) {
	t.Helper()
	var fn Fn
	for i, n := range FnNames {
		if n == f.Name {
			fn = Fn(i)
		}
	}
	for i, r := range f.Results {
		a := fromHex(t, f.Args[0][i])
		var b float64
		if len(f.Args) > 1 {
			b = fromHex(t, f.Args[1][i])
		}
		got, want := Eval(fn, a, b), fromHex(t, r)
		if math.Float64bits(got) != math.Float64bits(want) && !(math.IsNaN(got) && math.IsNaN(want)) {
			t.Errorf("%s(%v, %v) = %v (%s), golden.json has %v (%s)", f.Name, a, b, got, toHex(got), want, r)
		}
	}
}

// seaOf prepares the sea's waves from values named as the client names
// them.
func seaOf(values map[string]float64) (*Waves, error) {
	var p SeaParams
	if len(values) != len(fields(&p)) {
		return nil, fmt.Errorf("sea has %d values, SeaParams %d fields", len(values), len(fields(&p)))
	}
	if err := setFields(&p, values); err != nil {
		return nil, err
	}
	w := new(Waves)
	PrepareSea(&p, w)
	return w, nil
}

// scenarioOcean makes a scenario's sea, or nil for flat water.
func scenarioOcean(w *Waves, sea *scenarioSea) (*ocean, error) {
	if sea == nil {
		return nil, nil
	}
	if sea.Size < 1 || sea.Size > SeaClientWindow || len(sea.Areas) != int(sea.Size*sea.Size) {
		return nil, fmt.Errorf("a sea of %d areas for a window %d a side", len(sea.Areas), sea.Size)
	}
	o := &ocean{Sea: Sea{Waves: w, Window: newWindow(sea.Col, sea.Row, sea.Size)}}
	o.Tick = &o.tick
	return o, o.set(sea.Areas)
}

// set gives the sea's areas their inputs.
func (o *ocean) set(areas [][3]uint32) error {
	if len(areas) != len(o.Window.Inputs) {
		return fmt.Errorf("%d areas for a window of %d", len(areas), len(o.Window.Inputs))
	}
	for i, a := range areas {
		SeaArea(o.Waves, o.Window, int32(i), SeaInput{Speed: a[0], From: a[1], Fetch: a[2]})
	}
	o.Window.Seal()
	return nil
}

// scenarioSky is a scenario's weather, made ready: nil if it has none.
type scenarioSky struct {
	w    Weather
	t    WeatherTick
	tick float64
}

func newScenarioSky(wind map[string]any, sw *scenarioWeather) (*scenarioSky, error) {
	if sw == nil {
		return nil, nil
	}
	var p WeatherParams
	if err := setRecord(&p, wind); err != nil {
		return nil, fmt.Errorf("wind: %w", err)
	}
	sky := &scenarioSky{tick: sw.Tick}
	sky.w.Prepared = new(WeatherPrepared)
	PrepareWeather(&p, sky.w.Prepared)
	return sky, sky.set(sw.Spells)
}

// set makes spells the spells in play.
func (sky *scenarioSky) set(spells []map[string]any) error {
	if len(spells) > WeatherSpells {
		return fmt.Errorf("%d spells", len(spells))
	}
	for i, m := range spells {
		var s Spell
		if err := setRecord(&s, m); err != nil {
			return fmt.Errorf("spell %d: %w", i, err)
		}
		sky.w.SetSpell(int32(i), &s)
	}
	sky.w.SetCount(int32(len(spells)))
	return nil
}

// env is the wind of step i at the boat.
func (sky *scenarioSky) env(i int, s *State) Env {
	WeatherAt(&sky.w, &sky.t, sky.tick+float64(i))
	return WindAt(&sky.t, s.X, s.Y)
}

// runScenario steps a scenario, hashing the state and Out after every step.
func runScenario(seaParams map[string]float64, params map[string]any, wind map[string]any, sc scenario) (goldenScenario, error) {
	var (
		s State
		c Control
		e Env
		p Params
		b Prepared
		o Out
	)
	if err := setParams(&p, params); err != nil {
		return goldenScenario{}, err
	}
	w, err := seaOf(seaParams)
	if err != nil {
		return goldenScenario{}, err
	}
	Prepare(&p, w, &b)
	sea, err := scenarioOcean(w, sc.Sea)
	if err != nil {
		return goldenScenario{}, err
	}
	sky, err := newScenarioSky(wind, sc.Weather)
	if err != nil {
		return goldenScenario{}, err
	}
	if sky != nil && sc.Sea != nil && sc.Sea.Tick != sc.Weather.Tick {
		return goldenScenario{}, fmt.Errorf("the sea's tick is %v, the weather's %v", sc.Sea.Tick, sc.Weather.Tick)
	}
	for _, set := range []struct {
		record any
		values map[string]float64
	}{{&s, sc.State}, {&c, sc.Control}, {&e, sc.Env}} {
		if err := setFields(set.record, set.values); err != nil {
			return goldenScenario{}, err
		}
	}
	g := goldenScenario{Name: sc.Name}
	h := sha256.New()
	next := 0
	steering, target := false, 0.0
	for i := range sc.Steps {
		for ; next < len(sc.Changes) && sc.Changes[next].At == i; next++ {
			ch := sc.Changes[next]
			if err := setFields(&c, ch.Control); err != nil {
				return g, err
			}
			if err := setFields(&e, ch.Env); err != nil {
				return g, err
			}
			if _, ok := ch.Control["helm"]; ok {
				steering = false
			}
			if ch.Steer != nil {
				steering, target = true, *ch.Steer
			}
			if ch.Spells != nil {
				if sky == nil {
					return g, fmt.Errorf("change %d sets the spells of a scenario with no weather", next)
				}
				if err := sky.set(ch.Spells); err != nil {
					return g, err
				}
			}
			if ch.Areas != nil {
				if sea == nil {
					return g, fmt.Errorf("change %d sets the areas of a scenario with no sea", next)
				}
				if ch.Window != nil {
					sea.Window.Col, sea.Window.Row = ch.Window[0], ch.Window[1]
				}
				if err := sea.set(ch.Areas); err != nil {
					return g, err
				}
			}
		}
		if steering {
			c.Helm = steer(target, &s)
		}
		var at *Sea
		if sea != nil {
			at = sea.at(sc.Sea.Tick + float64(i))
		}
		if sky != nil {
			e = sky.env(i, &s)
		}
		Step(&s, &c, &e, at, &b, &o)
		values := fields(&s)
		for _, v := range append(values, fields(&o)...) {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return g, fmt.Errorf("step %d: the state or Out is not finite: %+v %+v", i, s, o)
			}
			h.Write(binary.LittleEndian.AppendUint64(nil, math.Float64bits(v)))
		}
		if n := i + 1; n%checkpointEvery == 0 || n == sc.Steps {
			cp := checkpoint{Step: n, State: map[string]string{}}
			st := reflect.TypeFor[State]()
			for j := range st.NumField() {
				cp.State[lowerFirst(st.Field(j).Name)] = toHex(values[j])
			}
			g.Checkpoints = append(g.Checkpoints, cp)
		}
	}
	if next != len(sc.Changes) {
		return g, fmt.Errorf("change %d is out of order or past the last step", next)
	}
	g.Digest = hex.EncodeToString(h.Sum(nil))
	return g, nil
}

// steer is the scenarios' heading-hold. It uses only operations JavaScript
// computes the same way, and writes its products float64(…) so that Go cannot
// fuse them; client/src/predict/golden.ts has its twin.
func steer(target float64, s *State) float64 {
	off := target - s.Heading
	if off > math.Pi {
		off -= 2 * math.Pi
	} else if off < -math.Pi {
		off += 2 * math.Pi
	}
	helm := float64(2*off) - float64(0.8*s.YawRate)
	return max(-1, min(1, helm))
}

// setParams sets Params from values named as the client names them, numbers
// or arrays of numbers; a missing or unknown name, or an array of another
// length, is an error.
func setParams(p *Params, values map[string]any) error { return setRecord(p, values) }

// setRecord sets every field of a record from values named as the client
// names them, as setParams does.
func setRecord(p any, values map[string]any) error {
	v := reflect.ValueOf(p).Elem()
	t := v.Type()
	if len(values) != t.NumField() {
		return fmt.Errorf("%d values for the %d fields of %s", len(values), t.NumField(), t.Name())
	}
	for i := range t.NumField() {
		name := lowerFirst(t.Field(i).Name)
		x, ok := values[name]
		if !ok {
			return fmt.Errorf("%s has no %s", t.Name(), name)
		}
		f := v.Field(i)
		switch x := x.(type) {
		case float64:
			if f.Kind() != reflect.Float64 {
				return fmt.Errorf("%s.%s must be an array", t.Name(), name)
			}
			f.SetFloat(x)
		case []any:
			if f.Kind() != reflect.Array || f.Len() != len(x) {
				return fmt.Errorf("%s.%s has %d values, and is %s", t.Name(), name, len(x), f.Type())
			}
			for j, e := range x {
				n, ok := e.(float64)
				if !ok {
					return fmt.Errorf("%s.%s[%d] is not a number", t.Name(), name, j)
				}
				f.Index(j).SetFloat(n)
			}
		default:
			return fmt.Errorf("%s.%s is neither a number nor an array", t.Name(), name)
		}
	}
	return nil
}

// setFields sets a record's fields from values named as the client names
// them; an unknown name is an error.
func setFields(record any, values map[string]float64) error {
	v := reflect.ValueOf(record).Elem()
	for name, x := range values {
		f := v.FieldByNameFunc(func(n string) bool { return lowerFirst(n) == name })
		if !f.IsValid() {
			return fmt.Errorf("%s has no field %q", v.Type().Name(), name)
		}
		f.SetFloat(x)
	}
	return nil
}

func fields(record any) []float64 {
	v := reflect.ValueOf(record).Elem()
	out := make([]float64, v.NumField())
	for i := range out {
		out[i] = v.Field(i).Float()
	}
	return out
}

func lowerFirst(s string) string {
	r, n := utf8.DecodeRuneInString(s)
	return string(unicode.ToLower(r)) + s[n:]
}

// functionTable draws the arguments for the function table: the special and
// hard cases, then values spread over each function's range, up to the
// module's batch of 256 per function.
func functionTable() []goldenFunction {
	const n = 256
	rng := rand.New(rand.NewPCG(7, 8))
	inf, nan := math.Inf(1), math.NaN()
	spreadOver := func(lo, hi float64, signed bool) float64 {
		x := math.Exp(math.Log(lo) + (math.Log(hi)-math.Log(lo))*rng.Float64())
		x = min(max(x, lo), hi) // see spread in fmath_test.go
		if signed && rng.IntN(2) == 0 {
			x = -x
		}
		return x
	}
	fill := func(special []float64, draw func() float64) []float64 {
		xs := append([]float64{}, special...)
		for len(xs) < n {
			xs = append(xs, draw())
		}
		return xs
	}
	trig := []float64{0, math.Copysign(0, -1), 1e-300, 0x1p-27, pio4, -pio4, math.Nextafter(pio4, 1),
		pio2Hi, piHi, 3 * pio2Hi, 1e6, mediumMax, -mediumMax, 1e22, 1e300, math.MaxFloat64,
		6381956970095103 * math.Pow(2, 797), inf, -inf, nan}
	trigDraw := func() float64 {
		switch rng.IntN(3) {
		case 0:
			return (rng.Float64() - 0.5) * 100
		case 1:
			return spreadOver(1, mediumMax, true)
		default:
			return spreadOver(mediumMax, math.MaxFloat64, true)
		}
	}
	table := []struct {
		name string
		args [][]float64
	}{
		{"sin", [][]float64{fill(trig, trigDraw)}},
		{"cos", [][]float64{fill(trig, trigDraw)}},
		{"exp", [][]float64{fill([]float64{0, math.Copysign(0, -1), 1, -1, 1e-30, expOverflow,
			math.Nextafter(expOverflow, inf), 710, expUnderflow, -745.2, -708.5, -740, inf, -inf, nan},
			func() float64 { return -745 + 1454*rng.Float64() })}},
		{"log", [][]float64{fill([]float64{1, 2, 0.5, math.Nextafter(1, 2), math.Nextafter(1, 0), sqrt2,
			0, math.Copysign(0, -1), -1, 5e-324, 0x1p-1022, math.MaxFloat64, inf, -inf, nan},
			func() float64 { return spreadOver(5e-324, math.MaxFloat64, false) })}},
		{"atan", [][]float64{fill(append([]float64{0, math.Copysign(0, -1), 1, -1, 1e-300, 1e300,
			inf, -inf, nan}, atanMid[:]...), func() float64 { return spreadOver(1e-20, 1e20, true) })}},
	}
	ys := []float64{0, math.Copysign(0, -1), 0, math.Copysign(0, -1), 1, -1, 1, inf, -inf, inf, -inf, 1, -1, inf, nan, 1}
	xs := []float64{1, 1, -1, -1, 0, 0, math.Copysign(0, -1), inf, inf, -inf, -inf, inf, -inf, 1, 1, nan}
	for len(ys) < n {
		ys = append(ys, spreadOver(1e-10, 1e10, true))
		xs = append(xs, spreadOver(1e-10, 1e10, true))
	}
	table = append(table, struct {
		name string
		args [][]float64
	}{"atan2", [][]float64{ys, xs}})

	var out []goldenFunction
	for _, f := range table {
		fn := Fn(len(out))
		if FnNames[fn] != f.name {
			panic("functionTable is not in the order of FnNames")
		}
		g := goldenFunction{Name: f.name}
		for _, a := range f.args {
			col := make([]string, len(a))
			for i, x := range a {
				col[i] = toHex(x)
			}
			g.Args = append(g.Args, col)
		}
		for i, a := range f.args[0] {
			var b float64
			if len(f.args) > 1 {
				b = f.args[1][i]
			}
			g.Results = append(g.Results, toHex(Eval(fn, a, b)))
		}
		out = append(out, g)
	}
	return out
}

func toHex(f float64) string { return fmt.Sprintf("%#016x", math.Float64bits(f)) }

func fromHex(t *testing.T, s string) float64 {
	t.Helper()
	b, err := strconv.ParseUint(s, 0, 64)
	if err != nil {
		t.Fatal(err)
	}
	return math.Float64frombits(b)
}

func readJSON(t testing.TB, path string, v any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

// jolly returns the Jolly boat, prepared, from the scenarios file.
func jolly(t testing.TB) *Prepared {
	t.Helper()
	var sf scenarioFile
	readJSON(t, scenariosFile, &sf)
	var p Params
	if err := setParams(&p, sf.Params); err != nil {
		t.Fatal(err)
	}
	var b Prepared
	Prepare(&p, testWaves(t), &b)
	return &b
}

func TestStepAllocatesNothing(t *testing.T) {
	b := jolly(t)
	s := State{Heading: 1, Surge: 2, SheetLimit: 0.5}
	c := Control{Helm: 0.3, Sheet: 0.4}
	e := Env{WindSpeed: 7, WindFrom: 2}
	var o Out
	if n := testing.AllocsPerRun(1000, func() { Step(&s, &c, &e, nil, b, &o) }); n != 0 {
		t.Errorf("a step allocates %v times", n)
	}
}

// BenchmarkStep times one step of Substeps substeps, on a beam reach.
func BenchmarkStep(bm *testing.B) {
	b := jolly(bm)
	s := State{Heading: math.Pi / 2, Surge: 3, SheetLimit: 0.6}
	c := Control{Sheet: 0.35}
	e := Env{WindSpeed: 7, WindFrom: 0}
	var o Out
	for bm.Loop() {
		Step(&s, &c, &e, nil, b, &o)
	}
}

// BenchmarkFunctions times each function on arguments of the size a step
// uses, beside the standard library's for comparison.
func BenchmarkFunctions(b *testing.B) {
	rng := rand.New(rand.NewPCG(9, 9))
	args := make([]float64, 1024)
	for i := range args {
		args[i] = (rng.Float64() - 0.5) * 20
	}
	std := map[string]func(a, b float64) float64{
		"sin":   func(a, _ float64) float64 { return math.Sin(a) },
		"cos":   func(a, _ float64) float64 { return math.Cos(a) },
		"exp":   func(a, _ float64) float64 { return math.Exp(a) },
		"log":   func(a, _ float64) float64 { return math.Log(math.Abs(a)) },
		"atan":  func(a, _ float64) float64 { return math.Atan(a) },
		"atan2": math.Atan2,
	}
	for fn, name := range FnNames {
		own := func(a, c float64) float64 {
			if Fn(fn) == FnLog {
				a = math.Abs(a)
			}
			return Eval(Fn(fn), a, c)
		}
		for _, impl := range []struct {
			label string
			f     func(a, b float64) float64
		}{{"own", own}, {"std", std[name]}} {
			b.Run(name+"/"+impl.label, func(b *testing.B) {
				sum := 0.0
				i := 0
				for b.Loop() {
					sum += impl.f(args[i&1023], args[(i+1)&1023])
					i++
				}
				_ = sum
			})
		}
	}
}
