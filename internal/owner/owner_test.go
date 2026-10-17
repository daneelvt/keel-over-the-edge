// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"math"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus/testutil"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen/chart"
)

// fakeAccounts is a database of accounts in memory.
type fakeAccounts struct {
	mu    sync.Mutex
	by    map[store.AccountID]store.Account
	reads int
}

func (f *fakeAccounts) Accounts(_ context.Context, ids []store.AccountID) (map[store.AccountID]store.Account, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reads++
	out := map[store.AccountID]store.Account{}
	for _, id := range ids {
		if a, ok := f.by[id]; ok {
			out[id] = a
		}
	}
	return out, nil
}

func (f *fakeAccounts) SetTools(_ context.Context, id store.AccountID, on bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.by[id]
	if !ok || a.Kind != store.Human {
		return store.ErrNotFound
	}
	a.Tools = on
	f.by[id] = a
	return nil
}

// fakeEdge records what it is told, and has eyes where a test puts them.
type fakeEdge struct {
	mu    sync.Mutex
	tools map[bus.Account]bool
	eyes  map[bus.Account][2]float64
}

func (e *fakeEdge) Tools(a bus.Account, on bool) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.tools[a] = on
	return true
}

func (e *fakeEdge) Eye(a bus.Account) (float64, float64, bool) {
	e.mu.Lock()
	defer e.mu.Unlock()
	p, ok := e.eyes[a]
	return p[0], p[1], ok
}

type fakeSessions struct{ forgot []store.AccountID }

func (s *fakeSessions) ForgetAccount(id store.AccountID) { s.forgot = append(s.forgot, id) }

func account(n byte) bus.Account { return bus.Account{0x01, 0x99, 15: n} }

// hill is the test world's land: a hill 30 m high and 100 m across at
// (2000, 0), its shore shelving to 40 m deep 300 m off; deep water
// everywhere else.
func hill(x, y float64) float64 {
	d := math.Hypot(x-2000, y)
	if d < 100 {
		return 30 * (1 - d/100)
	}
	return max(-40, -(d-100)/5)
}

// rig is a world, ticked by the test, with the owner's tools on it.
type rig struct {
	w        *sim.World
	o        *Owner
	accounts *fakeAccounts
	edge     *fakeEdge
	sessions *fakeSessions
	metrics  *obs.Metrics
	h        http.Handler
	// begun are the worlds the page ended, and restarted counts keel's
	// restarts.
	begun     []int
	restarted chan struct{}
}

func newRig(t testing.TB, limit int) *rig {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	waves, kinds := cat.Prepare()
	g := &physics.Ground{Prepared: cat.PrepareGround()}
	for n := range int32(physics.ChunkCount) {
		c0, j0 := physics.ChunkCorner(n)
		x0, y0 := physics.CellCentre(c0, j0)
		if math.Hypot(x0-2000, y0) > 1500 {
			continue
		}
		ch := new(physics.GroundChunk)
		for i := range int32(physics.ChunkHexes) {
			x, y := physics.CellCentre(c0+i/physics.ChunkRows, j0+i%physics.ChunkRows)
			ch.Elevation[i] = int16(math.Round(hill(x, y) * 10))
		}
		g.Chunks[n] = ch
	}
	b := worldgen.Empty(1)
	b.Ground = g
	c, j := physics.HexCell(physics.HexAt(2000, 0))
	b.Islands = []worldgen.Island{{Number: 0, Kind: "main", Name: "Hill", Biome: "test", Size: "small", Group: -1,
		X: 2000, Across: 200, Area: math.Pi * 100 * 100, Highest: 30, HighX: 2000, Box: [4]int32{c - 40, j - 40, 80, 80}}}
	b.Start.Places = [][2]float64{{0, -100}}
	b.Places = []worldgen.Place{
		{Number: 1, Kind: "reef", Name: "Blowers Rocks", Island: -1, X: 2000, Y: 110, Zone: "middle",
			Details: worldgen.PlaceDetails{Length: 120, Offshore: true, Offers: []string{"offshore"}}},
		{Number: 2, Kind: "lighthouse", Name: "Blowers Rocks Light", Island: 0, X: 2000, Y: 0, Zone: "middle",
			Details: worldgen.PlaceDetails{Offers: []string{}}},
	}
	b.Lights = []worldgen.Light{{Number: 0, Place: 2, Role: "hazard", Marks: 1, X: 2000, Y: 0, Ground: 30, Tower: 15, Focal: 45,
		Character: 1, Notation: "Fl W 10s", Phase: 1234, Range: 2778}}
	b.Towns = []worldgen.Town{{Number: 0, Kind: "port", Place: 3, Island: 0, Name: "Hill Harbour", X: 1840, Y: 0, Heading: -math.Pi / 2,
		Piers: []worldgen.Pier{{X: 1840, Y: 0, Heading: -math.Pi / 2, Length: 20, Width: 8}}, Buildings: 1, Counts: []int{1, 2},
		Harbour: []worldgen.Disc{{X: 1700, Y: 0, R: 150}, {X: 1840, Y: 0, R: 150}}}}
	b.Buildings = []worldgen.Building{{Kind: 0, X: 1880, Y: 10, Heading: -math.Pi / 2, Level: 16, Storeys: 2, Frontage: 6, Depth: 8, Top: 10.6},
		{Kind: 1, X: 1860, Y: -10, Level: 16, Storeys: 1, Frontage: 0.4, Depth: 0.4, Top: 2.6}}
	tl := weather.FixedIn(cat.PrepareWeather(), physics.SteadySpell(10*knot, 0, 0))
	w, err := sim.New(sim.Config{Capacity: 64, Kinds: kinds, Waves: waves, Workers: 1, Tick: 1000, Limit: limit,
		Weather: tl, Encounters: cat.PrepareEncounters(), Terrain: &sim.Terrain{Ground: g, Start: []physics.State{{X: 0, Y: -100, Heading: math.Pi / 2}}}, Edge: &sim.Edge{Fall: 150, Clear: 20}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(w.Close)
	r := &rig{w: w, accounts: &fakeAccounts{by: map[store.AccountID]store.Account{}}, edge: &fakeEdge{tools: map[bus.Account]bool{}, eyes: map[bus.Account][2]float64{}},
		sessions: &fakeSessions{}, metrics: obs.NewMetrics("test", catalog.Version), restarted: make(chan struct{}, 1)}
	r.o = New(Config{
		Frames: w.Bus().Frames, Owner: w.Bus().Commands.Owner(), Bundle: b, Weather: tl.Prepared(), Ground: g,
		Kinds: []string{"Jolly boat"}, Regimes: []string{"settled"}, Sky: cat.PrepareSky(), Calm: 900,
		World:    World{Number: 3, Epoch: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), Made: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
		Accounts: r.accounts, Sessions: r.sessions, Edge: r.edge, Log: slog.New(slog.DiscardHandler), Metrics: r.metrics,
		PlaceKinds: []PlaceKind{{ID: "reef", Name: "Reef", Site: "reef", Mark: "#c2563a"}, {ID: "lighthouse", Name: "Lighthouse", Site: "light", Mark: "#e8b400"}},
		Characters: []Character{{Notation: "Fl W 5s", Colour: "white", Steps: []int{500, 4500}}, {Notation: "Fl W 10s", Colour: "white", Steps: []int{1000, 9000}}},
		TownKinds:  []string{"Dwelling", "Bollard"},
		TownLook:   chart.TownLook{Kinds: []string{"#c9b08a", "#3c3a36"}, Props: []bool{false, true}, Surfaces: map[int32]string{}},
		BeginWorld: func(_ context.Context, number int) (store.World, error) {
			if number != 3 {
				return store.World{}, store.ErrNotActive
			}
			r.begun = append(r.begun, number)
			return store.World{Number: number + 1}, nil
		},
		Restart: func() { r.restarted <- struct{}{} },
	})
	r.h = r.o.Handler()
	return r
}

// join puts a boat at sea for account n, named and of kind, and returns it.
func (r *rig) join(t testing.TB, n byte, name string, kind store.Kind, tools bool) uint64 {
	t.Helper()
	a := account(n)
	r.accounts.mu.Lock()
	r.accounts.by[store.AccountID(a)] = store.Account{ID: store.AccountID(a), Kind: kind, Name: name, Tools: tools}
	r.accounts.mu.Unlock()
	reply := make(chan bus.Reply, 1)
	if err := r.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Join, Account: a, Conn: uint64(n), Reply: reply}); err != nil {
		t.Fatal(err)
	}
	r.w.Tick()
	return (<-reply).Boat
}

func (r *rig) place(t testing.TB, boat uint64, x, y float64) {
	t.Helper()
	if err := r.w.Bus().Commands.Developer().TrySend(bus.Command{Op: bus.Place, Boat: boat, State: physics.State{X: x, Y: y}}); err != nil {
		t.Fatal(err)
	}
	r.w.Tick()
}

// do sends a request to the owner's tools as the owner's browser does.
func (r *rig) do(t testing.TB, method, path string, body any) (int, []byte) {
	t.Helper()
	var b io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		b = bytes.NewReader(data)
	}
	req := httptest.NewRequest(method, "http://localhost:9090"+path, b)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Sec-Fetch-Site", "same-origin")
		req.Header.Set("Origin", "http://localhost:9090")
	}
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	return rec.Code, rec.Body.Bytes()
}

func (r *rig) world(t testing.TB) worldJSON {
	t.Helper()
	r.o.Build(context.Background())
	code, body := r.do(t, "GET", "/owner/api/world.json", nil)
	if code != 200 {
		t.Fatalf("world.json: %d %s", code, body)
	}
	var w worldJSON
	if err := json.Unmarshal(body, &w); err != nil {
		t.Fatal(err)
	}
	return w
}

// TestView: the view's boats are the frame's live slots, with their
// sailors' names, kinds and flags from the database, read once a minute;
// the queue too; the world, the weather and the wind.
func TestView(t *testing.T) {
	r := newRig(t, 2)
	ann := r.join(t, 1, "Ann", store.Human, true)
	r.join(t, 2, "Robot", store.AI, false)
	r.join(t, 3, "Bob", store.Human, false) // queued: the limit is 2
	r.place(t, ann, 500, 600)
	r.w.Bus().Commands.Owner().TrySend(bus.Command{Op: bus.Unseen, Boat: ann, On: true})
	r.w.Tick()
	r.edge.eyes[account(1)] = [2]float64{1500, -20}
	w := r.world(t)
	f := r.w.Latest()
	if len(w.Boats) != len(f.Live) || len(w.Boats) != 2 || len(w.Queue) != 1 {
		t.Fatalf("%d boats, %d live; %d queued", len(w.Boats), len(f.Live), len(w.Queue))
	}
	a := w.Boats[0]
	if a.Boat != ann || a.Sailor != "Ann" || !a.Human || !a.Tools || !a.Unseen || a.Kind != "Jolly boat" || a.Eye == nil || a.Eye[0] != 1500 ||
		math.Abs(a.East-500) > 1 || math.Abs(a.North-600) > 1 || a.Account != store.AccountID(account(1)).String() {
		t.Fatalf("Ann's boat %+v", a)
	}
	if w.Boats[1].Sailor != "Robot" || w.Boats[1].Human || w.Boats[1].Tools || w.Boats[1].Eye != nil {
		t.Fatalf("the robot's %+v", w.Boats[1])
	}
	if w.Queue[0].Sailor != "Bob" || !w.Queue[0].Connected {
		t.Fatalf("the queue %+v", w.Queue)
	}
	if w.World.Number != 3 || w.World.Seed != 1 || w.World.Lip != 8334 || w.Tick != f.Tick || w.Weather.Regime != "settled" ||
		math.Abs(w.Weather.Knots-10) > 0.01 || !w.Weather.Steady || len(w.Wind.Points) == 0 {
		t.Fatalf("the world %+v, weather %+v", w.World, w.Weather)
	}
	// Names are read once a minute, not each second.
	reads := r.accounts.reads
	r.world(t)
	if r.accounts.reads != reads {
		t.Fatal("the accounts were read again within the minute")
	}
}

// TestCopy: the builder holds a frame only while it copies, and the copy
// allocates nothing; however often it builds while the world ticks, no
// frame is made for want of one.
func TestCopy(t *testing.T) {
	r := newRig(t, 0)
	for i := range 40 {
		boat := r.join(t, byte(i+1), "", store.Human, false)
		r.place(t, boat, float64(30*i), -500)
	}
	r.o.b.copyFrame()
	if n := testing.AllocsPerRun(100, r.o.b.copyFrame); n != 0 {
		t.Fatalf("the copy allocates %v times", n)
	}
	var wg sync.WaitGroup
	done := make(chan struct{})
	wg.Go(func() {
		for {
			select {
			case <-done:
				return
			default:
				r.o.Build(context.Background())
			}
		}
	})
	for range 300 {
		r.w.Tick()
	}
	close(done)
	wg.Wait()
	if n := r.w.Bus().Frames.Allocated(); n != 0 {
		t.Fatalf("%d frames made while the view was built", n)
	}
}

// TestGusts: the gusts' grid is the wind a step sails in over its mean, as
// the physics has it, at its points; nothing beyond the lip.
func TestGusts(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	r := newRig(t, 0)
	// A gusty spell.
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		t.Fatal(err)
	}
	b := &r.o.b
	b.cfg.Weather = tl.Prepared()
	b.weather.Prepared = tl.Prepared()
	b.nspells = tl.Spells(100000, nil, &b.spells)
	b.tick = 100000
	b.weather.Set(b.spells[:b.nspells])
	physics.WeatherAt(&b.weather, &b.wind, float64(b.tick))
	b.gustGrid()
	n := gustSide(b.cfg.Grids.Gusts)
	if len(b.gusts) != n*n || n != 168 {
		t.Fatalf("a grid of %d, %d a side", len(b.gusts), n)
	}
	nonzero := 0
	for _, ij := range [][2]int{{84, 84}, {10, 84}, {60, 30}, {120, 140}, {0, 0}, {167, 167}} {
		x, y := GustPoint(b.cfg.Grids.Gusts, ij[0], ij[1])
		got := int8(b.gusts[ij[1]*n+ij[0]])
		if math.Hypot(x, y) > tl.Prepared().Edge() {
			if got != NoGust {
				t.Errorf("(%v, %v), beyond the lip: %d", x, y, got)
			}
			continue
		}
		var p physics.WindPoint
		physics.WindPointAt(&b.wind, x, y, &p, nil)
		e := physics.WindAt(&b.wind, x, y, nil)
		if e.WindSpeed != p.Speed {
			t.Fatalf("WindAt %v, WindPointAt %v", e.WindSpeed, p.Speed)
		}
		if want := int8(math.Round((e.WindSpeed - p.MeanSpeed) / GustStep)); got != want {
			t.Errorf("(%v, %v): %d, the physics %d", x, y, got, want)
		}
		if got != 0 {
			nonzero++
		}
	}
	if nonzero == 0 {
		t.Error("no gust at any point tried")
	}
}

// TestLand: the land is drawn once per world, its ETag the world's
// digest; an island is drawn at the lattice's resolution; the islands'
// list has each with its approach, in water 3 m deep.
func TestLand(t *testing.T) {
	r := newRig(t, 0)
	var first []byte
	for range 2 {
		code, body := r.do(t, "GET", "/owner/api/land.png", nil)
		if code != 200 || !bytes.HasPrefix(body, []byte("\x89PNG")) {
			t.Fatalf("land.png: %d", code)
		}
		if first != nil && &first[0] != &r.o.land.body[landPNG][0] {
			t.Fatal("drawn twice")
		}
		first = r.o.land.body[landPNG]
	}
	req := httptest.NewRequest("GET", "http://localhost:9090/owner/api/land.png", nil)
	req.Header.Set("If-None-Match", `"`+r.o.cfg.Bundle.DigestHex()+`"`)
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotModified {
		t.Fatalf("with its ETag: %d", rec.Code)
	}
	if code, body := r.do(t, "GET", "/owner/api/coasts.svg", nil); code != 200 || !bytes.Contains(body, []byte("<path d=\"M")) {
		t.Fatalf("coasts.svg: %d", code)
	}
	if code, body := r.do(t, "GET", "/owner/api/island/0.svg", nil); code != 200 || !bytes.Contains(body, []byte("Hill")) {
		t.Fatalf("island 0: %d", code)
	}
	for _, p := range []string{"/owner/api/island/1.svg", "/owner/api/island/x.svg", "/owner/api/island/0.png"} {
		if code, _ := r.do(t, "GET", p, nil); code != 404 {
			t.Errorf("%s: %d", p, code)
		}
	}
	code, body := r.do(t, "GET", "/owner/api/islands.json", nil)
	var list struct {
		Islands []struct {
			Name     string
			Approach [2]float64
		}
	}
	if code != 200 || json.Unmarshal(body, &list) != nil || len(list.Islands) != 1 {
		t.Fatalf("islands.json: %d %s", code, body)
	}
	a := list.Islands[0].Approach
	if e, _ := r.o.cfg.Ground.At(a[0], a[1]); e > -3 || a[0] >= 2000 || math.Abs(a[1]) > 0.01 {
		t.Fatalf("the approach at %v, %v m", a, e)
	}
	// A point clicked: on the hill, and out at sea.
	var pt struct {
		Elevation, FromLip, Off float64
		Island, Water           string
	}
	for _, c := range []struct {
		q     string
		land  bool
		water string
	}{{"east=2000&north=10", true, "over land"}, {"east=-3000&north=0", false, ""}} {
		code, body := r.do(t, "GET", "/owner/api/point?"+c.q, nil)
		if code != 200 || json.Unmarshal(body, &pt) != nil || (pt.Elevation > 0) != c.land || pt.Water != c.water || pt.Island != "Hill" {
			t.Fatalf("the point %s: %d %s", c.q, code, body)
		}
	}
	if code, _ := r.do(t, "GET", "/owner/api/point?east=x", nil); code != 400 {
		t.Fatalf("a point that is not one: %d", code)
	}
}

// TestGuard: a request whose Host is not this computer's is refused,
// whatever its method; a control from another origin is refused; a
// control's body is JSON of at most 4 KB; every response forbids framing.
func TestGuard(t *testing.T) {
	r := newRig(t, 0)
	r.o.Build(context.Background())
	body := `{"account":"0199c2a4-5f7e-7c3a-9d0e-000000000001","on":true}`
	for _, host := range []string{"evil.example:9090", "10.43.0.54:9090", "", "localhost.evil.example", "127.0.0.1.nip.io:9090"} {
		for _, p := range Paths {
			method := "GET"
			if strings.HasPrefix(p, "/owner/api/") && !strings.Contains(p, ".") {
				method = "POST"
			}
			req := httptest.NewRequest(method, "http://x"+p, strings.NewReader(body))
			req.Host = host
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("Sec-Fetch-Site", "same-origin")
			rec := httptest.NewRecorder()
			r.h.ServeHTTP(rec, req)
			if rec.Code != http.StatusForbidden {
				t.Errorf("%s %s with Host %q: %d", method, p, host, rec.Code)
			}
		}
	}
	for _, host := range []string{"localhost:9090", "127.0.0.1:19090", "[::1]:9090", "LOCALHOST", "127.0.0.1"} {
		req := httptest.NewRequest("GET", "http://x/owner/api/world.json", nil)
		req.Host = host
		rec := httptest.NewRecorder()
		r.h.ServeHTTP(rec, req)
		if rec.Code != 200 || rec.Header().Get("X-Frame-Options") != "DENY" || !strings.Contains(rec.Header().Get("Content-Security-Policy"), "frame-ancestors 'none'") ||
			rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("GET with Host %q: %d %v", host, rec.Code, rec.Header())
		}
	}
	post := func(mod func(*http.Request)) int {
		req := httptest.NewRequest("POST", "http://localhost:9090/owner/api/flag", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		mod(req)
		rec := httptest.NewRecorder()
		r.h.ServeHTTP(rec, req)
		return rec.Code
	}
	for name, mod := range map[string]func(*http.Request){
		"cross-site":           func(q *http.Request) { q.Header.Set("Sec-Fetch-Site", "cross-site") },
		"same-site":            func(q *http.Request) { q.Header.Set("Sec-Fetch-Site", "same-site") },
		"a foreign Origin":     func(q *http.Request) { q.Header.Set("Origin", "https://evil.example") },
		"same-origin, rebound": func(q *http.Request) { q.Header.Set("Sec-Fetch-Site", "same-origin"); q.Host = "evil.example:9090" },
		"a form's body":        func(q *http.Request) { q.Header.Set("Content-Type", "application/x-www-form-urlencoded") },
		"text":                 func(q *http.Request) { q.Header.Set("Content-Type", "text/plain") },
		"no type":              func(q *http.Request) { q.Header.Del("Content-Type") },
		"a body over the limit": func(q *http.Request) {
			q.Body = io.NopCloser(strings.NewReader(`{"account":"` + strings.Repeat("a", MaxBody) + `"}`))
		},
	} {
		if code := post(mod); code < 400 {
			t.Errorf("a control %s: %d", name, code)
		}
	}
	if n := testutil.ToFloat64(r.metrics.OwnerRefused.WithLabelValues("request")); n == 0 {
		t.Error("no refusal counted")
	}
	// The probes and the metrics answer any Host: they are not the guard's.
	in := obs.Internal(obs.NewHealth(), r.metrics, nil, nil, nil, r.h)
	for p, want := range map[string]int{"/livez": 200, "/metrics": 200, "/owner/api/world.json": 403} {
		req := httptest.NewRequest("GET", "http://evil.example"+p, nil)
		rec := httptest.NewRecorder()
		in.ServeHTTP(rec, req)
		if rec.Code != want {
			t.Errorf("%s with a foreign Host: %d, want %d", p, rec.Code, want)
		}
	}
}

// TestPaths: every route of the owner's tools is among the internal
// listener's, which the tests hold the public listeners to serve none of.
func TestPaths(t *testing.T) {
	for _, p := range Paths {
		if !slices.Contains(obs.InternalPaths, p) {
			t.Errorf("%s is not in obs.InternalPaths", p)
		}
	}
}

// TestFlag: the flag is set in the database first, then the sessions'
// cache forgets the account and its connection is told; cleared, its boat
// is seen again; an AI account is refused it; each is counted.
func TestFlag(t *testing.T) {
	r := newRig(t, 0)
	r.join(t, 1, "Ann", store.Human, false)
	r.join(t, 2, "Robot", store.AI, false)
	id := store.AccountID(account(1))
	if code, body := r.do(t, "POST", "/owner/api/flag", FlagRequest{Account: id.String(), On: true}); code != 200 {
		t.Fatalf("flag: %d %s", code, body)
	}
	if !r.accounts.by[id].Tools || !r.edge.tools[account(1)] || len(r.sessions.forgot) != 1 || r.sessions.forgot[0] != id {
		t.Fatalf("flagged: %+v, %v, %v", r.accounts.by[id], r.edge.tools, r.sessions.forgot)
	}
	if w := r.world(t); !w.Boats[0].Tools {
		t.Fatal("the page does not show the flag at once")
	}
	r.w.Bus().Commands.Owner().TrySend(bus.Command{Op: bus.Unseen, Boat: 1, On: true})
	r.w.Tick()
	if code, _ := r.do(t, "POST", "/owner/api/flag", FlagRequest{Account: id.String(), On: false}); code != 200 {
		t.Fatal("unflag")
	}
	r.w.Tick()
	if r.accounts.by[id].Tools || r.edge.tools[account(1)] || r.w.Latest().Unseen[0] {
		t.Fatal("unflagged, the flag or the boat's hiding stays")
	}
	if code, _ := r.do(t, "POST", "/owner/api/flag", FlagRequest{Account: store.AccountID(account(2)).String(), On: true}); code != 404 {
		t.Fatalf("an AI's flag: %d", code)
	}
	if code, _ := r.do(t, "POST", "/owner/api/flag", FlagRequest{Account: "nobody", On: true}); code != 400 {
		t.Fatalf("not an account: %d", code)
	}
	if testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues("flag")) != 1 || testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues("unflag")) != 1 ||
		testutil.ToFloat64(r.metrics.OwnerRefused.WithLabelValues("flag")) != 2 {
		t.Fatal("the flag's actions are not counted")
	}
}

// TestPlace: a teleport moves a flagged account's boat, and only one: to a
// point in water deep enough, inside the lip and clear of other boats; to
// the start; to an island's approach, facing it; under its free camera.
func TestPlace(t *testing.T) {
	r := newRig(t, 0)
	ann := r.join(t, 1, "Ann", store.Human, true)
	bob := r.join(t, 2, "Bob", store.Human, false)
	r.place(t, bob, -1000, -1000)
	f64 := func(v float64) *float64 { return &v }
	at := func(x, y float64) PlaceRequest { return PlaceRequest{Boat: ann, East: f64(x), North: f64(y)} }
	try := func(req PlaceRequest) (int, string) {
		t.Helper()
		code, body := r.do(t, "POST", "/owner/api/place", req)
		r.w.Tick()
		return code, string(body)
	}
	if code, _ := try(PlaceRequest{Boat: bob, East: f64(0), North: f64(0)}); code != 403 {
		t.Fatalf("another player's boat: %d", code)
	}
	for name, req := range map[string]PlaceRequest{
		"over land":           at(2000, 0),
		"in the shallows":     at(2100+5, 0),
		"at the lip":          at(8334, 0),
		"beyond the lip":      at(9000, 0),
		"beside another boat": at(-1005, -1000),
		"nowhere":             {Boat: ann},
		"an island not there": {Boat: ann, Island: new(int)},
	} {
		if name == "an island not there" {
			*req.Island = 7
		}
		if code, body := try(req); code < 400 {
			t.Errorf("%s: %d %s", name, code, body)
		}
	}
	if code, _ := try(PlaceRequest{Boat: 999, Start: true}); code != 409 {
		t.Fatalf("no such boat: %d", code)
	}
	heading := 90.0
	if code, body := try(PlaceRequest{Boat: ann, East: f64(-3000), North: f64(4000), Heading: &heading}); code != 200 {
		t.Fatalf("to a point: %d %s", code, body)
	}
	f := r.w.Latest()
	if st := f.State[0]; math.Hypot(st.X+3000, st.Y-4000) > 0.5 || math.Abs(st.Heading-math.Pi/2) > 0.01 || !f.Voyage[0].Placed {
		t.Fatalf("at %+v, voyage %+v", st, f.Voyage[0])
	}
	if code, _ := try(PlaceRequest{Boat: ann, Start: true}); code != 200 || math.Hypot(r.w.Latest().State[0].X, r.w.Latest().State[0].Y+100) > 1 {
		t.Fatalf("to the start: %d, at %+v", code, r.w.Latest().State[0])
	}
	island := 0
	if code, body := try(PlaceRequest{Boat: ann, Island: &island}); code != 200 {
		t.Fatalf("to the island: %d %s", code, body)
	}
	st := r.w.Latest().State[0]
	if e, _ := r.o.cfg.Ground.At(st.X, st.Y); e > -3 || math.Abs(math.Remainder(st.Heading-math.Pi/2, 2*math.Pi)) > 0.05 {
		t.Fatalf("at the island's approach %+v, %v m, heading %v", st, e, st.Heading)
	}
	if code, _ := try(PlaceRequest{Boat: ann, Camera: true}); code != 409 {
		t.Fatalf("under a camera not roaming: %d", code)
	}
	r.edge.eyes[account(1)] = [2]float64{-2500, 2500}
	if code, _ := try(PlaceRequest{Boat: ann, Camera: true}); code != 200 || math.Hypot(r.w.Latest().State[0].X+2500, r.w.Latest().State[0].Y-2500) > 0.5 {
		t.Fatalf("under the camera: %d", code)
	}
	if testutil.ToFloat64(r.metrics.OwnerActions.WithLabelValues("place")) != 4 {
		t.Fatal("teleports not counted")
	}
}

// TestTowns: the towns' list, a town's sheet, and a teleport to a town's
// harbour, facing the town.
func TestTowns(t *testing.T) {
	r := newRig(t, 0)
	ann := r.join(t, 1, "Ann", store.Human, true)
	code, body := r.do(t, "GET", "/owner/api/towns.json", nil)
	var list struct {
		Towns []struct {
			Name    string         `json:"name"`
			Counts  map[string]int `json:"counts"`
			Harbour *[2]float64    `json:"harbour"`
		} `json:"towns"`
	}
	if code != 200 || json.Unmarshal(body, &list) != nil || len(list.Towns) != 1 || list.Towns[0].Counts["Bollard"] != 2 ||
		list.Towns[0].Harbour == nil {
		t.Fatalf("towns.json: %d %s", code, body)
	}
	if code, body := r.do(t, "GET", "/owner/api/town/0.svg", nil); code != 200 || !bytes.Contains(body, []byte("Hill Harbour")) {
		t.Fatalf("the town's sheet: %d", code)
	}
	if code, _ := r.do(t, "GET", "/owner/api/town/5.svg", nil); code != 404 {
		t.Fatalf("a town not there: %d", code)
	}
	town := 0
	if code, body := r.do(t, "POST", "/owner/api/place", PlaceRequest{Boat: ann, Town: &town}); code != 200 {
		t.Fatalf("to the town's harbour: %d %s", code, body)
	}
	r.w.Tick()
	st := r.w.Latest().State[0]
	h := list.Towns[0].Harbour
	if math.Hypot(st.X-h[0], st.Y-h[1]) > 0.5 || math.Abs(math.Remainder(st.Heading-math.Pi/2, 2*math.Pi)) > 0.05 {
		t.Fatalf("in the harbour at %+v, heading %v", st, st.Heading)
	}
}

// TestUnseen: a flagged account's boat is hidden and shown; another's is
// not.
func TestUnseenControl(t *testing.T) {
	r := newRig(t, 0)
	ann := r.join(t, 1, "Ann", store.Human, true)
	bob := r.join(t, 2, "Bob", store.Human, false)
	if code, _ := r.do(t, "POST", "/owner/api/unseen", UnseenRequest{Boat: bob, On: true}); code != 403 {
		t.Fatalf("another player's boat: %d", code)
	}
	if code, _ := r.do(t, "POST", "/owner/api/unseen", UnseenRequest{Boat: ann, On: true}); code != 200 {
		t.Fatal("hiding")
	}
	r.w.Tick()
	if f := r.w.Latest(); !f.Unseen[0] || f.Unseen[1] {
		t.Fatal("not hidden")
	}
	if code, _ := r.do(t, "POST", "/owner/api/unseen", UnseenRequest{Boat: ann, On: false}); code != 200 {
		t.Fatal("showing")
	}
	r.w.Tick()
	if r.w.Latest().Unseen[0] {
		t.Fatal("still hidden")
	}
}

// TestNoPage: without the built page its routes say so; its data is
// served all the same.
func TestNoPage(t *testing.T) {
	r := newRig(t, 0)
	if code, body := r.do(t, "GET", "/owner/", nil); code != 404 || !bytes.Contains(body, []byte("not built")) {
		t.Fatalf("/owner/: %d %s", code, body)
	}
	if code, _ := r.do(t, "GET", "/owner/api/world.json", nil); code != 503 {
		t.Fatalf("before the first view: %d", code)
	}
}

// crowded is a world of 1,000 boats spread over the disk in the catalog's
// weather, and the owner's tools on it, building nothing yet.
func crowded(b *testing.B) (*sim.World, *Owner) {
	b.Helper()
	r := newRig(b, 0)
	cat, err := catalog.Load()
	if err != nil {
		b.Fatal(err)
	}
	waves, kinds := cat.Prepare()
	tl, err := weather.FromCatalog(cat)
	if err != nil {
		b.Fatal(err)
	}
	w, err := sim.New(sim.Config{Capacity: 1024, Kinds: kinds, Waves: waves, Workers: 4, Tick: 1000, Weather: tl, Encounters: cat.PrepareEncounters()})
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(w.Close)
	dev := w.Bus().Commands.Developer()
	for i := range 1000 {
		a := bus.Account{0xbb, 14: byte(i >> 8), 15: byte(i)}
		if err := dev.TrySend(bus.Command{Op: bus.Join, Account: a, Conn: uint64(i + 1)}); err != nil {
			b.Fatal(err)
		}
	}
	w.Tick()
	for i := range 1000 {
		a := float64(i) * 2.399963
		d := 8000 * math.Sqrt(float64(i)/1000)
		dev.TrySend(bus.Command{Op: bus.Place, Boat: uint64(i + 1), State: physics.State{X: d * math.Sin(a), Y: d * math.Cos(a)}})
	}
	w.Tick()
	if n := len(w.Latest().Live); n != 1000 {
		b.Fatalf("%d boats", n)
	}
	cfg := r.o.cfg
	cfg.Frames, cfg.Weather = w.Bus().Frames, tl.Prepared()
	return w, New(cfg)
}

// BenchmarkBuild is the view's builder with 1,000 boats about the disk.
func BenchmarkBuild(b *testing.B) {
	_, o := crowded(b)
	for b.Loop() {
		o.Build(context.Background())
	}
}

// BenchmarkTick is the world's tick with 1,000 boats; BenchmarkTickBuilding
// the same while the view is built, once a second as the server builds it,
// or without a pause, the most it could take from the tick.
func BenchmarkTick(b *testing.B) { benchTick(b, -1) }

func BenchmarkTickBuilding(b *testing.B) {
	b.Run("every second", func(b *testing.B) { benchTick(b, Every) })
	b.Run("without a pause", func(b *testing.B) { benchTick(b, 0) })
}

func benchTick(b *testing.B, every time.Duration) {
	w, o := crowded(b)
	done := make(chan struct{})
	var wg sync.WaitGroup
	if every >= 0 {
		wg.Go(func() {
			for {
				o.Build(context.Background())
				select {
				case <-done:
					return
				case <-time.After(every):
				}
			}
		})
	}
	before := w.Bus().Frames.Allocated()
	for b.Loop() {
		w.Tick()
	}
	close(done)
	wg.Wait()
	b.ReportMetric(float64(w.Bus().Frames.Allocated()-before), "frames-made")
}

// TestPlacesList: places.json lists every place and light of the bundle,
// with their names, kinds, a light's character as charts write it, and a
// place's approach in water deep enough.
func TestPlacesList(t *testing.T) {
	r := newRig(t, 0)
	code, body := r.do(t, "GET", "/owner/api/places.json", nil)
	if code != 200 {
		t.Fatalf("places.json: %d %s", code, body)
	}
	var got struct {
		Kinds      []PlaceKind `json:"kinds"`
		Characters []Character `json:"characters"`
		Places     []struct {
			Number   int32       `json:"number"`
			Kind     string      `json:"kind"`
			Name     string      `json:"name"`
			Approach *[2]float64 `json:"approach"`
		} `json:"places"`
		Lights []struct {
			Name  string `json:"name"`
			Chart string `json:"chart"`
			Phase int64  `json:"phase"`
		} `json:"lights"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Kinds) != 2 || len(got.Characters) != 2 || len(got.Places) != 2 || len(got.Lights) != 1 {
		t.Fatalf("places.json holds %s", body)
	}
	if p := got.Places[0]; p.Name != "Blowers Rocks" || p.Kind != "reef" || p.Approach == nil {
		t.Errorf("the reef is %+v", p)
	} else if e, _ := r.o.cfg.Ground.At(p.Approach[0], p.Approach[1]); e > -3 {
		t.Errorf("the reef's approach is in %.1f m of water", -e)
	}
	if l := got.Lights[0]; l.Name != "Blowers Rocks Light" || l.Chart != "Fl W 10s 45m 1.5M" || l.Phase != 1234 {
		t.Errorf("the light is %+v", l)
	}
}

// TestPlaceAtAPlace: a flagged boat is put at a place's approach, facing
// it; a place the world has not is refused.
func TestPlaceAtAPlace(t *testing.T) {
	r := newRig(t, 0)
	ann := r.join(t, 1, "Ann", store.Human, true)
	place := 1
	code, body := r.do(t, "POST", "/owner/api/place", PlaceRequest{Boat: ann, Place: &place})
	r.w.Tick()
	if code != 200 {
		t.Fatalf("to the reef: %d %s", code, body)
	}
	st := r.w.Latest().State[0]
	if e, _ := r.o.cfg.Ground.At(st.X, st.Y); e > -3 || math.Hypot(st.X-2000, st.Y-110) > 100 {
		t.Errorf("at %+v, in %.1f m", st, -e)
	}
	if want := math.Atan2(2000-st.X, 110-st.Y); math.Abs(math.Remainder(st.Heading-want, 2*math.Pi)) > 0.05 {
		t.Errorf("facing %.2f rad, not the reef at %.2f", st.Heading, want)
	}
	none := 99
	if code, _ := r.do(t, "POST", "/owner/api/place", PlaceRequest{Boat: ann, Place: &none}); code != 400 {
		t.Errorf("a place not there: %d", code)
	}
}

// TestNewWorld: a new world is begun only with the active world's number
// typed; then keel is stopped, to start again in it.
func TestNewWorld(t *testing.T) {
	r := newRig(t, 0)
	for _, n := range []int{0, 2, 4} {
		if code, _ := r.do(t, "POST", "/owner/api/world", NewWorldRequest{Number: n}); code != 400 {
			t.Errorf("world %d typed: %d", n, code)
		}
	}
	if code, _ := r.do(t, "POST", "/owner/api/world", map[string]any{"number": 3, "more": true}); code != 400 {
		t.Errorf("a body not the control's: %d", code)
	}
	if len(r.begun) != 0 {
		t.Fatalf("worlds ended: %v", r.begun)
	}
	code, body := r.do(t, "POST", "/owner/api/world", NewWorldRequest{Number: 3})
	if code != 200 || !strings.Contains(string(body), `"begun":4`) || !slices.Equal(r.begun, []int{3}) {
		t.Fatalf("world 3 typed: %d %s, ended %v", code, body, r.begun)
	}
	select {
	case <-r.restarted:
	case <-time.After(5 * time.Second):
		t.Fatal("keel was not stopped to start again")
	}
	// From another site, it is refused before it is heard.
	req := httptest.NewRequest("POST", "http://localhost:9090/owner/api/world", strings.NewReader(`{"number":3}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	rec := httptest.NewRecorder()
	r.h.ServeHTTP(rec, req)
	if rec.Code < 400 || len(r.begun) != 1 {
		t.Errorf("a cross-site request: %d, ended %v", rec.Code, r.begun)
	}
}
