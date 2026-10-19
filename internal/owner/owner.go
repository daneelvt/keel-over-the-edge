// SPDX-License-Identifier: AGPL-3.0-only

// Package owner is the owner's tools on keel's internal listener, which no
// player ever reaches: the world page, a map of the whole disk with every
// boat, the wind, the gusts, the current, the islands, the places and the
// lighthouses, the queue, the weather and the world's clock; and its
// controls, which set and clear an account's owner's flag, move a flagged
// account's boat anywhere on the disk, keep it unseen, and begin a new
// world. The internal listener has no route to the
// internet: the owner reaches it from their own computer through the
// tunnel to the machine, or a port forward on the local cluster.
//
// The page reads the world as a view built once a second by one goroutine
// (Run): it acquires the latest frame, copies what the page shows and
// releases it at once, then works out the wind and the lists and publishes
// them, so no request ever holds a frame, however many pages are open. The
// land is drawn once per world, on the first request for it.
//
// Every route is behind the guard (guard.go): a request whose Host is not
// this computer's own is refused, so no web page the owner has open can
// read the map or work the controls, by a cross-site request or by
// re-pointing a name of its own at this computer.
package owner

import (
	"context"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen/chart"
)

// Accounts is where accounts are kept: the store.
type Accounts interface {
	// Accounts finds accounts by ID, with their sailors' names.
	Accounts(ctx context.Context, ids []store.AccountID) (map[store.AccountID]store.Account, error)
	// SetTools sets or clears an account's owner's flag, or returns
	// store.ErrNotFound for an account that is not a human's.
	SetTools(ctx context.Context, id store.AccountID, on bool) error
}

// Sessions are the sessions' cache, which forgets an account at once when
// its flag changes.
type Sessions interface {
	ForgetAccount(id store.AccountID)
}

// Edge is the game connection, told of a flag's change at once, and asked
// where a free camera roams.
type Edge interface {
	Tools(account bus.Account, on bool) bool
	Eye(account bus.Account) (x, y float64, ok bool)
}

// A Clock tells world time: the loop's.
type Clock interface {
	WorldTime() (time.Duration, bool)
}

// World is what the page says of the world sailed.
type World struct {
	Number int
	ID     [16]byte
	Epoch  time.Time
	// Made is when its terrain was made and stored.
	Made time.Time
}

// Grids are the page's grids, m: the mean wind's arrows, the gusts and the
// current.
type Grids struct {
	Wind, Gusts, Current float64
}

// DefaultGrids are the starting grids: the wind every kilometre, the gusts
// every 100 m (the field players see darken the water), the current every
// 250 m.
var DefaultGrids = Grids{Wind: 1000, Gusts: 100, Current: 250}

// Rules are what a teleport needs of the water it puts a boat in.
type Rules struct {
	Depth float64 // at least this deep, m
	Clear float64 // at least this far from every other boat's centre, m
	// Approach is how deep the water is where an island's approach lies,
	// at least, m.
	Approach float64
}

// DefaultRules: 2 m, as a landmark must be reachable in; 10 m from any
// hull, as a new boat appears; an island's approach in 3 m.
var DefaultRules = Rules{Depth: 2, Clear: 10, Approach: 3}

// Config sets up the owner's tools.
type Config struct {
	Frames *bus.Frames
	// Owner is the owner's tools' sender: Teleport, Stay and Unseen.
	Owner bus.Sender
	// Bundle is the world's terrain: its ground drawn, its records listed.
	Bundle *worldgen.Bundle
	// Weather is the world's weather prepared: the lip and the mist band,
	// and the spells the frames name.
	Weather *physics.WeatherPrepared
	// Ground and Shelter are the land sailed, nil when land is off: the
	// water a teleport is checked against, the current and the gusts
	// sheltered by it. Circulation is the world's way round the disk.
	Ground      *physics.Ground
	Shelter     *physics.Shelter
	Circulation float64
	// Kinds are the boats' kinds' names, Regimes the weather's regimes'
	// ids, by their indices.
	Kinds   []string
	Regimes []string
	World   World
	Sky     *sky.Prepared
	Clock   Clock
	// Calm is the calm water's ring about the main port, m.
	Calm float64

	Accounts Accounts
	Sessions Sessions
	Edge     Edge

	// PlaceKinds and Characters are the catalog's kinds of place and
	// lights' characters, by their indices, as the page shows them.
	PlaceKinds []PlaceKind
	Characters []Character
	// FeatureKinds are the catalog's kinds of feature; SurfacePlants the
	// names of the plants that grow on each surface, by its index.
	FeatureKinds  []FeatureKind
	SurfacePlants [][]string
	// TownKinds are the catalog's kinds of building's names, by their
	// indices; TownLook how a town's sheet is drawn.
	TownKinds []string
	TownLook  chart.TownLook
	// BeginWorld ends the active world, of the number given, and begins the
	// next; Restart stops keel, to start again in it. Without them a new
	// world cannot be begun from the page.
	BeginWorld func(ctx context.Context, number int) (store.World, error)
	Restart    func()

	// Charted, if not nil, is the world's chart as it stands; Subjects how
	// many subjects there are to chart.
	Charted  ChartedList
	Subjects int

	// Page is the page's built files, or nil: the routes answer without it.
	Page *api.Page

	Grids Grids // DefaultGrids if zero
	Rules Rules // DefaultRules if zero

	Log     *slog.Logger
	Metrics *obs.Metrics
}

// Owner is the owner's tools.
type Owner struct {
	cfg  Config
	view atomic.Pointer[view]
	b    builder
	land land
	// current is the current's grid, once per world.
	current  []byte
	islands  []byte
	features []byte
	places   []byte
	towns    []byte
}

// Paths are the owner's tools' routes, for the tests that the public
// listeners serve none of them.
var Paths = []string{
	"/owner/", "/owner/index.html", "/owner/assets/x.js",
	"/owner/api/world.json", "/owner/api/gusts.bin", "/owner/api/islands.json", "/owner/api/current.json",
	"/owner/api/land.png", "/owner/api/coasts.svg", "/owner/api/island/0.svg", "/owner/api/point",
	"/owner/api/flag", "/owner/api/place", "/owner/api/unseen", "/owner/api/places.json", "/owner/api/world",
	"/owner/api/towns.json", "/owner/api/town/0.svg", "/owner/api/features.json", "/owner/api/charted.json",
}

// New makes the owner's tools. Run must be running for the page to see
// the world.
func New(cfg Config) *Owner {
	if cfg.Grids == (Grids{}) {
		cfg.Grids = DefaultGrids
	}
	if cfg.Rules == (Rules{}) {
		cfg.Rules = DefaultRules
	}
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	o := &Owner{cfg: cfg}
	o.b.init(&o.cfg)
	o.land.init(&o.cfg)
	o.current = currentGrid(&o.cfg)
	o.islands = islandsList(&o.cfg)
	o.places = placesList(&o.cfg)
	o.towns = townsList(&o.cfg)
	o.features = featuresList(&o.cfg)
	return o
}

// Every is how often the view is built.
const Every = time.Second

// Run builds the view once a second until ctx ends.
func (o *Owner) Run(ctx context.Context) {
	t := time.NewTicker(Every)
	defer t.Stop()
	for {
		o.Build(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// Build builds the view of the latest frame and publishes it.
func (o *Owner) Build(ctx context.Context) {
	start := time.Now()
	v := o.b.build(ctx)
	o.view.Store(v)
	if m := o.cfg.Metrics; m != nil {
		m.OwnerView.Observe(time.Since(start).Seconds())
	}
}

// Handler is the owner's tools' routes, behind the guard: the page at
// /owner/, its data and its controls under /owner/api/.
func (o *Owner) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /owner/{$}", o.page("index.html"))
	mux.HandleFunc("GET /owner/index.html", o.page("index.html"))
	mux.HandleFunc("GET /owner/assets/{file}", func(w http.ResponseWriter, r *http.Request) {
		o.page("assets/"+r.PathValue("file"))(w, r)
	})
	mux.HandleFunc("GET /owner/api/world.json", o.serveView(func(v *view) []byte { return v.world }, "application/json"))
	mux.HandleFunc("GET /owner/api/gusts.bin", o.serveView(func(v *view) []byte { return v.gusts }, "application/octet-stream"))
	mux.HandleFunc("GET /owner/api/islands.json", o.serveFixed(func() []byte { return o.islands }, "application/json"))
	mux.HandleFunc("GET /owner/api/places.json", o.serveFixed(func() []byte { return o.places }, "application/json"))
	mux.HandleFunc("GET /owner/api/towns.json", o.serveFixed(func() []byte { return o.towns }, "application/json"))
	mux.HandleFunc("GET /owner/api/features.json", o.serveFixed(func() []byte { return o.features }, "application/json"))
	mux.HandleFunc("GET /owner/api/charted.json", o.charted)
	mux.HandleFunc("GET /owner/api/town/{file}", o.land.town)
	mux.HandleFunc("GET /owner/api/current.json", o.serveFixed(func() []byte { return o.current }, "application/json"))
	mux.HandleFunc("GET /owner/api/land.png", o.land.serve(landPNG))
	mux.HandleFunc("GET /owner/api/coasts.svg", o.land.serve(coastsSVG))
	mux.HandleFunc("GET /owner/api/island/{file}", o.land.island)
	mux.HandleFunc("GET /owner/api/point", o.point)
	mux.HandleFunc("POST /owner/api/flag", o.flag)
	mux.HandleFunc("POST /owner/api/place", o.place)
	mux.HandleFunc("POST /owner/api/unseen", o.unseen)
	mux.HandleFunc("POST /owner/api/world", o.newWorld)
	var refused func()
	if m := o.cfg.Metrics; m != nil {
		c := m.OwnerRefused.WithLabelValues("request")
		refused = c.Inc
	}
	return Guard(mux, refused)
}

// page serves one of the page's files.
func (o *Owner) page(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if o.cfg.Page == nil {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("The world page is not built: npm run build in client/, with KEEL_CLIENT_DIR set; its data is under /owner/api/.\n"))
			return
		}
		o.cfg.Page.Serve(w, r, name)
	}
}

// serveView serves part of the latest view, never cached.
func (o *Owner) serveView(part func(*view) []byte, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		v := o.view.Load()
		if v == nil {
			http.Error(w, "the world is not yet seen", http.StatusServiceUnavailable)
			return
		}
		h := w.Header()
		h.Set("Content-Type", contentType)
		h.Set("Cache-Control", "no-store")
		_, _ = w.Write(part(v))
	}
}

// serveFixed serves what is the same for the world's life, kept by the
// browser until it asks again.
func (o *Owner) serveFixed(body func() []byte, contentType string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Type", contentType)
		h.Set("Cache-Control", "no-cache")
		h.Set("ETag", o.land.etag)
		if r.Header.Get("If-None-Match") == o.land.etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}
		_, _ = w.Write(body())
	}
}
