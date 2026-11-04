// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

const (
	basesFile  = "bases.yaml"
	tablesFile = "tables.yaml"
)

// versions are a look's two, a woman and a man, in the order they build.
var versions = []string{"female", "male"}

// regions are what a part of the atlas is coloured by: a sailor's main
// colour, their skin or their hair, or its own colour, fixed.
var regions = []string{"main", "skin", "hair", "fixed"}

// look is one file of looks/: a sailor in both versions. The build reads
// the parameters it does not name here; their meaning is the generators'.
type look struct {
	ID   string `yaml:"id" json:"id"`
	Name string `yaml:"name" json:"name"`
	// Committed looks are written beside the art; the others, the build's
	// own checks, into .dev.
	Committed bool               `yaml:"committed" json:"committed"`
	Versions  map[string]version `yaml:"versions" json:"versions"`
	Garments  []part             `yaml:"garments" json:"garments"`
	Hair      *part              `yaml:"hair" json:"hair"`
	Hat       *part              `yaml:"hat" json:"hat"`
	// Palette is the options the look is built and shown with by default:
	// main, skin and hair colours.
	Palette map[string]string `yaml:"palette" json:"palette"`
}

// version is a woman or a man: a base body and the look's changes to it.
type version struct {
	Base    string             `yaml:"base" json:"base"`
	Macros  map[string]float64 `yaml:"macros" json:"macros"`
	Targets map[string]float64 `yaml:"targets" json:"targets"`
}

// part is a garment, the hair or a hat: made by a generator of its family
// from parameters, the same for both versions unless a version's own say
// otherwise.
type part struct {
	ID     string         `yaml:"id" json:"id"`
	Family string         `yaml:"family" json:"family"`
	Region string         `yaml:"region" json:"region"`
	Colour string         `yaml:"colour" json:"colour,omitempty"`
	Params map[string]any `yaml:"params" json:"params"`
	Female map[string]any `yaml:"female" json:"female,omitempty"`
	Male   map[string]any `yaml:"male" json:"male,omitempty"`
}

var (
	idPattern = regexp.MustCompile(`^[a-z][a-z0-9-]*$`)
	hexColour = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
)

// readLooks reads every look, or the one named only, and checks them.
func readLooks(dir, only string) ([]look, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.yaml"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	var looks []look
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".yaml")
		if only != "" && name != only {
			continue
		}
		var l look
		if err := decodeStrict(f, &l); err != nil {
			return nil, err
		}
		if l.ID != name {
			return nil, fmt.Errorf("%s: its id is %q, not its file's name", f, l.ID)
		}
		if err := l.check(); err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		looks = append(looks, l)
	}
	if len(looks) == 0 {
		if only != "" {
			return nil, fmt.Errorf("no look %q in %s", only, dir)
		}
		return nil, fmt.Errorf("no looks in %s", dir)
	}
	return looks, nil
}

func (l look) check() error {
	if !idPattern.MatchString(l.ID) || l.Name == "" {
		return fmt.Errorf("the id %q or the name %q", l.ID, l.Name)
	}
	if len(l.Versions) == 0 {
		return errors.New("no versions")
	}
	for v, ver := range l.Versions {
		if !slices.Contains(versions, v) {
			return fmt.Errorf("a version %q: a look's versions are %s", v, strings.Join(versions, " and "))
		}
		if ver.Base == "" {
			return fmt.Errorf("the %s version names no base", v)
		}
	}
	parts := slices.Clone(l.Garments)
	if l.Hair != nil {
		parts = append(parts, *l.Hair)
	}
	if l.Hat != nil {
		parts = append(parts, *l.Hat)
	}
	seen := map[string]bool{}
	for _, p := range parts {
		switch {
		case !idPattern.MatchString(p.ID) || seen[p.ID]:
			return fmt.Errorf("a part's id %q is not a name, or is used twice", p.ID)
		case p.Family == "":
			return fmt.Errorf("%s has no family", p.ID)
		case !slices.Contains(regions, p.Region):
			return fmt.Errorf("%s: its region %q is none of %s", p.ID, p.Region, strings.Join(regions, ", "))
		case (p.Region == "fixed") != (p.Colour != ""):
			return fmt.Errorf("%s: a fixed region has its own colour, and only a fixed one", p.ID)
		case p.Colour != "" && !hexColour.MatchString(p.Colour):
			return fmt.Errorf("%s: the colour %q is not #RRGGBB", p.ID, p.Colour)
		}
		seen[p.ID] = true
	}
	for _, r := range []string{"main", "skin", "hair"} {
		if !hexColour.MatchString(l.Palette[r]) {
			return fmt.Errorf("the palette's %s is %q, not #RRGGBB", r, l.Palette[r])
		}
	}
	return nil
}

// tables are the build's shared tables, and the bases every look varies.
type tables struct {
	Bases  map[string]any `json:"bases"`
	Tables map[string]any `json:"tables"`
}

func readTables(dir string) (tables, error) {
	var t tables
	if err := decodeStrict(filepath.Join(dir, basesFile), &t.Bases); err != nil {
		return t, err
	}
	if err := decodeStrict(filepath.Join(dir, tablesFile), &t.Tables); err != nil {
		return t, err
	}
	for _, v := range versions {
		if _, ok := t.Bases[v]; !ok {
			return t, fmt.Errorf("%s has no %s base", basesFile, v)
		}
	}
	return t, nil
}

// decodeStrict reads a YAML file into v, refusing a field v does not have.
func decodeStrict(file string, v any) error {
	raw, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	dec := yaml.NewDecoder(bytes.NewReader(raw))
	dec.KnownFields(true)
	if err := dec.Decode(v); err != nil {
		return fmt.Errorf("%s: %w", file, err)
	}
	return nil
}

// job is what one build of a look reads: everything as JSON, since
// Blender's Python has no YAML.
type job struct {
	Root     string            `json:"root"`
	Look     look              `json:"look"`
	Bases    map[string]any    `json:"bases"`
	Tables   map[string]any    `json:"tables"`
	Sources  map[string]source `json:"sources"`
	Gltfpack string            `json:"gltfpack"`
	// Out is where the built files go; Work, what the build keeps for
	// itself: the reports of each run.
	Out  string `json:"out"`
	Work string `json:"work"`
}

func newJob(root string, l look, t tables, sources map[string]source, gltfpack string) job {
	out := filepath.Join(root, workDir, l.ID)
	if l.Committed {
		out = filepath.Join(root, sailorsDir, l.ID)
	}
	if !filepath.IsAbs(gltfpack) {
		gltfpack = filepath.Join(root, gltfpack)
	}
	return job{
		Root: root, Look: l, Bases: t.Bases, Tables: t.Tables, Sources: sources, Gltfpack: gltfpack,
		Out: out, Work: filepath.Join(root, workDir, "runs", l.ID),
	}
}

// write writes the job into dir, and returns its file.
func (j job) write(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	raw, err := json.MarshalIndent(j, "", "  ")
	if err != nil {
		return "", err
	}
	file, err := filepath.Abs(filepath.Join(dir, j.Look.ID+".json"))
	if err != nil {
		return "", err
	}
	return file, os.WriteFile(file, raw, 0o644)
}
