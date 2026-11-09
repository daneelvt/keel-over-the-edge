// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"context"
	"errors"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chat"
	"github.com/daneelvt/keel-over-the-edge/internal/edge"
	"github.com/daneelvt/keel-over-the-edge/internal/review"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Chat aboard in keel: the owner's switches for chat and every player's
// mutes and blocks, loaded as keel starts into the memory every line and
// knock reads; each world's hub, through which every line is said; and
// reports, across worlds.

// countryHeader is the header Cloudflare names a player's country in.
const countryHeader = "Cf-Ipcountry"

// chatStore is the store's side of chat.
type chatStore interface {
	ChatSettings(ctx context.Context) (chat, shipmates bool, countries []string, err error)
	Ties(ctx context.Context) (mutes, blocks []store.Tie, err error)
	Talker(ctx context.Context, id store.AccountID) (store.Talker, error)
	SetChat(ctx context.Context, id store.AccountID, on bool) error
	Mute(ctx context.Context, account, other store.AccountID, on bool) error
	Block(ctx context.Context, account, other store.AccountID, on bool) error
	TiesOf(ctx context.Context, account store.AccountID) ([]store.TieRow, error)
	Statements(ctx context.Context, account store.AccountID) ([]store.Statement, error)
	ReadStatement(ctx context.Context, account store.AccountID, id [16]byte) error
	AnswerStatement(ctx context.Context, account store.AccountID, id [16]byte, answer string) error
	MakeYoungReport(ctx context.Context, id store.AccountID) error
	DeleteReports(ctx context.Context, before time.Time) (int64, error)
	EndFollows(ctx context.Context) error
	review.Store
	SetChatSwitch(ctx context.Context, on bool, a store.Action) error
	SetShipmateMessages(ctx context.Context, on bool, a store.Action) error
	SetChatCountries(ctx context.Context, countries []string, a store.Action) error
}

// loadChat reads the owner's switches for chat into the switches, and
// every mute and block into memory, as keel starts.
func loadChat(ctx context.Context, db chatStore, sw *aboard.Switches) (*aboard.Ties, error) {
	on, shipmates, countries, err := db.ChatSettings(ctx)
	if err != nil {
		return nil, err
	}
	sw.SetChat(on)
	sw.SetShipmateMessages(shipmates)
	sw.SetChatCountries(countries)
	mutes, blocks, err := db.Ties(ctx)
	if err != nil {
		return nil, err
	}
	pairs := func(ts []store.Tie) [][2][16]byte {
		out := make([][2][16]byte, len(ts))
		for i, t := range ts {
			out[i] = [2][16]byte{t.Account, t.Other}
		}
		return out
	}
	// A report following its conversation when keel stopped follows it no
	// longer: the memory it followed is gone.
	if err := db.EndFollows(ctx); err != nil {
		return nil, err
	}
	return aboard.NewTies(pairs(mutes), pairs(blocks)), nil
}

// speakerOf is an account as chat's rule reads it.
func speakerOf(a bus.Account, t store.Talker, now time.Time) aboard.Speaker {
	band := aboard.Unknown
	if b, ok := aboard.BornOf(t.Born); ok {
		band = aboard.BandOf(b, now)
	}
	return aboard.Speaker{
		Account: a, Human: t.Human, Machine: t.Kind == store.AI, Band: band, ChatSet: t.ChatSet, Chat: t.Chat,
		Rules: t.Rules, MutedUntil: t.MutedUntil, Rested: t.Rested,
	}
}

// talker reads what chat needs of an account as it connects.
func (p *process) talker(ctx context.Context, a bus.Account) (aboard.Speaker, string, error) {
	t, err := p.chatDB().Talker(ctx, store.AccountID(a))
	if err != nil {
		return aboard.Speaker{}, "", err
	}
	return speakerOf(a, t, time.Now()), t.Name, nil
}

// chatDB is the store as chat reaches it.
func (p *process) chatDB() chatStore { return p.db }

// hub is the chat of the world sailed now, nil between worlds.
func (p *process) hub() *chat.Hub {
	if h := p.current.Load(); h != nil {
		return h.chat
	}
	return nil
}

// tie keeps a mute or a block in the store, then in memory.
func (p *process) tie(ctx context.Context, account, other bus.Account, block, on bool) error {
	db := p.chatDB()
	if block {
		if err := db.Block(ctx, store.AccountID(account), store.AccountID(other), on); err != nil {
			return err
		}
		p.ties.SetBlock(account, other, on)
		return nil
	}
	if err := db.Mute(ctx, store.AccountID(account), store.AccountID(other), on); err != nil {
		return err
	}
	p.ties.SetMute(account, other, on)
	return nil
}

// report keeps a report from the game connection.
func (p *process) report(ctx context.Context, r edge.ReportIn) error {
	return p.reports.Report(ctx, review.In(r))
}

// refreshTalker reads an account again into the hub, after its player
// changed what chat reads of it.
func (p *process) refreshTalker(ctx context.Context, id store.AccountID) {
	h := p.hub()
	if h == nil {
		return
	}
	t, err := p.chatDB().Talker(ctx, id)
	if err != nil {
		p.log.Warn("reading a sailor again for chat", "err", err)
		return
	}
	now := time.Now()
	h.Update(bus.Account(id), func(s *aboard.Speaker) {
		fresh := speakerOf(bus.Account(s.Account), t, now)
		if s.Account != bus.Account(id) {
			// A machine sailor of the player's: its human's answers.
			fresh.Account, fresh.Human, fresh.Machine = s.Account, s.Human, s.Machine
		}
		fresh.Country = s.Country
		*s = fresh
	})
}

// chatting is the play routes' side of chat.
type chatting struct{ p *process }

func (c chatting) SetChat(ctx context.Context, id store.AccountID, on bool) error {
	return c.p.chatDB().SetChat(ctx, id, on)
}

func (c chatting) Talker(ctx context.Context, id store.AccountID) (store.Talker, error) {
	return c.p.chatDB().Talker(ctx, id)
}

func (c chatting) TiesOf(ctx context.Context, account store.AccountID) ([]store.TieRow, error) {
	return c.p.chatDB().TiesOf(ctx, account)
}

func (c chatting) Untie(ctx context.Context, account, other store.AccountID, block bool) error {
	return c.p.tie(ctx, bus.Account(account), bus.Account(other), block, false)
}

func (c chatting) Statements(ctx context.Context, account store.AccountID) ([]store.Statement, error) {
	return c.p.chatDB().Statements(ctx, account)
}

func (c chatting) ReadStatement(ctx context.Context, account store.AccountID, id [16]byte) error {
	return c.p.chatDB().ReadStatement(ctx, account, id)
}

func (c chatting) AnswerStatement(ctx context.Context, account store.AccountID, id [16]byte, answer string) error {
	return c.p.chatDB().AnswerStatement(ctx, account, id, answer)
}

func (c chatting) Notice(ctx context.Context, n store.Notice) error {
	_, err := c.p.reports.Notice(ctx, n)
	if errors.Is(err, review.ErrNotice) || errors.Is(err, review.ErrReason) {
		return api.ErrNoticeForm
	}
	return err
}

func (c chatting) Changed(ctx context.Context, id store.AccountID) { c.p.refreshTalker(ctx, id) }
