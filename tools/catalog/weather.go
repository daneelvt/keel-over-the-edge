// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"reflect"
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
	{"WeatherFront", "front"},
	{"WeatherPressure", "pressure"},
	{"WeatherReach", "reach"},
}

const (
	regimeDef = "RegimeWind"
	cloudsDef = "WeatherClouds"
)

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

// cloudFields reads CloudParams's values from the schema.
func cloudFields(root string) ([]physicsField, error) {
	defs, err := schemaDefs(root)
	if err != nil {
		return nil, err
	}
	d, ok := defs[cloudsDef]
	if !ok {
		return nil, fmt.Errorf("%s has no %s", schemaPath, cloudsDef)
	}
	return groupFields(d, "clouds")
}

// checkWindParams fails unless WeatherParams, Regime and CloudParams have
// exactly the schema's values, in order.
func checkWindParams(wind, regime, clouds []physicsField) error {
	if err := checkRecord(reflect.TypeFor[physics.WeatherParams](), "weather's disk, gusts and waveWind", wind); err != nil {
		return err
	}
	if err := checkRecord(reflect.TypeFor[physics.CloudParams](), cloudsDef, clouds); err != nil {
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

	front, _ := w["front"].(map[string]any)
	if !(num(front["troughBehind"]) <= num(front["troughAhead"])) {
		bad("weather.front: troughBehind (%v) must be no more than troughAhead (%v)", front["troughBehind"], front["troughAhead"])
	}
	reach, _ := w["reach"].(map[string]any)
	ordered("weather.reach", "inwardFrom", "inwardTo", reach)

	kinds := map[string]bool{}
	systems, _ := w["systems"].([]any)
	for _, k := range systems {
		m, _ := k.(map[string]any)
		id, _ := m["id"].(string)
		if kinds[id] {
			bad("weather.systems: id %q is used more than once", id)
		}
		kinds[id] = true
		for _, f := range []string{"size", "speed", "life", "wind", "factor", "depth", "lift"} {
			if lo, hi := pair(m[f]); !(lo <= hi) {
				bad("weather.systems[%s].%s: %v is not from low to high", id, f, m[f])
			}
		}
	}
	week, _ := w["week"].(map[string]any)
	for _, f := range []string{"veer", "frontSpeed", "frontTrough", "wobblePeriod", "outer"} {
		if lo, hi := pair(week[f]); !(lo <= hi) {
			bad("weather.week.%s: %v is not from low to high", f, week[f])
		}
	}
	if _, hi := pair(week["outer"]); hi > edge {
		bad("weather.week.outer: %v reaches past the edge, %v", week["outer"], disk["edge"])
	}

	regimes, _ := w["regimes"].([]any)
	index := map[string]int{}
	share := map[string]float64{}
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
		wind, _ := m["wind"].(map[string]any)
		for _, f := range []string{"speed", "period"} {
			if lo, hi := pair(wind[f]); !(lo <= hi) {
				bad("weather.regimes[%s].wind.%s: %v is not from low to high", id, f, wind[f])
			}
		}
		for _, f := range []string{"spell", "pressure"} {
			if lo, hi := pair(m[f]); !(lo <= hi) {
				bad("weather.regimes[%s].%s: %v is not from low to high", id, f, m[f])
			}
		}
		ss, _ := m["systems"].([]any)
		for _, s := range ss {
			e, _ := s.(map[string]any)
			if k, _ := e["kind"].(string); !kinds[k] {
				bad("weather.regimes[%s].systems: no kind %q", id, k)
			}
		}
	}
	if math.Abs(total-1) > 1e-9 {
		bad("weather.regimes: the shares add up to %v, not 1", total)
	}
	if id, _ := week["closingRegime"].(string); id != "" {
		if i, ok := index[id]; !ok {
			bad("weather.week.closingRegime: no regime %q", id)
		} else if m, _ := regimes[i].(map[string]any); m["frontal"] == true {
			bad("weather.week.closingRegime: %s is frontal: a front would cross the disk as it begins", id)
		}
	}

	// The transition table: each row adds up to 1 and names regimes there
	// are, never its own, and its long-run shares are near the catalog's.
	table := make([][]float64, len(regimes))
	length := make([]float64, len(regimes))
	for i, r := range regimes {
		m, _ := r.(map[string]any)
		id, _ := m["id"].(string)
		table[i] = make([]float64, len(regimes))
		lo, hi := pair(m["spell"])
		length[i] = (lo + hi) / 2
		row := 0.0
		next, _ := m["next"].([]any)
		for _, x := range next {
			e, _ := x.(map[string]any)
			to, _ := e["to"].(string)
			j, ok := index[to]
			if !ok {
				bad("weather.regimes[%s].next: no regime %q", id, to)
				continue
			}
			if j == i {
				bad("weather.regimes[%s].next: a spell cannot give way to its own regime", id)
			}
			table[i][j] += num(e["chance"])
			row += num(e["chance"])
		}
		if math.Abs(row-1) > 1e-9 {
			bad("weather.regimes[%s].next: the chances add up to %v, not 1", id, row)
		}
	}
	if len(problems) == 0 {
		long := longRun(table, length)
		for i, r := range regimes {
			m, _ := r.(map[string]any)
			id, _ := m["id"].(string)
			if math.Abs(long[i]-share[id]) > shareTolerance {
				bad("weather.regimes: the table gives %s %.0f%% of the time in the long run, its share is %.0f%%", id, 100*long[i], 100*share[id])
			}
		}
	}

	if len(problems) > 0 {
		return fmt.Errorf("the weather:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}

// shareTolerance is how far the transition table's long-run share of a
// regime may be from the regime's: three hundredths of the time.
const shareTolerance = 0.03

// longRun is the long-run share of the time in each regime of a chain of
// spells: the chain's stationary distribution over spells, found by
// iterating, each regime's weighed by its mean spell.
func longRun(table [][]float64, length []float64) []float64 {
	n := len(table)
	p := make([]float64, n)
	for i := range p {
		p[i] = 1 / float64(n)
	}
	for range 10000 {
		q := make([]float64, n)
		for i := range n {
			for j := range n {
				q[j] += p[i] * table[i][j]
			}
		}
		// A chain that alternates never settles: keeping half of each
		// step's start damps the swing without moving where it settles.
		for i := range q {
			q[i] = (p[i] + q[i]) / 2
		}
		p = q
	}
	time := make([]float64, n)
	sum := 0.0
	for i := range n {
		time[i] = p[i] * length[i]
		sum += time[i]
	}
	for i := range time {
		time[i] /= sum
	}
	return time
}

func goWind(b *bytes.Buffer, wind, regime, clouds []physicsField) {
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
	b.WriteString(`
// CloudParams returns the catalog's clouds' values as the physics package's
// CloudParams.
func CloudParams(c *Catalog) physics.CloudParams {
	var p physics.CloudParams
`)
	for _, f := range clouds {
		from := fmt.Sprintf("c.Weather.Clouds.%s", goName(f.name))
		if f.length > 0 {
			fmt.Fprintf(b, "\tcopy(p.%s[:], %s)\n", goName(f.name), from)
		} else {
			fmt.Fprintf(b, "\tp.%s = float64(%s)\n", goName(f.name), from)
		}
	}
	b.WriteString("\treturn p\n}\n")
}

func tsWind(b *bytes.Buffer, wind, regime, clouds []physicsField) {
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
	b.WriteString(`}

/**
 * Writes the catalog's clouds' values into the physics module's
 * CloudParams record. The module's cloudsPrepare export derives the
 * clouds' constants from them.
 */
export function writeCloudParams(params: Float64Array, c: WeatherClouds): void {
  const f = RECORDS.cloudParams;
`)
	for _, f := range clouds {
		if f.length > 0 {
			fmt.Fprintf(b, "  params.set(c.%s, f.%s);\n", f.name, f.name)
		} else {
			fmt.Fprintf(b, "  params[f.%s] = c.%s;\n", f.name, f.name)
		}
	}
	b.WriteString("}\n")
}
