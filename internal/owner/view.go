// SPDX-License-Identifier: AGPL-3.0-only

package owner

import (
	"context"
	"encoding/json"
	"math"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/sky"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen/chart"
)

// view is the world as the page last saw it: world.json, and the gusts'
// grid, gusts.bin.
type view struct {
	world []byte
	gusts []byte
}

// The gusts' grid, gusts.bin: a byte a point, row by row from the north
// west, each point's wind over the mean in steps of GustStep m/s as a
// signed byte, NoGust beyond the disk. Its points are the centres of the
// cells of a square of chart.Half metres each way about the centre, the
// grid's step apart.
const (
	GustStep = 0.1 // m/s
	NoGust   = math.MinInt8
	noGust   = 0x80 // NoGust's byte
)

// boatCopy is what the page shows of a boat, copied from a frame.
type boatCopy struct {
	boat           uint64
	owner          bus.Account
	conn           uint64
	grace          int64
	kind           uint16
	x, y, heading  float64
	speed          float64 // over the ground, m/s
	falling, stays bool
	unseen         bool
	// machine is a machine sailor's boat; priority, admitted as a priority
	// account's.
	machine, priority bool
}

// named is an account as the database last said, and when.
type named struct {
	acc store.Account
	at  time.Time
	ok  bool // the database has it
}

// NamesFor is how long an account's name, kind and flag are used before
// they are read again.
const NamesFor = time.Minute

// builder builds the view, on Run's goroutine alone.
type builder struct {
	cfg *Config

	// Copied from the latest frame.
	tick     int64
	boats    []boatCopy
	queue    []bus.Waiting
	spells   [physics.WeatherSpells]physics.Spell
	nspells  int32
	weathers []bus.Weather
	keys     [bus.KeyFrames]physics.Keyframe

	weather physics.Weather
	wind    physics.WeatherTick
	names   map[bus.Account]named
	ask     []store.AccountID
	gusts   []byte
	// stale are the accounts whose flag the page changed since the last
	// build: read again.
	staleMu sync.Mutex
	stale   []bus.Account
}

func (b *builder) init(cfg *Config) {
	b.cfg = cfg
	capacity := cfg.Frames.Latest().Capacity()
	b.boats = make([]boatCopy, 0, capacity)
	b.queue = make([]bus.Waiting, 0, bus.QueueLimit)
	b.weathers = make([]bus.Weather, 0, bus.WeatherHistory)
	b.weather.Prepared = cfg.Weather
	b.names = map[bus.Account]named{}
	n := gustSide(cfg.Grids.Gusts)
	b.gusts = make([]byte, n*n)
}

// gustSide is how many points the gusts' grid has a side.
func gustSide(step float64) int { return int(math.Ceil(2 * chart.Half / step)) }

// copyFrame copies what the page shows of the latest frame, holding it
// only while it copies. It allocates nothing once the builder's room has
// grown to the world's.
func (b *builder) copyFrame() {
	f := b.cfg.Frames.Acquire()
	b.tick = f.Tick
	b.boats = b.boats[:0]
	for _, s := range f.Live {
		st := &f.State[s]
		b.boats = append(b.boats, boatCopy{
			boat: f.Boat[s], owner: f.Owner[s], conn: f.Conn[s], grace: f.Grace[s], kind: f.Kind[s],
			x: st.X, y: st.Y, heading: st.Heading, speed: math.Hypot(st.Surge, st.Sway),
			falling: f.Voyage[s].Falling(), stays: f.Stay[s], unseen: f.Unseen[s],
			machine: f.Machine[s], priority: f.Priority[s],
		})
	}
	b.queue = append(b.queue[:0], f.Queue...)
	b.spells, b.nspells = f.Spells, f.NSpells
	b.weathers = append(b.weathers[:0], f.Weathers...)
	b.keys = f.Keys
	f.Release()
}

// build builds a view of the latest frame.
func (b *builder) build(ctx context.Context) *view {
	b.copyFrame()
	b.lookUp(ctx)
	b.weather.Set(b.spells[:b.nspells])
	b.weather.SetKeys(b.keys[:2])
	physics.WeatherAt(&b.weather, &b.wind, float64(b.tick))
	w := worldJSON{
		Tick:  b.tick,
		World: b.worldInfo(),
		Boats: make([]boatJSON, 0, len(b.boats)),
		Queue: make([]waitJSON, 0, len(b.queue)),
	}
	if c := b.cfg.Clock; c != nil {
		if wt, ok := c.WorldTime(); ok {
			w.WorldTime = wt.Seconds()
			if s := b.cfg.Sky; s != nil {
				w.Hour = hourAt(sky.Time(s, float64(b.cfg.World.Epoch.UnixMicro()), float64(wt.Microseconds())), s.Day())
			}
		}
	}
	p := b.cfg.Weather
	now := time.Now()
	var watched map[bus.Account]int
	if e := b.cfg.Edge; e != nil {
		watched = e.Watched()
		w.Spectators = e.Spectators()
	}
	w.Admission = admissionJSON{AICap: b.cfg.AICap, AIReserve: b.cfg.AIReserve,
		AISilence: b.cfg.AISilence.Seconds(), AIOrders: b.cfg.AIOrders, AILooks: b.cfg.AILooks}
	for i := range b.boats {
		bc := &b.boats[i]
		n := b.names[bc.owner]
		kind := ""
		if int(bc.kind) < len(b.cfg.Kinds) {
			kind = b.cfg.Kinds[bc.kind]
		}
		j := boatJSON{
			Boat: bc.boat, Account: store.AccountID(bc.owner).String(), Sailor: n.acc.Name, Human: n.acc.Kind != store.AI,
			Kind: kind, East: round2(bc.x), North: round2(bc.y), Heading: round2(degrees(bc.heading)), Knots: round2(bc.speed / knot),
			FromLip: round2(physics.EdgeDistance(p, bc.x, bc.y)), Connected: bc.conn != 0,
			Falling: bc.falling, Stays: bc.stays, Unseen: bc.unseen, Tools: n.acc.Tools,
			Machine: bc.machine, Priority: n.acc.Priority, Admitted: bc.priority, Watchers: watched[bc.owner],
		}
		if bc.machine {
			w.Admission.Machines++
			if a := b.cfg.Agents; a != nil {
				if info, ok := a.Agent(bc.owner); ok {
					j.Agent = agentOf(info, now)
				}
			}
		} else {
			w.Admission.Humans++
		}
		if bc.grace != 0 {
			j.Grace = round2(float64(bc.grace-b.tick) * physics.Dt)
		}
		if n.acc.Tools && b.cfg.Edge != nil {
			if x, y, ok := b.cfg.Edge.Eye(bc.owner); ok {
				j.Eye = &[2]float64{round2(x), round2(y)}
			}
		}
		w.Boats = append(w.Boats, j)
	}
	// Humans and machine sailors wait in queues of their own: each place's
	// position is among those of its kind, as bus.QueuePlace counts it,
	// counted here in one pass.
	for i := range b.queue {
		q := &b.queue[i]
		n := b.names[q.Account]
		var position int
		if q.Machine {
			w.Admission.MachinesWaiting++
			position = w.Admission.MachinesWaiting
		} else {
			w.Admission.HumansWaiting++
			position = w.Admission.HumansWaiting
		}
		w.Queue = append(w.Queue, waitJSON{
			Account: store.AccountID(q.Account).String(), Sailor: n.acc.Name, Tools: n.acc.Tools,
			Waited: round2(float64(b.tick-q.Since) * physics.Dt), Connected: q.Conn != 0,
			Machine: q.Machine, Priority: n.acc.Priority, Admitted: q.Priority, Position: position,
		})
	}
	w.Weather = b.weatherNow()
	w.Wind = b.windArrows()
	b.gustGrid()
	body, err := json.Marshal(&w)
	if err != nil {
		panic(err) // the view always encodes
	}
	return &view{world: body, gusts: slices.Clone(b.gusts)}
}

// agentOf is what the page shows of a machine boat's agent, now.
func agentOf(info AgentInfo, now time.Time) *agentJSON {
	a := &agentJSON{App: info.App, Waiting: round2(info.Waiting.Seconds()), Refusals: info.Refusals}
	if !info.LastCall.IsZero() {
		since := round2(max(0, now.Sub(info.LastCall).Seconds()))
		a.SinceCall = &since
	}
	return a
}

// lookUp reads from the database the accounts the frame names that it
// has not read within NamesFor: their sailors' names, kinds and flags.
// The database's failure leaves the names as they were.
func (b *builder) lookUp(ctx context.Context) {
	now := time.Now()
	b.staleMu.Lock()
	for _, a := range b.stale {
		delete(b.names, a)
	}
	b.stale = b.stale[:0]
	b.staleMu.Unlock()
	b.ask = b.ask[:0]
	want := func(a bus.Account) {
		if n, ok := b.names[a]; !ok || now.Sub(n.at) >= NamesFor {
			b.ask = append(b.ask, store.AccountID(a))
		}
	}
	for i := range b.boats {
		want(b.boats[i].owner)
	}
	for i := range b.queue {
		want(b.queue[i].Account)
	}
	if len(b.ask) == 0 || b.cfg.Accounts == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	found, err := b.cfg.Accounts.Accounts(ctx, b.ask)
	if err != nil {
		b.cfg.Log.Warn("the world page could not read the accounts at sea", "err", err)
		return
	}
	for _, id := range b.ask {
		acc, ok := found[id]
		b.names[bus.Account(id)] = named{acc: acc, at: now, ok: ok}
	}
	// Those gone from the sea for a while are forgotten.
	if len(b.names) > 2*cap(b.boats)+bus.QueueLimit {
		for a, n := range b.names {
			if now.Sub(n.at) >= 10*NamesFor {
				delete(b.names, a)
			}
		}
	}
}

// forget has the builder read an account again at its next build, as the
// page changes its flag; from any goroutine.
func (b *builder) forget(id store.AccountID) {
	b.staleMu.Lock()
	b.stale = append(b.stale, bus.Account(id))
	b.staleMu.Unlock()
}

// worldInfo is the world sailed, and its clock.
func (b *builder) worldInfo() worldInfoJSON {
	w := b.cfg.World
	info := worldInfoJSON{
		Number: w.Number, ID: store.AccountID(w.ID).String(),
		Epoch: w.Epoch.UTC().Format(time.RFC3339), Made: w.Made.UTC().Format(time.RFC3339),
		Lip: b.cfg.Weather.Edge(), Mist: b.cfg.Weather.MistFrom(), Calm: b.cfg.Calm,
	}
	if bd := b.cfg.Bundle; bd != nil {
		info.Seed = jsonUint(bd.Seed)
		info.Generator = bd.Generator
		info.Digest = bd.DigestHex()
	}
	return info
}

// weatherNow is the spell in play: the last of those in play to begin by
// the tick, or the first if none has.
func (b *builder) weatherNow() weatherJSON {
	var w weatherJSON
	if b.nspells == 0 {
		return w
	}
	i := 0
	for j := 1; j < int(b.nspells); j++ {
		if b.spells[j].Begin <= float64(b.tick) {
			i = j
		}
	}
	s := &b.spells[i]
	if r := int(s.Regime); r >= 0 && r < len(b.cfg.Regimes) {
		w.Regime = b.cfg.Regimes[r]
	}
	w.Steady = s.Steady == 1
	w.Knots = round2(s.Speed * physics.SeaSpeedStep / knot)
	w.From = round2(s.From * 360 / 65536)
	w.Drift = round2(s.Drift * 360 / 65536)
	w.Gust = s.Gust / 1000
	if i+1 < int(b.nspells) && b.spells[i+1].Begin > float64(b.tick) {
		w.Next = int64(b.spells[i+1].Begin)
		w.NextIn = round2((b.spells[i+1].Begin - float64(b.tick)) * physics.Dt)
	}
	// A developer's weather in force overrides the world's own.
	for _, d := range slices.Backward(b.weathers) {
		if d.From <= b.tick {
			w.Held = d.Mode == bus.WeatherHeld || d.Mode == bus.WeatherSteady || d.Mode == bus.WeatherFront
			break
		}
	}
	return w
}

// windArrows is the mean wind, without its gusts, every Grids.Wind metres
// over the disk.
func (b *builder) windArrows() windJSON {
	step := b.cfg.Grids.Wind
	lip := b.cfg.Weather.Edge()
	out := windJSON{Step: step}
	n := int(math.Floor(lip / step))
	for j := -n; j <= n; j++ {
		for i := -n; i <= n; i++ {
			x, y := float64(i)*step, float64(j)*step
			if math.Hypot(x, y) > lip {
				continue
			}
			speed, from := physics.MeanWindAt(&b.wind, x, y)
			out.Points = append(out.Points, [4]float64{x, y, round2(speed / knot), round2(degrees(from))})
		}
	}
	return out
}

// gustGrid fills the gusts' grid: the wind a step sails in over its mean,
// in the land's shelter, at each point within the disk.
func (b *builder) gustGrid() {
	step := b.cfg.Grids.Gusts
	n := gustSide(step)
	lip := b.cfg.Weather.Edge()
	var p physics.WindPoint
	for j := range n {
		y := chart.Half - (float64(j)+0.5)*step
		for i := range n {
			x := -chart.Half + (float64(i)+0.5)*step
			k := j*n + i
			if math.Hypot(x, y) > lip {
				b.gusts[k] = noGust
				continue
			}
			physics.WindPointAt(&b.wind, x, y, &p, b.cfg.Shelter)
			b.gusts[k] = byte(int8(max(-127, min(127, math.Round((p.Speed-p.MeanSpeed)/GustStep)))))
		}
	}
}

// GustPoint is the gusts' grid's point (i, j), counted from the north
// west, for a grid of step metres.
func GustPoint(step float64, i, j int) (x, y float64) {
	return -chart.Half + (float64(i)+0.5)*step, chart.Half - (float64(j)+0.5)*step
}

// hourAt is the hour of the day at the centre of the disk at sky time t,
// in a day of day microseconds: 0 to 24, noon at 12.
func hourAt(t, day float64) float64 {
	frac := math.Mod(math.Mod(t, day)+day, day) / day
	return round2(math.Mod(frac*24+12, 24))
}

const knot = 1852.0 / 3600

func degrees(rad float64) float64 { return math.Mod(math.Mod(rad*180/math.Pi, 360)+360, 360) }

// round2 rounds to hundredths: centimetres, for the page.
func round2(v float64) float64 { return math.Round(v*100) / 100 }

// jsonUint is a 64-bit number as JSON's string: JavaScript's numbers hold
// 53 bits.
type jsonUint uint64

func (u jsonUint) MarshalJSON() ([]byte, error) {
	return strconv.AppendQuote(nil, strconv.FormatUint(uint64(u), 10)), nil
}

func (u *jsonUint) UnmarshalJSON(b []byte) error {
	s, err := strconv.Unquote(string(b))
	if err != nil {
		return err
	}
	v, err := strconv.ParseUint(s, 10, 64)
	*u = jsonUint(v)
	return err
}

// world.json.
type worldJSON struct {
	Tick      int64         `json:"tick"`
	WorldTime float64       `json:"worldTime"` // s since the epoch
	Hour      float64       `json:"hour"`      // the sky's hour at the centre
	World     worldInfoJSON `json:"world"`
	Weather   weatherJSON   `json:"weather"`
	Wind      windJSON      `json:"wind"`
	Boats     []boatJSON    `json:"boats"`
	Queue     []waitJSON    `json:"queue"`
	Admission admissionJSON `json:"admission"`
	// Spectators is how many watch boats, how many wait to, and the limit.
	Spectators edge.Spectators `json:"spectators"`
}

// admissionJSON is world.json's admission by kind: the boats at sea and
// the places waiting, of humans and of machine sailors; the machine
// sailors' cap and reserve; and the rules their agents are held to, as
// keel is configured.
type admissionJSON struct {
	Humans          int `json:"humans"`
	Machines        int `json:"machines"`
	HumansWaiting   int `json:"humansWaiting"`
	MachinesWaiting int `json:"machinesWaiting"`
	AICap           int `json:"aiCap"`
	AIReserve       int `json:"aiReserve"`
	// AISilence is how long an agent may make no call before its boat is
	// sent into its grace, s; 0 when the page is not told.
	AISilence float64 `json:"aiSilence"`
	AIOrders  string  `json:"aiOrders,omitempty"`
	AILooks   string  `json:"aiLooks,omitempty"`
}

type worldInfoJSON struct {
	Number    int      `json:"number"`
	ID        string   `json:"id"`
	Seed      jsonUint `json:"seed"`
	Generator int      `json:"generator"`
	Digest    string   `json:"digest"`
	Epoch     string   `json:"epoch"`
	Made      string   `json:"made"`
	Lip       float64  `json:"lip"`  // m from the centre
	Mist      float64  `json:"mist"` // where the mist band begins, m
	Calm      float64  `json:"calm"` // the calm water's ring, m
}

type weatherJSON struct {
	Regime string  `json:"regime"`
	Steady bool    `json:"steady"`
	Held   bool    `json:"held"`
	Knots  float64 `json:"knots"` // at mid-disk
	From   float64 `json:"from"`  // degrees
	Drift  float64 `json:"drift"` // degrees over the spell
	Gust   float64 `json:"gust"`
	Next   int64   `json:"next"`   // the tick of the next change, 0 for none known
	NextIn float64 `json:"nextIn"` // s
}

type windJSON struct {
	Step   float64      `json:"step"`
	Points [][4]float64 `json:"points"` // east, north, knots, from degrees
}

type boatJSON struct {
	Boat      uint64      `json:"boat"`
	Account   string      `json:"account"`
	Sailor    string      `json:"sailor"`
	Human     bool        `json:"human"`
	Kind      string      `json:"kind"`
	East      float64     `json:"east"`
	North     float64     `json:"north"`
	Heading   float64     `json:"heading"` // degrees
	Knots     float64     `json:"knots"`
	FromLip   float64     `json:"fromLip"` // m inside the lip
	Connected bool        `json:"connected"`
	Grace     float64     `json:"grace"` // s left, 0 while connected
	Falling   bool        `json:"falling"`
	Stays     bool        `json:"stays"`
	Unseen    bool        `json:"unseen"`
	Tools     bool        `json:"tools"`
	Eye       *[2]float64 `json:"eye"` // the free camera, east and north, while it roams
	// Machine is a machine sailor's boat, as the world holds it.
	Machine bool `json:"machine"`
	// Priority is the account's priority as the database last said, which
	// its next join takes; Admitted, whether this boat was given as a
	// priority account's.
	Priority bool `json:"priority"`
	Admitted bool `json:"admitted"`
	// Agent is a machine boat's agent, while keel knows of it.
	Agent *agentJSON `json:"agent,omitempty"`
	// Watchers is how many watch the boat.
	Watchers int `json:"watchers"`
}

// agentJSON is what the page shows of a machine boat's agent.
type agentJSON struct {
	App       string   `json:"app"`
	SinceCall *float64 `json:"sinceCall"` // s since its last call, null for none
	Waiting   float64  `json:"waiting"`   // s its observe has waited so far, 0 while not waiting
	Refusals  uint64   `json:"refusals"`  // its calls refused since keel started
}

type waitJSON struct {
	Account   string  `json:"account"`
	Sailor    string  `json:"sailor"`
	Tools     bool    `json:"tools"`
	Waited    float64 `json:"waited"` // s
	Connected bool    `json:"connected"`
	// Machine is a machine sailor's place, Position its place among those
	// of its kind, 1 for the head: humans and machine sailors wait in
	// queues of their own.
	Machine  bool `json:"machine"`
	Position int  `json:"position"`
	// Priority is the account's priority as the database last said;
	// Admitted, whether this place waits as a priority account's.
	Priority bool `json:"priority"`
	Admitted bool `json:"admitted"`
}
