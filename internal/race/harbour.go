// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"context"
	"fmt"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Harbour makes the world's harbour races for the hours ahead of now
// (HarbourAhead, or as many as the board shows), each once, by the
// timetable in force, written fenced by the lease's epoch; and as the
// world begins, its days' newcomers' hours, once. Its answer says what it
// did.
func (s *Service) Harbour(ctx context.Context, lease int64, now time.Time) (int, string, error) {
	limits, err := s.cfg.Store.RaceSettings(ctx)
	if err != nil {
		return 0, "", err
	}
	w := &s.cfg.World
	window := windowOf(w.Begins, s.cfg.Ends(), limits.Cutoff)
	days, err := s.cfg.Store.HarbourDays(ctx, w.ID)
	if err != nil {
		return 0, "", err
	}
	if len(days) == 0 {
		set := GreenhornDays(w.Seed, window, limits.Every, limits.GreenhornUS, s.cfg.Zone)
		if len(set) > 0 {
			if err := s.cfg.Store.SetHarbourDays(ctx, lease, w.ID, set); err != nil {
				return 0, "", err
			}
			if days, err = s.cfg.Store.HarbourDays(ctx, w.ID); err != nil {
				return 0, "", err
			}
		}
	}
	courses := s.cfg.Courses()
	trials, err := s.standing(ctx, lease, now, limits, &courses)
	if err != nil {
		return 0, "", err
	}
	if len(courses.Areas) == 0 {
		return trials, fmt.Sprintf("world %d: no racing area, %d standing trials", w.Number, trials), nil
	}
	greenhorn := map[string]int{}
	for _, d := range days {
		greenhorn[d.Day.Format(time.DateOnly)] = d.Hour
	}
	// Far enough ahead that the board always has its next few to show.
	ahead := max(HarbourAhead, time.Duration(HarbourShown*limits.Every)*time.Hour)
	slots := Slots(window, now, now.Add(ahead), limits.Every, s.cfg.Zone)
	if len(slots) == 0 {
		return trials, fmt.Sprintf("world %d: no harbour race due, %d standing trials", w.Number, trials), nil
	}
	busy, err := s.cfg.Store.BusyAreas(ctx, w.ID, slots[0].At.Add(-AreaApart), slots[len(slots)-1].At.Add(AreaApart))
	if err != nil {
		return 0, "", err
	}
	usualBoat := usual(limits.Boats)
	var races []store.NewRace
	for _, sl := range slots {
		r := store.NewRace{World: w.ID, Kind: KindRace, CourseKind: CourseBuoy, Who: WhoEveryone, StartsAt: sl.At,
			Harbour: sl.Hour, MadeAt: now, Shape: ShapeTriangle}
		if (sl.Hour/max(limits.Every, 1))%2 == 1 {
			r.Shape = ShapeWindwardLeeward
		}
		if h, ok := greenhorn[sl.Day.Format(time.DateOnly)]; ok && h == sl.Hour {
			r.Who, r.Boat, r.Name = WhoNewcomers, usualBoat, Greenhorn
		} else {
			r.Boat = rotation(limits.Boats, sl, max(limits.Every, 1))
			plural := ""
			if r.Boat != usualBoat {
				if b := s.boat(r.Boat); b != nil {
					plural = Plural(b.Name)
				}
			}
			r.Name = HourName(sl.Hour, plural)
		}
		b := s.boat(r.Boat)
		if b == nil || !s.inAreas(b, &courses) {
			continue
		}
		area, ok := freeArea(courses.Areas, busy, sl.At)
		if !ok {
			continue
		}
		r.Course = area
		// A harbour race already made keeps its area: the next slot's
		// choice counts this one as taken whether it is made now or was.
		busy = append(busy, store.BuoyStart{Area: area, At: sl.At})
		races = append(races, r)
	}
	made, err := s.cfg.Store.MakeHarbourRaces(ctx, lease, races)
	if err != nil {
		return 0, "", err
	}
	return made + trials, fmt.Sprintf("world %d: %d harbour races made of %d due, %d standing trials", w.Number, made, len(races), trials), nil
}

// The Harbourmaster's standing trials, made with the world's harbour
// races: on each buoy course a newcomer is set to sail (the short
// windward–leeward, the short triangle and the long windward–leeward),
// for every kind of boat that races buoy courses, and on each island
// course open, for every kind it is offered to. Each is made once, and
// stays open for runs the whole world long, the course laid to the wind
// at each run. A course a certificate asks for is always one of these.
var standingBuoys = []struct {
	shape string
	long  bool
}{{ShapeWindwardLeeward, false}, {ShapeTriangle, false}, {ShapeWindwardLeeward, true}}

// standing makes the standing trials not yet made, fenced by the lease's
// epoch: how many it made.
func (s *Service) standing(ctx context.Context, lease int64, now time.Time, limits store.RaceSettings, courses *Courses) (int, error) {
	if latest := s.latest(limits); !latest.IsZero() && now.After(latest) {
		return 0, nil
	}
	w := &s.cfg.World
	var trials []store.NewRace
	for i := range s.cfg.Catalog.Boats {
		b := &s.cfg.Catalog.Boats[i]
		if !s.inAreas(b, courses) {
			continue
		}
		for _, c := range standingBuoys {
			trials = append(trials, store.NewRace{World: w.ID, Kind: KindTrial, CourseKind: CourseBuoy, Shape: c.shape, Long: c.long,
				Boat: string(b.ID), Who: WhoEveryone, Name: StandingName(CourseBuoy, c.shape, c.long, ""), StartsAt: now, Harbour: -1,
				MadeAt: now})
		}
	}
	for _, ic := range courses.Island {
		for i := range s.cfg.Catalog.Boats {
			b := &s.cfg.Catalog.Boats[i]
			if _, ok := ic.Boats[string(b.ID)]; !ok {
				continue
			}
			trials = append(trials, store.NewRace{World: w.ID, Kind: KindTrial, CourseKind: CourseIsland, Course: ic.Number,
				Boat: string(b.ID), Who: WhoEveryone, Name: StandingName(CourseIsland, "", false, ic.Name), StartsAt: now, Harbour: -1,
				MadeAt: now})
		}
	}
	if len(trials) == 0 {
		return 0, nil
	}
	return s.cfg.Store.MakeStandingTrials(ctx, lease, trials)
}
