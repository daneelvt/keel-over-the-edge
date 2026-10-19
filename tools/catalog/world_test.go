// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"strings"
	"testing"
)

func TestWorldRejects(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{
			name:  "a range upside down",
			files: map[string]string{worldPath: strings.Replace(realFile(worldPath), "across: [500, 600] # m", "across: [600, 500] # m", 1)},
			want:  "world.mainPort.across: [600 500] runs from high to low",
		},
		{
			name:  "a biome naming no surface",
			files: map[string]string{worldPath: strings.Replace(realFile(worldPath), "surfaces: { beach: sand, low: dune-grass", "surfaces: { beach: shingle, low: dune-grass", 1)},
			want:  `"shingle" is not a surface`,
		},
		{
			name:  "size classes out of order",
			files: map[string]string{worldPath: strings.Replace(realFile(worldPath), "{ class: islet, worth: 2, below: 100 }", "{ class: islet, worth: 2, below: 10 }", 1)},
			want:  "world.sizes[1]: below 10 is not above",
		},
		{
			name: "a biome's id in code",
			files: map[string]string{
				"internal/x/x.go": "package x\n\nvar b = \"volcanic\"\n",
			},
			want: `internal/x/x.go: "volcanic"`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			c.files["shared/catalog/boats.yaml"] = validBoats
			err := checkAll(fixture(t, c.files))
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("error %v does not mention %q", err, c.want)
			}
		})
	}
}
