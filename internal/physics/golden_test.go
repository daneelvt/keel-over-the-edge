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
	Params      map[string]float64 `json:"params"`
	Scenarios   []scenario         `json:"scenarios"`
}

type scenario struct {
	Name    string             `json:"name"`
	Steps   int                `json:"steps"`
	State   map[string]float64 `json:"state"`
	Control map[string]float64 `json:"control"`
	Env     map[string]float64 `json:"env"`
	Changes []change           `json:"changes"`
}

type change struct {
	At      int                `json:"at"`
	Control map[string]float64 `json:"control"`
	Env     map[string]float64 `json:"env"`
}

type golden struct {
	Comment   string           `json:"comment"`
	Layout    string           `json:"layout"`
	Scenarios []goldenScenario `json:"scenarios"`
	Functions []goldenFunction `json:"functions"`
}

type goldenScenario struct {
	Name string `json:"name"`
	// Digest is the SHA-256 of the state after every step, each record's
	// float64s in little-endian order, one record after another.
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
		g, err := runScenario(sf.Params, sc)
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

// runScenario steps a scenario, hashing the state after every step.
func runScenario(params map[string]float64, sc scenario) (goldenScenario, error) {
	var (
		s State
		c Control
		e Env
		p Params
	)
	for _, set := range []struct {
		record any
		values map[string]float64
	}{{&p, params}, {&s, sc.State}, {&c, sc.Control}, {&e, sc.Env}} {
		if err := setFields(set.record, set.values); err != nil {
			return goldenScenario{}, err
		}
	}
	g := goldenScenario{Name: sc.Name}
	h := sha256.New()
	next := 0
	for i := range sc.Steps {
		for ; next < len(sc.Changes) && sc.Changes[next].At == i; next++ {
			if err := setFields(&c, sc.Changes[next].Control); err != nil {
				return g, err
			}
			if err := setFields(&e, sc.Changes[next].Env); err != nil {
				return g, err
			}
		}
		Step(&s, &c, &e, &p)
		values := fields(&s)
		for _, v := range values {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return g, fmt.Errorf("step %d: the state is not finite: %v", i, s)
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

func readJSON(t *testing.T, path string, v any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

func TestStepAllocatesNothing(t *testing.T) {
	s := State{Heading: 1, Surge: 1}
	c := Control{Helm: 0.3, Trim: 1}
	e := Env{WindSpeed: 7, WindFrom: 2}
	p := Params{Mass: 150, YawInertia: 300, SailArea: 7, SailHeight: 3, DragAhead: 60, DragSide: 900, RudderPower: 120, YawDamping: 1.5}
	if n := testing.AllocsPerRun(1000, func() { Step(&s, &c, &e, &p) }); n != 0 {
		t.Errorf("a step allocates %v times", n)
	}
}

func BenchmarkStep(b *testing.B) {
	s := State{Heading: 1, Surge: 1}
	c := Control{Helm: 0.3, Trim: 1}
	e := Env{WindSpeed: 7, WindFrom: 2}
	p := Params{Mass: 150, YawInertia: 300, SailArea: 7, SailHeight: 3, DragAhead: 60, DragSide: 900, RudderPower: 120, YawDamping: 1.5}
	for b.Loop() {
		Step(&s, &c, &e, &p)
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
