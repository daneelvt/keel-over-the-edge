// SPDX-License-Identifier: AGPL-3.0-only

package sky_test

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"flag"
	"math"
	"math/rand/v2"
	"os"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/sky"
)

// The golden test: the sky at twelve places and forty times, compared bit
// for bit with testdata/sky.json. CI runs it on amd64 and arm64, and the
// client runs the same file through the WebAssembly module
// (client/src/sky/golden.test.ts), so all three agree with each other by
// agreeing with the file. After a deliberate change to the rule or to the
// catalog's sky, rewrite the file with
//
//	go test ./internal/sky -run Golden -update

var update = flag.Bool("update", false, "rewrite testdata/sky.json from this machine's results")

const goldenFile = "testdata/sky.json"

type goldenSky struct {
	Comment string         `json:"comment"`
	Stars   int            `json:"stars"`
	Samples []goldenSample `json:"samples"`
}

// goldenSample is the sky from one place at one time: the sun, the moon,
// the moon's lit share and the stars' matrix, as the IEEE 754 bits of the
// Sky record's twenty floats in hexadecimal, one after another; and the
// SHA-256 of every named star's Body, in the catalog's order, each float
// as its bits, little-endian.
type goldenSample struct {
	T     float64 `json:"t"`
	East  float64 `json:"east"`
	North float64 `json:"north"`
	Sky   string  `json:"sky"`
	Stars string  `json:"stars"`
}

var goldenPlaces = [12][2]float64{
	{0, 0}, {1, 0}, {0, -1}, {4167, 0}, {0, 4167}, {-2946.5, 2946.5},
	{8334, 0}, {0, 8334}, {-8334, 0}, {0, -8334}, {5893.03, -5893.03}, {123.456, -7654.321},
}

// goldenTimes are forty sky times: the turning points of the day, month
// and year, and times up to a century on.
func goldenTimes(s *sky.Prepared) []float64 {
	times := []float64{0, 1, s.Day() / 4, s.Day() / 2, 3 * s.Day() / 4, s.Day() - 1, s.Day(),
		s.Month() / 2, s.Month(), s.Year() / 4, s.Year(), 100 * 365.25 * 86400e6}
	r := rand.New(rand.NewPCG(21, 21))
	for len(times) < 40 {
		span := 1e10
		if len(times)%2 == 0 {
			span = 3e15
		}
		times = append(times, math.Floor(r.Float64()*span))
	}
	return times
}

func bodyFloats(b *sky.Body) [sky.BodySize]float64 {
	return [sky.BodySize]float64{b.East, b.North, b.Up, b.Altitude, b.Bearing}
}

func skyFloats(a *sky.Sky) []float64 {
	out := make([]float64, 0, sky.SkySize)
	sun, moon := bodyFloats(&a.Sun), bodyFloats(&a.Moon)
	out = append(out, sun[:]...)
	out = append(out, moon[:]...)
	out = append(out, a.Lit)
	return append(out, a.Stars[:]...)
}

func TestGolden(t *testing.T) {
	c, s := load(t)
	got := goldenSky{
		Comment: "Written by go test ./internal/sky -run Golden -update. sky is the Sky record's floats as their IEEE 754 bits in hexadecimal; stars the SHA-256 of the named stars' Bodies.",
		Stars:   len(c.Sky.Stars),
	}
	var all sky.Sky
	var body sky.Body
	for _, p := range goldenPlaces {
		for _, at := range goldenTimes(s) {
			sky.At(s, at, p[0], p[1], &all)
			var b strings.Builder
			for _, v := range skyFloats(&all) {
				b.WriteString(hex.EncodeToString(binary.BigEndian.AppendUint64(nil, math.Float64bits(v))))
			}
			h := sha256.New()
			for _, st := range c.Sky.Stars {
				sky.Star(s, at, p[0], p[1], st.RightAscension, st.Declination, &body)
				for _, v := range bodyFloats(&body) {
					h.Write(binary.LittleEndian.AppendUint64(nil, math.Float64bits(v)))
				}
			}
			got.Samples = append(got.Samples, goldenSample{T: at, East: p[0], North: p[1], Sky: b.String(), Stars: hex.EncodeToString(h.Sum(nil))})
		}
	}
	if len(skyFloats(&all)) != sky.SkySize {
		t.Fatalf("a Sky holds %d floats, and SkySize says %d", len(skyFloats(&all)), sky.SkySize)
	}

	if *update {
		data, err := json.MarshalIndent(got, "", " ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(goldenFile, append(data, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	data, err := os.ReadFile(goldenFile)
	if err != nil {
		t.Fatal(err)
	}
	var want goldenSky
	if err := json.Unmarshal(data, &want); err != nil {
		t.Fatal(err)
	}
	if len(want.Samples) != len(got.Samples) || want.Stars != got.Stars {
		t.Fatalf("%s holds %d samples of %d stars, this run %d of %d: run go test ./internal/sky -run Golden -update",
			goldenFile, len(want.Samples), want.Stars, len(got.Samples), got.Stars)
	}
	failed := 0
	for i, g := range got.Samples {
		w := want.Samples[i]
		if g != w {
			if failed++; failed <= 5 {
				t.Errorf("sample %d (t %v from %v, %v):\n  got  %s %s\n  want %s %s", i, g.T, g.East, g.North, g.Sky, g.Stars, w.Sky, w.Stars)
			}
		}
	}
	if failed > 0 {
		t.Errorf("%d of %d samples differ from %s", failed, len(got.Samples), goldenFile)
	}
}
