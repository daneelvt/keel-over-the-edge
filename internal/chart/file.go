// SPDX-License-Identifier: AGPL-3.0-only

package chart

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"strconv"

	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The sandbox's chart: what the page sails offline beside a world file,
// written by go run ./tools/dev -world. Every subject, as the game
// connection would tell of it charted but by no one; the islands' models,
// inline; the world's sight table, which the sandbox looks by as the
// server does; what is known from the start; and, for the page's test of
// its looks against the server's, what a lookout sees, nothing yet
// charted, at points along runs out from the main port.

// SandboxEntry is a subject as the page's chart reads it.
type SandboxEntry struct {
	Subject     string    `json:"subject"`
	Number      int32     `json:"number"`
	Sort        int       `json:"sort"`
	Name        string    `json:"name"`
	East        float64   `json:"east"`
	North       float64   `json:"north"`
	By          string    `json:"by"`
	AI          bool      `json:"ai"`
	At          int64     `json:"at"`
	Worth       float64   `json:"worth"`
	Island      int32     `json:"island"`
	Group       string    `json:"group"`
	Bounds      []float64 `json:"bounds"`
	Highest     float64   `json:"highest"`
	Zone        uint32    `json:"zone"`
	ClassName   string    `json:"className"`
	Model       string    `json:"model"`
	Light       int32     `json:"light"`
	Character   uint32    `json:"character"`
	Focal       float64   `json:"focal"`
	Range       uint32    `json:"range"`
	Ship        string    `json:"ship"`
	Sunk        bool      `json:"sunk"`
	WithSubject *string   `json:"withSubject"`
	WithNumber  int32     `json:"withNumber"`
}

// SandboxCheck is what a lookout at a point sees, nothing charted.
type SandboxCheck struct {
	X, Y float64
	Seen []int32
}

// Sandbox is the sandbox's chart file.
type Sandbox struct {
	Entries []SandboxEntry `json:"entries"`
	Models  []string       `json:"models"` // base64, gzipped
	Known   []int32        `json:"known"`
	Sight   sight.Export   `json:"sight"`
	Checks  []SandboxCheck `json:"checks"`
}

// SandboxFile is the sandbox's chart of the world w, as JSON.
func (m *Model) SandboxFile() ([]byte, error) {
	w := m.world
	out := Sandbox{Known: w.Known, Sight: w.Table.Export()}
	for _, im := range w.Models {
		out.Models = append(out.Models, base64.StdEncoding.EncodeToString(im.Payload))
	}
	for i := range w.Subjects {
		e := m.entry(int32(i), &store.Charting{Written: true})
		se := SandboxEntry{
			Subject: KindWord(w.Subjects[i].Kind), Number: int32(e.Number), Sort: int(e.Sort), Name: e.Name,
			East: float64(e.East) / 100, North: float64(e.North) / 100, Worth: float64(e.Worth) / 10,
			Island: int32(e.Island) - 1, Group: e.Group, Highest: float64(e.Highest) / 100, Zone: e.Zone, ClassName: e.Class,
			Light: int32(e.Light) - 1, Character: e.Character, Focal: float64(e.Focal) / 100, Range: e.Range,
			Ship: e.Ship, Sunk: e.Sunk,
		}
		if len(e.Bounds) == 4 {
			se.Bounds = []float64{float64(e.Bounds[0]) / 100, float64(e.Bounds[1]) / 100, float64(e.Bounds[2]) / 100, float64(e.Bounds[3]) / 100}
		}
		if s := &w.Subjects[i]; s.Model >= 0 {
			se.Model = "#" + strconv.Itoa(s.Model)
		}
		out.Entries = append(out.Entries, se)
	}
	// Eight runs out from the main port, a look every 50 m.
	charted := make([]uint64, sight.Words(len(w.Subjects)))
	l := sight.Lookout{Eye: w.Table.Eye(2), Reach: w.Table.EyeReach(2)}
	var seen []sight.Seen
	home := w.Subjects[0]
	for k := range 8 {
		a := float64(k) * math.Pi / 4
		for d := 300.0; d < 8300; d += 50 {
			l.X, l.Y = home.X+d*math.Sin(a), home.Y+d*math.Cos(a)
			seen = w.Table.Look(&l, charted, nil, seen[:0])
			c := SandboxCheck{X: l.X, Y: l.Y, Seen: []int32{}}
			for _, s := range seen {
				c.Seen = append(c.Seen, s.Subject)
			}
			out.Checks = append(out.Checks, c)
		}
	}
	return json.Marshal(out)
}
