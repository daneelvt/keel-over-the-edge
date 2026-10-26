// SPDX-License-Identifier: AGPL-3.0-only

// Package owner is the owner's tools on keel's internal listener, which no
// player ever reaches: the world page, a map of the whole disk with every
// boat, the wind, the gusts, the current, the islands, the places and the
// lighthouses, the queue, the weather with the forecast beside it, and the
// world's clock; and its controls, which set and clear an account's
// owner's flag and an account's priority, move a flagged account's boat
// anywhere on the disk, keep it unseen, make a new next world, begin it, and chart the whole world.
// The internal listener has no route to the internet: the owner reaches it
// from their own computer through the tunnel to the machine, or a port
// forward on the local cluster.
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
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
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
	// SetPriority marks an account, human or AI, as a priority account or
	// not, or returns store.ErrNotFound for no such account.
	SetPriority(ctx context.Context, id store.AccountID, on bool) error
	// AccountCounts counts the human accounts: all, made in the last week,
	// seen in the last day.
	AccountCounts(ctx context.Context) (store.AccountCounts, error)
}

// Sessions are the sessions' cache, which forgets an account at once when
// its flag changes.
type Sessions interface {
	ForgetAccount(id store.AccountID)
}

// Door is the machine sailors' door, which keeps its connection tokens'
// accounts in a cache of its own: it forgets an account at once when the
// account's priority changes.
type Door interface {
	ForgetAccounts(ids ...store.AccountID)
}

// Agents tells of the machine sailors' agents: the app each boat's agent
// is, and what it last did. It is asked from the view's goroutine, once a
// second for each machine boat at sea.
type Agents interface {
	Agent(account bus.Account) (AgentInfo, bool)
}

// AgentInfo is what the page shows of a machine boat's agent.
type AgentInfo struct {
	App      string // the app's label: claude-ai, chatgpt, codex, …
	LastCall time.Time
	// Waiting is how long its observe has waited so far, 0 while it is not
	// waiting.
	Waiting  time.Duration
	Refusals uint64 // its calls refused since keel started
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
	// Owner is the owner's tools' sender: Teleport, Stay, Unseen and Chart.
	Owner bus.Sender
	// Bundle is the world's terrain: its ground drawn, its records listed.
	Bundle *worldgen.Bundle
	// Weather is the world's weather prepared: the lip and the mist band,
	// and the spells the frames name. Timeline is the world's week of
	// weather, nil while it has none; SystemKinds the kinds of weather
	// system's ids, by their indices.
	Weather     *physics.WeatherPrepared
	Timeline    *weather.Timeline
	SystemKinds []string
	// Waves are the sea's waves, which the frames' sea areas raise; nil is
	// flat water.
	Waves *physics.Waves
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
	// Door, if not nil, is the machine sailors' door, whose cache of
	// tokens' accounts forgets an account whose priority changes.
	Door Door
	// Agents, if not nil, tells of the machine sailors' agents.
	Agents Agents
	// AICap and AIReserve are the most boats machine sailors sail at once,
	// and how many places are kept for them ahead of humans waiting.
	AICap, AIReserve int
	// AISilence, if not zero, is how long a machine boat's agent may make
	// no call before its boat is sent into its grace; AIOrders and
	// AILooks, if not empty, are its budgets of orders and of looks, as
	// the page shows them: "2 a second, a burst of 5".
	AISilence         time.Duration
	AIOrders, AILooks string
	// Machines, if not nil, is the owner's hand on machine sailors and AI
	// apps' grants; Lifetime the grant lifetime kept in memory, and
	// LifetimeChanged, if not nil, told when it is set.
	Machines        AISailors
	Lifetime        Lifetime
	LifetimeChanged func()

	// PlaceKinds and Characters are the catalog's kinds of place and
	// lights' characters, by their indices, as the page shows them.
	PlaceKinds []PlaceKind
	Characters []Character
	// FogSignals are the catalog's fog signals' patterns, by their
	// indices; LightSignals each of the bundle's lights' fog signal, by its
	// index in them, −1 for none; and SoundsUnder the visibility at its
	// light a blast sounds under, m.
	FogSignals   []FogSignal
	LightSignals []int
	SoundsUnder  float64
	// FeatureKinds are the catalog's kinds of feature; SurfacePlants the
	// names of the plants that grow on each surface, by its index.
	FeatureKinds  []FeatureKind
	SurfacePlants [][]string
	// TownKinds are the catalog's kinds of building's names, by their
	// indices; TownLook how a town's sheet is drawn.
	TownKinds []string
	TownLook  chart.TownLook
	// Life is the world's life: its end, the next world, the jobs' runs,
	// and the owner's hand on them. Without it the page shows none of it.
	Life Life
	// From, if not nil, is a view of the same world already drawn, the
	// next world's before it began: its drawings are kept, not drawn again.
	From *Owner

	// Charted, if not nil, is the world's chart as it stands; Subjects how
	// many subjects there are to chart.
	Charted  ChartedList
	Subjects int

	// Forecasts, if not nil, is the world's forecast as issued; a world not
	// sailed has none. Words are the catalog's words of the weather; Risks
	// and RiskMarks each regime's risk and the chart's marks of it, by the
	// regimes' indices; Fog the rule a fog bank is born by; and Outlook the
	// minutes after an issue a place's outlook is sampled at.
	Forecasts Forecasts
	Words     weather.Words
	Risks     []weather.Risk
	RiskMarks [][]string
	Fog       weather.FogRule
	Outlook   []float64

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
	land *land
	// current is the current's grid, once per world.
	current  []byte
	islands  []byte
	features []byte
	places   []byte
	towns    []byte
	// fc is what the forecast's routes keep for the world.
	fc forecastCache
}

// Paths are the owner's tools' routes, for the tests that the public
// listeners serve none of them.
var Paths = []string{
	"/owner/", "/owner/index.html", "/owner/assets/x.js",
	"/owner/api/world.json", "/owner/api/gusts.bin", "/owner/api/islands.json", "/owner/api/current.json",
	"/owner/api/land.png", "/owner/api/coasts.svg", "/owner/api/island/0.svg", "/owner/api/point",
	"/owner/api/flag", "/owner/api/place", "/owner/api/unseen", "/owner/api/places.json", "/owner/api/world",
	"/owner/api/towns.json", "/owner/api/town/0.svg", "/owner/api/features.json", "/owner/api/charted.json",
	"/owner/api/accounts.json", "/owner/api/lifecycle.json", "/owner/api/next", "/owner/api/next/land.png",
	"/owner/api/weather.json", "/owner/api/pressure.json", "/owner/api/next/weather.json", "/owner/api/sea.json",
	"/owner/api/clouds.json", "/owner/api/visibility.json", "/owner/api/chart",
	"/owner/api/forecast.json", "/owner/api/calibration.json", "/owner/api/gales.json", "/owner/api/place.json",
	"/owner/api/lifetime", "/owner/api/machines", "/owner/api/priority",
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
	if cfg.Frames != nil {
		// A view of a world not yet sailed, the next world's, has no
		// frames: what is drawn of it alone is served.
		o.b.init(&o.cfg)
	}
	if f := cfg.From; f != nil && f.cfg.World.ID == cfg.World.ID && f.cfg.Bundle == cfg.Bundle {
		o.land = f.land
	} else {
		o.land = &land{}
		o.land.init(&o.cfg)
	}
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
	o.drawn(mux, "/owner/api/")
	mux.HandleFunc("GET /owner/api/charted.json", o.charted)
	mux.HandleFunc("GET /owner/api/accounts.json", o.accounts)
	mux.HandleFunc("GET /owner/api/point", o.point)
	mux.HandleFunc("GET /owner/api/sea.json", o.sea)
	mux.HandleFunc("GET /owner/api/clouds.json", o.clouds)
	mux.HandleFunc("GET /owner/api/visibility.json", o.visibility)
	mux.HandleFunc("GET /owner/api/forecast.json", o.forecastJSON)
	mux.HandleFunc("GET /owner/api/calibration.json", o.calibration)
	mux.HandleFunc("GET /owner/api/gales.json", o.gales)
	mux.HandleFunc("GET /owner/api/place.json", o.placeWeather)
	mux.HandleFunc("POST /owner/api/flag", o.flag)
	mux.HandleFunc("POST /owner/api/priority", o.priority)
	mux.HandleFunc("POST /owner/api/lifetime", o.lifetime)
	mux.HandleFunc("POST /owner/api/machines", o.machineCap)
	mux.HandleFunc("POST /owner/api/place", o.place)
	mux.HandleFunc("POST /owner/api/unseen", o.unseen)
	mux.HandleFunc("POST /owner/api/world", o.newWorld)
	mux.HandleFunc("GET /owner/api/lifecycle.json", o.lifecycle)
	mux.HandleFunc("POST /owner/api/next", o.makeNext)
	mux.HandleFunc("POST /owner/api/chart", o.chartWhole)
	mux.HandleFunc("GET /owner/api/next/", o.next)
	var refused func()
	if m := o.cfg.Metrics; m != nil {
		c := m.OwnerRefused.WithLabelValues("request")
		refused = c.Inc
	}
	return Guard(mux, refused)
}

// drawn adds the routes of what is drawn and listed of the world's
// terrain, the same for its life, under prefix: the current world's under
// /owner/api/, the next world's under /owner/api/next/.
func (o *Owner) drawn(mux *http.ServeMux, prefix string) {
	mux.HandleFunc("GET "+prefix+"islands.json", o.serveFixed(func() []byte { return o.islands }, "application/json"))
	mux.HandleFunc("GET "+prefix+"places.json", o.serveFixed(func() []byte { return o.places }, "application/json"))
	mux.HandleFunc("GET "+prefix+"towns.json", o.serveFixed(func() []byte { return o.towns }, "application/json"))
	mux.HandleFunc("GET "+prefix+"features.json", o.serveFixed(func() []byte { return o.features }, "application/json"))
	mux.HandleFunc("GET "+prefix+"town/{file}", o.land.town)
	mux.HandleFunc("GET "+prefix+"current.json", o.serveFixed(func() []byte { return o.current }, "application/json"))
	mux.HandleFunc("GET "+prefix+"land.png", o.land.serve(landPNG))
	mux.HandleFunc("GET "+prefix+"coasts.svg", o.land.serve(coastsSVG))
	mux.HandleFunc("GET "+prefix+"island/{file}", o.land.island)
	mux.HandleFunc("GET "+prefix+"weather.json", o.weather)
	mux.HandleFunc("GET "+prefix+"pressure.json", o.pressure)
}

// DrawnHandler is the routes of what is drawn of the world under
// /owner/api/next/: the next world's view, before it begins.
func (o *Owner) DrawnHandler() http.Handler {
	mux := http.NewServeMux()
	o.drawn(mux, "/owner/api/next/")
	return mux
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
