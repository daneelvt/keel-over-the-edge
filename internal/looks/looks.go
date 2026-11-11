// SPDX-License-Identifier: AGPL-3.0-only

// Package looks is a sailor's look as the catalog offers it: a look and its
// version with a skin, a hair colour and a main colour for a person; a
// version, a finish and a main colour for a machine sailor. It checks a
// look against the catalog, packs it into the look code the simulation and
// the wire carry, draws one at random, and says it in words.
//
// The look code is one number, five fields of 4 bits from the low end: the
// look's place among the catalog's sailors (Machine for a machine), the
// version's, the skin's (a machine's finish), the hair's (0 for a machine)
// and the main colour's. Each is a place in its catalog list, so the code
// means what it means only under the catalog it was made with, as
// everything on the wire does.
package looks

import (
	"encoding/binary"
	"math/rand/v2"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// MachineMark is a look code's first field for a machine sailor's look.
const MachineMark = 15

// Book is the catalog's looks and options, as they are checked, coded and
// said.
type Book struct {
	sailors []catalog.Sailor
	opts    catalog.SailorOptions
	machine catalog.Machine
}

// New is the book of the catalog's looks.
func New(cat *catalog.Catalog) *Book {
	return &Book{sailors: cat.Sailors, opts: cat.SailorOptions, machine: cat.Machine}
}

func find[T any](list []T, id string, idOf func(*T) catalog.ID) int {
	for i := range list {
		if string(idOf(&list[i])) == id {
			return i
		}
	}
	return -1
}

func versionID(v *catalog.SailorVersion) catalog.ID { return v.ID }
func optionID(o *catalog.SailorOption) catalog.ID   { return o.ID }
func sailorID(s *catalog.Sailor) catalog.ID         { return s.ID }

// hairs is the set a look's hair colour is chosen from.
func (b *Book) hairs(s *catalog.Sailor) []catalog.SailorOption {
	if s.Hair == catalog.HairGreys {
		return b.opts.Greys
	}
	return b.opts.Hairs
}

// places are a look's places in the catalog's lists, the look code's
// fields; ok is false for a look not made of the catalog's choices.
func (b *Book) places(l store.Look) (p [5]int, ok bool) {
	if l.Look == store.MachineLook {
		p = [5]int{MachineMark, find(b.machine.Versions, l.Version, versionID), find(b.machine.Finishes, l.Finish, optionID),
			0, find(b.opts.Colours, l.Colour, optionID)}
		return p, p[1] >= 0 && p[2] >= 0 && p[4] >= 0 && l.Skin == "" && l.Hair == ""
	}
	i := find(b.sailors, l.Look, sailorID)
	if i < 0 {
		return p, false
	}
	s := &b.sailors[i]
	p = [5]int{i, find(s.Versions, l.Version, versionID), find(b.opts.Skins, l.Skin, optionID),
		find(b.hairs(s), l.Hair, optionID), find(b.opts.Colours, l.Colour, optionID)}
	return p, p[1] >= 0 && p[2] >= 0 && p[3] >= 0 && p[4] >= 0 && l.Finish == ""
}

// Valid reports whether l is made of the catalog's choices: a look of its
// sailors with a version, skin, hair and colour of their sets, or a
// machine's version, finish and colour.
func (b *Book) Valid(l store.Look) bool {
	_, ok := b.places(l)
	return ok
}

// Code is l's look code; 0 for a look not made of the catalog's choices.
func (b *Book) Code(l store.Look) uint32 {
	p, ok := b.places(l)
	if !ok {
		return 0
	}
	var c uint32
	for k, v := range p {
		c |= uint32(v&15) << (4 * k)
	}
	return c
}

// Of is the look a code names, and false for a code that names none.
func (b *Book) Of(code uint32) (store.Look, bool) {
	var p [5]int
	for k := range p {
		p[k] = int(code >> (4 * k) & 15)
	}
	if code>>20 != 0 {
		return store.Look{}, false
	}
	at := func(list []catalog.SailorOption, i int) (string, bool) {
		if i >= len(list) {
			return "", false
		}
		return string(list[i].ID), true
	}
	var l store.Look
	var ok [4]bool
	if p[0] == MachineMark {
		if p[1] >= len(b.machine.Versions) || p[3] != 0 {
			return store.Look{}, false
		}
		l.Look, l.Version = store.MachineLook, string(b.machine.Versions[p[1]].ID)
		l.Finish, ok[0] = at(b.machine.Finishes, p[2])
		ok[1] = true
	} else {
		if p[0] >= len(b.sailors) || p[1] >= len(b.sailors[p[0]].Versions) {
			return store.Look{}, false
		}
		s := &b.sailors[p[0]]
		l.Look, l.Version = string(s.ID), string(s.Versions[p[1]].ID)
		l.Skin, ok[0] = at(b.opts.Skins, p[2])
		l.Hair, ok[1] = at(b.hairs(s), p[3])
	}
	l.Colour, ok[2] = at(b.opts.Colours, p[4])
	return l, ok[0] && ok[1] && ok[2]
}

// Draw is a person's look at random, from seed: any look and version, and
// any of their options, each as likely.
func (b *Book) Draw(seed uint64) store.Look {
	r := rand.New(rand.NewPCG(seed, 0x6c6f6f6b))
	s := &b.sailors[r.IntN(len(b.sailors))]
	hairs := b.hairs(s)
	return store.Look{
		Look: string(s.ID), Version: string(s.Versions[r.IntN(len(s.Versions))].ID),
		Skin: string(b.opts.Skins[r.IntN(len(b.opts.Skins))].ID), Hair: string(hairs[r.IntN(len(hairs))].ID),
		Colour: string(b.opts.Colours[r.IntN(len(b.opts.Colours))].ID),
	}
}

// DrawMachine is a machine sailor's look at random, from seed.
func (b *Book) DrawMachine(seed uint64) store.Look {
	r := rand.New(rand.NewPCG(seed, 0x6d616368))
	m := &b.machine
	return store.Look{
		Look: store.MachineLook, Version: string(m.Versions[r.IntN(len(m.Versions))].ID),
		Finish: string(m.Finishes[r.IntN(len(m.Finishes))].ID), Colour: string(b.opts.Colours[r.IntN(len(b.opts.Colours))].ID),
	}
}

// SeedOf is the seed an account's drawn look is drawn from: the same for
// the account every time.
func SeedOf(id store.AccountID) uint64 {
	return binary.LittleEndian.Uint64(id[:8]) ^ binary.LittleEndian.Uint64(id[8:])
}

// Resolve is an account's look as the game shows it: l if it is made of the
// catalog's choices; else, for a sailor made before looks were chosen or
// whose look the catalog no longer has, one drawn for the account, the
// same every time, and not chosen.
func (b *Book) Resolve(id store.AccountID, l store.Look) store.Look {
	if b.Valid(l) {
		return l
	}
	if l.Look == store.MachineLook {
		d := b.DrawMachine(SeedOf(id))
		d.Chosen = l.Chosen
		return d
	}
	return b.Draw(SeedOf(id))
}

// names are a look's choices' names: its look's, its version's, its main
// colour's, and the skin's and hair's, or the finish's.
func (b *Book) names(l store.Look) (look, version, colour, skin, hair, finish string) {
	name := func(list []catalog.SailorOption, id string) string {
		if i := find(list, id, optionID); i >= 0 {
			return list[i].Name
		}
		return ""
	}
	colour = name(b.opts.Colours, l.Colour)
	if l.Look == store.MachineLook {
		if i := find(b.machine.Versions, l.Version, versionID); i >= 0 {
			version = b.machine.Versions[i].Name
		}
		return "machine", version, colour, "", "", name(b.machine.Finishes, l.Finish)
	}
	i := find(b.sailors, l.Look, sailorID)
	if i < 0 {
		return "", "", colour, "", "", ""
	}
	s := &b.sailors[i]
	if j := find(s.Versions, l.Version, versionID); j >= 0 {
		version = s.Versions[j].Name
	}
	return s.Name, version, colour, name(b.opts.Skins, l.Skin), name(b.hairs(s), l.Hair), ""
}

// Words are a look in words, as an image's alternative text says it:
// "Old Salt, female, indigo navy, Tone 5, silver"; "Machine, male, brass,
// sea green".
func (b *Book) Words(l store.Look) string {
	look, version, colour, skin, hair, finish := b.names(l)
	if l.Look == store.MachineLook {
		return join("Machine", version, finish, colour)
	}
	return join(look, version, colour, skin, hair)
}

func join(parts ...string) string {
	out := parts[:0]
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, ", ")
}

// Seen is a look as another sailor sees it across the water: "a Cavalier
// in madder red"; "a brass machine sailor in sea green".
func (b *Book) Seen(l store.Look) string {
	look, _, colour, _, _, finish := b.names(l)
	if l.Look == store.MachineLook {
		return strings.TrimSpace(article(finish) + " " + finish + " machine sailor in " + colour)
	}
	if look == "" {
		return "a sailor"
	}
	return article(look) + " " + look + " in " + colour
}

// article is "an" before a vowel's sound, else "a".
func article(word string) string {
	if word != "" && strings.ContainsRune("AEIOUaeiou", rune(word[0])) {
		return "an"
	}
	return "a"
}

// Habit is what a look's sailor does now and then in a calm, in words.
func (b *Book) Habit(l store.Look) string {
	if l.Look == store.MachineLook {
		return b.machine.Habit
	}
	if i := find(b.sailors, l.Look, sailorID); i >= 0 {
		return b.sailors[i].Habit
	}
	return ""
}

// Choice is one choice of a look's option: its id, its name as the player
// reads it and its colour, sRGB.
type Choice struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Colour string `json:"colour,omitempty"`
}

// MachineChoices are the choices a machine sailor's look is made from, as
// the approval page offers them.
type MachineChoices struct {
	Versions []Choice `json:"versions"`
	Finishes []Choice `json:"finishes"`
	Colours  []Choice `json:"colours"`
}

// Machines are the choices a machine sailor's look is made from.
func (b *Book) Machines() MachineChoices {
	opts := func(list []catalog.SailorOption) []Choice {
		out := make([]Choice, len(list))
		for i, o := range list {
			out[i] = Choice{ID: string(o.ID), Name: o.Name, Colour: o.Colour}
		}
		return out
	}
	versions := make([]Choice, len(b.machine.Versions))
	for i, v := range b.machine.Versions {
		versions[i] = Choice{ID: string(v.ID), Name: v.Name}
	}
	return MachineChoices{Versions: versions, Finishes: opts(b.machine.Finishes), Colours: opts(b.opts.Colours)}
}

// Begin is POST /account/begin's body for a new sailor of a name and look,
// whose player was born in January 1990.
func Begin(name string, l store.Look) map[string]any {
	return map[string]any{"name": name, "look": l.Look, "version": l.Version, "skin": l.Skin, "hair": l.Hair, "colour": l.Colour,
		"born": map[string]int{"year": 1990, "month": 1}}
}
