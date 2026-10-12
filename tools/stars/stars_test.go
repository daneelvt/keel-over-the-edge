// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

const root = "../.."

func load(t *testing.T) ([]Star, *catalog.Catalog) {
	t.Helper()
	all, err := readCatalogue(root)
	if err != nil {
		t.Fatal(err)
	}
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return all, c
}

func TestCatalogue(t *testing.T) {
	all, _ := load(t)
	// 9,110 entries, of which 14 are not stars.
	if len(all) != 9096 {
		t.Errorf("the catalogue has %d stars with a place, want 9096", len(all))
	}
	for _, s := range all {
		if s.Number == 2491 { // α Canis Majoris
			if math.Abs(s.RA-101.28708) > 1e-4 || math.Abs(s.Dec+16.71611) > 1e-4 || s.Magnitude != -1.46 || s.Colour != 0 || !s.HasColour {
				t.Errorf("Sirius read as %+v", s)
			}
		}
	}
}

func TestTheTableIsCurrent(t *testing.T) {
	if err := run(root, true, io.Discard); err != nil {
		t.Fatal(err)
	}
}

func TestChosenStars(t *testing.T) {
	all, c := load(t)
	stars, few := choose(all, c.Sky.Stars)
	if len(stars) != 2360 || few != 1336 {
		t.Errorf("%d stars, the first %d the brightest; want 2360 and 1336", len(stars), few)
	}
	hubs := 0
	for i, s := range stars {
		if s.Dec < Southernmost {
			t.Errorf("HR %d is at %v°, south of %v°", s.Number, s.Dec, Southernmost)
		}
		if i > 0 && s.Magnitude < stars[i-1].Magnitude {
			t.Fatalf("star %d (HR %d) is brighter than the one before it", i, s.Number)
		}
		if (i < few) != (s.Magnitude <= FaintestFew) {
			t.Fatalf("star %d of magnitude %v is on the wrong side of the first %d", i, s.Magnitude, few)
		}
		if s.Dec == 90 {
			hubs++
			if s.Number != c.Sky.Stars[0].Number {
				t.Errorf("HR %d is at the pole", s.Number)
			}
		}
	}
	if hubs != 1 {
		t.Errorf("%d stars at the pole, want the Hub Star alone", hubs)
	}
}

func TestEncoding(t *testing.T) {
	all, c := load(t)
	stars, _ := choose(all, c.Sky.Stars)
	table := encode(stars)
	if len(table) != EntrySize*len(stars) {
		t.Fatalf("the table is %d bytes for %d stars", len(table), len(stars))
	}
	committed, err := os.ReadFile(filepath.Join(root, tablePath))
	if err != nil || !bytes.Equal(committed, table) {
		t.Errorf("%s is not what the tool writes (%v)", tablePath, err)
	}
	for i, s := range stars {
		e := table[i*EntrySize:]
		ra := float64(binary.LittleEndian.Uint16(e)) / 65536 * 360
		dec := float64(binary.LittleEndian.Uint16(e[2:]))/65535*180 - 90
		mag := float64(e[4])/32 - 2
		bv := float64(e[5])/80 - 0.5
		// A place to 20 seconds of arc.
		if d := math.Abs(math.Remainder(ra-s.RA, 360)); d > 0.0056 || math.Abs(dec-s.Dec) > 0.0056 {
			t.Fatalf("HR %d decodes to %v°, %v°; it is at %v°, %v°", s.Number, ra, dec, s.RA, s.Dec)
		}
		// The colour stops at the byte's end.
		if math.Abs(mag-s.Magnitude) > 0.016 || math.Abs(bv-math.Min(s.Colour, 255.0/80-0.5)) > 0.0063 {
			t.Fatalf("HR %d decodes to magnitude %v, B−V %v; it has %v, %v", s.Number, mag, bv, s.Magnitude, s.Colour)
		}
		if s.Dec == 90 && dec != 90 {
			t.Errorf("the Hub Star decodes to %v°, not the pole", dec)
		}
	}
}

func TestNamedStars(t *testing.T) {
	all, c := load(t)
	if err := checkNamed(all, c.Sky.Stars); err != nil {
		t.Fatal(err)
	}
	if len(c.Sky.Stars) != 22 {
		t.Errorf("%d named stars", len(c.Sky.Stars))
	}
	for name, change := range map[string]func(*catalog.NamedStar){
		"at 38.80":      func(n *catalog.NamedStar) { n.Declination += 0.02 },
		"at 279.27":     func(n *catalog.NamedStar) { n.RightAscension += 0.04 },
		"magnitude 0.1": func(n *catalog.NamedStar) { n.Magnitude = 0.1 },
		"no star HR":    func(n *catalog.NamedStar) { n.Number = 9111 },
	} {
		stars := append([]catalog.NamedStar{}, c.Sky.Stars...)
		for i := range stars {
			if stars[i].Number == 7001 { // α Lyrae
				change(&stars[i])
			}
		}
		if err := checkNamed(all, stars); err == nil || !strings.Contains(err.Error(), "Vega") {
			t.Errorf("%s: %v", name, err)
		}
	}
	// The Hub Star alone is not where the catalogue has it.
	hub := c.Sky.Stars[0]
	for _, s := range all {
		if s.Number == hub.Number && math.Abs(90-s.Dec-0.736) > 0.001 {
			t.Errorf("the Pole Star is %v° from the pole in the catalogue", 90-s.Dec)
		}
	}
}

func TestAnotherFileIsRefused(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, sourceDir), 0o755); err != nil {
		t.Fatal(err)
	}
	for name := range sums {
		data, err := os.ReadFile(filepath.Join(root, sourceDir, name))
		if err != nil {
			t.Fatal(err)
		}
		if name == readMeFile {
			data = append(data, '\n')
		}
		if err := os.WriteFile(filepath.Join(dir, sourceDir, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := readCatalogue(dir); err == nil || !strings.Contains(err.Error(), "not the file as published") {
		t.Errorf("a changed ReadMe: %v", err)
	}
}
