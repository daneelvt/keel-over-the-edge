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
// colour, their skin or their hair, or its own colour, fixed; or, on a
// machine, its own colour lit from within (its lamps).
var regions = []string{"main", "skin", "hair", "fixed", "glow"}

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
	// Trims are what is fastened on the garments once they are fitted
	// (buttons, pocket flaps, buckles), each naming the garment it is on.
	Trims []map[string]any `yaml:"trims" json:"trims,omitempty"`
	// Gear is what a sailor carries that is not worn as cloth (a chart
	// case on its strap, spectacles, dividers), each made by its family's
	// generator and placed on the dressed figure.
	Gear []part `yaml:"gear" json:"gear,omitempty"`
	// Palette is the options the look is built and shown with by default:
	// main, skin and hair colours.
	Palette map[string]string `yaml:"palette" json:"palette"`
	// Clips are the pose library's clips made on the look and judged with
	// it.
	Clips []string `yaml:"clips" json:"clips,omitempty"`
	// Names are the names the game asks for clips by, where a look's own
	// clip is not named so: a machine's habit is the game's "habit".
	Names map[string]string `yaml:"names" json:"names,omitempty"`
	// AtlasHead is the share of the atlas the head takes, where the look's
	// is not the table's.
	AtlasHead float64 `yaml:"atlas-head" json:"atlas-head,omitempty"`
	// Machine makes the look a machine's: no skin, hair or face of its
	// own, but rigid plates on the skeleton shaped from the body, a frame
	// between them and lamps; its parameters are the generator's. Its
	// palette is the coat's colour (main) and the metal's (skin).
	Machine map[string]any `yaml:"machine" json:"machine,omitempty"`
	// Gates is what a gate that fails does: fail the build (the default),
	// or only report, for the build's own checks of its machinery, whose
	// parts are no look's.
	Gates string `yaml:"gates" json:"gates,omitempty"`
}

// version is a woman or a man: a base body and the look's changes to it,
// and what differs between the two that the look's own parts do not say.
type version struct {
	Base    string             `yaml:"base" json:"base"`
	Macros  map[string]float64 `yaml:"macros" json:"macros"`
	Targets map[string]float64 `yaml:"targets" json:"targets"`
	// Face is how the face is painted and its eyes coloured, over the
	// base's.
	Face map[string]any `yaml:"face" json:"face,omitempty"`
	// Hair is the version's own, when the two wear it differently.
	Hair *part `yaml:"hair" json:"hair,omitempty"`
	// Machine is a machine version's own parameters, over the look's.
	Machine map[string]any `yaml:"machine" json:"machine,omitempty"`
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
	for _, v := range versions {
		if ver, ok := l.Versions[v]; ok && ver.Hair != nil {
			if l.Hair != nil {
				return fmt.Errorf("the %s version has its own hair, and so has the look", v)
			}
			if err := checkPart(*ver.Hair); err != nil {
				return err
			}
		}
	}
	if l.Hat != nil {
		parts = append(parts, *l.Hat)
	}
	parts = append(parts, l.Gear...)
	seen := map[string]bool{}
	for _, p := range parts {
		if seen[p.ID] {
			return fmt.Errorf("a part's id %q is used twice", p.ID)
		}
		if err := checkPart(p); err != nil {
			return err
		}
		seen[p.ID] = true
	}
	for _, t := range l.Trims {
		on, _ := t["on"].(string)
		if !slices.ContainsFunc(l.Garments, func(g part) bool { return g.ID == on }) {
			return fmt.Errorf("a trim is on %q, which is none of the look's garments", on)
		}
	}
	options := []string{"main", "skin", "hair"}
	if l.Machine != nil {
		// A machine has no hair: its coat's colour and its metal's.
		options = options[:2]
		if l.Hair != nil || l.Hat != nil || len(l.Gear) > 0 {
			return errors.New("a machine has no hair, hat or gear: its head is its own")
		}
	}
	for _, r := range options {
		if !hexColour.MatchString(l.Palette[r]) {
			return fmt.Errorf("the palette's %s is %q, not #RRGGBB", r, l.Palette[r])
		}
	}
	for _, v := range versions {
		if ver, ok := l.Versions[v]; ok && ver.Machine != nil && l.Machine == nil {
			return fmt.Errorf("the %s version has a machine's parameters, and the look is no machine", v)
		}
	}
	for c, as := range l.Names {
		if !slices.Contains(l.Clips, c) {
			return fmt.Errorf("the clip %q is named %q, and the look makes no such clip", c, as)
		}
		if slices.Contains(l.Clips, as) {
			return fmt.Errorf("the clip %q is named %q, which another of its clips is", c, as)
		}
	}
	for _, p := range parts {
		if p.Region == "glow" && l.Machine == nil {
			return fmt.Errorf("%s glows, and only a machine's lamps glow", p.ID)
		}
	}
	switch {
	case l.Gates != "" && l.Gates != "fail" && l.Gates != "report":
		return fmt.Errorf("gates %q: a gate that fails either fails the build or is reported", l.Gates)
	case l.Gates == "report" && l.Committed:
		return errors.New("a look the game offers fails the build on any gate")
	}
	return nil
}

// checkPart refuses a part without a name, a family or a region, or whose
// colour does not go with its region.
func checkPart(p part) error {
	switch {
	case !idPattern.MatchString(p.ID):
		return fmt.Errorf("a part's id %q is not a name", p.ID)
	case p.Family == "":
		return fmt.Errorf("%s has no family", p.ID)
	case !slices.Contains(regions, p.Region):
		return fmt.Errorf("%s: its region %q is none of %s", p.ID, p.Region, strings.Join(regions, ", "))
	case (p.Region == "fixed" || p.Region == "glow") != (p.Colour != ""):
		return fmt.Errorf("%s: a fixed or glowing region has its own colour, and only those", p.ID)
	case p.Colour != "" && !hexColour.MatchString(p.Colour):
		return fmt.Errorf("%s: the colour %q is not #RRGGBB", p.ID, p.Colour)
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
	Poses    poseLibrary       `json:"poses"`
	Gltfpack string            `json:"gltfpack"`
	// Out is where the built files go; Work, what the build keeps for
	// itself: the reports of each run.
	Out  string `json:"out"`
	Work string `json:"work"`
}

func newJob(root string, l look, t tables, sources map[string]source, poses poseLibrary, gltfpack string) job {
	out := filepath.Join(root, workDir, l.ID)
	if l.Committed {
		out = filepath.Join(root, sailorsDir, l.ID)
	}
	if !filepath.IsAbs(gltfpack) {
		gltfpack = filepath.Join(root, gltfpack)
	}
	return job{
		Root: root, Look: l, Bases: t.Bases, Tables: t.Tables, Sources: sources, Poses: poses, Gltfpack: gltfpack,
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
