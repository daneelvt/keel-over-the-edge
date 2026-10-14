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

// The encounters' numbers go from the catalog into the physics package's
// EncounterParams: on the server by catalog.EncounterParams, in the client
// by writeEncounterParams. Both are generated here from the schema, whose
// groups are checked against the record field for field, as a boat's
// physics values are. The overlay's group is the client's alone.

// encounterGroups are the encounters' groups whose values make
// EncounterParams, in its order.
var encounterGroups = []struct{ def, name string }{
	{"EncountersContact", "contact"},
	{"EncountersShadow", "shadow"},
	{"EncountersArticles", "articles"},
}

// encounterFields reads EncounterParams's values from the schema.
func encounterFields(root string) ([]physicsField, error) {
	defs, err := schemaDefs(root)
	if err != nil {
		return nil, err
	}
	var fields []physicsField
	for _, g := range encounterGroups {
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

// checkEncounterParams fails unless EncounterParams has exactly the
// schema's values, in order.
func checkEncounterParams(fields []physicsField) error {
	return checkRecord(reflect.TypeFor[physics.EncounterParams](), "encounters' contact, shadow and articles", fields)
}

// checkEncounters checks what the schema cannot: that each boat's outline
// is a convex polygon with the stem a point, no wider than the boat's beam
// and as long as the boat; that the shadow fades before its reach and its
// deflections' angles run from low to high.
func checkEncounters(doc map[string]any) error {
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
	boats, _ := doc["boats"].([]any)
	for _, b := range boats {
		m, _ := b.(map[string]any)
		id, _ := m["id"].(string)
		phys, _ := m["physics"].(map[string]any)
		hull, _ := phys["hull"].(map[string]any)
		raw, _ := hull["outline"].([]any)
		var p physics.Params
		if len(raw) != physics.OutlineStations {
			bad("boats[%s].physics.hull.outline: %d stations, not %d", id, len(raw), physics.OutlineStations)
			continue
		}
		widest := 0.0
		for i, v := range raw {
			p.Outline[i] = num(v)
			widest = max(widest, p.Outline[i])
		}
		if !physics.OutlineConvex(&p) {
			bad("boats[%s].physics.hull.outline: not convex with the stem a point: each half-beam must be at least the mean of its neighbours', and the last 0", id)
		}
		if beam := num(m["beam"]); widest > beam/2+1e-9 {
			bad("boats[%s].physics.hull.outline: %v m wide, wider than half the beam, %v m", id, widest, beam/2)
		}
		length := num(hull["transom"]) + num(hull["stem"])
		if overall := num(m["lengthOverall"]); math.Abs(length-overall) > 0.005 {
			bad("boats[%s].physics.hull: transom and stem make %v m, not the length overall, %v m", id, length, overall)
		}
	}
	enc, _ := doc["encounters"].(map[string]any)
	shadow, _ := enc["shadow"].(map[string]any)
	if !(num(shadow["taper"]) < num(shadow["reach"])) {
		bad("encounters.shadow: taper (%v) must be less than reach (%v)", shadow["taper"], shadow["reach"])
	}
	at, _ := shadow["deflectionAt"].([]any)
	if len(at) == 2 && !(num(at[0]) < num(at[1])) {
		bad("encounters.shadow.deflectionAt: %v is not from low to high", shadow["deflectionAt"])
	}
	if len(problems) > 0 {
		return fmt.Errorf("the encounters:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}

func goEncounters(b *bytes.Buffer, fields []physicsField) {
	b.WriteString(`
// EncounterParams returns the catalog's encounters values as the physics
// package's EncounterParams.
func EncounterParams(c *Catalog) physics.EncounterParams {
	var p physics.EncounterParams
`)
	for _, f := range fields {
		from := fmt.Sprintf("c.Encounters.%s.%s", goName(f.group), goName(f.name))
		if f.length > 0 {
			fmt.Fprintf(b, "\tcopy(p.%s[:], %s)\n", goName(f.name), from)
		} else {
			fmt.Fprintf(b, "\tp.%s = float64(%s)\n", goName(f.name), from)
		}
	}
	b.WriteString("\treturn p\n}\n")
}

func tsEncounters(b *bytes.Buffer, fields []physicsField) {
	b.WriteString(`
/**
 * Writes the catalog's encounters values into the physics module's
 * EncounterParams record. The module's encounterPrepare export derives
 * their constants.
 */
export function writeEncounterParams(params: Float64Array, e: Encounters): void {
  const f = RECORDS.encounterParams;
`)
	for _, f := range fields {
		if f.length > 0 {
			fmt.Fprintf(b, "  params.set(e.%s.%s, f.%s);\n", f.group, f.name, f.name)
		} else {
			fmt.Fprintf(b, "  params[f.%s] = e.%s.%s;\n", f.name, f.group, f.name)
		}
	}
	b.WriteString("}\n")
}
