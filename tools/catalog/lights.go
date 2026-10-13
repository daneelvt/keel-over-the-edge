// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

// A boat's navigation lights are data: which she shows follows from what
// she is, by the International Regulations for Preventing Collisions at
// Sea. Rule 21 gives each light its arc: a sidelight 112.5°, from right
// ahead to 22.5° abaft the beam on its own side; a sternlight the 135°
// astern. Rule 25(a) has a sailing vessel under way show sidelights and a
// sternlight, which together make the full circle once; Rule 25(b) lets one
// of less than 20 m combine them in a single lantern at the masthead.

// tricolourBelow is the length, in metres, below which Rule 25(b) allows
// the combined lantern.
const tricolourBelow = 20

// lightSets are the ways a boat's lights make the full circle once.
var lightSets = [][]string{
	{"tricolour"},
	{"port", "starboard", "stern"},
}

// checkLights fails on a boat whose lights do not make the full circle
// once, on a combined lantern on a boat too long for one, and on a light
// with no node of its name in the boat's model, where its lantern is.
func checkLights(root string, doc map[string]any) error {
	var problems []string
	for _, b := range kinds(doc)["boats"] {
		id, _ := b["id"].(string)
		var lights []string
		list, _ := b["lights"].([]any)
		for _, l := range list {
			if s, ok := l.(string); ok {
				lights = append(lights, s)
			}
		}
		sorted := slices.Clone(lights)
		sort.Strings(sorted)
		if !slices.ContainsFunc(lightSets, func(set []string) bool { return slices.Equal(set, sorted) }) {
			problems = append(problems, fmt.Sprintf("  boats[%s]: lights %v do not make the full circle once: a boat shows a tricolour, or port, starboard and stern", id, lights))
		}
		length, _ := b["lengthOverall"].(json.Number)
		if l, err := length.Float64(); err == nil && l >= tricolourBelow && slices.Contains(lights, "tricolour") {
			problems = append(problems, fmt.Sprintf("  boats[%s]: a tricolour on a boat of %s m; only one of less than %d m may combine her lights in one lantern", id, length, tricolourBelow))
		}
		art, _ := b["art"].(map[string]any)
		model, _ := art["model"].(string)
		if model == "" {
			continue
		}
		nodes, err := modelNodes(filepath.Join(root, artDir, filepath.FromSlash(model)))
		if err != nil {
			problems = append(problems, fmt.Sprintf("  boats[%s].art.model: %s/%s: %v", id, artDir, model, err))
			continue
		}
		for _, l := range lights {
			if !slices.Contains(nodes, l) {
				problems = append(problems, fmt.Sprintf("  boats[%s]: the model %s/%s has no node %q for the light's lantern", id, artDir, model, l))
			}
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return fmt.Errorf("navigation lights:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}

// The glTF binary container: a header of three little-endian uint32s (the
// magic, the version, the length), then chunks, the first of which is the
// JSON (Khronos glTF 2.0, section 4.4).
const (
	glbMagic = 0x46546c67 // "glTF"
	glbJSON  = 0x4e4f534a // "JSON"
)

// modelNodes lists the names of the nodes of a glTF binary.
func modelNodes(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(data) < 20 || binary.LittleEndian.Uint32(data) != glbMagic {
		return nil, errors.New("not a glTF binary")
	}
	n := int(binary.LittleEndian.Uint32(data[12:]))
	if binary.LittleEndian.Uint32(data[16:]) != glbJSON || n > len(data)-20 {
		return nil, errors.New("a glTF binary without its JSON")
	}
	var gltf struct {
		Nodes []struct {
			Name string `json:"name"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(data[20:20+n], &gltf); err != nil {
		return nil, fmt.Errorf("its JSON: %w", err)
	}
	names := make([]string, 0, len(gltf.Nodes))
	for _, node := range gltf.Nodes {
		names = append(names, node.Name)
	}
	return names, nil
}
