// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// Races: made by sailors and by the world (its harbour races, owned by no
// account), each found by its link's code, entered by skippers' boats.
// Every limit on racing is counted from these rows, inside the
// transaction that makes a race or enters one, so two asked at once
// cannot both pass.

// ActionRacing is the record's action for the racing limits or the
// harbour timetable set.
const ActionRacing = "racing"

// The states a race's row may be in. A race open or closed past its
// start is starting, waiting for the world to run it.
const (
	RaceOpen      = "open"      // entries taken
	RaceClosed    = "closed"    // its owner has closed entry
	RaceCancelled = "cancelled" // called off before it started
	RaceRacing    = "racing"    // under way
	RaceFinished  = "finished"  // over, its results kept
)

// RaceSettings are the racing limits and the harbour races' timetable,
// for the whole game: the most races a sailor may be entered in that have
// not started, start in a day, make in a day and own not yet finished;
// how long before a world's end no race may start; the harbour races
// every Every hours on the hour, their boats in turn, by the catalog's
// ids; and the percentage of the week's newcomers' harbour races at the
// hours that suit the US.
type RaceSettings struct {
	Ahead, Daily, Made, Owned int
	Cutoff                    time.Duration
	Every                     int
	Boats                     []string
	GreenhornUS               int
}

// RaceSettings are the racing limits and the harbour timetable in force.
func (s *Store) RaceSettings(ctx context.Context) (RaceSettings, error) {
	r, err := s.q.RaceSettings(ctx)
	if err != nil {
		return RaceSettings{}, err
	}
	return RaceSettings{Ahead: int(r.RaceAhead), Daily: int(r.RaceDaily), Made: int(r.RaceMade), Owned: int(r.RaceOwned),
		Cutoff: time.Duration(r.CutoffSeconds) * time.Second, Every: int(r.HarbourEvery), Boats: r.HarbourBoats,
		GreenhornUS: int(r.GreenhornUs)}, nil
}

// SetRaceSettings sets the racing limits and the harbour timetable, with
// a's record.
func (s *Store) SetRaceSettings(ctx context.Context, r RaceSettings, a Action) error {
	a.Action = ActionRacing
	boats := r.Boats
	if boats == nil {
		boats = []string{}
	}
	return s.setting(ctx, a, func(q *db.Queries) error {
		return q.SetRaceSettings(ctx, db.SetRaceSettingsParams{RaceAhead: int16(r.Ahead), RaceDaily: int16(r.Daily),
			RaceMade: int16(r.Made), RaceOwned: int16(r.Owned), CutoffSeconds: int64(r.Cutoff / time.Second),
			HarbourEvery: int16(r.Every), HarbourBoats: boats, GreenhornUs: int16(r.GreenhornUS)})
	})
}

// Race is a race as its row keeps it: its world, by ID and number; its
// code; its owner (none for a harbour race, HasOwner false); a race or a
// trial; its course, an island course's number or a racing area's (0 for
// a buoy trial's, laid at each run), and for a buoy course its shape and
// length; its boat, by the catalog's id; who may enter; its name; its
// start, and whether its owner has moved it; its state; a harbour race's
// hour, −1 for none; when it was made; and how many boats are entered.
type Race struct {
	World       [16]byte
	WorldNumber int
	ID          [16]byte
	Code        string
	Owner       AccountID
	HasOwner    bool
	Kind        string
	CourseKind  string
	Course      int
	Shape       string
	Long        bool
	Boat        string
	Who         string
	Name        string
	StartsAt    time.Time
	Moved       bool
	State       string
	Harbour     int
	MadeAt      time.Time
	Entered     int
}

// NewRace is a race to make: its world's ID, and the rest as a Race's.
type NewRace struct {
	World      [16]byte
	Owner      AccountID
	HasOwner   bool
	Kind       string
	CourseKind string
	Course     int
	Shape      string
	Long       bool
	Boat       string
	Who        string
	Name       string
	StartsAt   time.Time
	Harbour    int // −1 for none
	AgainOf    [16]byte
	HasAgainOf bool
	MadeAt     time.Time
}

// RaceMaking is what making a race is decided by, counted from the rows
// as it is made: when its owner made the races they made since the time
// asked, how many they own that are not over, and the racing areas taken
// by the buoy races starting within the times asked.
type RaceMaking struct {
	Made  []time.Time
	Owned int
	Busy  []BuoyStart
}

// BuoyStart is a buoy race's racing area and start.
type BuoyStart struct {
	Area int
	At   time.Time
}

func ownerOf(id AccountID, has bool) pgtype.UUID {
	if !has {
		return pgtype.UUID{}
	}
	return uuidOf(id)
}

func textOf(s string) pgtype.Text { return pgtype.Text{String: s, Valid: s != ""} }

func hourOf(h int) pgtype.Int2 { return pgtype.Int2{Int16: int16(h), Valid: h >= 0} }

// MakeRace makes the race r, asking decide first with the counts of its
// owner's races made since since and not over, and of the racing areas
// taken by buoy races starting between from and until; decide may change
// r (its racing area) or refuse with an error, which MakeRace returns.
// Its answer is the race's code.
func (s *Store) MakeRace(ctx context.Context, r *NewRace, since, from, until time.Time, decide func(RaceMaking, *NewRace) error) (string, error) {
	var code string
	err := s.inTx(ctx, func(q *db.Queries) error {
		if r.HasOwner {
			if err := q.LockRacing(ctx, "made:"+r.Owner.String()); err != nil {
				return err
			}
		}
		world := pgtype.UUID{Bytes: r.World, Valid: true}
		if r.CourseKind == "buoy" {
			if err := q.LockRacing(ctx, "areas:"+AccountID(r.World).String()); err != nil {
				return err
			}
		}
		var m RaceMaking
		if r.HasOwner {
			rows, err := q.RacesBy(ctx, db.RacesByParams{OwnerID: uuidOf(r.Owner), Since: since})
			if err != nil {
				return err
			}
			for _, row := range rows {
				if row.MadeAt.After(since) {
					m.Made = append(m.Made, row.MadeAt)
				}
				if row.State == RaceOpen || row.State == RaceClosed || row.State == RaceRacing {
					m.Owned++
				}
			}
		}
		busy, err := q.BuoyRacesNear(ctx, db.BuoyRacesNearParams{WorldID: world, Since: from, Until: until})
		if err != nil {
			return err
		}
		for _, b := range busy {
			m.Busy = append(m.Busy, BuoyStart{Area: int(b.Course), At: b.StartsAt})
		}
		if err := decide(m, r); err != nil {
			return err
		}
		var again pgtype.UUID
		if r.HasAgainOf {
			again = pgtype.UUID{Bytes: r.AgainOf, Valid: true}
		}
		code, err = q.InsertRace(ctx, db.InsertRaceParams{WorldID: world, OwnerID: ownerOf(r.Owner, r.HasOwner),
			Kind: r.Kind, CourseKind: r.CourseKind, Course: int32(r.Course), Shape: textOf(r.Shape), Long: r.Long,
			Boat: r.Boat, Who: r.Who, Name: r.Name, StartsAt: r.StartsAt, Harbour: hourOf(r.Harbour), AgainOf: again,
			MadeAt: r.MadeAt})
		return err
	})
	return code, err
}

// MakeHarbourRaces makes the harbour races given that are not made yet,
// one for each start, fenced by the lease's epoch: how many it made.
func (s *Store) MakeHarbourRaces(ctx context.Context, lease int64, races []NewRace) (int, error) {
	made := 0
	err := s.fenced(ctx, lease, func(q *db.Queries) error {
		made = 0
		for _, r := range races {
			n, err := q.InsertHarbourRace(ctx, db.InsertHarbourRaceParams{WorldID: pgtype.UUID{Bytes: r.World, Valid: true},
				Course: int32(r.Course), Shape: textOf(r.Shape), Boat: r.Boat, Who: r.Who, Name: r.Name,
				StartsAt: r.StartsAt, Harbour: hourOf(r.Harbour), MadeAt: r.MadeAt})
			if err != nil {
				return err
			}
			made += int(n)
		}
		return nil
	})
	return made, err
}

// RaceByCode is the race of a code, in the newest world with one, or
// ErrNotFound.
func (s *Store) RaceByCode(ctx context.Context, code string) (Race, error) {
	r, err := s.q.RaceByCode(ctx, code)
	if errors.Is(err, pgx.ErrNoRows) {
		return Race{}, ErrNotFound
	}
	if err != nil {
		return Race{}, err
	}
	return Race{World: r.WorldID.Bytes, WorldNumber: int(r.World), ID: r.ID.Bytes, Code: r.Code, Owner: r.OwnerID.Bytes,
		HasOwner: r.OwnerID.Bytes != [16]byte{}, Kind: r.Kind, CourseKind: r.CourseKind, Course: int(r.Course),
		Shape: r.Shape, Long: r.Long, Boat: r.Boat, Who: r.Who, Name: r.Name, StartsAt: r.StartsAt.UTC(), Moved: r.Moved,
		State: r.State, Harbour: int(r.Harbour), MadeAt: r.MadeAt.UTC(), Entered: int(r.Entered)}, nil
}

// racesOf are a world's races of the IDs given, by their starts.
func (s *Store) racesOf(ctx context.Context, world [16]byte, number int, ids []pgtype.UUID) ([]Race, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	rows, err := s.q.RaceList(ctx, db.RaceListParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, Ids: ids})
	if err != nil {
		return nil, err
	}
	out := make([]Race, len(rows))
	for i, r := range rows {
		out[i] = Race{World: world, WorldNumber: number, ID: r.ID.Bytes, Code: r.Code, Owner: r.OwnerID.Bytes,
			HasOwner: r.OwnerID.Bytes != [16]byte{}, Kind: r.Kind, CourseKind: r.CourseKind, Course: int(r.Course),
			Shape: r.Shape, Long: r.Long, Boat: r.Boat, Who: r.Who, Name: r.Name, StartsAt: r.StartsAt.UTC(),
			Moved: r.Moved, State: r.State, Harbour: int(r.Harbour), MadeAt: r.MadeAt.UTC(), Entered: int(r.Entered)}
	}
	return out, nil
}

// HarbourRaces are a world's next most harbour races, open or closed,
// starting after after.
func (s *Store) HarbourRaces(ctx context.Context, world [16]byte, number int, after time.Time, most int) ([]Race, error) {
	ids, err := s.q.HarbourRaceIDs(ctx, db.HarbourRaceIDsParams{WorldID: pgtype.UUID{Bytes: world, Valid: true},
		After: after, Most: int32(most)})
	if err != nil {
		return nil, err
	}
	return s.racesOf(ctx, world, number, ids)
}

// RacesOf are the races of a world an account owns or is entered in,
// not over, the soonest first.
func (s *Store) RacesOf(ctx context.Context, world [16]byte, number int, id AccountID) ([]Race, error) {
	ids, err := s.q.RaceIDsOf(ctx, db.RaceIDsOfParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, AccountID: uuidOf(id)})
	if err != nil {
		return nil, err
	}
	return s.racesOf(ctx, world, number, ids)
}

// RaceEntrant is a boat entered in a race: its skipper, its race number,
// whether a machine sailor's, whether those aboard come with it, when it
// was entered, and the name of its skipper's boat of the race's kind, ""
// for none.
type RaceEntrant struct {
	Account  AccountID
	Number   int
	Machine  bool
	WithCrew bool
	Entered  time.Time
	BoatName string
}

// RaceEntrants are a race's boats entered, by race number.
func (s *Store) RaceEntrants(ctx context.Context, r *Race) ([]RaceEntrant, error) {
	rows, err := s.q.RaceEntrants(ctx, db.RaceEntrantsParams{Boat: r.Boat, WorldID: pgtype.UUID{Bytes: r.World, Valid: true},
		RaceID: pgtype.UUID{Bytes: r.ID, Valid: true}})
	if err != nil {
		return nil, err
	}
	out := make([]RaceEntrant, len(rows))
	for i, e := range rows {
		out[i] = RaceEntrant{Account: e.AccountID.Bytes, Number: int(e.Number), Machine: e.Machine, WithCrew: e.WithCrew,
			Entered: e.EnteredAt.UTC(), BoatName: e.BoatName}
	}
	return out, nil
}

// RaceEntry is an account's entry in a race, in force or not: its race
// number, whether those aboard come, and whether withdrawn or removed.
type RaceEntry struct {
	Number    int
	WithCrew  bool
	Withdrawn bool
	Removed   bool
}

// EntryStart is a race an account is entered in: its world and ID, its
// start, state and kind, and whether the boat was placed on its line.
type EntryStart struct {
	World   [16]byte
	Race    [16]byte
	At      time.Time
	State   string
	Kind    string
	Started bool
}

// RaceEntering is what entering a race is decided by, read as it is
// entered: the race's state, start and kind; how many boats are entered;
// the account's entry in it, if any (HasEntry); and the account's races
// entered, in any world, that start after the time asked.
type RaceEntering struct {
	State    string
	StartsAt time.Time
	Kind     string
	Entered  int
	Entry    RaceEntry
	HasEntry bool
	Mine     []EntryStart
}

// EnterRace enters an account's boat in race r at at, asking decide first
// with what entering is decided by (its races counted from since); an
// entry withdrawn is entered again with its number. decide may refuse
// with an error, which EnterRace returns.
func (s *Store) EnterRace(ctx context.Context, r *Race, id AccountID, machine, crew bool, at, since time.Time, decide func(RaceEntering) error) error {
	world, race := pgtype.UUID{Bytes: r.World, Valid: true}, pgtype.UUID{Bytes: r.ID, Valid: true}
	return s.inTx(ctx, func(q *db.Queries) error {
		if err := q.LockRacing(ctx, "entered:"+id.String()); err != nil {
			return err
		}
		locked, err := q.RaceForUpdate(ctx, db.RaceForUpdateParams{WorldID: world, ID: race})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		e := RaceEntering{State: locked.State, StartsAt: locked.StartsAt.UTC(), Kind: locked.Kind}
		entrants, err := q.RaceEntrants(ctx, db.RaceEntrantsParams{Boat: r.Boat, WorldID: world, RaceID: race})
		if err != nil {
			return err
		}
		e.Entered = len(entrants)
		mine, err := q.RaceEntryOf(ctx, db.RaceEntryOfParams{WorldID: world, RaceID: race, AccountID: uuidOf(id)})
		switch {
		case err == nil:
			e.HasEntry = true
			e.Entry = RaceEntry{Number: int(mine.Number), WithCrew: mine.WithCrew, Withdrawn: mine.Withdrawn, Removed: mine.Removed}
		case !errors.Is(err, pgx.ErrNoRows):
			return err
		}
		rows, err := q.EntriesOf(ctx, db.EntriesOfParams{AccountID: uuidOf(id), Since: since})
		if err != nil {
			return err
		}
		for _, row := range rows {
			e.Mine = append(e.Mine, EntryStart{World: row.WorldID.Bytes, Race: row.ID.Bytes, At: row.StartsAt.UTC(),
				State: row.State, Kind: row.Kind, Started: row.Started})
		}
		if err := decide(e); err != nil {
			return err
		}
		number := e.Entry.Number
		if !e.HasEntry {
			n, err := q.NextRaceNumber(ctx, db.NextRaceNumberParams{WorldID: world, RaceID: race})
			if err != nil {
				return err
			}
			number = int(n)
		}
		return q.EnterRace(ctx, db.EnterRaceParams{WorldID: world, RaceID: race, AccountID: uuidOf(id), Number: int16(number),
			Machine: machine, WithCrew: crew, At: at})
	})
}

// RaceEntryOf is an account's entry in a race, and whether it has one.
func (s *Store) RaceEntryOf(ctx context.Context, r *Race, id AccountID) (RaceEntry, bool, error) {
	e, err := s.q.RaceEntryOf(ctx, db.RaceEntryOfParams{WorldID: pgtype.UUID{Bytes: r.World, Valid: true},
		RaceID: pgtype.UUID{Bytes: r.ID, Valid: true}, AccountID: uuidOf(id)})
	if errors.Is(err, pgx.ErrNoRows) {
		return RaceEntry{}, false, nil
	}
	if err != nil {
		return RaceEntry{}, false, err
	}
	return RaceEntry{Number: int(e.Number), WithCrew: e.WithCrew, Withdrawn: e.Withdrawn, Removed: e.Removed}, true, nil
}

// EntriesOf are an account's races entered in force, in any world, that
// start after since.
func (s *Store) EntriesOf(ctx context.Context, id AccountID, since time.Time) ([]EntryStart, error) {
	rows, err := s.q.EntriesOf(ctx, db.EntriesOfParams{AccountID: uuidOf(id), Since: since})
	if err != nil {
		return nil, err
	}
	out := make([]EntryStart, len(rows))
	for i, row := range rows {
		out[i] = EntryStart{World: row.WorldID.Bytes, Race: row.ID.Bytes, At: row.StartsAt.UTC(), State: row.State,
			Kind: row.Kind, Started: row.Started}
	}
	return out, nil
}

// RacesBy are when an owner made the races they made since since, and
// how many they own that are not over.
func (s *Store) RacesBy(ctx context.Context, owner AccountID, since time.Time) (made []time.Time, owned int, err error) {
	rows, err := s.q.RacesBy(ctx, db.RacesByParams{OwnerID: uuidOf(owner), Since: since})
	if err != nil {
		return nil, 0, err
	}
	for _, row := range rows {
		if row.MadeAt.After(since) {
			made = append(made, row.MadeAt.UTC())
		}
		if row.State == RaceOpen || row.State == RaceClosed || row.State == RaceRacing {
			owned++
		}
	}
	return made, owned, nil
}

// WithdrawEntry withdraws an account's boat from a race: false if it was
// not entered.
func (s *Store) WithdrawEntry(ctx context.Context, r *Race, id AccountID, at time.Time) (bool, error) {
	n, err := s.q.WithdrawEntry(ctx, db.WithdrawEntryParams{At: stamp(at), WorldID: pgtype.UUID{Bytes: r.World, Valid: true},
		RaceID: pgtype.UUID{Bytes: r.ID, Valid: true}, AccountID: uuidOf(id)})
	return n > 0, err
}

// RemoveEntry removes a race's boat of a number, at its owner's word: its
// skipper, or ErrNotFound for no boat entered of that number.
func (s *Store) RemoveEntry(ctx context.Context, r *Race, number int) (AccountID, error) {
	id, err := s.q.RemoveEntry(ctx, db.RemoveEntryParams{WorldID: pgtype.UUID{Bytes: r.World, Valid: true},
		RaceID: pgtype.UUID{Bytes: r.ID, Valid: true}, Number: int16(number)})
	if errors.Is(err, pgx.ErrNoRows) {
		return AccountID{}, ErrNotFound
	}
	return id.Bytes, err
}

// SetRaceState puts a race in state if it is in one of was: false if it
// was not.
func (s *Store) SetRaceState(ctx context.Context, r *Race, state string, was []string, at time.Time) (bool, error) {
	n, err := s.q.SetRaceState(ctx, db.SetRaceStateParams{State: state, At: at, WorldID: pgtype.UUID{Bytes: r.World, Valid: true},
		ID: pgtype.UUID{Bytes: r.ID, Valid: true}, Was: was})
	return n > 0, err
}

// MoveRace moves a race's start, once, before it starts: false if it was
// moved before, or is not open or closed.
func (s *Store) MoveRace(ctx context.Context, r *Race, at time.Time) (bool, error) {
	n, err := s.q.MoveRace(ctx, db.MoveRaceParams{StartsAt: at, WorldID: pgtype.UUID{Bytes: r.World, Valid: true},
		ID: pgtype.UUID{Bytes: r.ID, Valid: true}})
	return n > 0, err
}

// RacesSailed is how many races an account has sailed over every world,
// as skipper or crew, as its record keeps them.
func (s *Store) RacesSailed(ctx context.Context, id AccountID) (int, error) {
	n, err := s.q.RacesSailed(ctx, uuidOf(id))
	return int(n), err
}

// HarbourDay is a day of a world, its date in the schedule's zone (at
// midnight UTC), and its newcomers' harbour race's hour there.
type HarbourDay struct {
	Day  time.Time
	Hour int
}

// HarbourDays are a world's days and their newcomers' hours, by day.
func (s *Store) HarbourDays(ctx context.Context, world [16]byte) ([]HarbourDay, error) {
	rows, err := s.q.HarbourDays(ctx, pgtype.UUID{Bytes: world, Valid: true})
	if err != nil {
		return nil, err
	}
	out := make([]HarbourDay, len(rows))
	for i, r := range rows {
		out[i] = HarbourDay{Day: r.Day.Time.UTC(), Hour: int(r.Hour)}
	}
	return out, nil
}

// SetHarbourDays sets a world's days' newcomers' hours, each once, fenced
// by the lease's epoch: a day already set keeps its hour.
func (s *Store) SetHarbourDays(ctx context.Context, lease int64, world [16]byte, days []HarbourDay) error {
	return s.fenced(ctx, lease, func(q *db.Queries) error {
		for _, d := range days {
			if err := q.InsertHarbourDay(ctx, db.InsertHarbourDayParams{WorldID: pgtype.UUID{Bytes: world, Valid: true},
				Day: dateOf(d.Day), Hour: int16(d.Hour)}); err != nil {
				return err
			}
		}
		return nil
	})
}

// BusyAreas are the racing areas taken by a world's buoy races, not
// cancelled, starting between since and until.
func (s *Store) BusyAreas(ctx context.Context, world [16]byte, since, until time.Time) ([]BuoyStart, error) {
	rows, err := s.q.BuoyRacesNear(ctx, db.BuoyRacesNearParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, Since: since, Until: until})
	if err != nil {
		return nil, err
	}
	out := make([]BuoyStart, len(rows))
	for i, b := range rows {
		out[i] = BuoyStart{Area: int(b.Course), At: b.StartsAt.UTC()}
	}
	return out, nil
}
