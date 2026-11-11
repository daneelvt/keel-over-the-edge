// SPDX-License-Identifier: AGPL-3.0-only

// Package review is reports and what the owner does about them. A player
// reports someone from a line or from their name aboard; the server copies
// into the report what its memory still holds of that boat's chat, who
// was aboard and their bands, and then the next ten minutes: the only way
// a line of chat is ever written down. Nothing the phone sends is taken as
// evidence. Reports from three players in a day, or one saying a child may
// be at risk, rest the reported player's chat and knocks until the owner
// looks; the latter is counted for the alert that pages the owner.
//
// The owner reads the queue, a child's safety first, and acts on a
// report: dismiss, warn, mute from chat, stop, delete, remove a line,
// purge, hold, release, under 13, referred. Each is written with its
// record; a player restricted is told why by a statement of reasons on
// their next entry, and may answer it once.
package review

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/accounts"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chat"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Follow is how long a report goes on taking the conversation after it.
const Follow = 10 * time.Minute

// Store is the store's side of reports.
type Store interface {
	Talker(ctx context.Context, id store.AccountID) (store.Talker, error)
	MakeReport(ctx context.Context, r store.NewReport) (store.Made, error)
	AddReportLines(ctx context.Context, id store.ReportID, lines []store.ReportLine) error
	Report(ctx context.Context, id store.ReportID) (store.Report, error)
	ReportQueue(ctx context.Context, limit int) ([]store.QueueItem, error)
	ReportCounts(ctx context.Context) (open, child int64, oldest time.Time, err error)
	ActOnReport(ctx context.Context, a store.ReportAct) error
	MakeNotice(ctx context.Context, n store.Notice) (store.ReportID, error)
}

// Hand is the owner's hand on accounts, for a stop and a delete.
type Hand interface {
	Stop(ctx context.Context, req accounts.Request) (accounts.Done, error)
	Delete(ctx context.Context, req accounts.Request) (accounts.Done, error)
}

// Config is what reports reach.
type Config struct {
	Store Store
	Hand  Hand
	// Hub is the chat of the world sailed now, nil between worlds.
	Hub     func() *chat.Hub
	Log     *slog.Logger
	Metrics *obs.Metrics
	Now     func() time.Time
}

// Service is reports.
type Service struct {
	cfg Config

	mu      sync.Mutex
	follows map[store.ReportID]*following
}

// following is a report taking the conversation after it.
type following struct {
	mu    sync.Mutex
	lines []store.ReportLine
	stop  func()
}

// New makes the reports.
func New(cfg Config) *Service {
	if cfg.Log == nil {
		cfg.Log = slog.New(slog.DiscardHandler)
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Hub == nil {
		cfg.Hub = func() *chat.Hub { return nil }
	}
	return &Service{cfg: cfg, follows: map[store.ReportID]*following{}}
}

// Errors a report or an action may meet.
var (
	ErrReason = errors.New("review: no such reason")
	ErrNote   = errors.New("review: the note is too long")
	ErrAction = errors.New("review: no such action")
	ErrNoOne  = errors.New("review: the report names nobody to act on")
	ErrLine   = errors.New("review: the report holds no such line")
	ErrNotice = errors.New("review: a notice needs who, how to reach them, and what")
)

func validReason(r string) bool {
	for _, x := range store.ReportReasons {
		if x == r {
			return true
		}
	}
	return false
}

// bandName is a band as a report keeps it.
func bandName(b aboard.Band) string {
	switch b {
	case aboard.Adult:
		return "adult"
	case aboard.Teen:
		return "13-17"
	case aboard.Child:
		return "under 13"
	}
	return "unknown"
}

// two are the reporter and the reported, with their bands, for a report
// with nobody else in it.
func (s *Service) two(ctx context.Context, hub *chat.Hub, in In, reporter, reported store.Talker) []store.ReportPerson {
	var out []store.ReportPerson
	for _, p := range []struct {
		a bus.Account
		t store.Talker
	}{{in.Reporter, reporter}, {in.Reported, reported}} {
		rp := store.ReportPerson{Name: p.t.Name, Machine: p.t.Kind == store.AI, Band: bandOf(p.t)}
		if sp, ok := hub.Speaker(p.a); ok {
			rp.Band = bandName(sp.Band)
		}
		out = append(out, rp)
	}
	return out
}

// bandOf is the band of a talker as a report keeps it, worked out now.
func bandOf(t store.Talker) string {
	if b, ok := aboard.BornOf(t.Born); ok {
		return bandName(aboard.BandOf(b, time.Now()))
	}
	return bandName(aboard.Unknown)
}

// In is a player's report: the reporter, the account reported, the boat
// it was about, and the line it was made from (0 for one made from a name
// aboard). Thread is a report about the messages between the two as
// shipmates: the pair's ring is copied rather than a boat's.
type In struct {
	Reporter bus.Account
	Reported bus.Account
	Boat     uint64
	Line     uint64
	Reason   string
	Note     string
	Thread   bool
}

// Report keeps a player's report, with what the server holds of the
// boat's chat and who is aboard, and goes on taking its chat for Follow.
func (s *Service) Report(ctx context.Context, in In) error {
	if !validReason(in.Reason) {
		return ErrReason
	}
	if utf8.RuneCountInString(in.Note) > store.MaxReportNote {
		return ErrNote
	}
	reporter, err := s.cfg.Store.Talker(ctx, store.AccountID(in.Reporter))
	if err != nil {
		return err
	}
	reported, err := s.cfg.Store.Talker(ctx, store.AccountID(in.Reported))
	if err != nil {
		return err
	}
	now := s.cfg.Now()
	r := store.NewReport{
		Source: store.ReportByPlayer, Reason: in.Reason, Note: strings.TrimSpace(in.Note),
		Reporter: store.AccountID(in.Reporter), HasReporter: true, ReporterName: reporter.Name,
		Reported: store.AccountID(in.Reported), HasReported: true, ReportedKind: reported.Kind, ReportedName: reported.Name,
		FollowUntil: now.Add(Follow),
	}
	if reported.Kind == store.AI {
		r.Owner, r.HasOwner = reported.Human, true
		if o, err := s.cfg.Store.Talker(ctx, reported.Human); err == nil {
			r.OwnerName = o.Name
		}
	}
	hub := s.cfg.Hub()
	room := chat.Boat(in.Boat)
	if in.Thread {
		room = chat.Pair(in.Reporter, in.Reported)
	}
	if hub != nil && in.Thread {
		for _, l := range hub.Rings.Lines(room, now.Add(-chat.DefaultLimits().Keep)) {
			r.Lines = append(r.Lines, lineOf(l, l.ID == in.Line))
		}
		r.People = s.two(ctx, hub, in, reporter, reported)
		r.Place = "messages between shipmates " + reporter.Name + " and " + reported.Name
	}
	if hub != nil && in.Boat != 0 && !in.Thread {
		for _, l := range hub.Rings.Lines(room, now.Add(-chat.DefaultLimits().Keep)) {
			r.Lines = append(r.Lines, lineOf(l, l.ID == in.Line))
		}
		if people, ok := hub.Company(in.Boat); ok {
			for i, p := range people {
				rp := store.ReportPerson{Machine: p.Machine, Skipper: i == 0, Band: "unknown"}
				if sp, ok := hub.Speaker(p.Account); ok {
					rp.Band = bandName(sp.Band)
				}
				rp.Name = hub.Name(p.Account)
				if rp.Name == "" {
					if t, err := s.cfg.Store.Talker(ctx, store.AccountID(p.Account)); err == nil {
						rp.Name = t.Name
					}
				}
				r.People = append(r.People, rp)
			}
			if len(r.People) > 0 {
				r.Place = "aboard " + r.People[0].Name + "’s boat"
			}
		} else {
			// The boat has left the water: reported from the list of recent
			// crew, after sailing together.
			r.People = s.two(ctx, hub, in, reporter, reported)
			r.Place = "aboard a boat together, since gone ashore"
		}
	}
	made, err := s.cfg.Store.MakeReport(ctx, r)
	if err != nil {
		return err
	}
	s.counted(in.Reason)
	if in.Reason == store.ReasonChild {
		// The report itself pages the owner, through the alert on its count.
		s.cfg.Log.Warn("a report that a child may be at risk", "report", uuidString(made.ID))
	}
	if made.Rested && hub != nil {
		hub.Update(bus.Account(made.Subject), func(sp *aboard.Speaker) { sp.Rested = true })
	}
	if hub != nil && (in.Boat != 0 || in.Thread) {
		s.follow(hub, made.ID, room, made.At.Add(Follow))
	}
	return nil
}

func lineOf(l chat.Line, reported bool) store.ReportLine {
	return store.ReportLine{
		Line: l.ID, At: l.At, Sender: store.AccountID(l.From), HasSender: true, Name: l.Name, Machine: l.Machine,
		Text: l.Text, Reported: reported,
	}
}

// follow takes a room's next lines into a report until until, then keeps
// them.
func (s *Service) follow(hub *chat.Hub, id store.ReportID, room chat.Room, until time.Time) {
	f := &following{}
	f.stop = hub.Rings.Follow(room, until, func(l chat.Line) {
		f.mu.Lock()
		f.lines = append(f.lines, lineOf(l, false))
		f.mu.Unlock()
	})
	s.mu.Lock()
	s.follows[id] = f
	s.mu.Unlock()
	time.AfterFunc(time.Until(until), func() { s.keep(id) })
}

// keep writes what a report took of the conversation after it.
func (s *Service) keep(id store.ReportID) {
	s.mu.Lock()
	f := s.follows[id]
	delete(s.follows, id)
	s.mu.Unlock()
	if f == nil {
		return
	}
	f.stop()
	f.mu.Lock()
	lines := f.lines
	f.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.cfg.Store.AddReportLines(ctx, id, lines); err != nil {
		s.cfg.Log.Warn("keeping the lines after a report", "report", uuidString(id), "err", err)
	}
}

// Flush keeps what every report following its conversation has taken so
// far, as keel stops.
func (s *Service) Flush() {
	s.mu.Lock()
	var ids []store.ReportID
	for id := range s.follows {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.keep(id)
	}
}

func (s *Service) counted(reason string) {
	if m := s.cfg.Metrics; m != nil {
		m.Reports.WithLabelValues(reason).Inc()
	}
}

// Notice keeps a notice from outside the game in the queue.
func (s *Service) Notice(ctx context.Context, n store.Notice) (store.ReportID, error) {
	n.Who, n.Contact, n.What = strings.TrimSpace(n.Who), strings.TrimSpace(n.Contact), strings.TrimSpace(n.What)
	n.Sailor, n.Happened = strings.TrimSpace(n.Sailor), strings.TrimSpace(n.Happened)
	switch {
	case !validReason(n.Reason):
		return store.ReportID{}, ErrReason
	case n.Who == "" || n.Contact == "" || n.What == "",
		utf8.RuneCountInString(n.Who) > 200, utf8.RuneCountInString(n.Contact) > 200, utf8.RuneCountInString(n.What) > 2000,
		utf8.RuneCountInString(n.Sailor) > 80, utf8.RuneCountInString(n.Happened) > 200:
		return store.ReportID{}, ErrNotice
	}
	id, err := s.cfg.Store.MakeNotice(ctx, n)
	if err == nil {
		s.counted(n.Reason)
	}
	return id, err
}

// Count refreshes the queue's metrics: how many are open, how many say a
// child may be at risk, and the oldest's age.
func (s *Service) Count(ctx context.Context) {
	open, child, oldest, err := s.cfg.Store.ReportCounts(ctx)
	if err != nil {
		s.cfg.Log.Warn("counting the reports open", "err", err)
		return
	}
	if m := s.cfg.Metrics; m != nil {
		m.ReportsOpen.WithLabelValues("all").Set(float64(open))
		m.ReportsOpen.WithLabelValues("child").Set(float64(child))
		age := 0.0
		if !oldest.IsZero() {
			age = s.cfg.Now().Sub(oldest).Seconds()
		}
		m.ReportsOldest.Set(age)
	}
}

// Run refreshes the queue's metrics every half minute until ctx ends.
func (s *Service) Run(ctx context.Context) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	s.Count(ctx)
	for {
		select {
		case <-ctx.Done():
			s.Flush()
			return
		case <-t.C:
			s.Count(ctx)
		}
	}
}

// Queue is the open reports, in the order the owner reads them.
func (s *Service) Queue(ctx context.Context) ([]store.QueueItem, error) {
	return s.cfg.Store.ReportQueue(ctx, 200)
}

// Read is a report whole.
func (s *Service) Read(ctx context.Context, id store.ReportID) (store.Report, error) {
	r, err := s.cfg.Store.Report(ctx, id)
	if err == nil && r.HasOwner {
		if o, err := s.cfg.Store.Talker(ctx, r.Owner); err == nil {
			r.OwnerName = o.Name
		}
	}
	return r, err
}

// The owner's actions on a report.
const (
	Dismiss    = store.ActionDismiss
	Warn       = store.ActionWarn
	MuteChat   = store.ActionMuteChat
	Stop       = store.ActionStop
	Delete     = store.ActionDelete
	RemoveLine = store.ActionRemoveLine
	Purge      = store.ActionPurge
	Hold       = store.ActionHold
	Release    = store.ActionRelease
	Under13    = store.ActionUnder13
	Referred   = store.ActionReferred
)

// Actions are the owner's actions, in the order the page offers them.
var Actions = []string{Dismiss, Warn, MuteChat, Stop, Delete, RemoveLine, Purge, Hold, Release, Under13, Referred}

// MuteDays are the lengths a mute from chat may have.
var MuteDays = []int{1, 7, 30}

// Act is what the owner does about a report: the action, its reason
// (the record's, never the player's), the days of a mute from chat, the
// line to remove (its number and when it was said), whom it was referred
// to, the rule the statement of reasons names, and a note.
type Act struct {
	Report   store.ReportID
	Action   string
	Reason   string
	Days     int
	Line     uint64
	LineAt   time.Time
	Referred string
	Rule     string
	Note     string
	Source   string
	From     string
	Check    bool
}

// Done is what an action did, or with Check would do, in words.
type Done struct {
	Action string `json:"action"`
	Done   bool   `json:"done"`
	Words  string `json:"words"`
}

// rules are the Rules of the sea a statement of reasons may name, by the
// report's reason.
var rules = map[string]string{
	store.ReasonChild: "child safety", store.ReasonSexual: "sexual content", store.ReasonBullying: "bullying or harassment",
	store.ReasonHate: "hate", store.ReasonThreats: "threats or self-harm", store.ReasonScam: "scams or spam",
	store.ReasonCheating: "cheating", store.ReasonOther: "the Rules of the sea", store.ReasonYoung: "ages",
}

// Do does what the owner decided about a report.
func (s *Service) Do(ctx context.Context, a Act) (Done, error) {
	r, err := s.cfg.Store.Report(ctx, a.Report)
	if err != nil {
		return Done{}, err
	}
	who, whoKind, whoName, has := r.Reported, store.Kind(r.ReportedKind), r.ReportedName, r.HasReported
	if r.HasOwner {
		// A machine sailor's words are its human's to answer for.
		who, whoKind, has = r.Owner, store.Human, true
		if t, err := s.cfg.Store.Talker(ctx, who); err == nil {
			whoName = t.Name
		}
	}
	switch {
	case utf8.RuneCountInString(a.Note) > store.MaxAnswer:
		return Done{}, fmt.Errorf("%w: a note is at most %d characters", ErrAction, store.MaxAnswer)
	case len(a.Referred) > 400:
		return Done{}, fmt.Errorf("%w: whom it was referred to is at most 400 bytes", ErrAction)
	case len(a.Rule) > 40:
		return Done{}, fmt.Errorf("%w: a rule's name is at most 40 bytes", ErrAction)
	}
	rule := a.Rule
	if rule == "" {
		rule = rules[r.Reason]
	}
	act := store.ReportAct{
		Report: a.Report, Action: a.Action, Detail: a.Reason, Source: a.Source, From: a.From, Note: strings.TrimSpace(a.Note),
	}
	onPlayer := func() error {
		if !has {
			return ErrNoOne
		}
		act.Account, act.HasAcc, act.Kind, act.Name = who, true, whoKind, whoName
		return nil
	}
	now := s.cfg.Now()
	var words string
	var after func() error
	switch a.Action {
	case Dismiss:
		act.Close, act.Unrest = true, true
		if err := onPlayer(); err != nil {
			act.HasAcc = false
		}
		words = "The report closes; nobody is told."
	case Warn:
		if err := onPlayer(); err != nil {
			return Done{}, err
		}
		act.Close, act.All, act.Unrest = true, true, true
		act.Tell = &store.Statement{Action: Warn, Rule: rule, Seen: a.Note}
		words = fmt.Sprintf("%s is warned, by a statement of reasons at their next entry; every report open on them closes.", whoName)
	case MuteChat:
		if err := onPlayer(); err != nil {
			return Done{}, err
		}
		if !validDays(a.Days) {
			return Done{}, fmt.Errorf("%w: a mute from chat lasts 1, 7 or 30 days", ErrAction)
		}
		act.Close, act.All, act.Unrest = true, true, true
		act.MuteUntil = now.Add(time.Duration(a.Days) * 24 * time.Hour)
		act.Tell = &store.Statement{Action: MuteChat, Rule: rule, Seen: a.Note, Until: act.MuteUntil}
		act.Detail = strings.TrimSpace(fmt.Sprintf("%d days. %s", a.Days, a.Reason))
		days := fmt.Sprintf("%d days", a.Days)
		if a.Days == 1 {
			days = "a day"
		}
		words = fmt.Sprintf("%s’s chat is muted for %s, and they are told why; every report open on them closes.", whoName, days)
		after = func() error {
			if hub := s.cfg.Hub(); hub != nil {
				hub.Update(bus.Account(who), func(sp *aboard.Speaker) { sp.MutedUntil, sp.Rested = act.MuteUntil, false })
			}
			return nil
		}
	case Stop, Delete, Under13:
		if err := onPlayer(); err != nil {
			return Done{}, err
		}
		if a.Reason == "" && a.Action != Under13 {
			return Done{}, fmt.Errorf("%w: a stop and a delete need a reason", ErrAction)
		}
		act.Close, act.All, act.Unrest = true, true, true
		reason := a.Reason
		if a.Action == Under13 {
			reason = "under 13: " + strings.TrimSpace(a.Reason)
		} else if r.HasReported {
			// A stop or a delete reaches the account reported: a machine
			// sailor alone, or a human with theirs.
			who, whoKind, whoName = r.Reported, store.Kind(r.ReportedKind), r.ReportedName
			act.Account, act.Kind, act.Name = who, whoKind, whoName
		}
		req := accounts.Request{Account: who, Reason: strings.TrimSpace(reason), Name: whoName, Source: a.Source, From: a.From, Check: a.Check}
		var d accounts.Done
		var err error
		if a.Action == Stop {
			d, err = s.cfg.Hand.Stop(ctx, req)
		} else {
			d, err = s.cfg.Hand.Delete(ctx, req)
		}
		if err != nil {
			return Done{}, err
		}
		words = d.Words
		if a.Action != Stop {
			words += " The reports on them go with the account, but those held."
		}
		if a.Check {
			return Done{Action: a.Action, Words: words}, nil
		}
		if a.Action != Stop {
			// The account and its reports are gone but those held: what is
			// left records the action.
			act.Close, act.All, act.Unrest = r.HeldUntil.After(now), false, false
			act.HasAcc = true
		}
	case RemoveLine:
		var line *store.ReportLine
		for i := range r.Lines {
			if r.Lines[i].Line == a.Line && (a.LineAt.IsZero() || r.Lines[i].At.Equal(a.LineAt)) {
				line = &r.Lines[i]
			}
		}
		if line == nil {
			return Done{}, ErrLine
		}
		act.Line, act.LineAt = line.Line, line.At
		if line.HasSender {
			act.Account, act.HasAcc, act.Name = line.Sender, true, line.Name
			if t, err := s.cfg.Store.Talker(ctx, line.Sender); err == nil {
				act.Kind = t.Kind
				if t.Kind == store.AI {
					act.Account, act.Kind = t.Human, store.Human
				}
			}
			act.Tell = &store.Statement{Action: RemoveLine, Rule: rule, Seen: a.Note}
		}
		words = "The line goes from the game’s memory and from every report that holds it; its sender is told why."
		after = func() error {
			if hub := s.cfg.Hub(); hub != nil {
				hub.Rings.Remove(line.Line)
			}
			return nil
		}
	case Purge:
		act.Purge = true
		words = fmt.Sprintf("Every line this report holds (%d) goes from every report that holds it, with its note.", len(r.Lines))
		after = func() error {
			if hub := s.cfg.Hub(); hub != nil {
				for _, l := range r.Lines {
					hub.Rings.Remove(l.Line)
				}
			}
			return nil
		}
	case Hold:
		act.Hold = now.Add(store.HoldFor)
		words = "The report is held for a year at least, and outlives its accounts’ deletion."
	case Release:
		act.Release = true
		words = "The hold ends: the report is kept as any other."
	case Referred:
		if strings.TrimSpace(a.Referred) == "" {
			return Done{}, fmt.Errorf("%w: say to whom, and its reference", ErrAction)
		}
		act.Referred = strings.TrimSpace(a.Referred)
		act.Detail = strings.TrimSpace(act.Referred + ". " + a.Reason)
		words = "Recorded as referred to " + act.Referred + "."
	default:
		return Done{}, ErrAction
	}
	if a.Check {
		return Done{Action: a.Action, Words: words}, nil
	}
	if err := s.cfg.Store.ActOnReport(ctx, act); err != nil && !(errors.Is(err, store.ErrNotFound) && (a.Action == Delete || a.Action == Under13)) {
		return Done{}, err
	}
	if act.Unrest && act.HasAcc {
		if hub := s.cfg.Hub(); hub != nil {
			hub.Update(bus.Account(who), func(sp *aboard.Speaker) { sp.Rested = false })
		}
	}
	if after != nil {
		if err := after(); err != nil {
			return Done{}, err
		}
	}
	s.Count(ctx)
	return Done{Action: a.Action, Done: true, Words: words}, nil
}

func validDays(d int) bool {
	for _, x := range MuteDays {
		if x == d {
			return true
		}
	}
	return false
}

func uuidString(id store.ReportID) string { return store.AccountID(id).String() }
