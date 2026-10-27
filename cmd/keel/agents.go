// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/agentapi"
	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/forecast"
	"github.com/daneelvt/keel-over-the-edge/internal/jobs"
	"github.com/daneelvt/keel-over-the-edge/internal/oauth"
	"github.com/daneelvt/keel-over-the-edge/internal/owner"
	"github.com/daneelvt/keel-over-the-edge/internal/sim"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
	"github.com/daneelvt/keel-over-the-edge/internal/weather"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// Sign-in for AI apps, kept across worlds: the authorization server on the
// play listener, the MCP address's door on the agents' listener, and what
// both share: the grant lifetime, and the door's check, which every
// revocation tells at once.
type agents struct {
	lifetime *oauth.Lifetime
	grants   *oauth.Grants
	server   *oauth.Server
	usage    *agentapi.Usage
	core     *agentapi.Core
	handler  http.Handler
	looks    oauth.MachineLooks
	boat     string
}

// machineLooks are the catalog's choices of a machine sailor's look.
func machineLooks(cat *catalog.Catalog) oauth.MachineLooks {
	of := func(cs []catalog.MachineChoice) []oauth.LookOption {
		out := make([]oauth.LookOption, len(cs))
		for i, c := range cs {
			out[i] = oauth.LookOption{ID: string(c.ID), Name: c.Name}
			if c.Colour != nil {
				out[i].Colour = *c.Colour
			}
		}
		return out
	}
	m := &cat.Machine
	return oauth.MachineLooks{Versions: of(m.Versions), Finishes: of(m.Finishes), Colours: of(m.Colours)}
}

// newAgents makes sign-in for AI apps, the lifetime read from the
// database.
func (p *process) newAgents(ctx context.Context, stopped *accounts.Set) (*agents, error) {
	d, err := p.db.GrantLifetime(ctx)
	if err != nil {
		return nil, fmt.Errorf("the grant lifetime: %w", err)
	}
	a := &agents{lifetime: oauth.NewLifetime(d), looks: machineLooks(p.cat), boat: string(p.cat.Boats[0].ID)}
	a.grants = oauth.NewGrants(p.db, a.lifetime, p.cfg.Schedule.Zone, nil)
	var page func(w http.ResponseWriter, r *http.Request)
	if p.page != nil && p.page.Has(approvePage) {
		page = func(w http.ResponseWriter, r *http.Request) { p.page.Serve(w, r, approvePage) }
	}
	a.server = oauth.New(oauth.Config{
		Issuer: p.cfg.PlayOrigin, Resource: p.cfg.AgentsURL, Store: p.db, Passkeys: p.passkeys,
		Fetcher: oauth.NewFetcher(oauth.FetcherOptions{}), Lifetime: a.lifetime, Grants: a.grants,
		Looks: a.looks, Boat: a.boat, Build: p.build, Zone: p.cfg.Schedule.Zone, Log: p.log, Metrics: p.metrics,
		Page: page, AtSea: p.atSea,
	})
	a.usage = agentapi.NewUsage(p.db, p.log)
	a.core = agentapi.NewCore(agentapi.CoreConfig{Log: p.log, Metrics: p.metrics, Silence: p.cfg.AISilence, Stopped: stopped.Has})
	a.handler, err = agentapi.Handler(agentapi.Config{
		Resource: p.cfg.AgentsURL, Issuer: p.cfg.PlayOrigin, Grants: a.grants, Used: a.usage.Used,
		Build: p.build, Log: p.log, Metrics: p.metrics, Core: a.core,
	})
	if err != nil {
		return nil, err
	}
	p.log.Info("the MCP address", "url", p.cfg.AgentsURL, "grant_lifetime", d.String())
	return a, nil
}

// seaOf is the world half h as the machine sailors' tools reach it.
func (p *process) seaOf(h *worldHalf, rw *readyWorld, sighting *sim.Sight) *agentapi.Sea {
	cat := p.cat
	s := &agentapi.Sea{
		Number: h.row.Number, Epoch: h.row.Epoch, Ends: h.ends, Bus: h.bus, Boats: cat.Boats,
		Limit: h.world.Limit(), AICap: h.world.AICap(), AIReserve: h.world.AIReserve(),
		Timeline: rw.timeline, Waves: p.waves, Sky: cat.PrepareSky(), Bundle: rw.bundle,
		Forecast: h.forecasts, Words: weather.WordsOf(cat), Catalog: cat, Kinds: p.kinds, Encounters: cat.PrepareEncounters(),
		News: news{db: p.db, world: h.row.ID}.News, Columns: map[string]string{}, Biomes: map[string]string{},
	}
	if t := rw.terrain; t != nil {
		s.Ground, s.Shelter = t.Ground, t.Shelter
	}
	if rw.charts != nil {
		s.Chart, s.Sight = rw.charts.model, sighting
	}
	s.Place = &forecast.PlaceWords{Timeline: rw.timeline, Words: s.Words, Outlook: cat.Weather.Forecast.Outlook.Samples}
	copy(s.RainWords[:], cat.Weather.Clouds.RainWords)
	for _, c := range cat.News.Columns {
		s.Columns[string(c.ID)] = c.Title
	}
	for _, b := range cat.World.Biomes {
		s.Biomes[string(b.ID)] = strings.ReplaceAll(string(b.ID), "-", " ")
	}
	for _, k := range cat.World.Places.Kinds {
		s.PlaceKinds = append(s.PlaceKinds, k.Name)
	}
	for _, k := range cat.World.Features.Kinds {
		s.FeatureKinds = append(s.FeatureKinds, k.Name)
	}
	for _, k := range cat.Weather.Systems {
		s.SystemKinds = append(s.SystemKinds, k.Name)
	}
	if b := rw.bundle; b != nil {
		for _, is := range b.Islands {
			if is.Kind == worldgen.KindMain {
				s.Start = is.Name
				break
			}
		}
	}
	return s
}

// ownerAgents tells the world page of the machine sailors' agents.
type ownerAgents struct{ core *agentapi.Core }

func (o ownerAgents) Agent(account bus.Account) (owner.AgentInfo, bool) {
	app, last, waiting, refusals, ok := o.core.Agent(account)
	return owner.AgentInfo{App: app, LastCall: last, Waiting: waiting, Refusals: refusals}, ok
}

// approvePage is the approval page's file in the built page.
const approvePage = "approve.html"

// apiConfig is the play routes' part in sign-in for AI apps.
func (a *agents) apiConfig(cfg *api.Config, p *process) {
	cfg.OAuth, cfg.Grants, cfg.MCP, cfg.Lifetime = a.server, a.grants, p.cfg.AgentsURL, a.lifetime
	cfg.MachineLooks, cfg.Boat, cfg.AtSea, cfg.Machines = a.looks, a.boat, p.atSea, p.db
}

// atSea reports whether an account's boat is at sea in the world sailed.
func (p *process) atSea(id store.AccountID) bool {
	h := p.current.Load()
	if h == nil {
		return false
	}
	f := h.bus.Frames.Acquire()
	defer f.Release()
	for _, s := range f.Live {
		if f.Owner[s] == bus.Account(id) {
			return true
		}
	}
	return false
}

// The oauth job's time of day, UTC, after the sessions' and the worlds'.
const (
	jobOAuth               = "oauth"
	oauthHour, oauthMinute = 7, 30
	grantsEvery            = 5 * time.Minute
	grantsTimeout          = 10 * time.Second
)

// oauthJob deletes what sign-in for AI apps no longer needs.
func (p *process) oauthJob() jobs.Job {
	return jobs.Job{
		Name: jobOAuth, Due: jobs.Daily(oauthHour, oauthMinute), Next: jobs.DailyNext(oauthHour, oauthMinute),
		Run: func(ctx context.Context, due time.Time) (jobs.Result, error) {
			c, err := p.db.DeleteOAuthLeftovers(ctx, due, p.agents.lifetime.Get())
			if err != nil {
				return jobs.Result{}, err
			}
			n := c.Requests + c.Codes + c.AccessTokens + c.RefreshTokens + c.Grants + c.Clients
			return jobs.Result{Skipped: n == 0, Detail: fmt.Sprintf(
				"%d requests, %d codes, %d access and %d refresh tokens, %d grants and %d clients deleted",
				c.Requests, c.Codes, c.AccessTokens, c.RefreshTokens, c.Grants, c.Clients)}, nil
		},
	}
}

// countGrants keeps keel_grants_live up to date, every grantsEvery, until
// ctx ends.
func (p *process) countGrants(ctx context.Context) {
	t := time.NewTicker(grantsEvery)
	defer t.Stop()
	for {
		qctx, cancel := context.WithTimeout(ctx, grantsTimeout)
		c, err := p.db.MachineCounts(qctx, p.agents.lifetime.Get())
		cancel()
		if err == nil {
			for _, k := range []string{store.GrantApp, store.GrantConnection} {
				p.metrics.GrantsLive.WithLabelValues(k).Set(float64(c.Grants[k]))
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
