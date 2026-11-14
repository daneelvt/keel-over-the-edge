// SPDX-License-Identifier: AGPL-3.0-only

package logbook

import (
	"context"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A log's ribbons: every race its sailor sailed, skipper or crew, over
// every world, each with its place of how many and its awards, newest
// first; and the counts kept for good. Read with the log, by the log's
// own rule: who may read the log may read its ribbons. A crew's record
// names the boat's skipper as the log names anyone. The log itself
// carries the counts; its races are read a page at a time, so that
// neither answer outgrows a phone's data.

// RibbonsPage is how many races a page of a log's ribbons lists; the
// counts are over every race.
const RibbonsPage = 30

// Ribbons are a log's races: the counts, and a page of races from the
// newest with More if older ones follow. The log's own answer has no
// page.
type Ribbons struct {
	Counts RaceCounts `json:"counts"`
	Races  []Ribbon   `json:"races,omitempty"`
	More   bool       `json:"more,omitempty"`
}

// RaceCounts are a sailor's races counted over every world: sailed, the
// top three places and wins of races, each award, each medal of a time
// trial, and the races run as their owner.
type RaceCounts struct {
	Sailed int            `json:"sailed"`
	Top3   int            `json:"top3"`
	Wins   int            `json:"wins"`
	Awards map[string]int `json:"awards"`
	Medals map[string]int `json:"medals"`
	Ran    int            `json:"ran"`
}

// Ribbon is a race in a log: when and in which world; the race's name,
// whether a race or a time trial, its course, its boats' kind (the
// catalog's id), the sailor's boat's name and the fleet's size; a harbour
// race's, a newcomers' race's; the sailor's part (skipper or crew); their
// place, how their race ended (finished, placed, ret), a trial's medal and
// the awards; and a crew's skipper, nil where not named. Code is the
// race's link's; Hung, in the reader's own log, whether its wooden spoon
// hangs from their sterns.
type Ribbon struct {
	World     int      `json:"world"`
	At        int64    `json:"at"`
	Code      string   `json:"code"`
	Name      string   `json:"name"`
	Kind      string   `json:"kind"`
	Course    string   `json:"course"`
	Boat      string   `json:"boat"`
	BoatName  string   `json:"boatName,omitempty"`
	Fleet     int      `json:"fleet"`
	Harbour   bool     `json:"harbour,omitempty"`
	Newcomers bool     `json:"newcomers,omitempty"`
	Role      string   `json:"role"`
	Place     int      `json:"place,omitempty"`
	How       string   `json:"how,omitempty"`
	Medal     string   `json:"medal,omitempty"`
	Awards    []string `json:"awards"`
	Skipper   *Person  `json:"skipper,omitempty"`
	Hung      bool     `json:"hung,omitempty"`
}

// The awards and medals counted, by their names in the record.
var (
	awardNames = [...]string{"best-start", "comeback", "photo-finish", "crowd", "spoon"}
	medalNames = [...]string{"harbourmaster", "gold", "silver", "bronze"}
)

// ribbons reads the races of id's log for r: the counts, and the page of
// races after the first from; none for a from below 0.
func (s *Service) ribbons(ctx context.Context, r Reader, id store.AccountID, from int) (Ribbons, error) {
	c, err := s.cfg.Store.RaceCountsOf(ctx, id)
	if err != nil {
		return Ribbons{}, err
	}
	out := Ribbons{Counts: RaceCounts{Sailed: c.Sailed, Top3: c.Top3, Wins: c.Wins, Ran: c.Ran,
		Awards: map[string]int{}, Medals: map[string]int{}}}
	for i, n := range [...]int{c.BestStarts, c.Comebacks, c.PhotoFinishes, c.Crowds, c.Spoons} {
		if n > 0 {
			out.Counts.Awards[awardNames[i]] = n
		}
	}
	for i, n := range [...]int{c.Harbourmasters, c.Golds, c.Silvers, c.Bronzes} {
		if n > 0 {
			out.Counts.Medals[medalNames[i]] = n
		}
	}
	if from < 0 {
		return out, nil
	}
	out.Races = []Ribbon{}
	if from >= c.Sailed {
		return out, nil
	}
	// One more than the page, to know whether older ones follow.
	recs, err := s.cfg.Store.RaceRibbonsOf(ctx, id, from, RibbonsPage+1)
	if err != nil {
		return Ribbons{}, err
	}
	if len(recs) > RibbonsPage {
		recs, out.More = recs[:RibbonsPage], true
	}
	var skippers []store.AccountID
	seen := map[store.AccountID]bool{}
	for i := range recs {
		if k := recs[i].Skipper; recs[i].Role == store.RoleCrew && k != (store.AccountID{}) && !seen[k] {
			seen[k] = true
			skippers = append(skippers, k)
		}
	}
	people, err := s.cfg.Store.LogPeople(ctx, skippers)
	if err != nil {
		return Ribbons{}, err
	}
	now := s.cfg.Now()
	for i := range recs {
		x := &recs[i]
		rb := Ribbon{World: x.World, At: ms(x.At), Code: x.Code, Name: x.RaceName, Kind: x.Kind, Course: x.CourseName, Boat: x.Boat, BoatName: x.BoatName,
			Fleet: x.Fleet, Harbour: x.Harbour, Newcomers: x.Newcomers, Role: x.Role, Place: x.Place, How: x.How, Medal: x.Medal,
			Awards: x.Awards}
		if rb.Awards == nil {
			rb.Awards = []string{}
		}
		if x.Role == store.RoleCrew {
			rb.Skipper = s.skipperOf(r, id, x, people, now)
		}
		if r.ID == id {
			rb.Hung = x.Hung
		}
		out.Races = append(out.Races, rb)
	}
	return out, nil
}

// skipperOf is a crew's record's skipper as r is shown them, the log
// being owner's: nil where not named.
func (s *Service) skipperOf(r Reader, owner store.AccountID, x *store.RaceRecord, people map[store.AccountID]store.LogPerson, now time.Time) *Person {
	var sl Sailor
	if p, ok := people[x.Skipper]; ok && x.Skipper != (store.AccountID{}) {
		sl = SailorOf(p, now)
	} else {
		sl = Sailor{ID: x.Skipper, Machine: x.SkipperMachine, Gone: true}
	}
	blocked := !r.All && (s.blocks(r.ID, x.Skipper) || s.blocks(owner, x.Skipper))
	switch NameOf(r, sl, blocked) {
	case Named:
		if x.SkipperName == "" {
			return &Person{Hidden: true, Machine: sl.Machine}
		}
		return &Person{Name: x.SkipperName, Machine: sl.Machine, Logged: MayRead(r, sl, blocked)}
	case Hidden:
		return &Person{Hidden: true}
	case Former:
		return &Person{Former: true}
	}
	return nil
}
