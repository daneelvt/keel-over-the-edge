// SPDX-License-Identifier: AGPL-3.0-only

// Package aboard is the rules of sailing together: who may come aboard
// whose boat, and what a player's declared age allows. A skipper shares a
// link; whoever opens it asks to come aboard (a knock), and the skipper
// lets each arrival aboard, every time. Every door that lets one player
// reach another asks the rules here, so they live in one place.
//
// Ages are what a player says: a month and a year of birth, asked when a
// sailor is made, never shown to anyone. Under 13 no sailor is made.
package aboard

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"sync/atomic"
	"time"
)

// Born is a month of birth: the year and the month, 1 to 12. The day is
// never asked.
type Born struct {
	Year  int
	Month time.Month
}

// Valid reports whether b is a month that could be someone's birth, by
// now: from 1900 to now's month.
func (b Born) Valid(now time.Time) bool {
	if b.Month < time.January || b.Month > time.December || b.Year < 1900 {
		return false
	}
	return months(b.Year, b.Month) <= months(now.UTC().Year(), now.UTC().Month())
}

// Code is b as the database keeps it: year × 100 + month (200104).
func (b Born) Code() int32 { return int32(b.Year*100 + int(b.Month)) }

// BornOf reads a code; ok is false for none or a malformed one.
func BornOf(code int32) (Born, bool) {
	b := Born{Year: int(code / 100), Month: time.Month(code % 100)}
	return b, code > 0 && b.Month >= time.January && b.Month <= time.December
}

func months(year int, m time.Month) int { return year*12 + int(m) - 1 }

// Band is an age band, worked out from a month of birth at each entry: a
// teen becomes an adult on the month they turn 18.
type Band uint8

// The bands.
const (
	// Unknown: the age question is not answered yet (an account made
	// before it was asked). Such a player sails alone.
	Unknown Band = iota
	// Child: under 13. No sailor is made.
	Child
	// Teen: 13 to 17.
	Teen
	// Adult: 18 and over.
	Adult
)

// The ages that divide the bands, in whole years.
const (
	MinAge   = 13
	AdultAge = 18
)

// BandOf is the band of someone born in b, at now: their age counted in
// whole years from the month of birth, so they turn a year older on the
// first of the month.
func BandOf(b Born, now time.Time) Band {
	n := now.UTC()
	age := (months(n.Year(), n.Month()) - months(b.Year, b.Month)) / 12
	switch {
	case age < MinAge:
		return Child
	case age < AdultAge:
		return Teen
	}
	return Adult
}

// Link lifetimes: how long a "sail with me" link lasts from when it is
// made, the owner's for the whole game.
const (
	DefaultLifetime = 24 * time.Hour
	MinLifetime     = 5 * time.Minute
	MaxLifetime     = 7 * 24 * time.Hour
)

// Switches are the owner's for everyone at once, kept in memory as the
// database has them and read at every knock and link: whether links work,
// whether anyone may come aboard, and how long a link lasts.
type Switches struct {
	links    atomic.Bool
	boarding atomic.Bool
	lifetime atomic.Int64
}

// NewSwitches is every switch on, and the lifetime given.
func NewSwitches(lifetime time.Duration) *Switches {
	s := &Switches{}
	s.links.Store(true)
	s.boarding.Store(true)
	s.lifetime.Store(int64(lifetime))
	return s
}

// Links reports whether links work; Boarding whether anyone may come
// aboard; Lifetime how long a link lasts.
func (s *Switches) Links() bool                 { return s.links.Load() }
func (s *Switches) Boarding() bool              { return s.boarding.Load() }
func (s *Switches) Lifetime() time.Duration     { return time.Duration(s.lifetime.Load()) }
func (s *Switches) SetLinks(on bool)            { s.links.Store(on) }
func (s *Switches) SetBoarding(on bool)         { s.boarding.Store(on) }
func (s *Switches) SetLifetime(d time.Duration) { s.lifetime.Store(int64(d)) }

// A link's token is 16 random bytes, 128 bits, in base64url without
// padding: 22 characters. Only its SHA-256 is kept.
const (
	tokenBytes = 16
	TokenLen   = 22
)

// NewToken makes a link's token and the hash to keep of it.
func NewToken() (token string, hash [32]byte) {
	var b [tokenBytes]byte
	_, _ = rand.Read(b[:])
	token = base64.RawURLEncoding.EncodeToString(b[:])
	return token, sha256.Sum256([]byte(token))
}

// ErrToken is a token that is not one the game makes.
var ErrToken = errors.New("aboard: not a link's token")

// TokenHash is the hash a token is kept by, or ErrToken for a string that
// cannot be one: so a lookup never touches the database for it.
func TokenHash(token string) ([32]byte, error) {
	if len(token) != TokenLen {
		return [32]byte{}, ErrToken
	}
	if b, err := base64.RawURLEncoding.Strict().DecodeString(token); err != nil || len(b) != tokenBytes {
		return [32]byte{}, ErrToken
	}
	return sha256.Sum256([]byte(token)), nil
}

// Live reports whether a link made at made, set to expire at expires and
// not ended, still works at now under the lifetime now in force: lowering
// the lifetime shortens live links to it from their making; raising it
// never lengthens them.
func Live(made, expires time.Time, ended bool, lifetime time.Duration, now time.Time) bool {
	if ended {
		return false
	}
	end := expires
	if e := made.Add(lifetime); e.Before(end) {
		end = e
	}
	return now.Before(end)
}

// A Refuser says whether one player keeps another off their boat, or off
// boats they skipper, without saying why: a block, from either side. A
// refusal reads as the boat not taking crew.
type Refuser interface {
	Refuses(skipper, knocker [16]byte) bool
}

// NoBlocks refuses nobody: the game has no blocks yet.
type NoBlocks struct{}

// Refuses reports false.
func (NoBlocks) Refuses(skipper, knocker [16]byte) bool { return false }
