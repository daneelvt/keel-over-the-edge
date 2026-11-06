// SPDX-License-Identifier: AGPL-3.0-only

package looks

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

func book(t *testing.T) (*Book, *catalog.Catalog) {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return New(cat), cat
}

// Every look and version, with every option, codes and decodes to itself,
// and no two code the same.
func TestCodes(t *testing.T) {
	b, cat := book(t)
	seen := map[uint32]store.Look{}
	add := func(l store.Look) {
		if !b.Valid(l) {
			t.Fatalf("%+v is not valid", l)
		}
		c := b.Code(l)
		if c >= 1<<20 {
			t.Fatalf("%+v codes to %d, over 20 bits", l, c)
		}
		if other, dup := seen[c]; dup {
			t.Fatalf("%+v and %+v both code to %d", l, other, c)
		}
		seen[c] = l
		back, ok := b.Of(c)
		if !ok || back != l {
			t.Fatalf("%d decodes to %+v %v, want %+v", c, back, ok, l)
		}
	}
	opts := &cat.SailorOptions
	for _, s := range cat.Sailors {
		hairs := opts.Hairs
		if s.Hair == catalog.HairGreys {
			hairs = opts.Greys
		}
		for _, v := range s.Versions {
			for _, sk := range opts.Skins {
				for _, h := range hairs {
					for _, c := range opts.Colours {
						add(store.Look{Look: string(s.ID), Version: string(v.ID), Skin: string(sk.ID), Hair: string(h.ID), Colour: string(c.ID)})
					}
				}
			}
		}
	}
	for _, v := range cat.Machine.Versions {
		for _, f := range cat.Machine.Finishes {
			for _, c := range opts.Colours {
				add(store.Look{Look: store.MachineLook, Version: string(v.ID), Finish: string(f.ID), Colour: string(c.ID)})
			}
		}
	}
	// Seven looks of six hair colours, two of four greys; the machines.
	if len(seen) != 7*2*6*6*8+2*2*6*4*8+2*4*8 {
		t.Fatalf("%d looks", len(seen))
	}
}

func TestInvalid(t *testing.T) {
	b, cat := book(t)
	good := b.Draw(1)
	for name, l := range map[string]store.Look{
		"no look":           {},
		"an unknown look":   {Look: "nobody", Version: good.Version, Skin: good.Skin, Hair: good.Hair, Colour: good.Colour},
		"no skin":           {Look: good.Look, Version: good.Version, Hair: good.Hair, Colour: good.Colour},
		"a finish":          {Look: good.Look, Version: good.Version, Skin: good.Skin, Hair: good.Hair, Colour: good.Colour, Finish: string(cat.Machine.Finishes[0].ID)},
		"a machine's skin":  {Look: store.MachineLook, Version: "female", Finish: string(cat.Machine.Finishes[0].ID), Colour: good.Colour, Skin: good.Skin},
		"a machine, no fin": {Look: store.MachineLook, Version: "female", Colour: good.Colour},
	} {
		if b.Valid(l) || b.Code(l) != 0 {
			t.Errorf("%s: valid", name)
		}
	}
	// A grey on a look of colours, and a colour on a look of greys.
	for _, s := range cat.Sailors {
		wrong := cat.SailorOptions.Greys[0].ID
		if s.Hair == catalog.HairGreys {
			wrong = cat.SailorOptions.Hairs[0].ID
		}
		if wrong == cat.SailorOptions.Greys[0].ID && s.Hair == catalog.HairColours {
			l := store.Look{Look: string(s.ID), Version: string(s.Versions[0].ID), Skin: good.Skin, Hair: string(wrong), Colour: good.Colour}
			if b.Valid(l) {
				t.Errorf("%s with %s hair", s.ID, wrong)
			}
		}
	}
	for _, c := range []uint32{1 << 20, 14, 0xF | 9<<4} {
		if l, ok := b.Of(c); ok {
			t.Errorf("code %#x names %+v", c, l)
		}
	}
}

// Drawn looks are every look's and version's, each a valid look; the same
// seed draws the same; an account's drawn look is its own every time.
func TestDraw(t *testing.T) {
	b, cat := book(t)
	looks := map[string]bool{}
	for seed := range uint64(2000) {
		l := b.Draw(seed)
		if !b.Valid(l) || l.Chosen {
			t.Fatalf("seed %d drew %+v", seed, l)
		}
		looks[l.Look+" "+l.Version] = true
		if m := b.DrawMachine(seed); !b.Valid(m) {
			t.Fatalf("seed %d drew the machine %+v", seed, m)
		}
	}
	if len(looks) != 2*len(cat.Sailors) {
		t.Fatalf("%d of the looks and versions drawn", len(looks))
	}
	if a, again := b.Draw(7), b.Draw(7); a != again {
		t.Fatal("a seed drew two looks")
	}
	id := store.AccountID{1, 2, 3}
	old := store.Look{Look: "stand-in"}
	if got := b.Resolve(id, old); got != b.Resolve(id, old) || !b.Valid(got) || got.Chosen {
		t.Fatalf("resolved %+v", got)
	}
	chosen := b.Draw(3)
	chosen.Chosen = true
	if b.Resolve(id, chosen) != chosen {
		t.Fatal("a valid look resolved to another")
	}
}

func TestWords(t *testing.T) {
	b, _ := book(t)
	l := store.Look{Look: "oldsalt", Version: "female", Skin: "tone-5", Hair: "silver", Colour: "indigo-navy"}
	if got := b.Words(l); got != "Old Salt, female, indigo navy, Tone 5, silver" {
		t.Errorf("words %q", got)
	}
	if got := b.Seen(l); got != "an Old Salt in indigo navy" {
		t.Errorf("seen %q", got)
	}
	m := store.Look{Look: store.MachineLook, Version: "male", Finish: "brass", Colour: "sea-green"}
	if got := b.Words(m); got != "Machine, male, brass, sea green" {
		t.Errorf("words %q", got)
	}
	if got := b.Seen(m); got != "a brass machine sailor in sea green" {
		t.Errorf("seen %q", got)
	}
	if got := b.Seen(store.Look{Look: "cavalier", Version: "male", Skin: "tone-1", Hair: "black", Colour: "madder-red"}); got != "a Cavalier in madder red" {
		t.Errorf("seen %q", got)
	}
	if b.Habit(l) == "" || b.Habit(m) == "" {
		t.Error("no habit")
	}
}
