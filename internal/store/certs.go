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

// Certificates (migration 00041): a sailor's are kept for good, and what
// it sailed toward the next is counted from the log's and the races'
// rows each time, never stored. They are judged inside the transactions
// that write those rows, the races' clerk's and the log writer's, by an
// Examiner (internal/certs): what it reads and writes there is an Exam's.

// The ways a task counted, CertTask.Way.
const (
	WayHand  = "hand"  // a course sailed with the autopilot off throughout
	WayPilot = "pilot" // a course's longer venture, the autopilot on at some moment
	WayLog   = "log"   // a task of the log, however it was sailed
)

// Certificate is a certificate a sailor holds: the catalog's id, whether
// earned by hand, when and in which world, and the tasks that counted.
type Certificate struct {
	ID     string
	ByHand bool
	Earned time.Time
	World  int
	Tasks  []CertTask
}

// CertTask is a task that counted toward a certificate, by the catalog's
// id, and the way it did.
type CertTask struct {
	Task string `json:"task"`
	Way  string `json:"way"`
}

// TrialRun is a time trial's run a sailor finished as skipper with nobody
// else aboard, as its record keeps it: its course (CourseShort …) and the
// course's name, its medal ("" for none), whether the autopilot steered
// at some moment, and when.
type TrialRun struct {
	Course     string
	CourseName string
	Medal      string
	Piloted    bool
	At         time.Time
}

// SoloLog is what a sailor's log holds of its sailing alone since a time:
// the distance logged, m; the nights at sea, gales ridden out, storms
// ridden out or landfalls in fog, and falls over the lip; the closest
// approach to the lip survived, m, if Survived; the worlds sailed in;
// every weather met, the log's LogMet… flags; the kinds of the sea's life
// met; the places charted first; and the places seen.
type SoloLog struct {
	Distance                    float64
	Nights, Gales, StormsOrFogs int
	Falls                       int
	Least                       float64
	Survived                    bool
	Worlds                      int
	Weather                     int
	LifeKinds, Charted, Places  int
}

// Standing is where a sailor stands toward its next certificate as an
// Examiner reads it: that certificate's id ("" after the last), and its
// tasks done, by id, each with its way.
type Standing struct {
	Next string
	Done map[string]string
	// Runs are the runs counted so far toward each course task's venture,
	// by the task's id.
	Runs map[string]int
}

// Certified is what a judging tells a sailor: a task of its next
// certificate newly done (Task, the task's place among the certificate's
// tasks), a course task's venture a run nearer (Runs of RunsOf, the task
// not yet done; RunsOf 0 otherwise), and the certificate earned (Earned,
// Task −1 if nothing but the earning is told). Certificate is its place
// in the catalog's list; Done of Of the tasks done of those it needs; Way
// the task's way.
type Certified struct {
	Account      AccountID
	Certificate  int
	Task         int
	Done, Of     int
	Way          string
	Runs, RunsOf int
	Earned       bool
	ByHand       bool
}

// Examiner judges sailors' certificates in the transactions that write
// what they sailed: internal/certs. Standing is read before a
// transaction's rows are written, Judge after, with it: Judge earns the
// next certificate when its tasks are done, and says what is new.
type Examiner interface {
	Standing(ctx context.Context, x *Exam, account AccountID) (Standing, error)
	Judge(ctx context.Context, x *Exam, account AccountID, world int, at time.Time, before Standing) ([]Certified, error)
}

// Exam reads and writes a sailor's certificates and what counts toward
// them, in a transaction of the store's or on the pool; nw, if not nil,
// is the news its earnings' stories are written to.
type Exam struct {
	q  *db.Queries
	nw *newsWrite
}

// Exam reads certificates on the pool, outside any transaction.
func (s *Store) Exam() *Exam { return &Exam{q: s.q} }

// Held are the certificates a sailor holds, the first earned first.
func (x *Exam) Held(ctx context.Context, account AccountID) ([]Certificate, error) {
	rows, err := x.q.CertificatesOf(ctx, uuidOf(account))
	if err != nil {
		return nil, err
	}
	out := make([]Certificate, len(rows))
	for i, r := range rows {
		out[i] = Certificate{ID: r.Certificate, ByHand: r.ByHand, Earned: r.EarnedAt.UTC(), World: int(r.World)}
		if err := json.Unmarshal(r.Tasks, &out[i].Tasks); err != nil {
			return nil, fmt.Errorf("a certificate's tasks: %w", err)
		}
	}
	return out, nil
}

// Runs are a sailor's time trials' runs finished alone since a time, the
// oldest first.
func (x *Exam) Runs(ctx context.Context, account AccountID, since time.Time) ([]TrialRun, error) {
	rows, err := x.q.SoloRuns(ctx, db.SoloRunsParams{AccountID: uuidOf(account), Since: since})
	if err != nil {
		return nil, err
	}
	out := make([]TrialRun, len(rows))
	for i, r := range rows {
		out[i] = TrialRun{Course: r.Course, CourseName: r.CourseName, Medal: r.Medal, Piloted: r.Piloted, At: r.At.UTC()}
	}
	return out, nil
}

// Solo is what a sailor's log holds of its sailing alone since a time.
func (x *Exam) Solo(ctx context.Context, account AccountID, since time.Time) (SoloLog, error) {
	v, err := x.q.SoloVoyages(ctx, db.SoloVoyagesParams{AccountID: uuidOf(account), Since: since})
	if err != nil {
		return SoloLog{}, err
	}
	e, err := x.q.SoloEntries(ctx, db.SoloEntriesParams{AccountID: uuidOf(account), Since: since})
	if err != nil {
		return SoloLog{}, err
	}
	return SoloLog{
		Distance: v.Distance, Nights: int(v.Nights), Gales: int(v.Gales), StormsOrFogs: int(v.StormsOrFogs), Falls: int(v.Falls),
		Least: max(v.Least, 0), Survived: v.Least >= 0, Worlds: int(v.Worlds), Weather: int(v.Weather),
		LifeKinds: int(e.LifeKinds), Charted: int(e.Charted), Places: int(e.Places),
	}, nil
}

// StoryCertificate is a story of a certificate earned: its title the
// certificate's name, its what "by hand" if it was, its facts' boats the
// kinds it opens.
const StoryCertificate = "certificate"

// Earn writes a certificate earned, once, and its entry in the sailor's
// log, its title name, and with the news, its story, of a score: false
// if the sailor held it already, or is no longer kept.
func (x *Exam) Earn(ctx context.Context, account AccountID, c *Certificate, name string, opens []string, score int) (bool, error) {
	tasks := c.Tasks
	if tasks == nil {
		tasks = []CertTask{}
	}
	tj, err := json.Marshal(tasks)
	if err != nil {
		return false, err
	}
	source := "cert:" + c.ID
	n, err := x.q.InsertCertificate(ctx, db.InsertCertificateParams{AccountID: uuidOf(account), Certificate: c.ID, ByHand: c.ByHand,
		EarnedAt: c.Earned, World: int32(c.World), Tasks: tj, Source: source})
	if err != nil {
		return false, fmt.Errorf("a certificate: %w", err)
	}
	if n == 0 {
		return false, nil
	}
	what := ""
	if c.ByHand {
		what = "by hand"
	}
	if _, err := insertEntry(ctx, x.q, &LogEntry{Account: account, Source: source, World: c.World, At: c.Earned, Kind: LogCertificate,
		Title: name, What: what}, pgtype.Text{}); err != nil {
		return false, err
	}
	if x.nw == nil {
		return true, nil
	}
	st := Story{Story: StoryCertificate, Score: score, At: c.Earned, Account: account, Subject: SubjectSailor, Title: name, What: what,
		Island: -1, Facts: StoryFacts{Boats: opens}, Source: fmt.Sprintf("cert:%s:%x", c.ID, account[:])}
	if _, err := insertStory(ctx, x.q, x.nw, &st); err != nil {
		return false, err
	}
	return true, nil
}

// SailRights are what opens boats to a sailor: the owner's every boat,
// the certificates it holds by the catalog's ids, the first earned first,
// and the kinds of boat it keeps.
type SailRights struct {
	EveryBoat bool
	Held      []string
	Kept      []string
}

// SailRights reads what opens boats to a sailor; ErrNotFound for no such
// account.
func (s *Store) SailRights(ctx context.Context, id AccountID) (SailRights, error) {
	r, err := s.q.SailRights(ctx, uuidOf(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return SailRights{}, ErrNotFound
	}
	if err != nil {
		return SailRights{}, err
	}
	return SailRights{EveryBoat: r.EveryBoat, Held: r.Held, Kept: r.Kept}, nil
}

// SetEveryBoat opens every kind of boat to a sailor, or closes them again,
// whatever its certificates; ErrNotFound for no such account.
func (s *Store) SetEveryBoat(ctx context.Context, id AccountID, on bool) error {
	n, err := s.q.SetEveryBoat(ctx, db.SetEveryBoatParams{EveryBoat: on, ID: uuidOf(id)})
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// judging is a transaction's judging of the sailors whose rows it writes:
// each one's standing before them, and what Judge told once they are
// written.
type judging struct {
	ex      Examiner
	x       *Exam
	before  map[AccountID]Standing
	order   []AccountID
	world   map[AccountID]int
	at      map[AccountID]time.Time
	written map[AccountID]bool
	told    []Certified
}

func newJudging(ex Examiner, q *db.Queries, nw *newsWrite) *judging {
	if ex == nil {
		return nil
	}
	return &judging{ex: ex, x: &Exam{q: q, nw: nw}, before: map[AccountID]Standing{}, world: map[AccountID]int{}, at: map[AccountID]time.Time{},
		written: map[AccountID]bool{}}
}

// look reads a sailor's standing before its rows are written, once.
func (j *judging) look(ctx context.Context, account AccountID, world int, at time.Time) error {
	if j == nil {
		return nil
	}
	if _, ok := j.before[account]; !ok {
		st, err := j.ex.Standing(ctx, j.x, account)
		if err != nil {
			return err
		}
		j.before[account] = st
		j.order = append(j.order, account)
	}
	j.world[account] = max(j.world[account], world)
	if at.After(j.at[account]) {
		j.at[account] = at
	}
	return nil
}

// wrote marks a sailor's row as written, so it is judged.
func (j *judging) wrote(account AccountID) {
	if j != nil {
		j.written[account] = true
	}
}

// judge judges each sailor with a row written, in the order they were
// looked at.
func (j *judging) judge(ctx context.Context) error {
	if j == nil {
		return nil
	}
	for _, a := range j.order {
		if !j.written[a] || j.before[a].Next == "" {
			continue
		}
		told, err := j.ex.Judge(ctx, j.x, a, j.world[a], j.at[a], j.before[a])
		if err != nil {
			return err
		}
		j.told = append(j.told, told...)
	}
	return nil
}
