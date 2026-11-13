// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// benchTop is how far from a bench's top a station on it may be, in m: its
// point is the bench's front edge on its top.
const benchTop = 0.01

// benchEdge is how far a station on a bench may be from the front edge its
// model gives, in m, across the boat: the edge follows the cockpit's side,
// which the model gives at one station only.
const benchEdge = 0.1

// stanchionClear is how near a station on the rail may be to a stanchion,
// fore and aft, in m: the person sits between two, the arms over the upper
// lifeline.
const stanchionClear = 0.3

// modelPlaces holds what a boat's model says of the places its people sit:
// its `bench` node's data (the bench's ends, its top's height and its front
// edge out from the centreline) and its `lifelines` node's (the stanchions'
// stations and the lifelines' ends); nil where the model has none.
type modelPlaces struct {
	Bench *struct {
		Fore  float64 `json:"fore"`
		Aft   float64 `json:"aft"`
		Top   float64 `json:"top"`
		Inner float64 `json:"inner"`
	}
	Lifelines *struct {
		Stanchions []float64 `json:"stanchions"`
		Fore       float64   `json:"fore"`
		Aft        float64   `json:"aft"`
	}
}

// readPlaces reads a glTF binary's `bench` and `lifelines` nodes' data.
func readPlaces(path string) (modelPlaces, error) {
	var out modelPlaces
	data, err := os.ReadFile(path)
	if err != nil {
		return out, err
	}
	if len(data) < 20 || binary.LittleEndian.Uint32(data) != glbMagic {
		return out, errors.New("not a glTF binary")
	}
	n := int(binary.LittleEndian.Uint32(data[12:]))
	if binary.LittleEndian.Uint32(data[16:]) != glbJSON || n > len(data)-20 {
		return out, errors.New("a glTF binary without its JSON")
	}
	var gltf struct {
		Nodes []struct {
			Name   string `json:"name"`
			Extras struct {
				Bench     json.RawMessage `json:"bench"`
				Lifelines json.RawMessage `json:"lifelines"`
			} `json:"extras"`
		} `json:"nodes"`
	}
	if err := json.Unmarshal(data[20:20+n], &gltf); err != nil {
		return out, fmt.Errorf("its JSON: %w", err)
	}
	for _, node := range gltf.Nodes {
		switch {
		case node.Name == "bench" && len(node.Extras.Bench) > 0:
			if err := json.Unmarshal(node.Extras.Bench, &out.Bench); err != nil {
				return out, fmt.Errorf("its bench: %w", err)
			}
		case node.Name == "lifelines" && len(node.Extras.Lifelines) > 0:
			if err := json.Unmarshal(node.Extras.Lifelines, &out.Lifelines); err != nil {
				return out, fmt.Errorf("its lifelines: %w", err)
			}
		}
	}
	return out, nil
}

// checkPlaces fails on a station its boat's model has no place for: one on
// a bench where the model has none, or off the bench's top at its front
// edge, or beyond its ends; and one on the rail of a boat with lifelines
// outside their run, between the pulpit and the pushpit, or within
// stanchionClear of a stanchion.
func checkPlaces(root string, doc map[string]any) error {
	var problems []string
	for _, b := range kinds(doc)["boats"] {
		id, _ := b["id"].(string)
		stations, _ := b["stations"].([]any)
		art, _ := b["art"].(map[string]any)
		model, _ := art["model"].(string)
		if model == "" {
			continue
		}
		var places *modelPlaces
		for j, s := range stations {
			st, _ := s.(map[string]any)
			pose, _ := st["pose"].(string)
			if pose != "bench" && pose != "rail" {
				continue
			}
			if places == nil {
				p, err := readPlaces(filepath.Join(root, artDir, filepath.FromSlash(model)))
				if err != nil {
					problems = append(problems, fmt.Sprintf("  boats[%s].art.model: %s/%s: %v", id, artDir, model, err))
					break
				}
				places = &p
			}
			at, _ := st["at"].([]any)
			if len(at) != 3 {
				continue
			}
			num := func(v any) float64 {
				f, _ := v.(json.Number).Float64()
				return f
			}
			x, y, z := math.Abs(num(at[0])), num(at[1]), num(at[2])
			switch {
			case pose == "bench" && places.Bench == nil:
				problems = append(problems, fmt.Sprintf("  boats[%s].stations[%d]: on a bench, but the model %s/%s has no bench", id, j, artDir, model))
			case pose == "bench":
				bench := places.Bench
				if math.Abs(y-bench.Top) > benchTop || z < bench.Fore || z > bench.Aft || math.Abs(x-bench.Inner) > benchEdge {
					problems = append(problems, fmt.Sprintf("  boats[%s].stations[%d]: (%v, %v, %v) is not on the bench's top at its front edge (%v up, %v out, from %v to %v)", id, j, x, y, z, bench.Top, bench.Inner, bench.Fore, bench.Aft))
				}
			case places.Lifelines != nil:
				l := places.Lifelines
				if z < l.Fore || z > l.Aft {
					problems = append(problems, fmt.Sprintf("  boats[%s].stations[%d]: on the rail at %v, outside the lifelines from %v to %v", id, j, z, l.Fore, l.Aft))
				}
				for _, s := range l.Stanchions {
					if math.Abs(z-s) < stanchionClear {
						problems = append(problems, fmt.Sprintf("  boats[%s].stations[%d]: on the rail at %v, within %v m of the stanchion at %v", id, j, z, stanchionClear, s))
					}
				}
			}
		}
	}
	if len(problems) > 0 {
		sort.Strings(problems)
		return fmt.Errorf("the people's places:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}
