// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// The sailor's log lasts from world to world: its rows keep the world's
// number, never its ID, and their own copies of the names and places they
// show (migration 00034). Every count is a query on the rows.

// The kinds of a log's entry.
const (
	LogCharted = "charted" // a place charted, credited to the sailor
	LogSighted = "sighted" // a place charted from another's boat, aboard
	LogFound   = "found"   // the first of a kind for the collection
	LogMet     = "met"     // a kind of the sea's life met
	LogBump    = "bump"    // a bump with another boat
)

// How a voyage, or a time aboard, ended.
const (
	LogReturned = "returned" // the sailor brought the boat out of the water
	LogExpired  = "expired"  // its connection's grace ran out
	LogOver     = "over"     // it went over the lip of the falls
	LogTaken    = "taken"    // it was afloat when the falls took the world
	LogAboard   = "aboard"   // its sailor went aboard another's boat
	LogAshore   = "ashore"   // one aboard went ashore, or was put ashore
	LogLanded   = "landed"   // the boat one was aboard left the water
)

// Whose fault a bump in the log was.
const (
	FaultMine   = "mine"
	FaultTheirs = "theirs"
)

// Who may read a log, account.log_shown: every sailor in the game, or its
// sailor alone; LogShownDefault for its age band's default.
const (
	LogShownSailors = "sailors"
	LogShownMe      = "me"
	LogShownDefault = ""
)

// The weather a voyage met, LogVoyage.Met's flags, as the log keeps them.
const (
	LogMetGale = 1 << iota
	LogMetStorm
	LogRodeGale
	LogRodeStorm
	LogMetFog
	LogMetNight
)

// LogMate is someone else aboard on a voyage, as the log copies them: a
// zero ID is an account deleted since, a former sailor.
type LogMate struct {
	ID      AccountID
	Name    string
	Machine bool
	Seconds int
}

type logMateJSON struct {
	ID      string `json:"id,omitempty"`
	Name    string `json:"name,omitempty"`
	Machine bool   `json:"machine,omitempty"`
	Seconds int    `json:"s"`
}

// LogFind is a kind of a group of the collection.
type LogFind struct {
	Group, Kind string
}

// LogVoyage is a voyage in a sailor's log, or a time aboard another's
// boat (Aboard, with its Skipper). Run is the distance run over the
// ground, m, if Logged. Least is the closest approach to the lip
// survived, m, if Survived. Met is the weather met, LogMet… flags. Finds
// are the kinds of the collection it adds, written with it the first time
// it is.
type LogVoyage struct {
	ID       [16]byte
	Account  AccountID
	Source   string
	World    int
	Aboard   bool
	Boat     uint64
	BoatKind string
	BoatName string
	Began    time.Time
	Ended    time.Time
	How      string
	Run      float64
	Logged   bool
	Place    string
	Least    float64
	Survived bool
	BumpsAt  int
	BumpsNot int
	Met      int

	GalePlace, FogPlace string

	Skipper        AccountID
	SkipperName    string
	SkipperMachine bool
	Crew           []LogMate
	Finds          []LogFind
}

// LogEntry is a notable thing in a sailor's log: LogCharted, LogSighted,
// LogFound, LogMet or LogBump. Other is the other sailor it names, zero
// for none (or a former sailor), with their boat's name. Charting, if not
// nil, is the charting it tells of: it is written only if that charting
// was written in the same batch. Finds are the kinds it adds.
type LogEntry struct {
	ID           [16]byte
	Account      AccountID
	Source       string
	World        int
	At           time.Time
	Kind         string
	Title, What  string
	Worth        float64
	Group, Find  string
	X, Y         float64
	Place        string
	Other        AccountID
	OtherName    string
	OtherMachine bool
	OtherBoat    string
	Article      string
	Fault        string
	Charting     *ChartKey
	Finds        []LogFind
}

// ChartKey is a subject of a world's chart.
type ChartKey struct {
	Subject string
	Number  int32
}

// LogRows are rows of the log to write.
type LogRows struct {
	Voyages []LogVoyage
	Entries []LogEntry
}

// Empty reports whether there is nothing to write.
func (r *LogRows) Empty() bool { return len(r.Voyages) == 0 && len(r.Entries) == 0 }

// Reset empties r, keeping its room.
func (r *LogRows) Reset() {
	clear(r.Voyages)
	clear(r.Entries)
	r.Voyages, r.Entries = r.Voyages[:0], r.Entries[:0]
}

// WriteLog writes rows of the log, fenced by the lease's epoch: what the
// backfill writes.
func (s *Store) WriteLog(ctx context.Context, lease int64, rows LogRows) error {
	return s.fenced(ctx, lease, func(q *db.Queries) error { return writeLog(ctx, q, &rows, nil) })
}

// writeLog writes rows of the log in a transaction: each row once by its
// source, and only while its account is; an entry of a charting only if
// the charting is in written; the names of the sailors it copies as they
// are now, where not given; and each row written the first time adds its
// finds to its sailor's collection, a find made for the first time an
// entry of its own.
func writeLog(ctx context.Context, q *db.Queries, rows *LogRows, written map[ChartKey]bool) error {
	if rows.Empty() {
		return nil
	}
	names, err := logNames(ctx, q, rows)
	if err != nil {
		return err
	}
	name := func(id AccountID, given string) pgtype.Text {
		if given == "" && id != (AccountID{}) {
			given = names[id]
		}
		return text(given)
	}
	for i := range rows.Voyages {
		v := &rows.Voyages[i]
		crew := make([]logMateJSON, len(v.Crew))
		for j, m := range v.Crew {
			crew[j] = logMateJSON{Name: name(m.ID, m.Name).String, Machine: m.Machine, Seconds: m.Seconds}
			if m.ID != (AccountID{}) {
				crew[j].ID = m.ID.String()
			}
		}
		cj, err := json.Marshal(crew)
		if err != nil {
			return err
		}
		p := db.InsertLogVoyageParams{
			AccountID: uuidOf(v.Account), Source: v.Source, World: int32(v.World), Aboard: v.Aboard, Boat: int64(v.Boat),
			BoatKind: v.BoatKind, BoatName: text(v.BoatName), BeganAt: v.Began, EndedAt: v.Ended, How: v.How,
			Run: pgtype.Float4{Float32: float32(v.Run), Valid: v.Logged}, Place: text(v.Place),
			Least:   pgtype.Float4{Float32: float32(v.Least), Valid: v.Survived},
			BumpsAt: int16(min(v.BumpsAt, 32767)), BumpsNot: int16(min(v.BumpsNot, 32767)), Met: int16(v.Met),
			GalePlace: text(v.GalePlace), FogPlace: text(v.FogPlace), SkipperMachine: v.SkipperMachine, Crew: cj,
		}
		if v.Skipper != (AccountID{}) {
			p.SkipperID, p.SkipperName = uuidOf(v.Skipper), name(v.Skipper, v.SkipperName)
		}
		n, err := q.InsertLogVoyage(ctx, p)
		if err != nil {
			return fmt.Errorf("a voyage of the log: %w", err)
		}
		if n == 0 {
			continue
		}
		for _, fd := range v.Finds {
			if err := writeFind(ctx, q, v.Account, v.World, v.Ended, v.Place, fd); err != nil {
				return err
			}
		}
	}
	for i := range rows.Entries {
		e := &rows.Entries[i]
		if e.Charting != nil && !written[*e.Charting] {
			continue
		}
		n, err := insertEntry(ctx, q, e, name(e.Other, e.OtherName))
		if err != nil {
			return err
		}
		if n == 0 {
			continue
		}
		for _, fd := range e.Finds {
			if err := writeFind(ctx, q, e.Account, e.World, e.At, e.Place, fd); err != nil {
				return err
			}
		}
	}
	return nil
}

// insertEntry inserts an entry, other its other sailor's name, and returns
// how many rows it wrote.
func insertEntry(ctx context.Context, q *db.Queries, e *LogEntry, other pgtype.Text) (int64, error) {
	p := db.InsertLogEntryParams{
		AccountID: uuidOf(e.Account), Source: e.Source, World: int32(e.World), At: e.At, Kind: e.Kind,
		Title: e.Title, What: e.What, Worth: float32(e.Worth), Grp: text(e.Group), Find: text(e.Find),
		Place: text(e.Place), OtherMachine: e.OtherMachine, OtherBoat: text(e.OtherBoat),
		Article: text(e.Article), Fault: text(e.Fault),
	}
	if e.X != 0 || e.Y != 0 {
		p.X, p.Y = pgtype.Float4{Float32: float32(e.X), Valid: true}, pgtype.Float4{Float32: float32(e.Y), Valid: true}
	}
	if e.Other != (AccountID{}) {
		p.OtherID, p.OtherName = uuidOf(e.Other), other
	}
	n, err := q.InsertLogEntry(ctx, p)
	if err != nil {
		return 0, fmt.Errorf("an entry of the log: %w", err)
	}
	return n, nil
}

// writeFind counts a kind found once more in account's collection; found
// for the first time, it is an entry of its own.
func writeFind(ctx context.Context, q *db.Queries, account AccountID, world int, at time.Time, place string, fd LogFind) error {
	first, err := q.UpsertLogFind(ctx, db.UpsertLogFindParams{
		AccountID: uuidOf(account), Grp: fd.Group, Find: fd.Kind, World: int32(world), At: at, Place: text(place),
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("a find of the log: %w", err)
	}
	if !first {
		return nil
	}
	_, err = insertEntry(ctx, q, &LogEntry{
		Account: account, Source: "found:" + fd.Group + ":" + fd.Kind, World: world, At: at, Kind: LogFound,
		Group: fd.Group, Find: fd.Kind, Place: place,
	}, pgtype.Text{})
	return err
}

// logNames are the names of the sailors rows copies, as they are now, by
// account.
func logNames(ctx context.Context, q *db.Queries, rows *LogRows) (map[AccountID]string, error) {
	seen := map[AccountID]bool{}
	var ids []pgtype.UUID
	add := func(id AccountID, given string) {
		if id == (AccountID{}) || given != "" || seen[id] {
			return
		}
		seen[id] = true
		ids = append(ids, uuidOf(id))
	}
	for i := range rows.Voyages {
		v := &rows.Voyages[i]
		add(v.Skipper, v.SkipperName)
		for _, m := range v.Crew {
			add(m.ID, m.Name)
		}
	}
	for i := range rows.Entries {
		add(rows.Entries[i].Other, rows.Entries[i].OtherName)
	}
	if len(ids) == 0 {
		return nil, nil
	}
	found, err := q.SailorsByID(ctx, ids)
	if err != nil {
		return nil, err
	}
	out := make(map[AccountID]string, len(found))
	for _, r := range found {
		out[r.ID.Bytes] = r.Name
	}
	return out, nil
}

// LogSailor is a sailor as their log is read: their account's kind, its
// owner (a machine sailor's), the sailor's name and look, when the account
// was made, its month of birth (the owner's for a machine sailor), who may
// read its log, and whether it, or its owner, is stopped.
type LogSailor struct {
	ID      AccountID
	Kind    Kind
	Owner   AccountID
	Name    string
	Look    Look
	Since   time.Time
	Born    int32
	Shown   string
	Stopped bool
}

// LogSailorByKey is the sailor whose name has the key given; ErrNotFound
// for none.
func (s *Store) LogSailorByKey(ctx context.Context, key string) (LogSailor, error) {
	return s.logSailor(ctx, db.LogSailorParams{NameKey: pgtype.Text{String: key, Valid: true}})
}

// LogSailorByID is an account's sailor; ErrNotFound for none.
func (s *Store) LogSailorByID(ctx context.Context, id AccountID) (LogSailor, error) {
	return s.logSailor(ctx, db.LogSailorParams{ID: uuidOf(id)})
}

func (s *Store) logSailor(ctx context.Context, p db.LogSailorParams) (LogSailor, error) {
	r, err := s.q.LogSailor(ctx, p)
	if errors.Is(err, pgx.ErrNoRows) {
		return LogSailor{}, ErrNotFound
	}
	if err != nil {
		return LogSailor{}, err
	}
	return LogSailor{
		ID: r.ID.Bytes, Kind: Kind(r.Kind), Owner: r.OwnerID.Bytes, Name: r.Name,
		Look:  Look{Look: r.Look, Version: r.Version, Skin: r.Skin, Hair: r.Hair, Colour: r.Colour, Finish: r.Finish, Chosen: r.LookChosen},
		Since: r.CreatedAt.UTC(), Born: r.Born, Shown: r.LogShown, Stopped: r.Stopped,
	}, nil
}

// LogPerson is an account as the log names it: its kind, its owner (a
// machine sailor's), its month of birth (its owner's for a machine
// sailor) and who may read its log.
type LogPerson struct {
	ID    AccountID
	Kind  Kind
	Owner AccountID
	Born  int32
	Shown string
}

// LogPeople are the accounts of ids still kept, by ID.
func (s *Store) LogPeople(ctx context.Context, ids []AccountID) (map[AccountID]LogPerson, error) {
	if len(ids) == 0 {
		return map[AccountID]LogPerson{}, nil
	}
	us := make([]pgtype.UUID, len(ids))
	for i, id := range ids {
		us[i] = uuidOf(id)
	}
	rows, err := s.q.LogPeople(ctx, us)
	if err != nil {
		return nil, err
	}
	out := make(map[AccountID]LogPerson, len(rows))
	for _, r := range rows {
		out[r.ID.Bytes] = LogPerson{ID: r.ID.Bytes, Kind: Kind(r.Kind), Owner: r.OwnerID.Bytes, Born: r.Born, Shown: r.LogShown}
	}
	return out, nil
}

// SetLogShown sets who may read a human account's log: LogShownSailors,
// LogShownMe, or LogShownDefault for its age band's. ErrNotFound if there
// is no such human account.
func (s *Store) SetLogShown(ctx context.Context, id AccountID, shown string) error {
	n, err := s.q.SetLogShown(ctx, db.SetLogShownParams{LogShown: text(shown), ID: uuidOf(id)})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// LogTotals is a sailor's log over every world, counted from its rows:
// voyages skippered and times aboard, the distance logged (m), the worlds
// it has anything of, the falls, the closest approach to the lip survived
// (m, if Survived), the bumps at fault and not, the gales and storms
// ridden out, the landfalls in fog and nights at sea, the voyages
// skippered with others aboard, the places charted and sighted from
// another's boat, the kinds of life met, and when distance was first
// logged (zero for never).
type LogTotals struct {
	Voyages, Aboard   int
	Run               float64
	Worlds            int
	Falls             int
	Least             float64
	Survived          bool
	BumpsAt, BumpsNot int
	Gales, Storms     int
	Fogs, Nights      int
	Crewed            int
	Charted, Sighted  int
	Met               int
	LoggedFrom        time.Time
}

// LogTotals counts an account's log.
func (s *Store) LogTotals(ctx context.Context, id AccountID) (LogTotals, error) {
	v, err := s.q.LogTotals(ctx, uuidOf(id))
	if err != nil {
		return LogTotals{}, err
	}
	e, err := s.q.LogEntryTotals(ctx, uuidOf(id))
	if err != nil {
		return LogTotals{}, err
	}
	t := LogTotals{
		Voyages: int(v.Voyages), Aboard: int(v.Aboard), Run: v.Run, Worlds: int(v.Worlds), Falls: int(v.Falls),
		Least: v.Least, Survived: v.Least >= 0, BumpsAt: int(v.BumpsAt), BumpsNot: int(v.BumpsNot),
		Gales: int(v.Gales), Storms: int(v.Storms), Fogs: int(v.Fogs), Nights: int(v.Nights), Crewed: int(v.Crewed),
		Charted: int(e.Charted), Sighted: int(e.Sighted), Met: int(e.Met), LoggedFrom: since(v.LoggedFrom),
	}
	if !t.Survived {
		t.Least = 0
	}
	if t.Worlds == 0 {
		// Entries of a world with no voyage logged, as the backfill may
		// write.
		t.Worlds = int(e.Worlds)
	}
	return t, nil
}

// LogWorld is a world a sailor's log has anything of: its number, and the
// first and last time of it.
type LogWorld struct {
	Number      int
	First, Last time.Time
}

// LogWorlds are the worlds of an account's log, the newest first.
func (s *Store) LogWorlds(ctx context.Context, id AccountID) ([]LogWorld, error) {
	rows, err := s.q.LogWorlds(ctx, uuidOf(id))
	if err != nil {
		return nil, err
	}
	out := make([]LogWorld, len(rows))
	for i, r := range rows {
		out[i] = LogWorld{Number: int(r.World), First: r.FirstAt.UTC(), Last: r.LastAt.UTC()}
	}
	return out, nil
}

// LogVoyages are an account's voyages and times aboard in a world, in the
// order they ended.
func (s *Store) LogVoyages(ctx context.Context, id AccountID, world int) ([]LogVoyage, error) {
	rows, err := s.q.LogVoyagesOf(ctx, db.LogVoyagesOfParams{AccountID: uuidOf(id), World: int32(world)})
	if err != nil {
		return nil, err
	}
	out := make([]LogVoyage, len(rows))
	for i, r := range rows {
		v := LogVoyage{
			ID: r.ID.Bytes, Account: id, World: world, Aboard: r.Aboard, Boat: uint64(r.Boat), BoatKind: r.BoatKind, BoatName: r.BoatName,
			Began: r.BeganAt.UTC(), Ended: r.EndedAt.UTC(), How: r.How, Run: max(r.Run, 0), Logged: r.Run >= 0, Place: r.Place,
			Least: max(r.Least, 0), Survived: r.Least >= 0, BumpsAt: int(r.BumpsAt), BumpsNot: int(r.BumpsNot), Met: int(r.Met),
			GalePlace: r.GalePlace, FogPlace: r.FogPlace, Skipper: r.SkipperID.Bytes, SkipperName: r.SkipperName,
			SkipperMachine: r.SkipperMachine,
		}
		var crew []logMateJSON
		if err := json.Unmarshal(r.Crew, &crew); err != nil {
			return nil, err
		}
		for _, m := range crew {
			mate := LogMate{Name: m.Name, Machine: m.Machine, Seconds: m.Seconds}
			if m.ID != "" {
				if mate.ID, err = ParseAccountID(m.ID); err != nil {
					return nil, fmt.Errorf("a voyage's crew: %q", m.ID)
				}
			}
			v.Crew = append(v.Crew, mate)
		}
		out[i] = v
	}
	return out, nil
}

// LogEntries are an account's entries in a world, in their order.
func (s *Store) LogEntries(ctx context.Context, id AccountID, world int) ([]LogEntry, error) {
	rows, err := s.q.LogEntriesOf(ctx, db.LogEntriesOfParams{AccountID: uuidOf(id), World: int32(world)})
	if err != nil {
		return nil, err
	}
	out := make([]LogEntry, len(rows))
	for i, r := range rows {
		out[i] = LogEntry{
			ID: r.ID.Bytes, Account: id, World: world, At: r.At.UTC(), Kind: r.Kind, Title: r.Title, What: r.What, Worth: float64(r.Worth),
			Group: r.Grp, Find: r.Find, X: r.X, Y: r.Y, Place: r.Place, Other: r.OtherID.Bytes, OtherName: r.OtherName,
			OtherMachine: r.OtherMachine, OtherBoat: r.OtherBoat, Article: r.Article, Fault: r.Fault,
		}
	}
	return out, nil
}

// LogKept is a kind in a sailor's collection: how many times found, and
// the world, time and place it was first, and the latest world.
type LogKept struct {
	LogFind
	Count      int
	FirstWorld int
	FirstAt    time.Time
	FirstPlace string
	LastWorld  int
}

// LogFinds are an account's collection.
func (s *Store) LogFinds(ctx context.Context, id AccountID) ([]LogKept, error) {
	rows, err := s.q.LogFinds(ctx, uuidOf(id))
	if err != nil {
		return nil, err
	}
	out := make([]LogKept, len(rows))
	for i, r := range rows {
		out[i] = LogKept{LogFind: LogFind{Group: r.Grp, Kind: r.Find}, Count: int(r.Count), FirstWorld: int(r.FirstWorld),
			FirstAt: r.FirstAt.UTC(), FirstPlace: r.FirstPlace, LastWorld: int(r.LastWorld)}
	}
	return out, nil
}

// LogFigures are a log in a few figures: the distance logged, m, and the
// voyages skippered.
type LogFigures struct {
	Run     float64
	Voyages int
}

// LogFigures are the logs of the accounts of ids in a few figures; an
// account with nothing logged is not in it.
func (s *Store) LogFigures(ctx context.Context, ids []AccountID) (map[AccountID]LogFigures, error) {
	us := make([]pgtype.UUID, len(ids))
	for i, id := range ids {
		us[i] = uuidOf(id)
	}
	rows, err := s.q.LogFigures(ctx, us)
	if err != nil {
		return nil, err
	}
	out := make(map[AccountID]LogFigures, len(rows))
	for _, r := range rows {
		out[r.AccountID.Bytes] = LogFigures{Run: r.Run, Voyages: int(r.Voyages)}
	}
	return out, nil
}

// LogFrom is when the log began to be kept as the game keeps it now: what
// was recorded before it is the backfill's.
func (s *Store) LogFrom(ctx context.Context) (time.Time, error) {
	t, err := s.q.LogFrom(ctx)
	return t.UTC(), err
}

// KeptWorld is a world whose records are still kept.
type KeptWorld struct {
	ID     [16]byte
	Number int
	Epoch  time.Time
}

// KeptWorlds are the worlds whose records are still kept, the oldest
// first.
func (s *Store) KeptWorlds(ctx context.Context) ([]KeptWorld, error) {
	rows, err := s.q.KeptWorlds(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]KeptWorld, len(rows))
	for i, r := range rows {
		out[i] = KeptWorld{ID: r.ID.Bytes, Number: int(r.Number), Epoch: r.Epoch.UTC()}
	}
	return out, nil
}

// BackfillChartings are a world's credited chartings written before a
// time, the oldest first.
func (s *Store) BackfillChartings(ctx context.Context, world [16]byte, before time.Time) ([]Charting, error) {
	rows, err := s.q.BackfillChartings(ctx, db.BackfillChartingsParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, Before: before})
	if err != nil {
		return nil, err
	}
	out := make([]Charting, len(rows))
	for i, r := range rows {
		out[i] = Charting{Subject: r.Subject, Number: r.Number, Credited: true, Account: r.AccountID.Bytes, Tick: r.Tick,
			X: r.X.Float64, Y: r.Y.Float64, Worth: r.Worth, WithSubject: r.WithSubject, WithNumber: r.WithNumber,
			Written: true, At: r.ChartedAt.UTC()}
	}
	return out, nil
}

// StoredEvent is an event as it was written: its row's ID and when.
type StoredEvent struct {
	Event
	ID      [16]byte
	Written time.Time
}

// BackfillEvents are a world's events of the kinds a log is made of,
// written before a time, in their order.
func (s *Store) BackfillEvents(ctx context.Context, world [16]byte, before time.Time) ([]StoredEvent, error) {
	rows, err := s.q.BackfillEvents(ctx, db.BackfillEventsParams{WorldID: pgtype.UUID{Bytes: world, Valid: true}, Before: before})
	if err != nil {
		return nil, err
	}
	out := make([]StoredEvent, len(rows))
	for i, r := range rows {
		out[i] = StoredEvent{ID: r.ID.Bytes, Written: r.WrittenAt.UTC(), Event: Event{
			Tick: r.Tick, Kind: r.Kind, Account: r.AccountID.Bytes, Boat: uint64(r.Boat), Other: r.OtherAccountID.Bytes,
			OtherBoat: uint64(r.OtherBoat), Article: r.Article, Fault: r.Fault, X: r.X, Y: r.Y, Distance: r.Distance,
		}}
	}
	return out, nil
}

// since is a time read with 'epoch' for none: zero for none.
func since(t time.Time) time.Time {
	if t.Unix() <= 0 {
		return time.Time{}
	}
	return t.UTC()
}
