// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"slices"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// The wind's numbers go from the catalog into the physics package's
// WeatherParams, and each regime's wind into a Regime: on the server by
// catalog.WeatherParams and catalog.Regimes, in the client by
// writeWeatherParams and writeRegime. Both are generated here from the
// schema, whose groups are checked against the records field for field, as
// a boat's physics values are.

// windGroups are the weather's groups whose values make WeatherParams, in
// its order.
var windGroups = []struct{ def, name string }{
	{"WeatherDisk", "disk"},
	{"WeatherGusts", "gusts"},
	{"WeatherWaveWind", "waveWind"},
	{"WeatherCurrent", "current"},
}

const regimeDef = "RegimeWind"

// windFields reads WeatherParams's values from the schema.
func windFields(root string) ([]physicsField, error) {
	defs, err := schemaDefs(root)
	if err != nil {
		return nil, err
	}
	var fields []physicsField
	for _, g := range windGroups {
		d, ok := defs[g.def]
		if !ok {
			return nil, fmt.Errorf("%s has no %s", schemaPath, g.def)
		}
		fs, err := groupFields(d, g.name)
		if err != nil {
			return nil, err
		}
		fields = append(fields, fs...)
	}
	return fields, nil
}

// regimeFields reads a regime's wind from the schema.
func regimeFields(root string) ([]physicsField, error) {
	defs, err := schemaDefs(root)
	if err != nil {
		return nil, err
	}
	d, ok := defs[regimeDef]
	if !ok {
		return nil, fmt.Errorf("%s has no %s", schemaPath, regimeDef)
	}
	return groupFields(d, "wind")
}

// checkWindParams fails unless WeatherParams and Regime have exactly the
// schema's values, in order.
func checkWindParams(wind, regime []physicsField) error {
	if err := checkRecord(reflect.TypeFor[physics.WeatherParams](), "weather's disk, gusts and waveWind", wind); err != nil {
		return err
	}
	return checkRecord(reflect.TypeFor[physics.Regime](), regimeDef, regime)
}

// checkWeather checks what the schema cannot: that ranges run from low to
// high, that the refuge's and the rim's limits lie in order, that every
// regime named exists, and that the sequence keeps each regime's share and
// changes only as the regimes allow.
func checkWeather(doc map[string]any) error {
	w, _ := doc["weather"].(map[string]any)
	var problems []string
	bad := func(format string, args ...any) { problems = append(problems, "  "+fmt.Sprintf(format, args...)) }
	num := func(v any) float64 {
		n, _ := v.(json.Number)
		f, err := n.Float64()
		if err != nil {
			return math.NaN()
		}
		return f
	}
	pair := func(v any) (lo, hi float64) {
		a, _ := v.([]any)
		if len(a) != 2 {
			return math.NaN(), math.NaN()
		}
		return num(a[0]), num(a[1])
	}

	disk, _ := w["disk"].(map[string]any)
	ordered := func(where, low, high string, m map[string]any) {
		if !(num(m[low]) < num(m[high])) {
			bad("%s: %s (%v) must be less than %s (%v)", where, low, m[low], high, m[high])
		}
	}
	ordered("weather.disk", "refugeInner", "refugeOuter", disk)
	ordered("weather.disk", "refugeMeanKnee", "refugeMean", disk)
	ordered("weather.disk", "refugeWindKnee", "refugeWind", disk)
	ordered("weather.disk", "rimGustsFrom", "rim", disk)
	if lo, hi := pair(disk["acrossTurn"]); !(lo <= hi) {
		bad("weather.disk.acrossTurn: %v is not from low to high", disk["acrossTurn"])
	}

	// The edge is the world's: its radius and where its mist band begins.
	world, _ := doc["world"].(map[string]any)
	worldDisk, _ := world["disk"].(map[string]any)
	edge := num(disk["edge"])
	if radius := num(worldDisk["radius"]); math.Abs(edge*1852-radius) > 1e-6 {
		bad("weather.disk.edge: %v nautical miles is not world.disk.radius, %v m", disk["edge"], worldDisk["radius"])
	}
	if mist := num(worldDisk["mist"]); num(disk["rim"]) != mist || num(disk["fallDraftFrom"]) != mist {
		bad("weather.disk: rim (%v) and fallDraftFrom (%v) must be world.disk.mist, %v", disk["rim"], disk["fallDraftFrom"], worldDisk["mist"])
	}
	ordered("weather.disk", "fallDraftFrom", "edge", disk)
	current, _ := w["current"].(map[string]any)
	for _, name := range []string{"circulationAt", "drainAt"} {
		a, _ := current[name].([]any)
		for i := 1; i < len(a); i++ {
			if !(num(a[i-1]) < num(a[i])) {
				bad("weather.current.%s: %v does not rise", name, current[name])
				break
			}
		}
	}
	if a, _ := current["drainAt"].([]any); len(a) == 3 && num(a[2]) != edge {
		bad("weather.current.drainAt: its last point (%v) must be the edge, %v", a[2], disk["edge"])
	}

	regimes, _ := w["regimes"].([]any)
	index := map[string]int{}
	share := map[string]float64{}
	next := map[string][]string{}
	total := 0.0
	for i, r := range regimes {
		m, _ := r.(map[string]any)
		id, _ := m["id"].(string)
		if _, dup := index[id]; dup {
			bad("weather.regimes: id %q is used more than once", id)
		}
		index[id] = i
		share[id] = num(m["share"])
		total += share[id]
		for _, n := range m["next"].([]any) {
			next[id] = append(next[id], n.(string))
		}
		wind, _ := m["wind"].(map[string]any)
		for _, f := range []string{"speed", "period"} {
			if lo, hi := pair(wind[f]); !(lo <= hi) {
				bad("weather.regimes[%s].wind.%s: %v is not from low to high", id, f, wind[f])
			}
		}
	}
	if math.Abs(total-1) > 1e-9 {
		bad("weather.regimes: the shares add up to %v, not 1", total)
	}
	for _, id := range sortedKeys(next) {
		for _, n := range next[id] {
			if _, ok := index[n]; !ok {
				bad("weather.regimes[%s].next: no regime %q", id, n)
			}
		}
	}

	seq, _ := w["sequence"].(map[string]any)
	spells, _ := seq["spells"].([]any)
	hours := map[string]float64{}
	sum := 0.0
	var order []string
	for i, s := range spells {
		m, _ := s.(map[string]any)
		id, _ := m["regime"].(string)
		if _, ok := index[id]; !ok {
			bad("weather.sequence.spells[%d]: no regime %q", i, id)
			continue
		}
		order = append(order, id)
		hours[id] += num(m["hours"])
		sum += num(m["hours"])
	}
	// The sequence repeats, so its last spell gives way to its first.
	for i, id := range order {
		to := order[(i+1)%len(order)]
		if !slices.Contains(next[id], to) {
			bad("weather.sequence: a %s spell gives way to a %s one, which its regime does not allow", id, to)
		}
	}
	if sum > 0 {
		for _, id := range sortedKeys(share) {
			if got := hours[id] / sum; math.Abs(got-share[id]) > shareTolerance {
				bad("weather.sequence: %s has %.0f%% of the time, its share is %.0f%%", id, 100*got, 100*share[id])
			}
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("the weather:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}

// shareTolerance is how far the sequence's share of a regime may be from
// the regime's: five hundredths of the time.
const shareTolerance = 0.05

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	return keys
}

func goWind(b *bytes.Buffer, wind, regime []physicsField) {
	b.WriteString(`
// WeatherParams returns the catalog's wind values as the physics package's
// WeatherParams.
func WeatherParams(c *Catalog) physics.WeatherParams {
	var p physics.WeatherParams
`)
	for _, f := range wind {
		from := fmt.Sprintf("c.Weather.%s.%s", goName(f.group), goName(f.name))
		if f.length > 0 {
			fmt.Fprintf(b, "\tcopy(p.%s[:], %s)\n", goName(f.name), from)
		} else {
			fmt.Fprintf(b, "\tp.%s = float64(%s)\n", goName(f.name), from)
		}
	}
	b.WriteString(`	return p
}

// Regimes returns the catalog's regimes' winds as the physics package's
// Regime, in the catalog's order.
func Regimes(c *Catalog) []physics.Regime {
	out := make([]physics.Regime, len(c.Weather.Regimes))
	for i := range c.Weather.Regimes {
		r, p := &c.Weather.Regimes[i].Wind, &out[i]
`)
	for _, f := range regime {
		if f.length > 0 {
			fmt.Fprintf(b, "\t\tcopy(p.%s[:], r.%s)\n", goName(f.name), goName(f.name))
		} else {
			fmt.Fprintf(b, "\t\tp.%s = float64(r.%s)\n", goName(f.name), goName(f.name))
		}
	}
	b.WriteString("\t}\n\treturn out\n}\n")
}

func tsWind(b *bytes.Buffer, wind, regime []physicsField) {
	b.WriteString(`
/**
 * Writes the catalog's wind values into the physics module's WeatherParams
 * record. The module's weatherPrepare export derives the wind's constants
 * from them.
 */
export function writeWeatherParams(params: Float64Array, w: Weather): void {
  const f = RECORDS.weatherParams;
`)
	for _, f := range wind {
		if f.length > 0 {
			fmt.Fprintf(b, "  params.set(w.%s.%s, f.%s);\n", f.group, f.name, f.name)
		} else {
			fmt.Fprintf(b, "  params[f.%s] = w.%s.%s;\n", f.name, f.group, f.name)
		}
	}
	b.WriteString(`}

/** Writes a regime's wind into the physics module's Regime record. */
export function writeRegime(record: Float64Array, r: RegimeWind): void {
  const f = RECORDS.regime;
`)
	for _, f := range regime {
		if f.length > 0 {
			fmt.Fprintf(b, "  record.set(r.%s, f.%s);\n", f.name, f.name)
		} else {
			fmt.Fprintf(b, "  record[f.%s] = r.%s;\n", f.name, f.name)
		}
	}
	b.WriteString("}\n")
}
