// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

// The Bright Star Catalogue, 5th Revised Edition (Preliminary Version), by
// D. Hoffleit and W. H. Warren Jr. (1991), Astronomical Data Center,
// NSSDC/ADC: catalogue V/50 of the Centre de Données astronomiques de
// Strasbourg, https://cdsarc.cds.unistra.fr/ftp/cats/V/50/. The two files
// are kept here exactly as CDS publishes them.
const (
	sourceDir     = "tools/stars/bsc5"
	catalogueFile = "catalog.gz"
	readMeFile    = "ReadMe"
	tablePath     = "client/src/sky/stars.bin"
)

// sums are the SHA-256 of the files as published.
var sums = map[string]string{
	catalogueFile: "3dc44b1e90be8fbe5bcc7656032560f51275f985c7e3f783c9028e1838ec7bed",
	readMeFile:    "44fd9c73e2eecad0beb47bdfa3f01c60fd43f93d6964198e31fcd48732de5b33",
}

const (
	// Faintest is the faintest star drawn: the naked eye sees to about
	// magnitude 6 under a dark sky, and a phone's screen shows less.
	Faintest = 5.5
	// FaintestFew is the faintest drawn where fewer are: the table is in
	// order of brightness, so these are its first stars.
	FaintestFew = 5.0
	// Southernmost is the declination below which a star is never seen
	// from the disk: at the rim, 45° from the pole, the horizon reaches
	// down to it.
	Southernmost = -45.0
	// EntrySize is the bytes of a star in the table.
	EntrySize = 6
	// A missing colour index is taken as this: a white star's.
	plainColour = 0.5
)

// Star is an entry of the catalogue: its number there (HR), its J2000
// place in degrees, its visual magnitude and its B−V colour index.
type Star struct {
	Number    int
	Name      string
	RA, Dec   float64
	Magnitude float64
	Colour    float64
	HasColour bool
}

// readCatalogue reads the catalogue under root, checking it is the file
// as published.
func readCatalogue(root string) ([]Star, error) {
	for name, want := range sums {
		data, err := os.ReadFile(filepath.Join(root, sourceDir, name))
		if err != nil {
			return nil, err
		}
		sum := sha256.Sum256(data)
		if got := hex.EncodeToString(sum[:]); got != want {
			return nil, fmt.Errorf("%s/%s has SHA-256 %s, not %s: it is not the file as published", sourceDir, name, got, want)
		}
	}
	f, err := os.Open(filepath.Join(root, sourceDir, catalogueFile))
	if err != nil {
		return nil, err
	}
	defer f.Close()
	z, err := gzip.NewReader(f)
	if err != nil {
		return nil, err
	}
	data, err := io.ReadAll(z)
	if err != nil {
		return nil, err
	}
	return parseCatalogue(data)
}

// parseCatalogue reads the catalogue's lines, by the byte-by-byte
// description in its ReadMe (columns counted from 1):
//
//	  1-  4  HR, the Bright Star Number
//	  5- 14  Name
//	 76- 83  right ascension, J2000: hours, minutes, seconds (F4.1)
//	 84- 90  declination, J2000: sign, degrees, arcminutes, arcseconds
//	103-107  Vmag, the visual magnitude
//	110-114  B-V
//
// The fourteen entries that are not stars have blank places, and are left
// out.
func parseCatalogue(data []byte) ([]Star, error) {
	var stars []Star
	for i, line := range strings.Split(string(data), "\n") {
		if len(line) < 107 || strings.TrimSpace(line[75:90]) == "" {
			continue
		}
		field := func(from, to int) (float64, error) {
			return strconv.ParseFloat(strings.TrimSpace(line[from-1:to]), 64)
		}
		var v [8]float64
		var err error
		for k, cols := range [][2]int{{1, 4}, {76, 77}, {78, 79}, {80, 83}, {85, 86}, {87, 88}, {89, 90}, {103, 107}} {
			if v[k], err = field(cols[0], cols[1]); err != nil {
				return nil, fmt.Errorf("the catalogue's line %d, columns %d to %d: %w", i+1, cols[0], cols[1], err)
			}
		}
		s := Star{
			Number:    int(v[0]),
			Name:      strings.TrimSpace(line[4:14]),
			RA:        (v[1] + v[2]/60 + v[3]/3600) * 15,
			Dec:       v[4] + v[5]/60 + v[6]/3600,
			Magnitude: v[7],
			Colour:    plainColour,
		}
		if line[83] == '-' {
			s.Dec = -s.Dec
		}
		if len(line) >= 114 && strings.TrimSpace(line[109:114]) != "" {
			if s.Colour, err = field(110, 114); err != nil {
				return nil, fmt.Errorf("the catalogue's line %d, B-V: %w", i+1, err)
			}
			s.HasColour = true
		}
		stars = append(stars, s)
	}
	if len(stars) == 0 {
		return nil, errors.New("the catalogue holds no stars")
	}
	return stars, nil
}

// choose returns the stars to draw: those no fainter than Faintest and
// north of Southernmost, the brightest first, the catalogue's order between
// equals; and how many of them are no fainter than FaintestFew. The star at
// the pole of the catalog's named stars is moved to the pole itself.
func choose(all []Star, named []catalog.NamedStar) (stars []Star, few int) {
	pole := map[int]bool{}
	for _, n := range named {
		if n.Declination == 90 {
			pole[n.Number] = true
		}
	}
	for _, s := range all {
		if s.Magnitude > Faintest || s.Dec < Southernmost {
			continue
		}
		if pole[s.Number] {
			s.Dec = 90
		}
		stars = append(stars, s)
	}
	sort.SliceStable(stars, func(i, j int) bool { return stars[i].Magnitude < stars[j].Magnitude })
	for _, s := range stars {
		if s.Magnitude <= FaintestFew {
			few++
		}
	}
	return stars, few
}

// encode writes the table: for each star, little-endian,
//
//	uint16  right ascension, in 65536ths of a turn
//	uint16  declination: 0 at −90°, 65535 at +90°
//	uint16  the low 10 bits the magnitude, in hundredths, 0 at −2; the
//	        high 6 bits B−V, in twentieths, 0 at −0.5
//
// A place is good to 20 seconds of arc, a magnitude as the catalogue gives
// it. The colour only tints a star, and stops at 2.65: the few redder
// carbon stars are drawn as red as that.
func encode(stars []Star) []byte {
	var b bytes.Buffer
	for _, s := range stars {
		ra := uint16(math.Mod(math.Round(s.RA/360*65536), 65536))
		dec := uint16(math.Round((s.Dec + 90) / 180 * 65535))
		b.Write(binary.LittleEndian.AppendUint16(binary.LittleEndian.AppendUint16(nil, ra), dec))
		mag := clamped((s.Magnitude+2)*100, 1023)
		colour := clamped((s.Colour+0.5)*20, 63)
		b.Write(binary.LittleEndian.AppendUint16(nil, mag|colour<<10))
	}
	return b.Bytes()
}

func clamped(v float64, most uint16) uint16 {
	return uint16(math.Max(0, math.Min(float64(most), math.Round(v))))
}

// Tolerances of a named star's entry in the game's catalog against the
// star catalogue's: degrees, and magnitudes.
const (
	placeTolerance     = 0.01
	magnitudeTolerance = 0.05
)

// checkNamed fails unless every named star of the game's catalog is the
// star catalogue's entry of its number, at its place and magnitude. The
// star at the pole is excepted in its declination: it is moved there.
func checkNamed(all []Star, named []catalog.NamedStar) error {
	byNumber := map[int]Star{}
	for _, s := range all {
		byNumber[s.Number] = s
	}
	var problems []string
	for _, n := range named {
		s, ok := byNumber[n.Number]
		if !ok {
			problems = append(problems, fmt.Sprintf("  %s: the catalogue has no star HR %d", n.Name, n.Number))
			continue
		}
		// A degree of right ascension is shorter toward the pole.
		ra := math.Abs(math.Remainder(n.RightAscension-s.RA, 360)) * math.Cos(s.Dec*math.Pi/180)
		dec := math.Abs(n.Declination - s.Dec)
		if n.Declination == 90 {
			dec = 0
		}
		if ra > placeTolerance || dec > placeTolerance {
			problems = append(problems, fmt.Sprintf("  %s (HR %d): at %.5f°, %+.5f°; the catalogue has %.5f°, %+.5f°", n.Name, n.Number, n.RightAscension, n.Declination, s.RA, s.Dec))
		}
		if math.Abs(n.Magnitude-s.Magnitude) > magnitudeTolerance {
			problems = append(problems, fmt.Sprintf("  %s (HR %d): magnitude %v; the catalogue has %v", n.Name, n.Number, n.Magnitude, s.Magnitude))
		}
		if s.Magnitude > Faintest || s.Dec < Southernmost {
			problems = append(problems, fmt.Sprintf("  %s (HR %d) is not among the stars drawn", n.Name, n.Number))
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("shared/catalog/sky.yaml's named stars against the Bright Star Catalogue:\n%s", strings.Join(problems, "\n"))
	}
	return nil
}

// run writes the table under root, or with check compares it.
func run(root string, check bool, out io.Writer) error {
	all, err := readCatalogue(root)
	if err != nil {
		return err
	}
	c, err := catalog.Load()
	if err != nil {
		return err
	}
	if err := checkNamed(all, c.Sky.Stars); err != nil {
		return err
	}
	stars, few := choose(all, c.Sky.Stars)
	table := encode(stars)
	path := filepath.Join(root, filepath.FromSlash(tablePath))
	old, err := os.ReadFile(path)
	same := err == nil && bytes.Equal(old, table)
	switch {
	case check && !same:
		return fmt.Errorf("%s is out of date; run go run ./tools/stars", tablePath)
	case !same:
		if err := os.WriteFile(path, table, 0o644); err != nil {
			return err
		}
	}
	fmt.Fprintf(out, "stars: %s: %d stars to magnitude %v north of %v°, the first %d to magnitude %v; %d bytes\n",
		tablePath, len(stars), Faintest, Southernmost, few, FaintestFew, len(table))
	return nil
}
