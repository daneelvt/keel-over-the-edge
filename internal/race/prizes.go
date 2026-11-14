// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"context"
	"sync"
	"sync/atomic"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Prizes afloat: what a sailor's races in the world sailed now show on the
// water while it lasts, on every boat they sail. A winner flies a pennant
// for each of their latest wins, in each race's colour, and wears the
// cockade; a sailor who has raced often flies the racing burgee, then the
// gilded one; one who chose to hang their wooden spoons hangs them from the
// stern; one who has run races flies the committee's flag. Only races of
// three boats from three accounts count, as for every prize. They are read
// from the world's lasting records, so a new world starts bare and the log
// keeps the races for good.
//
// The game's connections ask a boat's prizes for every boat in view, many
// times a second, so they are kept here, read from the database for a few
// sailors at a time: a sailor first asked for is read at the clerk's next
// turn, and again when a race of theirs is written or they hang or take
// down a spoon. Until read, a sailor shows nothing.

// Prizes is a sailor's prizes in a world as the game draws them, a prize
// code (Code, and the protocol's BoatPrize).
type Prizes uint32

// A prize code's fields, from the low bits: how many winner's pennants (3
// bits), each pennant's colour, the newest win's first (3 bits each, five),
// the burgee (2 bits: BurgeeNone, BurgeeRacing, BurgeeGilded), how many
// wooden spoons (2 bits), and the committee's flag (1 bit).
const (
	pennantBits   = 3
	colourBits    = 3
	mostPennants  = 5
	burgeeShift   = pennantBits + colourBits*mostPennants
	spoonShift    = burgeeShift + 2
	committeeFlag = 1 << (spoonShift + 2)
	mostSpoons    = 3
)

// The burgees.
const (
	BurgeeNone   = 0
	BurgeeRacing = 1
	BurgeeGilded = 2
)

// Pennants is how many winner's pennants the code flies.
func (p Prizes) Pennants() int { return int(p & (1<<pennantBits - 1)) }

// Pennant is the colour of the code's pennant i, the newest win's first:
// a place in the races' colours.
func (p Prizes) Pennant(i int) int {
	return int(p >> (pennantBits + colourBits*i) & (1<<colourBits - 1))
}

// Burgee is the code's burgee.
func (p Prizes) Burgee() int { return int(p >> burgeeShift & 3) }

// Spoons is how many wooden spoons hang from the stern.
func (p Prizes) Spoons() int { return int(p >> spoonShift & 3) }

// Committee says whether the committee's flag flies.
func (p Prizes) Committee() bool { return p&committeeFlag != 0 }

// Cockade says whether the sailor wears the winner's cockade: one for
// however many wins.
func (p Prizes) Cockade() bool { return p.Pennants() > 0 }

// PrizeRules are the catalog's: how many pennants and spoons show at
// most, how many races sailed earn each burgee and how many run the
// committee's flag, and how many colours the races take.
type PrizeRules struct {
	Pennants, Spoons int
	Burgee, Gilded   int
	Ran              int
	Colours          int
}

// PrizeRulesOf are the catalog's rules for the prizes afloat.
func PrizeRulesOf(cat *catalog.Catalog) PrizeRules {
	p := cat.World.Committee.Prizes
	r := PrizeRules{Pennants: int(p.Pennants), Spoons: int(p.Spoons), Burgee: int(p.Burgee), Gilded: int(p.Gilded), Ran: int(p.Ran)}
	for _, f := range cat.World.Committee.Flags {
		if f.Signal == catalog.SignalVictory {
			r.Colours++
		}
	}
	return r
}

// RaceColour is the place among n colours of the race of a link's code,
// as the game colours its ribbons and pennants: the same on every phone.
func RaceColour(code string, n int) int {
	if n <= 0 {
		return 0
	}
	var h uint32
	for i := range len(code) {
		h = h*31 + uint32(code[i])
	}
	return int(h % uint32(n))
}

// PrizesFrom is the prize code of a sailor's records in a world.
func PrizesFrom(r store.RacePrizes, rules PrizeRules) Prizes {
	var p Prizes
	n := min(len(r.Wins), rules.Pennants, mostPennants)
	p |= Prizes(n)
	for i := range n {
		c := min(RaceColour(r.Wins[i], rules.Colours), 1<<colourBits-1)
		p |= Prizes(c) << (pennantBits + colourBits*i)
	}
	switch {
	case r.Sailed >= rules.Gilded:
		p |= BurgeeGilded << burgeeShift
	case r.Sailed >= rules.Burgee:
		p |= BurgeeRacing << burgeeShift
	}
	p |= Prizes(min(r.Spoons, rules.Spoons, mostSpoons)) << spoonShift
	if r.Ran >= rules.Ran {
		p |= committeeFlag
	}
	return p
}

// prizeBoard keeps the prizes of the sailors asked for, of one world.
type prizeBoard struct {
	// known are the prize codes read, by account: replaced whole, never
	// changed, so a reader needs no lock.
	known atomic.Pointer[map[bus.Account]Prizes]
	// wanted are the sailors to read at the next turn.
	mu     sync.Mutex
	wanted map[bus.Account]bool
}

func newPrizeBoard() *prizeBoard {
	b := &prizeBoard{wanted: map[bus.Account]bool{}}
	b.known.Store(&map[bus.Account]Prizes{})
	return b
}

// of is a sailor's prizes as read; a sailor not read yet is wanted, and
// shows none until read.
func (b *prizeBoard) of(a bus.Account) Prizes {
	if p, ok := (*b.known.Load())[a]; ok {
		return p
	}
	b.want(a)
	return 0
}

// want asks for sailors' prizes to be read, again if they were.
func (b *prizeBoard) want(as ...bus.Account) {
	b.mu.Lock()
	for _, a := range as {
		b.wanted[a] = true
	}
	b.mu.Unlock()
}

// load reads the prizes of the sailors wanted, at most most of them.
func (b *prizeBoard) load(ctx context.Context, most int, read func(ids []store.AccountID) (map[store.AccountID]Prizes, error)) error {
	b.mu.Lock()
	ids := make([]store.AccountID, 0, min(len(b.wanted), most))
	for a := range b.wanted {
		if len(ids) == most {
			break
		}
		ids = append(ids, store.AccountID(a))
		delete(b.wanted, a)
	}
	b.mu.Unlock()
	if len(ids) == 0 {
		return nil
	}
	got, err := read(ids)
	if err != nil {
		// Asked again at the next turn.
		accounts := make([]bus.Account, len(ids))
		for i, id := range ids {
			accounts[i] = bus.Account(id)
		}
		b.want(accounts...)
		return err
	}
	old := *b.known.Load()
	next := make(map[bus.Account]Prizes, len(old)+len(ids))
	for a, p := range old {
		next[a] = p
	}
	for _, id := range ids {
		next[bus.Account(id)] = got[id]
	}
	b.known.Store(&next)
	return ctx.Err()
}

// readMost is how many sailors' prizes are read in one turn.
const readMost = 256

// PrizesOf is a sailor's prizes in the world, as last read: none for a
// sailor not read yet, who is read at the clerk's next turn. It never
// waits.
func (s *Service) PrizesOf(a bus.Account) Prizes {
	return s.prizes.of(a)
}

// LoadPrizes reads the prizes of the sailors asked for since the last
// turn: the clerk's work, once a second.
func (s *Service) LoadPrizes(ctx context.Context) error {
	w := s.cfg.World
	return s.prizes.load(ctx, readMost, func(ids []store.AccountID) (map[store.AccountID]Prizes, error) {
		rows, err := s.cfg.Store.PrizesOf(ctx, w.Number, ids, s.rules.Pennants)
		if err != nil {
			return nil, err
		}
		out := make(map[store.AccountID]Prizes, len(rows))
		for id, r := range rows {
			out[id] = PrizesFrom(r, s.rules)
		}
		return out, nil
	})
}
