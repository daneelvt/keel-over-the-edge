// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"encoding/json"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/life"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// lifeOf is a world's life schedule: its habitat built from its terrain as
// made, whether its land is sailed or not, on a disk of radius disk, its
// seed and the sky over it from its epoch.
func lifeOf(cat *catalog.Catalog, b *worldgen.Bundle, disk float64, epoch time.Time, log *slog.Logger) *life.Schedule {
	made := time.Now()
	p, kinds := life.Prepare(cat)
	places := life.Places{}
	var ground *physics.Ground
	if b != nil {
		ground = b.Ground
		for _, t := range b.Towns {
			places.Towns = append(places.Towns, [2]float64{t.X, t.Y})
		}
		sites := map[string]catalog.Site{}
		for _, k := range cat.World.Places.Kinds {
			sites[string(k.ID)] = k.Site
		}
		for _, pl := range b.Places {
			if s := sites[pl.Kind]; s == catalog.SiteReef || s == catalog.SiteLagoon {
				places.Reefs = append(places.Reefs, life.Reach{X: pl.X, Y: pl.Y, Half: math.Min(pl.Details.Length/2, 1000)})
			}
		}
		colony := map[string]bool{}
		for _, k := range cat.World.Features.Kinds {
			colony[string(k.ID)] = k.Site == catalog.FeatureSiteColony
		}
		for _, f := range b.Features {
			if colony[f.Kind] {
				places.Colonies = append(places.Colonies, [2]float64{f.X, f.Y})
			}
		}
		for _, is := range b.Islands {
			places.Islands = append(places.Islands, [2]float64{is.X, is.Y})
		}
	}
	h := life.NewHabitat(p, ground, places, disk)
	var seed uint64
	if b != nil {
		seed = b.Seed
	}
	s := life.NewSchedule(&life.Config{Params: p, Kinds: kinds, Habitat: h, Seed: seed, Sky: cat.PrepareSky(), Epoch: epoch.UnixMicro()})
	log.Info("the sea's life is ready", "kinds", len(kinds), "towns", len(places.Towns), "reefs", len(places.Reefs),
		"colonies", len(places.Colonies), "took", time.Since(made).Round(time.Millisecond).String())
	return s
}

// lifeReach is how far each kind of the sea's life is sent: within its
// reach of where it is drawn and its range, which it comes in from.
func lifeReach(cat *catalog.Catalog) *edge.LifeReach {
	r := &edge.LifeReach{Drop: cat.Life.Drop}
	for _, k := range cat.Life.Kinds {
		r.Reach = append(r.Reach, k.Reach+k.Range)
	}
	return r
}

// lifeRoute raises an encounter with the sea's life by hand, on the
// internal listener only, with KEEL_DEV_COMMANDS=1: of the kind given, by
// its id or its index in the catalog's, at a point, or near the first
// player's boat (at=boat, 150 m off its bow, or the boat given), beginning
// at the next tick. A kind that follows boats or rides their bows takes
// the boat if it is under way on a steady course, quiet or not; one that
// brings others brings them; a ground of fish is raised reaching its
// kind's furthest, unseen but for the fish the boats in it flush. It
// answers with the kind and where.
//
//	POST /debug/life?kind=…&east=…&north=…
//	POST /debug/life?kind=…&at=boat[&boat=…][&ahead=m]
func lifeRoute(b *bus.Bus, cat *catalog.Catalog, log *slog.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "POST only", http.StatusMethodNotAllowed)
			return
		}
		q := r.URL.Query()
		kind := -1
		for i := range cat.Life.Kinds {
			if cat.Life.Kinds[i].ID == q.Get("kind") || strconv.Itoa(i) == q.Get("kind") {
				kind = i
			}
		}
		if kind < 0 {
			http.Error(w, "kind, the id or index of one of the catalog's life kinds, is required", http.StatusBadRequest)
			return
		}
		var east, north float64
		if q.Get("at") == "boat" {
			var wanted uint64
			if q.Has("boat") {
				n, err := strconv.ParseUint(q.Get("boat"), 10, 64)
				if err != nil || n == 0 {
					http.Error(w, "boat is not a boat's id", http.StatusBadRequest)
					return
				}
				wanted = n
			}
			ahead := 150.0
			if q.Has("ahead") {
				a, err := strconv.ParseFloat(q.Get("ahead"), 64)
				if err != nil || math.Abs(a) > 5000 {
					http.Error(w, "ahead is metres, within 5 km", http.StatusBadRequest)
					return
				}
				ahead = a
			}
			f := b.Frames.Acquire()
			found := false
			for _, s := range f.Live {
				if wanted != 0 && f.Boat[s] == wanted || wanted == 0 && f.Conn[s] != 0 && f.Grace[s] == 0 {
					st := &f.State[s]
					east, north = st.X+ahead*math.Sin(st.Heading), st.Y+ahead*math.Cos(st.Heading)
					found = true
					break
				}
			}
			f.Release()
			if !found {
				http.Error(w, "no such boat at sea", http.StatusConflict)
				return
			}
		} else {
			var err1, err2 error
			east, err1 = strconv.ParseFloat(q.Get("east"), 64)
			north, err2 = strconv.ParseFloat(q.Get("north"), 64)
			if err1 != nil || err2 != nil || math.Abs(east) > 20000 || math.Abs(north) > 20000 {
				http.Error(w, "east and north, metres within 20 km of the centre, or at=boat, are required", http.StatusBadRequest)
				return
			}
		}
		c := bus.Command{Op: bus.RaiseLife, LifeKind: uint16(kind), State: physics.State{X: east, Y: north}}
		if err := b.Commands.Developer().TrySend(c); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		log.Info("the sea's life raised by hand", "kind", cat.Life.Kinds[kind].ID, "east", east, "north", north)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"kind": cat.Life.Kinds[kind].ID, "index": kind, "east": east, "north": north})
	})
}
