// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/daneelvt/keel-over-the-edge/internal/store/db"
)

// Chat aboard. A player's own switch for chat; mutes and blocks between
// players; reports, the only place a line of chat is ever written, and
// what the owner does about them; notices from outside the game;
// statements of reasons to the players the owner restricts; and the
// owner's switches for chat, for everyone.

// The record's actions for chat.
const (
	ActionChat             = "chat"
	ActionShipmateMessages = "shipmate-messages"
	ActionChatCountries    = "chat-countries"
	ActionDismiss          = "dismiss"
	ActionWarn             = "warn"
	ActionMuteChat         = "mute-chat"
	ActionRemoveLine       = "remove-line"
	ActionPurge            = "purge"
	ActionHold             = "hold"
	ActionRelease          = "release"
	ActionUnder13          = "under-13"
	ActionReferred         = "referred"
	// ActionRest is the game's: reports rested a player's chat and knocks
	// until the owner looks.
	ActionRest = "rest"
)

// Report sources and reasons, as the database names them.
const (
	ReportByPlayer = "player"
	ReportByNotice = "notice"
	ReportByGame   = "game"

	ReasonChild    = "child"
	ReasonSexual   = "sexual"
	ReasonBullying = "bullying"
	ReasonHate     = "hate"
	ReasonThreats  = "threats"
	ReasonScam     = "scam"
	ReasonCheating = "cheating"
	ReasonOther    = "other"
	ReasonYoung    = "young"
)

// ReportReasons are the reasons a player may give, in the order offered.
var ReportReasons = []string{ReasonChild, ReasonSexual, ReasonBullying, ReasonHate, ReasonThreats, ReasonScam, ReasonCheating, ReasonOther}

// Limits.
const (
	// MaxTies is the most mutes, and the most blocks, an account keeps.
	MaxTies = 1000
	// MaxReportNote is the longest a report's note may be, in characters;
	// MaxAnswer a player's answer to a statement of reasons.
	MaxReportNote = 200
	MaxAnswer     = 500
	// ReportsToRest is how many players reporting an account in a day rest
	// its chat and knocks until the owner looks; one report that a child
	// may be at risk does too.
	ReportsToRest = 3
	// ReportKeep is how long a report is kept after it closes; HoldFor how
	// long a report held is kept at least.
	ReportKeep = 183 * 24 * time.Hour
	HoldFor    = 366 * 24 * time.Hour
	// ReportBatch is how many reports one statement deletes.
	ReportBatch = 1000
)

var (
	// ErrTooManyTies is a mute or a block past MaxTies.
	ErrTooManyTies = errors.New("store: too many mutes or blocks")
	// ErrAnsweredAlready is a second answer to a statement of reasons.
	ErrAnsweredAlready = errors.New("store: the statement is answered already")
)

// ReportID is a report's.
type ReportID [16]byte

// Talker is an account as chat needs it: its kind and sailor's name, and
// what its human (itself, for a human; a machine sailor's owner) has said
// and been given: their month of birth (0 for not answered), the Rules of
// the sea, their own chat switch (ChatSet false for the band's default),
// the owner's mute from chat and a rest by reports.
type Talker struct {
	Kind       Kind
	Human      AccountID
	Name       string
	Born       int32
	Rules      bool
	ChatSet    bool
	Chat       bool
	MutedUntil time.Time
	Rested     bool
}

// Talker finds an account as chat needs it: ErrNotFound for none.
func (s *Store) Talker(ctx context.Context, id AccountID) (Talker, error) {
	r, err := s.q.TalkerOf(ctx, uuidOf(id))
	if errors.Is(err, pgx.ErrNoRows) {
		return Talker{}, ErrNotFound
	}
	if err != nil {
		return Talker{}, err
	}
	return Talker{
		Kind: Kind(r.Kind), Human: r.Human.Bytes, Name: r.Name, Born: r.Born, Rules: r.Rules,
		ChatSet: r.Chat.Valid, Chat: r.Chat.Bool, MutedUntil: timeOf(r.ChatMutedUntil), Rested: r.RestedAt.Valid,
	}, nil
}

// SetChat sets a human's own switch for chat: ErrNotHuman for any other.
func (s *Store) SetChat(ctx context.Context, id AccountID, on bool) error {
	n, err := s.q.SetChat(ctx, db.SetChatParams{ID: uuidOf(id), Chat: pgtype.Bool{Bool: on, Valid: true}})
	if err == nil && n == 0 {
		return ErrNotHuman
	}
	return err
}

// Tie is one account's mute or block of another.
type Tie struct{ Account, Other AccountID }

// Ties are every mute and every block kept, to be held in memory.
func (s *Store) Ties(ctx context.Context) (mutes, blocks []Tie, err error) {
	ms, err := s.q.AllMutes(ctx)
	if err != nil {
		return nil, nil, err
	}
	bs, err := s.q.AllBlocks(ctx)
	if err != nil {
		return nil, nil, err
	}
	for _, m := range ms {
		mutes = append(mutes, Tie{m.AccountID.Bytes, m.OtherID.Bytes})
	}
	for _, b := range bs {
		blocks = append(blocks, Tie{b.AccountID.Bytes, b.OtherID.Bytes})
	}
	return mutes, blocks, nil
}

// Mute mutes other for account, or no longer: ErrTooManyTies past
// MaxTies. Muting twice changes nothing.
func (s *Store) Mute(ctx context.Context, account, other AccountID, on bool) error {
	if !on {
		_, err := s.q.DeleteMute(ctx, db.DeleteMuteParams{AccountID: uuidOf(account), OtherID: uuidOf(other)})
		return err
	}
	n, err := s.q.InsertMute(ctx, db.InsertMuteParams{AccountID: uuidOf(account), OtherID: uuidOf(other), Lim: MaxTies})
	if err == nil && n == 0 {
		return s.tiedOrTooMany(ctx, account, other, "mute")
	}
	return err
}

// Block blocks other for account, or no longer: ErrTooManyTies past
// MaxTies.
func (s *Store) Block(ctx context.Context, account, other AccountID, on bool) error {
	if !on {
		_, err := s.q.DeleteBlock(ctx, db.DeleteBlockParams{AccountID: uuidOf(account), OtherID: uuidOf(other)})
		return err
	}
	n, err := s.q.InsertBlock(ctx, db.InsertBlockParams{AccountID: uuidOf(account), OtherID: uuidOf(other), Lim: MaxTies})
	if err == nil && n == 0 {
		return s.tiedOrTooMany(ctx, account, other, "block")
	}
	return err
}

// tiedOrTooMany tells an insert that did nothing because the tie was there
// already from one refused by the limit.
func (s *Store) tiedOrTooMany(ctx context.Context, account, other AccountID, kind string) error {
	ties, err := s.TiesOf(ctx, account)
	if err != nil {
		return err
	}
	for _, t := range ties {
		if t.Other == other && t.Kind == kind {
			return nil
		}
	}
	return ErrTooManyTies
}

// TieRow is a mute or a block as its player's list shows it.
type TieRow struct {
	Kind  string // "mute" or "block"
	Other AccountID
	Name  string
	Made  time.Time
}

// TiesOf are an account's mutes and blocks, the newest first.
func (s *Store) TiesOf(ctx context.Context, account AccountID) ([]TieRow, error) {
	rows, err := s.q.TiesOf(ctx, uuidOf(account))
	if err != nil {
		return nil, err
	}
	out := make([]TieRow, len(rows))
	for i, r := range rows {
		out[i] = TieRow{Kind: r.Kind, Other: r.OtherID.Bytes, Name: r.Name, Made: r.MadeAt.UTC()}
	}
	return out, nil
}

// ReportLine is a line a report holds, as the game's memory had it.
type ReportLine struct {
	Line      uint64
	At        time.Time
	Sender    AccountID
	HasSender bool
	Name      string
	Machine   bool
	Text      string
	// Reported marks the line the report was made from.
	Reported bool
}

// ReportPerson is someone aboard at a report: name, band and machine mark.
type ReportPerson struct {
	Name    string `json:"name"`
	Band    string `json:"band"`
	Machine bool   `json:"machine,omitempty"`
	Skipper bool   `json:"skipper,omitempty"`
}

// NewReport is a report as it is made.
type NewReport struct {
	Source       string
	Reason       string
	Note         string
	Reporter     AccountID
	HasReporter  bool
	ReporterName string
	// The account reported, its kind and name; a machine sailor's human is
	// Owner.
	Reported     AccountID
	HasReported  bool
	ReportedKind Kind
	ReportedName string
	Owner        AccountID
	HasOwner     bool
	OwnerName    string
	Place        string
	People       []ReportPerson
	FollowUntil  time.Time
	Lines        []ReportLine
}

// Made is a report made, and what it brought about: Rested, when this
// report rested the reported human's chat and knocks (ReportsToRest
// players reported them in a day, or one said a child may be at risk);
// Subject is that human.
type Made struct {
	ID      ReportID
	At      time.Time
	Rested  bool
	Subject AccountID
}

func optUUID(id [16]byte, ok bool) pgtype.UUID { return pgtype.UUID{Bytes: id, Valid: ok} }

func optStamp(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: !t.IsZero()} }

// MakeReport keeps a report and its lines, in one transaction; a
// player's report rests the reported human's chat and knocks when it
// makes ReportsToRest reporters in a day, or says a child may be at risk.
func (s *Store) MakeReport(ctx context.Context, r NewReport) (Made, error) {
	people, err := json.Marshal(r.People)
	if err != nil {
		return Made{}, err
	}
	if r.People == nil {
		people = []byte("[]")
	}
	var out Made
	err = s.inTx(ctx, func(q *db.Queries) error {
		row, err := q.InsertReport(ctx, db.InsertReportParams{
			Source: r.Source, Reason: r.Reason, Note: r.Note,
			ReporterID: optUUID(r.Reporter, r.HasReporter), ReporterName: clip(r.ReporterName, 80),
			ReportedID: optUUID(r.Reported, r.HasReported), ReportedKind: text(string(r.ReportedKind)),
			ReportedName: clip(r.ReportedName, 80), ReportedOwner: optUUID(r.Owner, r.HasOwner),
			Place: clip(r.Place, 400), People: people, FollowUntil: optStamp(r.FollowUntil),
		})
		if err != nil {
			return err
		}
		out.ID, out.At = row.ID.Bytes, row.MadeAt.UTC()
		if err := insertLines(ctx, q, out.ID, r.Lines); err != nil {
			return err
		}
		if r.Source != ReportByPlayer || !r.HasReported {
			return nil
		}
		out.Subject = r.Reported
		name := r.ReportedName
		if r.HasOwner {
			out.Subject, name = r.Owner, r.OwnerName
		}
		c, err := q.ReportersOfInDay(ctx, uuidOf(out.Subject))
		if err != nil {
			return err
		}
		if c.Reporters < ReportsToRest && !c.Child {
			return nil
		}
		n, err := q.SetRested(ctx, uuidOf(out.Subject))
		if err != nil || n == 0 {
			return err
		}
		out.Rested = true
		return insertAction(ctx, q, Action{
			Action: ActionRest, Account: out.Subject, HasAccount: true, Kind: Human, Name: name,
			Detail: "reports rested the player's chat and knocks until the owner looks", Source: SourceGame,
			Report: out.ID, HasReport: true,
		})
	})
	return out, err
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && s[n]&0xc0 == 0x80 {
		n--
	}
	return s[:n]
}

func insertLines(ctx context.Context, q *db.Queries, id ReportID, lines []ReportLine) error {
	for _, l := range lines {
		if err := q.InsertReportLine(ctx, db.InsertReportLineParams{
			ReportID: uuidOf(AccountID(id)), Line: int64(l.Line), At: l.At, SenderID: optUUID(l.Sender, l.HasSender),
			SenderName: clip(l.Name, 80), Machine: l.Machine, Text: l.Text, Reported: l.Reported,
		}); err != nil {
			return err
		}
	}
	return nil
}

// AddReportLines adds lines to a report: the conversation after it.
func (s *Store) AddReportLines(ctx context.Context, id ReportID, lines []ReportLine) error {
	if len(lines) == 0 {
		return nil
	}
	return s.inTx(ctx, func(q *db.Queries) error { return insertLines(ctx, q, id, lines) })
}

// EndFollows ends every report's following of its conversation: none can
// follow it past a restart.
func (s *Store) EndFollows(ctx context.Context) error { return s.q.EndFollows(ctx) }

// Notice is a notice from outside the game, from anyone.
type Notice struct {
	Who      string `json:"who"`      // who they are
	Contact  string `json:"contact"`  // how to reach them
	Sailor   string `json:"sailor"`   // the sailor's name, if they know it
	Happened string `json:"happened"` // where and when
	Reason   string `json:"reason"`   // one of ReportReasons
	What     string `json:"what"`     // what happened, and why it is wrong
}

// MakeNotice keeps a notice in the reports' queue.
func (s *Store) MakeNotice(ctx context.Context, n Notice) (ReportID, error) {
	var id ReportID
	err := s.inTx(ctx, func(q *db.Queries) error {
		row, err := q.InsertReport(ctx, db.InsertReportParams{
			Source: ReportByNotice, Reason: n.Reason, ReportedName: clip(n.Sailor, 80), People: []byte("[]"),
		})
		if err != nil {
			return err
		}
		id = row.ID.Bytes
		return q.InsertNotice(ctx, db.InsertNoticeParams{
			ReportID: row.ID, Who: n.Who, Contact: n.Contact, Sailor: n.Sailor, Happened: n.Happened, What: n.What,
		})
	})
	return id, err
}

// MakeYoungReport puts an account the game stopped, its player having said
// they are under 13, in the reports' queue for the owner.
func (s *Store) MakeYoungReport(ctx context.Context, id AccountID) error {
	_, err := s.q.InsertYoungReport(ctx, uuidOf(id))
	return err
}

// QueueItem is an open report as the queue lists it.
type QueueItem struct {
	ID           ReportID
	Made         time.Time
	Source       string
	Reason       string
	ReporterName string
	ReportedName string
	ReportedKind string
	Place        string
	// Reports is how many open reports there are on the same player;
	// Lines how many lines this one holds; Answers whether the player
	// answered a statement about it.
	Reports int64
	Urgent  bool
	Lines   int64
	Answers int64
}

// ReportQueue is the open reports: a child's safety first, then the
// players with the most reports open, then the oldest.
func (s *Store) ReportQueue(ctx context.Context, limit int) ([]QueueItem, error) {
	rows, err := s.q.ReportQueue(ctx, int32(limit))
	if err != nil {
		return nil, err
	}
	out := make([]QueueItem, len(rows))
	for i, r := range rows {
		out[i] = QueueItem{
			ID: r.ID.Bytes, Made: r.MadeAt.UTC(), Source: r.Source, Reason: r.Reason, ReporterName: r.ReporterName,
			ReportedName: r.ReportedName, ReportedKind: r.ReportedKind, Place: r.Place, Reports: r.Reports,
			Urgent: r.Urgent, Lines: r.Lines, Answers: r.Answers,
		}
	}
	return out, nil
}

// ReportCounts are how many reports are open, how many say a child may be
// at risk, and when the oldest open one was made (zero for none).
func (s *Store) ReportCounts(ctx context.Context) (open, child int64, oldest time.Time, err error) {
	r, err := s.q.ReportCounts(ctx)
	if err != nil {
		return 0, 0, time.Time{}, err
	}
	oldest = r.Oldest
	if r.Open == 0 {
		oldest = time.Time{}
	}
	return r.Open, r.Child, oldest.UTC(), nil
}

// Report is a report whole, as the owner reads it.
type Report struct {
	ID           ReportID
	Made         time.Time
	Source       string
	Reason       string
	Note         string
	Reporter     AccountID
	HasReporter  bool
	ReporterName string
	Reported     AccountID
	HasReported  bool
	ReportedKind string
	ReportedName string
	Owner        AccountID
	HasOwner     bool
	// OwnerName is the owner's sailor's name, as the reader looks it up.
	OwnerName   string
	Place       string
	People      []ReportPerson
	FollowUntil time.Time
	Closed      time.Time
	Outcome     string
	HeldUntil   time.Time
	Referred    string
	Notice      *Notice
	Lines       []ReportLine
	Notes       []ReportNote
}

// ReportNote is a note on a report: the owner's, or the player's answer.
type ReportNote struct {
	At   time.Time
	By   string // "owner" or "player"
	Text string
}

// Report reads a report whole: ErrNotFound for none.
func (s *Store) Report(ctx context.Context, id ReportID) (Report, error) {
	r, err := s.q.ReportByID(ctx, uuidOf(AccountID(id)))
	if errors.Is(err, pgx.ErrNoRows) {
		return Report{}, ErrNotFound
	}
	if err != nil {
		return Report{}, err
	}
	out := Report{
		ID: r.ID.Bytes, Made: r.MadeAt.UTC(), Source: r.Source, Reason: r.Reason, Note: r.Note,
		Reporter: r.ReporterID.Bytes, HasReporter: r.ReporterID.Valid, ReporterName: r.ReporterName,
		Reported: r.ReportedID.Bytes, HasReported: r.ReportedID.Valid, ReportedKind: r.ReportedKind,
		ReportedName: r.ReportedName, Owner: r.ReportedOwner.Bytes, HasOwner: r.ReportedOwner.Valid, Place: r.Place,
		FollowUntil: timeOf(r.FollowUntil), Closed: timeOf(r.ClosedAt), Outcome: r.Outcome,
		HeldUntil: timeOf(r.HeldUntil), Referred: r.Referred,
	}
	_ = json.Unmarshal(r.People, &out.People)
	if r.Source == ReportByNotice {
		out.Notice = &Notice{
			Who: r.NoticeWho, Contact: r.NoticeContact, Sailor: r.NoticeSailor, Happened: r.NoticeHappened,
			Reason: r.Reason, What: r.NoticeWhat,
		}
	}
	lines, err := s.q.ReportLines(ctx, r.ID)
	if err != nil {
		return Report{}, err
	}
	for _, l := range lines {
		out.Lines = append(out.Lines, ReportLine{
			Line: uint64(l.Line), At: l.At.UTC(), Sender: l.SenderID.Bytes, HasSender: l.SenderID.Valid,
			Name: l.SenderName, Machine: l.Machine, Text: l.Text, Reported: l.Reported,
		})
	}
	notes, err := s.q.ReportNotes(ctx, r.ID)
	if err != nil {
		return Report{}, err
	}
	for _, n := range notes {
		out.Notes = append(out.Notes, ReportNote{At: n.At.UTC(), By: n.By, Text: n.Text})
	}
	return out, nil
}

// Statement is a statement of reasons, to a player the owner restricted:
// the rule they broke, what was seen, the action and until when.
type Statement struct {
	ID       [16]byte
	Made     time.Time
	Action   string
	Rule     string
	Seen     string
	Until    time.Time
	Read     time.Time
	Answer   string
	Answered time.Time
}

// ReportAct is what the owner does about a report, in one transaction
// with its record: the report closed (with every open report on the same
// player, for an action on them), its rest lifted, and the player told
// by a statement of reasons; a hold, a release, a referral; a line taken
// out of every report; a purge.
type ReportAct struct {
	Report  ReportID
	Action  string
	Account AccountID // the player acted on, for actions on a player
	HasAcc  bool
	Name    string
	Kind    Kind
	Detail  string
	Source  string
	From    string
	// Close closes the report, with every open one on the same player when
	// All; Unrest lifts the player's rest; MuteUntil mutes their chat
	// until then.
	Close     bool
	All       bool
	Unrest    bool
	MuteUntil time.Time
	// Tell is the statement of reasons to send, if any.
	Tell *Statement
	// Hold holds the report until then; Release ends a hold.
	Hold    time.Time
	Release bool
	// Referred records whom it was referred to, and its reference.
	Referred string
	// Line, if not zero, is a line taken out of every report holding it.
	Line   uint64
	LineAt time.Time
	// Purge takes every line the report holds out of every report, and its
	// note.
	Purge bool
	// Note is the owner's note, if any.
	Note string
}

// ActOnReport does what the owner decided about a report: ErrNotFound for
// no such report.
func (s *Store) ActOnReport(ctx context.Context, a ReportAct) error {
	rid := uuidOf(AccountID(a.Report))
	return s.inTx(ctx, func(q *db.Queries) error {
		if a.Close {
			n, err := q.CloseReport(ctx, db.CloseReportParams{ID: rid, Outcome: a.Action})
			if err != nil {
				return err
			}
			if n == 0 {
				return ErrNotFound
			}
			if a.All {
				if _, err := q.CloseReportsOf(ctx, db.CloseReportsOfParams{ID: rid, Outcome: a.Action}); err != nil {
					return err
				}
			}
		}
		if a.HasAcc && a.Unrest {
			if _, err := q.ClearRested(ctx, uuidOf(a.Account)); err != nil {
				return err
			}
		}
		if a.HasAcc && !a.MuteUntil.IsZero() {
			if _, err := q.MuteChat(ctx, db.MuteChatParams{ID: uuidOf(a.Account), Until: stamp(a.MuteUntil)}); err != nil {
				return err
			}
		}
		if !a.Hold.IsZero() || a.Release {
			if _, err := q.HoldReport(ctx, db.HoldReportParams{ID: rid, Until: optStamp(a.Hold)}); err != nil {
				return err
			}
		}
		if a.Referred != "" {
			if _, err := q.ReferReport(ctx, db.ReferReportParams{ID: rid, Referred: clip(a.Referred, 400)}); err != nil {
				return err
			}
		}
		if a.Line != 0 {
			if _, err := q.RemoveReportLine(ctx, db.RemoveReportLineParams{Line: int64(a.Line), At: a.LineAt}); err != nil {
				return err
			}
		}
		if a.Purge {
			if _, err := q.PurgeReport(ctx, rid); err != nil {
				return err
			}
			if err := q.BlankReportNote(ctx, rid); err != nil {
				return err
			}
		}
		if a.Note != "" {
			if err := q.InsertReportNote(ctx, db.InsertReportNoteParams{ReportID: rid, By: "owner", Text: a.Note}); err != nil {
				return err
			}
		}
		if a.HasAcc && a.Tell != nil {
			if _, err := q.InsertStatement(ctx, db.InsertStatementParams{
				AccountID: uuidOf(a.Account), ReportID: rid, Action: a.Tell.Action, Rule: a.Tell.Rule,
				Seen: a.Tell.Seen, Until: optStamp(a.Tell.Until),
			}); err != nil {
				return err
			}
		}
		return insertAction(ctx, q, Action{
			Action: a.Action, Account: a.Account, HasAccount: a.HasAcc, Kind: a.Kind, Name: a.Name,
			Detail: a.Detail, Source: a.Source, From: a.From, Report: a.Report, HasReport: true,
		})
	})
}

// Statements are an account's statements of reasons, the newest first.
func (s *Store) Statements(ctx context.Context, account AccountID) ([]Statement, error) {
	rows, err := s.q.StatementsOf(ctx, uuidOf(account))
	if err != nil {
		return nil, err
	}
	out := make([]Statement, len(rows))
	for i, r := range rows {
		out[i] = Statement{
			ID: r.ID.Bytes, Made: r.MadeAt.UTC(), Action: r.Action, Rule: r.Rule, Seen: r.Seen, Until: timeOf(r.Until),
			Read: timeOf(r.ReadAt), Answer: r.Answer.String, Answered: timeOf(r.AnsweredAt),
		}
	}
	return out, nil
}

// ReadStatement marks a statement read by its player.
func (s *Store) ReadStatement(ctx context.Context, account AccountID, id [16]byte) error {
	_, err := s.q.ReadStatement(ctx, db.ReadStatementParams{ID: uuidOf(id), AccountID: uuidOf(account)})
	return err
}

// AnswerStatement keeps a player's one answer to a statement of reasons
// and puts the report it was about back in the queue, with the answer as
// its note: ErrAnsweredAlready for a second, ErrNotFound for none.
func (s *Store) AnswerStatement(ctx context.Context, account AccountID, id [16]byte, answer string) error {
	return s.inTx(ctx, func(q *db.Queries) error {
		rid, err := q.AnswerStatement(ctx, db.AnswerStatementParams{ID: uuidOf(id), AccountID: uuidOf(account), Answer: text(answer)})
		if errors.Is(err, pgx.ErrNoRows) {
			list, lerr := q.StatementsOf(ctx, uuidOf(account))
			if lerr != nil {
				return lerr
			}
			for _, st := range list {
				if st.ID.Bytes == id {
					return ErrAnsweredAlready
				}
			}
			return ErrNotFound
		}
		if err != nil || !rid.Valid {
			return err
		}
		if _, err := q.ReopenReport(ctx, rid); err != nil {
			return err
		}
		return q.InsertReportNote(ctx, db.InsertReportNoteParams{ReportID: rid, By: "player", Text: answer})
	})
}

// DeleteReports deletes the reports closed before the time given and not
// held, ReportBatch at a time, and returns how many.
func (s *Store) DeleteReports(ctx context.Context, before time.Time) (int64, error) {
	var total int64
	for {
		n, err := s.q.DeleteOldReports(ctx, db.DeleteOldReportsParams{Before: before, Lim: ReportBatch})
		total += n
		if err != nil || n < ReportBatch {
			return total, err
		}
	}
}

// ChatSettings are the owner's switches for chat as kept: chat itself,
// shipmates' messages, and the countries where chat is off.
func (s *Store) ChatSettings(ctx context.Context) (chat, shipmates bool, countries []string, err error) {
	r, err := s.q.ChatSettings(ctx)
	if err != nil {
		return false, false, nil, err
	}
	return r.Chat, r.ShipmateMessages, r.ChatCountries, nil
}

// SetChatSwitch switches chat on or off for everyone, with its record.
func (s *Store) SetChatSwitch(ctx context.Context, on bool, a Action) error {
	a.Action = ActionChat
	return s.setting(ctx, a, func(q *db.Queries) error { _, err := q.SetChatSwitch(ctx, on); return err })
}

// SetShipmateMessages switches shipmates' messages on or off for everyone,
// with its record.
func (s *Store) SetShipmateMessages(ctx context.Context, on bool, a Action) error {
	a.Action = ActionShipmateMessages
	return s.setting(ctx, a, func(q *db.Queries) error { _, err := q.SetShipmateMessages(ctx, on); return err })
}

// SetChatCountries sets the countries where chat is off, with its record.
func (s *Store) SetChatCountries(ctx context.Context, countries []string, a Action) error {
	a.Action = ActionChatCountries
	if countries == nil {
		countries = []string{}
	}
	return s.setting(ctx, a, func(q *db.Queries) error { _, err := q.SetChatCountries(ctx, countries); return err })
}
