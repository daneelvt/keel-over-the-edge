// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestRepositoryPoses: the repository's pose library reads and checks
// against its own tables and sources, and has the poses the gates judge.
func TestRepositoryPoses(t *testing.T) {
	root := filepath.Join("..", "..", sailorsDir)
	tables, err := readTables(root)
	if err != nil {
		t.Fatal(err)
	}
	sources, err := readSources(root)
	if err != nil {
		t.Fatal(err)
	}
	lib, err := readPoses(filepath.Join(root, posesDir), tables, sources)
	if err != nil {
		t.Fatal(err)
	}
	// The poses the build's gates name (build/sailor.py), and the far
	// level's.
	for _, p := range []string{"standing", "seated", "hiking", "arm-raised", "in-water", "on-board", "climbing", "far"} {
		if _, ok := lib.Poses[p]; !ok {
			t.Errorf("no pose %s", p)
		}
	}
	looks, err := readLooks(filepath.Join("..", "..", looksDir), "")
	if err != nil {
		t.Fatal(err)
	}
	for _, l := range looks {
		if err := checkClips(l, lib); err != nil {
			t.Error(err)
		}
	}
}

func TestPosesRefused(t *testing.T) {
	tables := tables{Tables: map[string]any{
		"skeleton": []any{"Root", "pelvis", "thigh_l", "head", "hand_r"},
		"stage":    map[string]any{"points": map[string]any{"tiller": []any{0, 0, 0}}},
	}}
	sources := map[string]source{"vendor/clip.glb": {Path: "vendor/clip.glb"}}
	good := "poses:\n  sit:\n    turn:\n      - [thigh_l, x, -80]\n    ik:\n      hand_r: { at: tiller }\n"
	for name, c := range map[string]struct{ body, want string }{
		"a field no pose has":         {good + "    colour: red\n", "not found"},
		"a bone the skeleton has not": {strings.Replace(good, "thigh_l", "tail", 1), `no bone "tail"`},
		"an axis":                     {strings.Replace(good, ", x,", ", w,", 1), "the axis is x, y or z"},
		"too far a turn":              {strings.Replace(good, "-80", "-200", 1), "within ±180"},
		"a place":                     {good + "    place: mast\n", "none of seat, gunwale, cockpit, outside"},
		"IK on the head":              {strings.Replace(good, "hand_r:", "head:", 1), "only hand_l"},
		"a target nowhere":            {strings.Replace(good, "at: tiller", "at: moon", 1), "no place on the stage"},
		"a bone target's bone":        {strings.Replace(good, "at: tiller", "at: bone, bone: tail", 1), "which the skeleton has not"},
		"a reach on a bone":           {strings.Replace(good, "at: tiller", "at: bone, bone: head, reach: 0.9", 1), "a reach is a share"},
		"an offset of two":            {strings.Replace(good, "at: tiller", "at: tiller, offset: [0, 1]", 1), "three numbers"},
		"from nowhere":                {good + "    from: stand\n", `comes from "stand"`},
		"from itself":                 {good + "    from: sit\n", "comes from itself"},
		"a clip of no pose":           {good + "clips:\n  c:\n    keys:\n      - { pose: lie, hold: 1 }\n", `no pose "lie"`},
		"a clip without keys":         {good + "clips:\n  c:\n    keys: []\n", "has no keys"},
		"a lead":                      {good + "clips:\n  c:\n    keys:\n      - { pose: sit, hold: 1, lead: feet }\n", "neither hips nor head"},
		"an arc of three":             {good + "clips:\n  c:\n    keys:\n      - { pose: sit, hold: 1, arc: [0, 0, 0] }\n", "[out, up]"},
		"much anticipation":           {good + "clips:\n  c:\n    keys:\n      - { pose: sit, hold: 1, anticipate: 0.9 }\n", "0 to 0.5"},
		"an input not listed":         {good + "retarget:\n  r:\n    file: vendor/other.glb\n", "is not in SOURCES.md"},
		"a hand locked":               {good + "retarget:\n  r:\n    file: vendor/clip.glb\n    lock: [hand_r]\n", "only feet"},
		"a name twice":                {good + "clips:\n  sit:\n    keys:\n      - { pose: sit, hold: 1 }\n", "named twice"},
	} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "a.yaml"), []byte(c.body), 0o644); err != nil {
				t.Fatal(err)
			}
			_, err := readPoses(dir, tables, sources)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("%v, want %q", err, c.want)
			}
		})
	}
}

func TestCheckClips(t *testing.T) {
	lib := poseLibrary{Clips: map[string]clip{"helm": {}}, Retarget: map[string]retarget{"idle": {}}}
	if err := checkClips(look{ID: "x", Clips: []string{"helm", "idle"}}, lib); err != nil {
		t.Error(err)
	}
	if err := checkClips(look{ID: "x", Clips: []string{"dance"}}, lib); err == nil {
		t.Error("a clip the library has not was accepted")
	}
}

func TestLookGates(t *testing.T) {
	good := "id: x\nname: X\nversions:\n  female:\n    base: female\npalette: {main: '#000000', skin: '#111111', hair: '#222222'}\n"
	for body, want := range map[string]string{
		good + "gates: maybe\n":                   "either fails the build or is reported",
		good + "gates: report\ncommitted: true\n": "fails the build on any gate",
	} {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "x.yaml"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := readLooks(dir, "x"); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", body, err, want)
		}
	}
}

// glbOf writes a glTF binary of the JSON and binary chunk.
func glbOf(t *testing.T, doc map[string]any, bin []byte) []byte {
	t.Helper()
	raw := map[string]json.RawMessage{}
	for k, v := range doc {
		js, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		raw[k] = js
	}
	out, err := glb{doc: raw, bin: bin}.bytes()
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestOneClip(t *testing.T) {
	// Four floats a view: a joint's inverse bind (cut short), the mesh's
	// positions, and each clip's times and rotations.
	bin := new(bytes.Buffer)
	for i := range 16 {
		_ = binary.Write(bin, binary.LittleEndian, float32(i))
	}
	view := func(i int) map[string]any { return map[string]any{"buffer": 0, "byteOffset": i * 16, "byteLength": 16} }
	acc := func(v int, typ string, n int) map[string]any {
		return map[string]any{"bufferView": v, "componentType": 5126, "count": n, "type": typ}
	}
	doc := map[string]any{
		"asset":  map[string]any{"version": "2.0"},
		"scene":  0,
		"scenes": []any{map[string]any{"nodes": []int{0, 2}}},
		"nodes": []any{
			map[string]any{"name": "root", "children": []int{1}},
			map[string]any{"name": "pelvis"},
			map[string]any{"name": "Mannequin", "mesh": 0, "skin": 0},
		},
		"meshes":      []any{map[string]any{"primitives": []any{map[string]any{"attributes": map[string]int{"POSITION": 1}}}}},
		"skins":       []any{map[string]any{"joints": []int{0, 1}, "inverseBindMatrices": 0}},
		"accessors":   []any{acc(0, "SCALAR", 4), acc(1, "VEC3", 1), acc(2, "SCALAR", 4), acc(3, "VEC4", 1)},
		"bufferViews": []any{view(0), view(1), view(2), view(3)},
		"buffers":     []any{map[string]any{"byteLength": bin.Len()}},
		"animations": []any{
			map[string]any{"name": "Wave", "channels": []any{map[string]any{"sampler": 0, "target": map[string]any{"node": 1, "path": "rotation"}}},
				"samplers": []any{map[string]any{"input": 0, "output": 1}}},
			map[string]any{"name": "Idle", "channels": []any{map[string]any{"sampler": 0, "target": map[string]any{"node": 1, "path": "rotation"}}},
				"samplers": []any{map[string]any{"input": 2, "output": 3}}},
		},
	}
	out, err := oneClip(glbOf(t, doc, bin.Bytes()), "Idle")
	if err != nil {
		t.Fatal(err)
	}
	g, err := readGlb(out)
	if err != nil {
		t.Fatal(err)
	}
	var anims []animation
	var nodes []map[string]any
	var accessors []map[string]any
	for f, v := range map[string]any{"animations": &anims, "nodes": &nodes, "accessors": &accessors} {
		if err := json.Unmarshal(g.doc[f], v); err != nil {
			t.Fatal(err)
		}
	}
	if len(anims) != 1 || anims[0].Name != "Idle" {
		t.Fatalf("clips %+v, want Idle alone", anims)
	}
	if _, ok := g.doc["meshes"]; ok {
		t.Error("the mesh was kept")
	}
	if _, ok := nodes[2]["mesh"]; ok || len(nodes) != 3 {
		t.Errorf("nodes %v: the mesh's node is to stay, empty", nodes)
	}
	// The skin's inverse binds and Idle's two accessors, in a binary of
	// their own: Idle's times are the third view's floats, 8 to 11.
	if len(accessors) != 3 || len(g.bin) != 48 {
		t.Fatalf("%d accessors and %d bytes, want 3 and 48", len(accessors), len(g.bin))
	}
	in := int(anims[0].Samplers[0]["input"].(float64))
	off := in * 16
	if got := binary.LittleEndian.Uint32(g.bin[off:]); got != 0x41000000 { // 8.0
		t.Errorf("Idle's first time reads %x, not 8.0's", got)
	}
	if _, err := oneClip(glbOf(t, doc, bin.Bytes()), "Dance"); err == nil {
		t.Error("a clip the file has not was copied")
	}
}
