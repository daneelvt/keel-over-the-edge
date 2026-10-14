// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/format"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/physics"
)

// A boat's physics values go from the catalog into the physics package's
// Params record: on the server by catalog.PhysicsParams, in the client by
// writeParams, which writes them into the WebAssembly module's memory. Both
// are generated here from the schema, and the schema's fields are checked
// against Params field for field, so the three cannot drift. The sea's
// values go into SeaParams the same way.

const (
	goPhysicsPath = "internal/catalog/physics.gen.go"
	tsParamsPath  = "client/src/predict/params.gen.ts"
	physicsDef    = "BoatPhysics"
	seaDef        = "WeatherSea"
)

// physicsField is one value of a boat's physics object.
type physicsField struct {
	group, name string // as in the catalog: hull, displacement
	length      int    // for an array, its fixed length; 0 for a number
}

// schemaDef is one of the schema's definitions, as far as the physics
// values need it.
type schemaDef struct {
	Required   []string `json:"required"`
	Properties map[string]struct {
		Ref      string `json:"$ref"`
		Type     string `json:"type"`
		MinItems int    `json:"minItems"`
		MaxItems int    `json:"maxItems"`
	} `json:"properties"`
}

func schemaDefs(root string) (map[string]schemaDef, error) {
	raw, err := os.ReadFile(filepath.Join(root, schemaPath))
	if err != nil {
		return nil, err
	}
	var schema struct {
		Defs map[string]schemaDef `json:"$defs"`
	}
	if err := json.Unmarshal(raw, &schema); err != nil {
		return nil, fmt.Errorf("%s: %w", schemaPath, err)
	}
	return schema.Defs, nil
}

// groupFields reads one group's values from its definition, in the order of
// its required list.
func groupFields(g schemaDef, group string) ([]physicsField, error) {
	if len(g.Required) != len(g.Properties) {
		return nil, fmt.Errorf("%s: every value of the physics group %s must be required", schemaPath, group)
	}
	var fields []physicsField
	for _, name := range g.Required {
		prop, ok := g.Properties[name]
		if !ok {
			return nil, fmt.Errorf("%s: physics group %s requires %s, which it does not define", schemaPath, group, name)
		}
		f := physicsField{group: group, name: name}
		switch prop.Type {
		case "number", "integer":
		case "array":
			if prop.MinItems != prop.MaxItems || prop.MaxItems == 0 {
				return nil, fmt.Errorf("%s: physics array %s.%s must have a fixed length", schemaPath, group, name)
			}
			f.length = prop.MaxItems
		default:
			return nil, fmt.Errorf("%s: physics value %s.%s must be a number or an array of numbers", schemaPath, group, name)
		}
		fields = append(fields, f)
	}
	return fields, nil
}

// physicsFields reads the physics object's fields from the schema, in the
// order of its required lists, which is the order of Params.
func physicsFields(root string) ([]physicsField, error) {
	defs, err := schemaDefs(root)
	if err != nil {
		return nil, err
	}
	top, ok := defs[physicsDef]
	if !ok {
		return nil, fmt.Errorf("%s has no %s", schemaPath, physicsDef)
	}
	var fields []physicsField
	for _, group := range top.Required {
		ref := top.Properties[group].Ref
		g, ok := defs[strings.TrimPrefix(ref, "#/$defs/")]
		if !ok {
			return nil, fmt.Errorf("%s.%s refers to %q, which is not defined", physicsDef, group, ref)
		}
		fs, err := groupFields(g, group)
		if err != nil {
			return nil, err
		}
		fields = append(fields, fs...)
	}
	return fields, nil
}

// seaFields reads the sea's values from the schema, in the order of its
// required list, which is the order of SeaParams.
func seaFields(root string) ([]physicsField, error) {
	defs, err := schemaDefs(root)
	if err != nil {
		return nil, err
	}
	g, ok := defs[seaDef]
	if !ok {
		return nil, fmt.Errorf("%s has no %s", schemaPath, seaDef)
	}
	return groupFields(g, "sea")
}

// checkParams fails unless Params has exactly the schema's fields, in order,
// with the same array lengths.
func checkParams(fields []physicsField) error {
	return checkRecord(reflect.TypeFor[physics.Params](), physicsDef, fields)
}

// checkSeaParams does the same for SeaParams and the schema's sea.
func checkSeaParams(fields []physicsField) error {
	return checkRecord(reflect.TypeFor[physics.SeaParams](), seaDef, fields)
}

func checkRecord(t reflect.Type, def string, fields []physicsField) error {
	var problems []string
	for i := range max(t.NumField(), len(fields)) {
		switch {
		case i >= len(fields):
			problems = append(problems, fmt.Sprintf("  %s.%s is not in the schema", t.Name(), t.Field(i).Name))
		case i >= t.NumField():
			problems = append(problems, fmt.Sprintf("  the schema's %s.%s is not in %s", fields[i].group, fields[i].name, t.Name()))
		default:
			sf, f := t.Field(i), fields[i]
			length := 0
			if sf.Type.Kind() == reflect.Array {
				length = sf.Type.Len()
			}
			if sf.Name != goName(f.name) || length != f.length {
				problems = append(problems, fmt.Sprintf("  field %d: %s has %s %s, the schema %s.%s%s",
					i, t.Name(), sf.Name, sf.Type, f.group, f.name, lengthNote(f.length)))
			}
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("internal/physics %s does not match the schema's %s, field for field:\n%s",
			t.Name(), def, strings.Join(problems, "\n"))
	}
	return nil
}

func lengthNote(n int) string {
	if n == 0 {
		return ""
	}
	return fmt.Sprintf(" (%d values)", n)
}

// goName is a schema property as Go spells it: dragArea is DragArea.
func goName(name string) string {
	r, n := utf8.DecodeRuneInString(name)
	return string(unicode.ToUpper(r)) + name[n:]
}

func goPhysics(fields, sea, sky, wind, regime, encounters []physicsField) ([]byte, error) {
	var b bytes.Buffer
	fmt.Fprintf(&b, `// %s

// Code generated by tools/catalog from %s. DO NOT EDIT.

package catalog

import (
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
)

// PhysicsParams returns a boat's physics values as the physics package's
// Params.
func PhysicsParams(b *Boat) physics.Params {
	var p physics.Params
`, spdx, schemaPath)
	for _, f := range fields {
		from := fmt.Sprintf("b.Physics.%s.%s", goName(f.group), goName(f.name))
		if f.length > 0 {
			fmt.Fprintf(&b, "\tcopy(p.%s[:], %s)\n", goName(f.name), from)
		} else {
			fmt.Fprintf(&b, "\tp.%s = %s\n", goName(f.name), from)
		}
	}
	b.WriteString("\treturn p\n}\n")
	b.WriteString(`
// SeaParams returns the catalog's sea values as the physics package's
// SeaParams.
func SeaParams(c *Catalog) physics.SeaParams {
	var p physics.SeaParams
`)
	for _, f := range sea {
		fmt.Fprintf(&b, "\tp.%s = float64(c.Weather.Sea.%s)\n", goName(f.name), goName(f.name))
	}
	b.WriteString("\treturn p\n}\n")
	goSky(&b, sky)
	goWind(&b, wind, regime)
	goEncounters(&b, encounters)
	return format.Source(b.Bytes())
}

func tsParams(fields, sea, sky, wind, regime, encounters []physicsField) []byte {
	var b bytes.Buffer
	fmt.Fprintf(&b, `// %s
// Code generated by tools/catalog from %s. DO NOT EDIT.

import type {
  BoatPhysics,
  Encounters,
  RegimeWind,
  Sky,
  Weather,
  WeatherSea,
} from '../catalog/types.gen';
import { RECORDS } from './layout.gen';

/**
 * Writes a boat's physics values from the catalog into the physics module's
 * Params record. The module's prepare export derives everything else.
 */
export function writeParams(params: Float64Array, p: BoatPhysics): void {
  const f = RECORDS.params;
`, spdx, schemaPath)
	for _, f := range fields {
		if f.length > 0 {
			fmt.Fprintf(&b, "  params.set(p.%s.%s, f.%s);\n", f.group, f.name, f.name)
		} else {
			fmt.Fprintf(&b, "  params[f.%s] = p.%s.%s;\n", f.name, f.group, f.name)
		}
	}
	b.WriteString(`}

/**
 * Writes the catalog's sea values into the physics module's SeaParams
 * record. The module's seaPrepare export derives the waves from them.
 */
export function writeSeaParams(params: Float64Array, s: WeatherSea): void {
  const f = RECORDS.seaParams;
`)
	for _, f := range sea {
		fmt.Fprintf(&b, "  params[f.%s] = s.%s;\n", f.name, f.name)
	}
	b.WriteString("}\n")
	tsSky(&b, sky)
	tsWind(&b, wind, regime)
	tsEncounters(&b, encounters)
	return b.Bytes()
}
