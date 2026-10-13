// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"fmt"
	"reflect"

	"github.com/daneelvt/keel-over-the-edge/internal/sky"
)

// The sky's numbers go from the catalog into the sky package's Params: on
// the server by catalog.SkyParams, in the client by writeSkyParams, which
// writes them into the WebAssembly module's memory. Both are generated
// here from the schema, whose numbers are checked against Params field for
// field, as a boat's physics values are.

const skyDef = "Sky"

// skyFields reads the sky's numbers from the schema, in the order of its
// required list, which is the order of sky.Params. Its list of named stars
// is not one of them: a star's place is handed to the rule with each
// question.
func skyFields(root string) ([]physicsField, error) {
	defs, err := schemaDefs(root)
	if err != nil {
		return nil, err
	}
	g, ok := defs[skyDef]
	if !ok {
		return nil, fmt.Errorf("%s has no %s", schemaPath, skyDef)
	}
	var fields []physicsField
	for _, name := range g.Required {
		switch g.Properties[name].Type {
		case "number", "integer":
			fields = append(fields, physicsField{group: "sky", name: name})
		}
	}
	return fields, nil
}

// checkSkyParams fails unless sky.Params has exactly the schema's numbers,
// in order.
func checkSkyParams(fields []physicsField) error {
	t := reflect.TypeFor[sky.Params]()
	if t.NumField() != sky.ParamsSize {
		return fmt.Errorf("internal/sky Params has %d fields, and ParamsSize says %d", t.NumField(), sky.ParamsSize)
	}
	return checkRecord(t, skyDef, fields)
}

func goSky(b *bytes.Buffer, fields []physicsField) {
	b.WriteString(`
// SkyParams returns the catalog's sky values as the sky package's Params.
func SkyParams(c *Catalog) sky.Params {
	var p sky.Params
`)
	for _, f := range fields {
		fmt.Fprintf(b, "\tp.%s = float64(c.Sky.%s)\n", goName(f.name), goName(f.name))
	}
	b.WriteString("\treturn p\n}\n")
}

func tsSky(b *bytes.Buffer, fields []physicsField) {
	fmt.Fprintf(b, `
/** How many values the physics module's SkyParams record holds. */
export const SKY_PARAMS = %d;

/**
 * Writes the catalog's sky values into the physics module's SkyParams
 * record. The module's skyPrepare export readies them.
 */
export function writeSkyParams(params: Float64Array, s: Sky): void {
`, len(fields))
	for i, f := range fields {
		fmt.Fprintf(b, "  params[%d] = s.%s;\n", i, f.name)
	}
	b.WriteString("}\n")
}
