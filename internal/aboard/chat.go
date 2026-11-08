// SPDX-License-Identifier: AGPL-3.0-only

package aboard

import (
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Chat. Nothing reaches anyone who has not accepted its sender: a line
// goes only to those aboard the same boat, where the skipper let every
// person aboard and every crew member chose to knock, or between
// two shipmates, who both chose it. Every door that delivers a line asks
// Delivered, for every line and every receiver.

// Speaker is one side of a line, as chat's rule asks of it: the account,
// its human (itself, or a machine sailor's owner), and what the human has
// said and been given. A machine sailor's human answers for it: their
// band, their switch, the owner's mute.
type Speaker struct {
	Account [16]byte
	Human   [16]byte
	Machine bool
	// Band is the human's, worked out at entry.
	Band Band
	// ChatSet is whether the human chose; Chat their choice. Unset, an
	// adult's chat is on and a teen's off.
	ChatSet bool
	Chat    bool
	// Rules: the human has accepted the Rules of the sea, which a first
	// line needs.
	Rules bool
	// Country is where the connection comes from, as the edge's header
	// gives it, "" for unknown.
	Country string
	// MutedUntil is the owner's mute from chat; Rested a rest by reports,
	// until the owner looks; Resting the filter's rest (refusals) or any
	// other rest of the moment.
	MutedUntil time.Time
	Rested     bool
	Resting    bool
	// Offline: the human appears offline to their shipmates.
	Offline bool
}

// ChatOn reports whether a player's own chat is on: their choice, or by
// default an adult's on and a teen's off. Nobody else chats: under 13, or
// the age question not answered.
func ChatOn(band Band, set, on bool) bool {
	switch band {
	case Adult:
		return !set || on
	case Teen:
		return set && on
	}
	return false
}

// On is whether the speaker's own chat is on.
func (s Speaker) On() bool { return ChatOn(s.Band, s.ChatSet, s.Chat) }

// Silenced is whether the speaker may say nothing now, whatever their
// switch: muted from chat by the owner, rested by reports, or resting.
func (s Speaker) Silenced(now time.Time) bool {
	return s.Rested || s.Resting || now.Before(s.MutedUntil)
}

// Together is how two people stand to each other for a line: aboard the
// same boat (its skipper's human given, for machine sailors), or
// shipmates.
type Together struct {
	Aboard bool
	// BoatHuman is the human of the boat's skipper: the skipper, or a
	// machine skipper's owner.
	BoatHuman [16]byte
	// Watches: the receiver is not aboard but watches the boat, where
	// everyone aboard is a machine sailor: they read the machine sailors'
	// lines, and say none.
	Watches   bool
	Shipmates bool
}

// Member is someone aboard a boat, or coming aboard, as the boarding rule
// reads them: a machine sailor or a person, and their human (a machine
// sailor's owner, a person themselves; zero for not known).
type Member struct {
	Machine bool
	Human   [16]byte
}

// MayJoin reports whether joiner may come aboard a boat whose company,
// its skipper first, is company. People and machine sailors never mix
// aboard, but for one person with only their own machine sailors: a
// boat's company is people only, machine sailors only (of any owners), or
// one owner with their own machine sailors. So no machine sailor boards a
// person's boat; a person comes aboard a machine sailor's boat only if
// they own every machine sailor aboard; and with a person aboard, only
// that person's machine sailors are let aboard. A refusal reads as the
// boat not taking crew.
func MayJoin(company []Member, joiner Member) bool {
	if len(company) == 0 {
		return false
	}
	if !company[0].Machine {
		// A person's boat: people alone.
		if joiner.Machine {
			return false
		}
		for _, m := range company {
			if m.Machine {
				return false
			}
		}
		return true
	}
	if joiner.Machine {
		for _, m := range company {
			if !m.Machine && m.Human != joiner.Human {
				return false
			}
		}
		return true
	}
	for _, m := range company {
		if !m.Machine || m.Human != joiner.Human || m.Human == ([16]byte{}) {
			return false
		}
	}
	return true
}

// SpectatorReads reports whether someone not aboard a boat, watching it,
// may read the chat aboard it: only while everyone aboard is a machine
// sailor, and then anyone watching, whoever owns the machine sailors. What
// machine sailors say is public. With a person aboard, a boat's chat is
// its company's alone: no spectator reads a word of it, a machine
// sailor's owner watching included. Spectators never say anything.
// machines says whether each one aboard is a machine sailor.
func SpectatorReads(machines []bool) bool {
	if len(machines) == 0 {
		return false
	}
	for _, m := range machines {
		if !m {
			return false
		}
	}
	return true
}

// Rules is chat's rule over the owner's switches and the ties between
// players.
type Rules struct {
	Switches *Switches
	Ties     *Ties
}

// Why a speaker may say nothing now, for their own screen.
type Silence uint8

// The silences.
const (
	// Speaks: nothing stops the speaker.
	Speaks Silence = iota
	// ChatOff: the owner has chat off for everyone, or in their country.
	ChatOff
	// OwnOff: the speaker's own chat is off (a teen's until they turn it
	// on).
	OwnOff
	// Silenced: the speaker is muted from chat, or rested.
	Silenced
	// NoRules: the Rules of the sea are not accepted yet.
	NoRules
)

// MaySay is why from may say nothing now, or Speaks.
func (r Rules) MaySay(from Speaker, now time.Time) Silence {
	switch {
	case r.Switches != nil && (!r.Switches.Chat() || r.Switches.ChatOffIn(from.Country)):
		return ChatOff
	case !from.On():
		return OwnOff
	case from.Silenced(now):
		return Silenced
	case !from.Rules:
		return NoRules
	}
	return Speaks
}

// Delivered reports whether a line from from reaches to: chat on for
// everyone and in both their countries; both their own chats on; the
// sender not silenced; neither blocking the other, nor the receiver
// muting the sender; and the two aboard the same boat, or shipmates with
// shipmates' messages on. A machine sailor's line reaches no human but
// its own and the boat's skipper's human, and no human's line reaches
// another's machine sailor. A spectator (Watches) reads a machine
// sailor's line and nobody else's: what machine sailors say is public, so
// a block between the spectator and its owner hides none of it, as it
// hides no watch of a machine sailor; the spectator's own mute or block
// of the machine sailor does.
func (r Rules) Delivered(from, to Speaker, t Together, now time.Time) bool {
	if from.Account == to.Account || r.MaySay(from, now) != Speaks {
		return false
	}
	if t.Watches && (!from.Machine || to.Machine) {
		return false
	}
	if r.Switches != nil && r.Switches.ChatOffIn(to.Country) || !to.On() {
		return false
	}
	if r.Ties != nil && (r.Ties.Blocks(from.Account, to.Account) || !t.Watches && r.Ties.Blocks(from.Human, to.Human) ||
		r.Ties.Mutes(to.Account, from.Account) || r.Ties.Mutes(to.Human, from.Account)) {
		return false
	}
	if from.Machine != to.Machine && !t.Watches {
		human, machine := to, from
		if to.Machine {
			human, machine = from, to
		}
		if human.Account != machine.Human && human.Account != t.BoatHuman {
			return false
		}
	}
	return t.Aboard || t.Watches || t.Shipmates && (r.Switches == nil || r.Switches.ShipmateMessages())
}

// chatSwitches are the owner's switches for chat, inside Switches.
type chatSwitches struct {
	chat      atomic.Bool
	shipmates atomic.Bool
	countries atomic.Pointer[[]string]
}

// Chat reports whether chat is on for everyone; ShipmateMessages whether
// shipmates' messages are.
func (s *Switches) Chat() bool             { return s.chat.chat.Load() }
func (s *Switches) ShipmateMessages() bool { return s.chat.shipmates.Load() }
func (s *Switches) SetChat(on bool)        { s.chat.chat.Store(on) }
func (s *Switches) SetShipmateMessages(on bool) {
	s.chat.shipmates.Store(on)
}

// ChatCountries are the countries where chat is off, as ISO 3166 codes in
// capitals, sorted.
func (s *Switches) ChatCountries() []string {
	if p := s.chat.countries.Load(); p != nil {
		return slices.Clone(*p)
	}
	return nil
}

// SetChatCountries sets the countries where chat is off.
func (s *Switches) SetChatCountries(codes []string) {
	c, _ := Countries(codes)
	s.chat.countries.Store(&c)
}

// ChatOffIn reports whether chat is off in country, an ISO 3166 code from
// the edge's header ("" for unknown, never off by country).
func (s *Switches) ChatOffIn(country string) bool {
	p := s.chat.countries.Load()
	if p == nil || len(*p) == 0 || len(country) != 2 {
		return false
	}
	_, found := slices.BinarySearch(*p, strings.ToUpper(country))
	return found
}

// Countries checks a list of countries for the switch: two letters each,
// capitalised, sorted and without repeats; ok false if any is not two
// letters.
func Countries(codes []string) (out []string, ok bool) {
	ok = true
	for _, c := range codes {
		c = strings.ToUpper(strings.TrimSpace(c))
		if len(c) != 2 || c[0] < 'A' || c[0] > 'Z' || c[1] < 'A' || c[1] > 'Z' {
			ok = false
			continue
		}
		out = append(out, c)
	}
	slices.Sort(out)
	return slices.Compact(out), ok
}

// Ties are every player's mutes and blocks of others, and every pair of
// shipmates, held in memory as the database has them, read for every line
// and every knock. A mute hides the other's lines from the player; a block
// hides each one's lines from the other, refuses knocks both ways, and
// puts the other ashore from the player's boat. Shipmates message each
// other anywhere in the game, and knock on each other's boat without a
// link.
type Ties struct {
	mu        sync.RWMutex
	mutes     map[[16]byte]map[[16]byte]bool
	blocks    map[[16]byte]map[[16]byte]bool
	shipmates map[[16]byte]map[[16]byte]bool
}

// NewTies holds the mutes and blocks given, each an account and the other.
func NewTies(mutes, blocks [][2][16]byte) *Ties {
	t := &Ties{mutes: map[[16]byte]map[[16]byte]bool{}, blocks: map[[16]byte]map[[16]byte]bool{}, shipmates: map[[16]byte]map[[16]byte]bool{}}
	for _, m := range mutes {
		set(t.mutes, m[0], m[1], true)
	}
	for _, b := range blocks {
		set(t.blocks, b[0], b[1], true)
	}
	return t
}

func set(m map[[16]byte]map[[16]byte]bool, a, b [16]byte, on bool) {
	if on {
		if m[a] == nil {
			m[a] = map[[16]byte]bool{}
		}
		m[a][b] = true
		return
	}
	delete(m[a], b)
	if len(m[a]) == 0 {
		delete(m, a)
	}
}

// Mutes reports whether viewer mutes other.
func (t *Ties) Mutes(viewer, other [16]byte) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.mutes[viewer][other]
}

// Blocks reports whether either of a and b blocks the other.
func (t *Ties) Blocks(a, b [16]byte) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.blocks[a][b] || t.blocks[b][a]
}

// Blocked reports whether a blocks b (one way).
func (t *Ties) Blocked(a, b [16]byte) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.blocks[a][b]
}

// SetMute and SetBlock change a tie in memory, after the database.
func (t *Ties) SetMute(a, b [16]byte, on bool) {
	t.mu.Lock()
	set(t.mutes, a, b, on)
	t.mu.Unlock()
}

func (t *Ties) SetBlock(a, b [16]byte, on bool) {
	t.mu.Lock()
	set(t.blocks, a, b, on)
	t.mu.Unlock()
}

// Shipmates reports whether a and b are shipmates.
func (t *Ties) Shipmates(a, b [16]byte) bool {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.shipmates[a][b]
}

// ShipmatesOf are a's shipmates, in no order.
func (t *Ties) ShipmatesOf(a [16]byte) [][16]byte {
	t.mu.RLock()
	defer t.mu.RUnlock()
	out := make([][16]byte, 0, len(t.shipmates[a]))
	for b := range t.shipmates[a] {
		out = append(out, b)
	}
	return out
}

// SetShipmates makes a and b shipmates in memory, or no longer, after the
// database: both ways at once.
func (t *Ties) SetShipmates(a, b [16]byte, on bool) {
	t.mu.Lock()
	set(t.shipmates, a, b, on)
	set(t.shipmates, b, a, on)
	t.mu.Unlock()
}

// Forget drops every tie of an account deleted.
func (t *Ties) Forget(a [16]byte) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, m := range []map[[16]byte]map[[16]byte]bool{t.mutes, t.blocks, t.shipmates} {
		delete(m, a)
		for k, v := range m {
			delete(v, a)
			if len(v) == 0 {
				delete(m, k)
			}
		}
	}
}

// Refuses is the knock's refusal for a block, from either side: Ties is
// the edge's Refuser.
func (t *Ties) Refuses(skipper, knocker [16]byte) bool { return t.Blocks(skipper, knocker) }

// MayBeShipmates reports whether two players of the bands given may be
// shipmates: both adults, or both 13 to 17, so that an adult and a teen
// never have the private channel shipmates' messages are. An offer between
// the bands is sent as any other and never reaches its receiver, so that
// neither its absence nor a refusal says anything of an age. Once made,
// shipmates stay shipmates when a teen turns 18.
func MayBeShipmates(a, b Band) bool {
	return a == b && (a == Adult || a == Teen)
}
