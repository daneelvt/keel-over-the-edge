// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/chart"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/edge/edgetest"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/sight"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// seed1 is seed 1's world, made once for the package's tests.
var seed1 = sync.OnceValues(func() (*worldgen.Bundle, error) {
	cat, err := catalog.Load()
	if err != nil {
		return nil, err
	}
	return worldgen.Generate(1, cat)
})

// TestChartNames: the chart a connection is sent as a world starts holds
// the names of what is known, and of nothing else; the chart of the world
// charted whole is under 40 KB.
func TestChartNames(t *testing.T) {
	if testing.Short() {
		t.Skip("makes a whole world")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	b, err := seed1()
	if err != nil {
		t.Fatal(err)
	}
	c := newWorldChart(b, cat, [16]byte{1}, []byte("key"))
	var known []store.Charting
	for _, k := range c.world.Known {
		s := c.world.Subjects[k]
		known = append(known, store.Charting{Subject: chart.KindWord(s.Kind), Number: s.Number, Written: true, At: time.Now()})
	}
	c.model.Add(known)
	wire, err := protocol.AppendServer(nil, &pb.ServerMessage{Body: &pb.ServerMessage_Chart{Chart: &pb.Chart{Entries: c.model.Entries()}}})
	if err != nil {
		t.Fatal(err)
	}
	isKnown := map[int32]bool{}
	for _, k := range c.world.Known {
		isKnown[k] = true
	}
	for i, s := range c.world.Subjects {
		on := s.Name != "" && len(s.Name) >= 3 && bytes.Contains(wire, []byte(s.Name))
		if isKnown[int32(i)] && s.Name != "" && !on {
			t.Errorf("%q is known and not on the wire", s.Name)
		}
		// A name an unknown subject shares with a known one may be there.
		if !isKnown[int32(i)] && on && !slices.ContainsFunc(c.world.Known, func(k int32) bool { return c.world.Subjects[k].Name == s.Name }) {
			t.Errorf("%q is on the wire, not charted", s.Name)
		}
	}
	// The world charted whole.
	var all []store.Charting
	for _, s := range c.world.Subjects {
		all = append(all, store.Charting{Subject: chart.KindWord(s.Kind), Number: s.Number, Credited: true, Sailor: "Bartholomew Roberts",
			AccountKind: "human", Written: true, At: time.Now()})
	}
	c.model.Add(all)
	whole, err := protocol.AppendServer(nil, &pb.ServerMessage{Body: &pb.ServerMessage_Chart{Chart: &pb.Chart{Entries: c.model.Entries()}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(whole) > 40<<10 {
		t.Errorf("the chart of the world charted whole is %d bytes", len(whole))
	}
	t.Logf("the chart: %d bytes known (%d entries), %d bytes whole (%d entries); the models %d bytes",
		len(wire), len(known), len(whole), c.model.Load().Len(), c.models.Size())
}

// TestChartOnline: a server sailing seed 1. Ann and Bob are sent the chart
// of what is known as they are welcomed; Ann's boat put off an island
// charts it, and both are sent it, credited to her; Carol, welcomed after,
// is sent it with the rest. The database holds the credit.
func TestChartOnline(t *testing.T) {
	if testing.Short() {
		t.Skip("makes a whole world")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	world, err := seed1()
	if err != nil {
		t.Fatal(err)
	}
	cw := chart.Build(world, cat)
	// An island with nothing about it charted: off its east coast.
	target := -1
	for i, s := range cw.Subjects {
		if s.Kind == sight.Island && s.Highest > 10 && s.Zone == "middle" {
			target = i
			break
		}
	}
	if target < 0 {
		t.Fatal("no island of the middle waters")
	}
	is := cw.Subjects[target]
	synctest.Test(t, func(t *testing.T) {
		d := &memDB{epoch: bubbleEpoch, sessions: edgetest.NewSessions()}
		ann, _ := d.sessions.Add("Ann", "human")
		bob, _ := d.sessions.Add("Bob", "human")
		carol, _ := d.sessions.Add("Carol", "human")
		gen := func(uint64) (*worldgen.Bundle, error) { return world, nil }
		s := startServer(t, map[string]string{"KEEL_DEV_COMMANDS": "1"}, newMemNet(), d.with(serveOptions{generate: gen}))
		time.Sleep(time.Second)
		heard := func(in *client.Inbox) *charts {
			g := &charts{}
			go func() {
				for r := range in.C {
					g.add(r.Message)
				}
			}()
			return g
		}
		_, ain, _ := connect(t, s, ann)
		a := heard(ain)
		_, bin, _ := connect(t, s, bob)
		b := heard(bin)
		time.Sleep(2 * time.Second)
		synctest.Wait()
		if got := a.names(); !slices.Contains(got, cw.Subjects[cw.Known[0]].Name) || slices.Contains(got, is.Name) {
			t.Fatalf("Ann's chart at the start: %v", got)
		}
		res, err := s.client.Post(fmt.Sprintf("%s/debug/place?east=%.1f&north=%.1f&boat=1", internalURL, is.Bounds[2]+80, is.Y), "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		time.Sleep(3 * time.Second)
		synctest.Wait()
		_, cin, _ := connect(t, s, carol)
		c := heard(cin)
		time.Sleep(2 * time.Second)
		synctest.Wait()
		s.stop(t)
		for who, g := range map[string]*charts{"Ann": a, "Bob": b, "Carol": c} {
			e := g.entry(is.Name)
			if e == nil {
				t.Errorf("%s was not sent %s; was sent %v", who, is.Name, g.names())
				continue
			}
			if e.By == "" || e.Model == "" {
				t.Errorf("%s was sent %s uncredited or with no model: %+v", who, is.Name, e)
			}
		}
		if c.charted > 0 {
			t.Errorf("Carol was sent %d chartings after her chart", c.charted)
		}
		rows, _ := d.Chartings(t.Context(), [16]byte{})
		if !slices.ContainsFunc(rows, func(r store.Charting) bool { return r.Number == is.Number && r.Subject == "island" && r.Credited }) {
			t.Errorf("the database holds no credit for %s: %+v", is.Name, rows)
		}
	})
}

// charts is what a connection was sent of the chart.
type charts struct {
	mu      sync.Mutex
	entries []*pb.ChartEntry
	charted int // Charted messages
}

func (g *charts) add(m *pb.ServerMessage) {
	if m == nil {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if c := m.GetChart(); c != nil {
		g.entries = append(g.entries, c.Entries...)
	}
	if c := m.GetCharted(); c != nil {
		g.entries = append(g.entries, c.Entries...)
		g.charted++
	}
}

func (g *charts) names() []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	var out []string
	for _, e := range g.entries {
		out = append(out, e.Name)
	}
	return out
}

func (g *charts) entry(name string) *pb.ChartEntry {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, e := range g.entries {
		if e.Name == name {
			return e
		}
	}
	return nil
}

// TestChartWhole: a server sailing seed 1. Ann charts an island; the world
// page charts the whole world: Ann, connected, is sent the rest in one
// Charted, every subject known, credited to no one, and her island keeps
// her credit; nothing charted whole makes news. Carol, welcomed after, is
// sent the whole chart. The page refuses to chart it again, or another
// world; the chart survives a restart; and the next world begins with only
// what is known from its start.
func TestChartWhole(t *testing.T) {
	if testing.Short() {
		t.Skip("makes a whole world")
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	world, err := seed1()
	if err != nil {
		t.Fatal(err)
	}
	cw := chart.Build(world, cat)
	target := slices.IndexFunc(cw.Subjects, func(s chart.Subject) bool { return s.Kind == sight.Island && s.Highest > 10 && s.Zone == "middle" })
	if target < 0 {
		t.Fatal("no island of the middle waters")
	}
	is := cw.Subjects[target]
	synctest.Test(t, func(t *testing.T) {
		d := &memDB{epoch: bubbleEpoch, sessions: edgetest.NewSessions()}
		ann, _ := d.sessions.Add("Ann", "human")
		carol, _ := d.sessions.Add("Carol", "human")
		gen := func(uint64) (*worldgen.Bundle, error) { return world, nil }
		vars := func() map[string]string { return map[string]string{"KEEL_DEV_COMMANDS": "1"} }
		s := startServer(t, vars(), newMemNet(), d.with(serveOptions{generate: gen}))
		time.Sleep(time.Second)
		var start chartedJSON
		getJSON(t, s, internalURL+"/owner/api/charted.json", &start)
		_, ain, _ := connect(t, s, ann)
		a := &charts{}
		go func() {
			for r := range ain.C {
				a.add(r.Message)
			}
		}()
		res, err := s.client.Post(fmt.Sprintf("%s/debug/place?east=%.1f&north=%.1f&boat=1", internalURL, is.Bounds[2]+80, is.Y), "", nil)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		time.Sleep(3 * time.Second)
		synctest.Wait()
		if e := a.entry(is.Name); e == nil || e.By == "" {
			t.Fatalf("Ann did not chart %s: %+v", is.Name, e)
		}
		a.mu.Lock()
		before, entries := a.charted, len(a.entries)
		a.mu.Unlock()
		earlier, _ := d.Chartings(t.Context(), [16]byte{})

		if code, body := postJSON(t, s, internalURL+"/owner/api/chart", `{"number":2}`); code != 409 {
			t.Errorf("another world's number: %d %s", code, body)
		}
		code, body := postJSON(t, s, internalURL+"/owner/api/chart", `{"number":1}`)
		if code != 202 {
			t.Fatalf("chart the whole world: %d %s", code, body)
		}
		time.Sleep(3 * time.Second)
		synctest.Wait()
		var whole chartedJSON
		getJSON(t, s, internalURL+"/owner/api/charted.json", &whole)
		if len(whole.Charted) != whole.Subjects || whole.Subjects != len(cw.Subjects) {
			t.Fatalf("charted whole: %d of %d", len(whole.Charted), whole.Subjects)
		}
		a.mu.Lock()
		sent, rest := a.charted-before, a.entries[entries:]
		a.mu.Unlock()
		if sent != 1 || len(rest) != len(cw.Subjects)-entries {
			t.Errorf("Ann was sent %d Charted with %d entries, not one with the %d left", sent, len(rest), len(cw.Subjects)-entries)
		}
		for _, e := range rest {
			if e.By != "" {
				t.Errorf("%s was charted whole credited to %q", e.Name, e.By)
			}
		}
		rows, _ := d.Chartings(t.Context(), [16]byte{})
		for _, r := range rows[len(earlier):] {
			if r.Credited || r.News != nil {
				t.Errorf("%s %d charted whole: credited %v, news %+v", r.Subject, r.Number, r.Credited, r.News)
			}
		}
		if !slices.ContainsFunc(rows, func(r store.Charting) bool { return r.Subject == "island" && r.Number == is.Number && r.Credited }) {
			t.Errorf("Ann's credit for %s is lost", is.Name)
		}
		if code, body := postJSON(t, s, internalURL+"/owner/api/chart", `{"number":1}`); code != 409 || !strings.Contains(body, "charted whole") {
			t.Errorf("charted again: %d %s", code, body)
		}
		_, cin, _ := connect(t, s, carol)
		c := &charts{}
		go func() {
			for r := range cin.C {
				c.add(r.Message)
			}
		}()
		time.Sleep(2 * time.Second)
		synctest.Wait()
		if got := len(c.names()); got != len(cw.Subjects) || c.charted > 0 {
			t.Errorf("Carol was sent %d entries of %d, and %d Charted after", got, len(cw.Subjects), c.charted)
		}
		s.stop(t)

		s = startServer(t, vars(), newMemNet(), d.with(serveOptions{generate: gen}))
		time.Sleep(time.Second)
		var again chartedJSON
		getJSON(t, s, internalURL+"/owner/api/charted.json", &again)
		if len(again.Charted) != len(cw.Subjects) {
			t.Errorf("after a restart, %d of %d charted", len(again.Charted), len(cw.Subjects))
		}
		if code, body := postJSON(t, s, internalURL+"/owner/api/world", `{"number":1}`); code != 202 {
			t.Fatalf("begin the next world: %d %s", code, body)
		}
		time.Sleep(3 * time.Second)
		synctest.Wait()
		var next chartedJSON
		getJSON(t, s, internalURL+"/owner/api/charted.json", &next)
		if len(next.Charted) != len(start.Charted) {
			t.Errorf("the next world begins with %d charted, not the %d known", len(next.Charted), len(start.Charted))
		}
		s.stop(t)
	})
}

// chartedJSON is the world page's charted.json.
type chartedJSON struct {
	Subjects int `json:"subjects"`
	Charted  []struct {
		Subject string `json:"subject"`
		Number  int32  `json:"number"`
		By      string `json:"by"`
	} `json:"charted"`
}
