// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"os"
	"path/filepath"
	"slices"
)

// vendorClips copies clips out of an animation library's glTF binary (as
// Quaternius' Universal Animation Library ships them), each into a file of
// its own under art/sailors/vendor/<into>: the skeleton and the one clip,
// without the mannequin's mesh, materials or the other clips. Only what
// the build uses is copied; the packs themselves stay where they were
// bought. It prints each file's row for SOURCES.md.
func vendorClips(pack, into, pkg string, names []string) error {
	raw, err := os.ReadFile(pack)
	if err != nil {
		return err
	}
	dir := filepath.Join(sailorsDir, vendorDir, into)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	for _, name := range names {
		out, err := oneClip(raw, name)
		if err != nil {
			return fmt.Errorf("%s: %w", pack, err)
		}
		file := filepath.Join(dir, name+".glb")
		if err := os.WriteFile(file, out, 0o644); err != nil {
			return err
		}
		sum, err := fileSHA256(file)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(sailorsDir, file)
		fmt.Printf("| `%s` | %s | CC0-1.0 | %s |\n", filepath.ToSlash(rel), pkg, sum)
	}
	return nil
}

// glb is a glTF binary's JSON, kept as raw fields, and its binary chunk.
type glb struct {
	doc map[string]json.RawMessage
	bin []byte
}

func readGlb(raw []byte) (glb, error) {
	var g glb
	if len(raw) < 20 || string(raw[:4]) != "glTF" || binary.LittleEndian.Uint32(raw[4:]) != 2 {
		return g, errors.New("not a glTF 2 binary")
	}
	for off := 12; off+8 <= len(raw); {
		n := int(binary.LittleEndian.Uint32(raw[off:]))
		kind := string(raw[off+4 : off+8])
		if off+8+n > len(raw) {
			return g, errors.New("a chunk runs past the end")
		}
		chunk := raw[off+8 : off+8+n]
		switch kind {
		case "JSON":
			if err := json.Unmarshal(chunk, &g.doc); err != nil {
				return g, err
			}
		case "BIN\x00":
			g.bin = chunk
		}
		off += 8 + n
	}
	if g.doc == nil {
		return g, errors.New("no JSON chunk")
	}
	return g, nil
}

func (g glb) bytes() ([]byte, error) {
	js, err := json.Marshal(g.doc)
	if err != nil {
		return nil, err
	}
	js = append(js, bytes.Repeat([]byte(" "), (4-len(js)%4)%4)...)
	bin := append(slices.Clone(g.bin), make([]byte, (4-len(g.bin)%4)%4)...)
	var b bytes.Buffer
	le := binary.LittleEndian
	b.WriteString("glTF")
	_ = binary.Write(&b, le, uint32(2))
	_ = binary.Write(&b, le, uint32(12+8+len(js)+8+len(bin)))
	_ = binary.Write(&b, le, uint32(len(js)))
	b.WriteString("JSON")
	b.Write(js)
	_ = binary.Write(&b, le, uint32(len(bin)))
	b.WriteString("BIN\x00")
	b.Write(bin)
	return b.Bytes(), nil
}

type accessor = map[string]any

type animation struct {
	Name     string           `json:"name"`
	Channels []map[string]any `json:"channels"`
	Samplers []map[string]any `json:"samplers"`
}

// oneClip is the library's file cut down to its skeleton and one clip.
func oneClip(raw []byte, name string) ([]byte, error) {
	g, err := readGlb(raw)
	if err != nil {
		return nil, err
	}
	var anims []animation
	var accessors []accessor
	var views []map[string]any
	var nodes []map[string]any
	var skins []map[string]any
	for field, v := range map[string]any{"animations": &anims, "accessors": &accessors, "bufferViews": &views,
		"nodes": &nodes, "skins": &skins} {
		if err := json.Unmarshal(g.doc[field], v); err != nil {
			return nil, fmt.Errorf("its %s: %w", field, err)
		}
	}
	i := slices.IndexFunc(anims, func(a animation) bool { return a.Name == name })
	if i < 0 {
		return nil, fmt.Errorf("no clip %q", name)
	}
	anim := anims[i]
	if len(skins) != 1 {
		return nil, fmt.Errorf("%d skins, not one skeleton", len(skins))
	}

	// The accessors kept, renumbered, each with its own buffer view in a
	// new binary chunk.
	var bin []byte
	var keptAcc []accessor
	var keptViews []map[string]any
	renumber := map[int]int{}
	keep := func(a int) (int, error) {
		if n, ok := renumber[a]; ok {
			return n, nil
		}
		acc := maps.Clone(accessors[a])
		vi, ok := acc["bufferView"].(float64)
		if !ok || acc["sparse"] != nil {
			return 0, fmt.Errorf("accessor %d has no plain buffer view", a)
		}
		view := views[int(vi)]
		start := int(num(view["byteOffset"]))
		length := int(num(view["byteLength"]))
		bin = append(bin, make([]byte, (4-len(bin)%4)%4)...)
		nv := map[string]any{"buffer": 0, "byteOffset": len(bin), "byteLength": length}
		if s, ok := view["byteStride"]; ok {
			nv["byteStride"] = s
		}
		bin = append(bin, g.bin[start:start+length]...)
		keptViews = append(keptViews, nv)
		acc["bufferView"] = len(keptViews) - 1
		keptAcc = append(keptAcc, acc)
		renumber[a] = len(keptAcc) - 1
		return renumber[a], nil
	}
	for _, s := range anim.Samplers {
		for _, f := range []string{"input", "output"} {
			n, err := keep(int(num(s[f])))
			if err != nil {
				return nil, err
			}
			s[f] = n
		}
	}
	skin := skins[0]
	if ibm, ok := skin["inverseBindMatrices"]; ok {
		n, err := keep(int(num(ibm)))
		if err != nil {
			return nil, err
		}
		skin["inverseBindMatrices"] = n
	}
	// The mesh's node stays, empty: removing it would renumber the rest.
	for _, n := range nodes {
		delete(n, "mesh")
		delete(n, "skin")
	}

	out := glb{doc: map[string]json.RawMessage{}, bin: bin}
	for field, v := range map[string]any{
		"asset":       map[string]string{"version": "2.0", "generator": "keel tools/sailors -vendor"},
		"scene":       0,
		"scenes":      json.RawMessage(g.doc["scenes"]),
		"nodes":       nodes,
		"skins":       skins,
		"animations":  []any{map[string]any{"name": anim.Name, "channels": anim.Channels, "samplers": anim.Samplers}},
		"accessors":   keptAcc,
		"bufferViews": keptViews,
		"buffers":     []any{map[string]any{"byteLength": len(bin)}},
	} {
		js, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		out.doc[field] = js
	}
	return out.bytes()
}

func num(v any) float64 {
	f, _ := v.(float64)
	return f
}
