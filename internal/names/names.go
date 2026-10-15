// SPDX-License-Identifier: AGPL-3.0-only

// Package names holds the names islands are given when a world is made:
// whole names for single islands, names for groups of rocks and islets,
// the generic words and the specifics that combine into more, and the
// list of names and words never to give. The data is the server's alone:
// players learn a place's name only when they come upon it.
//
// The files are shared/catalog/names/*; go run ./tools/catalog checks them
// and writes them, parsed, to names.gen.json, which this package embeds.
// Lists inside a field are separated by ";".
package names

import (
	"bytes"
	_ "embed"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"slices"
	"strconv"
	"strings"
	"unicode"
)

// Any is the tag that fits every biome or zone.
const Any = "any"

// Island is a whole name for a single island, with what it suits: the size
// classes, the biomes and zones (or Any), the features the island must
// show, and the name's tone; the note says where it comes from.
type Island struct {
	Name   string   `json:"name"`
	Sizes  []string `json:"sizes"`
	Biomes []string `json:"biomes"`
	Needs  []string `json:"needs"`
	Zones  []string `json:"zones"`
	Tone   string   `json:"tone"`
	Note   string   `json:"note"`
}

// Group is a name for a group of rocks and islets, of Count[0] to Count[1].
type Group struct {
	Name   string   `json:"name"`
	Count  [2]int   `json:"count"`
	Biomes []string `json:"biomes"`
	Zones  []string `json:"zones"`
	Tone   string   `json:"tone"`
	Note   string   `json:"note"`
}

// Generic is a generic word, its class, the sizes and biomes it suits and
// its form: "{specific} Cay", or "Calf of {island}" for one named after a
// neighbour.
type Generic struct {
	Generic string   `json:"generic"`
	Class   string   `json:"class"`
	Sizes   []string `json:"sizes"`
	Biomes  []string `json:"biomes"`
	Form    string   `json:"form"`
}

// The places in a generic's form.
const (
	SpecificSlot = "{specific}"
	IslandSlot   = "{island}"
)

// Specific is a part that combines with the generics of the classes it
// takes.
type Specific struct {
	Specific string   `json:"specific"`
	Takes    []string `json:"takes"`
	Biomes   []string `json:"biomes"`
	Zones    []string `json:"zones"`
	Tone     string   `json:"tone"`
}

// DB is the names.
type DB struct {
	Islands   []Island   `json:"islands"`
	Groups    []Group    `json:"groups"`
	Generics  []Generic  `json:"generics"`
	Specifics []Specific `json:"specifics"`
	// AvoidWords are banned anywhere in a name, as whole words in any
	// case; AvoidNames are banned as they are and with any other generic.
	AvoidWords []string `json:"avoidWords"`
	AvoidNames []string `json:"avoidNames"`

	index *index
}

// index is what Banned looks names up in, worked out once.
type index struct {
	words    map[string]bool // the banned words, in lower case
	names    map[string]bool // the banned names, in lower case
	cores    map[string]bool // and their cores
	generics map[string]bool // the generic words, in lower case
}

// prepare works out the index.
func (db *DB) prepare() {
	ix := &index{words: map[string]bool{}, names: map[string]bool{}, cores: map[string]bool{}, generics: map[string]bool{}}
	for _, w := range db.genericWords() {
		ix.generics[strings.ToLower(w)] = true
	}
	db.index = ix
	for _, w := range db.AvoidWords {
		ix.words[strings.ToLower(w)] = true
	}
	for _, n := range db.AvoidNames {
		ix.names[strings.ToLower(n)] = true
		if c := db.core(n); c != "" {
			ix.cores[c] = true
		}
	}
}

// The files, under shared/catalog/names.
const (
	IslandsFile   = "islands.csv"
	GroupsFile    = "island-groups.csv"
	GenericsFile  = "generics.csv"
	SpecificsFile = "specifics.csv"
	AvoidFile     = "avoid.txt"
)

// Files are the files Parse reads, in order.
var Files = []string{IslandsFile, GroupsFile, GenericsFile, SpecificsFile, AvoidFile}

// Each file's columns.
var columns = map[string][]string{
	IslandsFile:   {"name", "size", "biomes", "needs", "zone", "tone", "note"},
	GroupsFile:    {"name", "count", "biomes", "zone", "tone", "note"},
	GenericsFile:  {"generic", "class", "size", "biomes", "form", "note"},
	SpecificsFile: {"specific", "takes", "biomes", "zone", "tone", "note"},
}

//go:embed names.gen.json
var embedded []byte

// Load is the names built into the binary.
func Load() (*DB, error) {
	var db DB
	if err := json.Unmarshal(embedded, &db); err != nil {
		return nil, fmt.Errorf("names: %w", err)
	}
	db.prepare()
	return &db, nil
}

// Parse reads the names' files, by name.
func Parse(files map[string][]byte) (*DB, error) {
	var db DB
	rows := map[string][][]string{}
	for name, want := range columns {
		data, ok := files[name]
		if !ok {
			return nil, fmt.Errorf("names: no %s", name)
		}
		r := csv.NewReader(bytes.NewReader(data))
		r.FieldsPerRecord = len(want)
		all, err := r.ReadAll()
		if err != nil {
			return nil, fmt.Errorf("names: %s: %w", name, err)
		}
		if len(all) == 0 || !slices.Equal(all[0], want) {
			return nil, fmt.Errorf("names: %s: the columns must be %s", name, strings.Join(want, ","))
		}
		rows[name] = all[1:]
	}
	for _, r := range rows[IslandsFile] {
		db.Islands = append(db.Islands, Island{Name: r[0], Sizes: list(r[1]), Biomes: list(r[2]), Needs: list(r[3]), Zones: list(r[4]), Tone: r[5], Note: r[6]})
	}
	for i, r := range rows[GroupsFile] {
		lo, hi, err := countOf(r[1])
		if err != nil {
			return nil, fmt.Errorf("names: %s row %d (%s): %w", GroupsFile, i+2, r[0], err)
		}
		db.Groups = append(db.Groups, Group{Name: r[0], Count: [2]int{lo, hi}, Biomes: list(r[2]), Zones: list(r[3]), Tone: r[4], Note: r[5]})
	}
	for _, r := range rows[GenericsFile] {
		db.Generics = append(db.Generics, Generic{Generic: r[0], Class: r[1], Sizes: list(r[2]), Biomes: list(r[3]), Form: r[4]})
	}
	for _, r := range rows[SpecificsFile] {
		db.Specifics = append(db.Specifics, Specific{Specific: r[0], Takes: list(r[1]), Biomes: list(r[2]), Zones: list(r[3]), Tone: r[4]})
	}
	avoid, ok := files[AvoidFile]
	if !ok {
		return nil, fmt.Errorf("names: no %s", AvoidFile)
	}
	for line := range strings.Lines(string(avoid)) {
		line = strings.TrimSpace(line)
		switch {
		case line == "" || strings.HasPrefix(line, "#"):
		case strings.HasPrefix(line, "word:"):
			db.AvoidWords = append(db.AvoidWords, strings.TrimSpace(strings.TrimPrefix(line, "word:")))
		default:
			db.AvoidNames = append(db.AvoidNames, line)
		}
	}
	db.prepare()
	return &db, nil
}

// list splits a field's list; an empty field is none.
func list(field string) []string {
	if field = strings.TrimSpace(field); field == "" {
		return []string{}
	}
	parts := strings.Split(field, ";")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

// countOf reads a group's count: "4-8" or "7".
func countOf(field string) (lo, hi int, err error) {
	a, b, ranged := strings.Cut(field, "-")
	if lo, err = strconv.Atoi(a); err != nil {
		return 0, 0, fmt.Errorf("count %q is not a number or a range", field)
	}
	hi = lo
	if ranged {
		if hi, err = strconv.Atoi(b); err != nil {
			return 0, 0, fmt.Errorf("count %q is not a number or a range", field)
		}
	}
	if lo < 1 || hi < lo {
		return 0, 0, fmt.Errorf("count %q runs from %d to %d", field, lo, hi)
	}
	return lo, hi, nil
}

// Combine is a specific in a generic's form.
func Combine(g *Generic, specific string) string {
	return strings.ReplaceAll(g.Form, SpecificSlot, specific)
}

// Banned reports whether the avoid list bans a name: one of its words is a
// banned word, or it is a banned name, or one with another generic.
func (db *DB) Banned(name string) bool {
	if db.index == nil {
		db.prepare()
	}
	for _, w := range words(name) {
		if db.index.words[strings.ToLower(w)] {
			return true
		}
	}
	if db.index.names[strings.ToLower(name)] {
		return true
	}
	c := db.core(name)
	return c != "" && db.index.cores[c]
}

// words are a name's words: its letters, digits and apostrophes, split at
// everything else.
func words(name string) []string {
	return strings.FieldsFunc(name, func(r rune) bool {
		return !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == '\'' || r == '’')
	})
}

// genericWords are the words a name may differ by and still be the same
// name: every generic's, singular and plural.
func (db *DB) genericWords() []string {
	var out []string
	for _, g := range db.Generics {
		for _, w := range words(strings.ReplaceAll(strings.ReplaceAll(g.Form, SpecificSlot, ""), IslandSlot, "")) {
			out = append(out, w, w+"s")
		}
		out = append(out, g.Generic, g.Generic+"s")
	}
	return append(out, "Isley", "Atoll", "Keys", "Islands")
}

// core is a name without a generic word at its start or its end, in lower
// case; "" if nothing is left.
func (db *DB) core(name string) string {
	if db.index == nil {
		db.prepare()
	}
	ws := words(name)
	isGeneric := func(w string) bool { return db.index.generics[strings.ToLower(w)] }
	if len(ws) > 1 && isGeneric(ws[len(ws)-1]) {
		ws = ws[:len(ws)-1]
	}
	if len(ws) > 1 && isGeneric(ws[0]) {
		ws = ws[1:]
	}
	return strings.ToLower(strings.Join(ws, " "))
}

// Vocabulary is what a name's tags may hold.
type Vocabulary struct {
	Sizes    []string // the size classes
	Biomes   []string // the biomes' ids
	Features []string // the features' words
	Zones    []string // the zones
	Tones    []string // the tones' words
	Partners [][2]string
	Reserved []string // names no place but its own may have: the main port's
}

// Check lists what is wrong with the names: tags outside the vocabulary, a
// name twice, a generic whose form has no place to fill, a specific taking
// no class there is, a banned name or combination, a partner that is not a
// name, a reserved name the avoid list does not ban.
func (db *DB) Check(v Vocabulary) []string {
	var problems []string
	bad := func(format string, args ...any) { problems = append(problems, fmt.Sprintf(format, args...)) }
	tags := func(where, field string, got, allowed []string, any bool) {
		if len(got) == 0 && field != "needs" {
			bad("%s: no %s", where, field)
		}
		for _, t := range got {
			if !(slices.Contains(allowed, t) || any && t == Any) {
				bad("%s: %s %q is not one of %s", where, field, t, strings.Join(allowed, ", "))
			}
			if t == Any && len(got) > 1 {
				bad("%s: %s lists %q beside others", where, field, Any)
			}
		}
	}
	seen := map[string]string{}
	once := func(where, name string) {
		key := strings.ToLower(name)
		if prev, ok := seen[key]; ok {
			bad("%s: %q is also %s", where, name, prev)
		}
		seen[key] = where
	}
	tone := func(where, t string) {
		if !slices.Contains(v.Tones, t) {
			bad("%s: tone %q is not one of %s", where, t, strings.Join(v.Tones, ", "))
		}
	}
	for i, n := range db.Islands {
		where := fmt.Sprintf("%s row %d (%s)", IslandsFile, i+2, n.Name)
		once(where, n.Name)
		tags(where, "size", n.Sizes, v.Sizes, false)
		tags(where, "biomes", n.Biomes, v.Biomes, true)
		tags(where, "needs", n.Needs, v.Features, false)
		tags(where, "zone", n.Zones, v.Zones, true)
		tone(where, n.Tone)
		if db.Banned(n.Name) {
			bad("%s: the avoid list bans it", where)
		}
	}
	for i, g := range db.Groups {
		where := fmt.Sprintf("%s row %d (%s)", GroupsFile, i+2, g.Name)
		once(where, g.Name)
		tags(where, "biomes", g.Biomes, v.Biomes, true)
		tags(where, "zone", g.Zones, v.Zones, true)
		tone(where, g.Tone)
		if db.Banned(g.Name) {
			bad("%s: the avoid list bans it", where)
		}
	}
	var classes []string
	for i, g := range db.Generics {
		where := fmt.Sprintf("%s row %d (%s)", GenericsFile, i+2, g.Generic)
		tags(where, "size", g.Sizes, v.Sizes, false)
		tags(where, "biomes", g.Biomes, v.Biomes, true)
		if strings.Count(g.Form, SpecificSlot)+strings.Count(g.Form, IslandSlot) != 1 {
			bad("%s: form %q must hold %s or %s once", where, g.Form, SpecificSlot, IslandSlot)
		}
		if !slices.Contains(classes, g.Class) {
			classes = append(classes, g.Class)
		}
	}
	specs := map[string]bool{}
	for i, s := range db.Specifics {
		where := fmt.Sprintf("%s row %d (%s)", SpecificsFile, i+2, s.Specific)
		if specs[strings.ToLower(s.Specific)] {
			bad("%s: %q twice", where, s.Specific)
		}
		specs[strings.ToLower(s.Specific)] = true
		tags(where, "takes", s.Takes, classes, false)
		tags(where, "biomes", s.Biomes, v.Biomes, true)
		tags(where, "zone", s.Zones, v.Zones, true)
		tone(where, s.Tone)
		for _, g := range db.Generics {
			if slices.Contains(s.Takes, g.Class) && strings.Contains(g.Form, SpecificSlot) {
				if name := Combine(&g, s.Specific); db.Banned(name) {
					bad("%s: the avoid list bans %q", where, name)
				}
			}
		}
	}
	for _, p := range v.Partners {
		for _, n := range p {
			if !slices.ContainsFunc(db.Islands, func(i Island) bool { return i.Name == n }) {
				bad("partner %q is not a name in %s", n, IslandsFile)
			}
		}
	}
	for _, r := range v.Reserved {
		if !db.Banned(r) {
			bad("%s does not ban the reserved name %q", AvoidFile, r)
		}
	}
	return problems
}

// Encode writes db as names.gen.json holds it: each list's entries a line
// apiece, so that a change to the names shows in a diff as the lines it
// changes.
func Encode(w io.Writer, db *DB) error {
	var b bytes.Buffer
	b.WriteString("{\n")
	lists := []struct {
		key  string
		list any
	}{
		{"islands", db.Islands}, {"groups", db.Groups}, {"generics", db.Generics},
		{"specifics", db.Specifics}, {"avoidWords", db.AvoidWords}, {"avoidNames", db.AvoidNames},
	}
	for i, l := range lists {
		raw, err := json.Marshal(l.list)
		if err != nil {
			return err
		}
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return err
		}
		fmt.Fprintf(&b, "%q: [\n", l.key)
		for j, it := range items {
			b.Write(it)
			if j < len(items)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString("]")
		if i < len(lists)-1 {
			b.WriteByte(',')
		}
		b.WriteByte('\n')
	}
	b.WriteString("}\n")
	_, err := w.Write(b.Bytes())
	return err
}
