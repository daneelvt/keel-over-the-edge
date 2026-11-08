// SPDX-License-Identifier: AGPL-3.0-only

package aboard

import (
	"testing"
	"time"
)

func speaker(n byte, band Band) Speaker {
	return Speaker{Account: [16]byte{n}, Human: [16]byte{n}, Band: band, Rules: true}
}

func TestChatOnByBand(t *testing.T) {
	for _, c := range []struct {
		band    Band
		set, on bool
		want    bool
	}{
		{Adult, false, false, true}, {Adult, true, false, false}, {Adult, true, true, true},
		{Teen, false, false, false}, {Teen, true, false, false}, {Teen, true, true, true},
		{Child, true, true, false}, {Unknown, true, true, false}, {Unknown, false, false, false},
	} {
		if got := ChatOn(c.band, c.set, c.on); got != c.want {
			t.Errorf("ChatOn(%v, set %v, on %v) = %v, want %v", c.band, c.set, c.on, got, c.want)
		}
	}
}

// TestDeliveredEveryPair tries the rule for every pair of bands and own
// switches, aboard and not.
func TestDeliveredEveryPair(t *testing.T) {
	now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	r := Rules{Switches: NewSwitches(DefaultLifetime), Ties: NewTies(nil, nil)}
	bands := []Band{Unknown, Child, Teen, Adult}
	for _, fb := range bands {
		for _, tb := range bands {
			for _, fset := range []bool{false, true} {
				for _, tset := range []bool{false, true} {
					for _, aboard := range []bool{false, true} {
						from, to := speaker(1, fb), speaker(2, tb)
						from.ChatSet, from.Chat = fset, fset
						to.ChatSet, to.Chat = tset, tset
						got := r.Delivered(from, to, Together{Aboard: aboard}, now)
						want := aboard && from.On() && to.On()
						if got != want {
							t.Errorf("from %v (set %v) to %v (set %v), aboard %v: %v, want %v", fb, fset, tb, tset, aboard, got, want)
						}
					}
				}
			}
		}
	}
}

func TestDeliveredRefusals(t *testing.T) {
	now := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	aboard := Together{Aboard: true}
	watches := Together{Watches: true}
	adult := func(n byte) Speaker { return speaker(n, Adult) }
	cases := []struct {
		name  string
		setup func(r Rules, from, to *Speaker)
		t     Together
		want  bool
	}{
		{"aboard", func(Rules, *Speaker, *Speaker) {}, aboard, true},
		{"not together", func(Rules, *Speaker, *Speaker) {}, Together{}, false},
		{"to oneself", func(_ Rules, from, to *Speaker) { *to = *from }, aboard, false},
		{"chat off for everyone", func(r Rules, _, _ *Speaker) { r.Switches.SetChat(false) }, aboard, false},
		{"the sender's country off", func(r Rules, from, _ *Speaker) {
			r.Switches.SetChatCountries([]string{"br"})
			from.Country = "BR"
		}, aboard, false},
		{"the receiver's country off", func(r Rules, _, to *Speaker) {
			r.Switches.SetChatCountries([]string{"BR"})
			to.Country = "br"
		}, aboard, false},
		{"another country off", func(r Rules, from, _ *Speaker) {
			r.Switches.SetChatCountries([]string{"BR"})
			from.Country = "NZ"
		}, aboard, true},
		{"the sender muted from chat", func(_ Rules, from, _ *Speaker) { from.MutedUntil = now.Add(time.Hour) }, aboard, false},
		{"a mute from chat ended", func(_ Rules, from, _ *Speaker) { from.MutedUntil = now.Add(-time.Hour) }, aboard, true},
		{"the sender rested", func(_ Rules, from, _ *Speaker) { from.Rested = true }, aboard, false},
		{"the sender resting", func(_ Rules, from, _ *Speaker) { from.Resting = true }, aboard, false},
		{"the Rules not accepted", func(_ Rules, from, _ *Speaker) { from.Rules = false }, aboard, false},
		{"the receiver muted from chat still reads", func(_ Rules, _, to *Speaker) { to.MutedUntil = now.Add(time.Hour) }, aboard, true},
		{"the sender blocks the receiver", func(r Rules, from, to *Speaker) { r.Ties.SetBlock(from.Account, to.Account, true) }, aboard, false},
		{"the receiver blocks the sender", func(r Rules, from, to *Speaker) { r.Ties.SetBlock(to.Account, from.Account, true) }, aboard, false},
		{"the receiver mutes the sender", func(r Rules, from, to *Speaker) { r.Ties.SetMute(to.Account, from.Account, true) }, aboard, false},
		{"the sender mutes the receiver, who still reads", func(r Rules, from, to *Speaker) { r.Ties.SetMute(from.Account, to.Account, true) }, aboard, true},
		{"shipmates", func(Rules, *Speaker, *Speaker) {}, Together{Shipmates: true}, true},
		{"shipmates' messages off", func(r Rules, _, _ *Speaker) { r.Switches.SetShipmateMessages(false) }, Together{Shipmates: true}, false},
		{"shipmates' messages off aboard", func(r Rules, _, _ *Speaker) { r.Switches.SetShipmateMessages(false) }, aboard, true},
		{"a machine sailor to its owner", func(_ Rules, from, to *Speaker) {
			from.Machine, from.Human = true, to.Account
		}, aboard, true},
		{"a machine sailor to the boat's skipper's human", func(_ Rules, from, to *Speaker) {
			from.Machine, from.Human = true, [16]byte{9}
		}, Together{Aboard: true, BoatHuman: [16]byte{2}}, true},
		{"a machine sailor to another human", func(_ Rules, from, _ *Speaker) {
			from.Machine, from.Human = true, [16]byte{9}
		}, aboard, false},
		{"a human to another's machine sailor", func(_ Rules, _, to *Speaker) {
			to.Machine, to.Human = true, [16]byte{9}
		}, aboard, false},
		{"two machine sailors", func(_ Rules, from, to *Speaker) {
			from.Machine, from.Human = true, [16]byte{8}
			to.Machine, to.Human = true, [16]byte{9}
		}, aboard, true},
		{"a machine sailor to a spectator of its boat", func(_ Rules, from, _ *Speaker) {
			from.Machine, from.Human = true, [16]byte{9}
		}, watches, true},
		{"a person's line never to a spectator", func(Rules, *Speaker, *Speaker) {}, watches, false},
		{"a spectator says nothing to the machine sailors", func(_ Rules, _, to *Speaker) {
			to.Machine, to.Human = true, [16]byte{9}
		}, watches, false},
		{"a block between a spectator and the machine sailor's owner hides nothing", func(r Rules, from, to *Speaker) {
			from.Machine, from.Human = true, [16]byte{9}
			r.Ties.SetBlock([16]byte{9}, to.Account, true)
		}, watches, true},
		{"the spectator blocks the machine sailor", func(r Rules, from, to *Speaker) {
			from.Machine, from.Human = true, [16]byte{9}
			r.Ties.SetBlock(to.Account, from.Account, true)
		}, watches, false},
		{"the spectator mutes the machine sailor", func(r Rules, from, to *Speaker) {
			from.Machine, from.Human = true, [16]byte{9}
			r.Ties.SetMute(to.Account, from.Account, true)
		}, watches, false},
		{"a spectator's own chat off", func(_ Rules, from, to *Speaker) {
			from.Machine, from.Human = true, [16]byte{9}
			to.ChatSet, to.Chat = true, false
		}, watches, false},
		{"a spectator with chat off in their country", func(r Rules, from, to *Speaker) {
			from.Machine, from.Human = true, [16]byte{9}
			to.Country = "NZ"
			r.Switches.SetChatCountries([]string{"NZ"})
		}, watches, false},
		{"a block between their humans", func(r Rules, from, to *Speaker) {
			from.Machine, from.Human = true, [16]byte{8}
			to.Machine, to.Human = true, [16]byte{9}
			r.Ties.SetBlock([16]byte{9}, [16]byte{8}, true)
		}, aboard, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := Rules{Switches: NewSwitches(DefaultLifetime), Ties: NewTies(nil, nil)}
			from, to := adult(1), adult(2)
			c.setup(r, &from, &to)
			if got := r.Delivered(from, to, c.t, now); got != c.want {
				t.Errorf("Delivered = %v, want %v", got, c.want)
			}
		})
	}
}

func TestMayJoin(t *testing.T) {
	ann, bob := [16]byte{1}, [16]byte{2}
	person := func(h [16]byte) Member { return Member{Human: h} }
	machine := func(h [16]byte) Member { return Member{Machine: true, Human: h} }
	for _, c := range []struct {
		name    string
		company []Member
		joiner  Member
		want    bool
	}{
		{"a person aboard a person's boat", []Member{person(ann)}, person(bob), true},
		{"a machine sailor aboard a person's boat", []Member{person(ann)}, machine(ann), false},
		{"the owner aboard their machine sailor's boat", []Member{machine(ann)}, person(ann), true},
		{"another person aboard a machine sailor's boat", []Member{machine(ann)}, person(bob), false},
		{"another owner's machine sailor aboard a machine sailor's boat", []Member{machine(ann)}, machine(bob), true},
		{"the owner aboard, with their own second machine sailor let aboard", []Member{machine(ann), person(ann)}, machine(ann), true},
		{"the owner aboard, another owner's machine sailor refused", []Member{machine(ann), person(ann)}, machine(bob), false},
		{"another owner's machine sailor aboard, the skipper's owner refused", []Member{machine(ann), machine(bob)}, person(ann), false},
		{"only the owner's machine sailors aboard, the owner let aboard", []Member{machine(ann), machine(ann)}, person(ann), true},
		{"an owner not known", []Member{machine([16]byte{})}, person([16]byte{}), false},
		{"nobody aboard", nil, person(ann), false},
	} {
		if got := MayJoin(c.company, c.joiner); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

func TestSpectatorReads(t *testing.T) {
	for _, c := range []struct {
		machines []bool
		want     bool
	}{
		{[]bool{true, true}, true},
		{[]bool{true}, true},
		{[]bool{true, true, true}, true},
		{[]bool{true, false}, false},
		{[]bool{false, true, true}, false},
		{[]bool{false}, false},
		{nil, false},
	} {
		if got := SpectatorReads(c.machines); got != c.want {
			t.Errorf("SpectatorReads(%v) = %v, want %v", c.machines, got, c.want)
		}
	}
}

func TestMaySay(t *testing.T) {
	now := time.Now()
	r := Rules{Switches: NewSwitches(DefaultLifetime)}
	teen := speaker(1, Teen)
	if got := r.MaySay(teen, now); got != OwnOff {
		t.Errorf("a teen not opted in: %v, want OwnOff", got)
	}
	teen.ChatSet, teen.Chat = true, true
	if got := r.MaySay(teen, now); got != Speaks {
		t.Errorf("a teen opted in: %v, want Speaks", got)
	}
	teen.Rested = true
	if got := r.MaySay(teen, now); got != Silenced {
		t.Errorf("rested: %v, want Silenced", got)
	}
	r.Switches.SetChat(false)
	if got := r.MaySay(teen, now); got != ChatOff {
		t.Errorf("chat off: %v, want ChatOff", got)
	}
}

func TestCountries(t *testing.T) {
	got, ok := Countries([]string{"nz", " BR", "br", "x", "123"})
	if ok || len(got) != 2 || got[0] != "BR" || got[1] != "NZ" {
		t.Errorf("Countries = %v, %v", got, ok)
	}
}

func TestTiesForget(t *testing.T) {
	a, b, c := [16]byte{1}, [16]byte{2}, [16]byte{3}
	ties := NewTies([][2][16]byte{{a, b}, {c, a}}, [][2][16]byte{{b, a}})
	if !ties.Mutes(a, b) || !ties.Blocks(a, b) || !ties.Refuses(a, b) || ties.Blocked(a, b) || !ties.Blocked(b, a) {
		t.Fatal("ties not held")
	}
	ties.Forget(a)
	if ties.Mutes(a, b) || ties.Mutes(c, a) || ties.Blocks(a, b) {
		t.Error("a deleted account's ties kept")
	}
}

// TestMayBeShipmates: shipmates only within one band, adults or 13 to 17;
// nobody whose age is not known, or under 13.
func TestMayBeShipmates(t *testing.T) {
	bands := []Band{Unknown, Child, Teen, Adult}
	for _, a := range bands {
		for _, b := range bands {
			want := a == b && (a == Adult || a == Teen)
			if got := MayBeShipmates(a, b); got != want {
				t.Errorf("MayBeShipmates(%d, %d) = %v", a, b, got)
			}
		}
	}
}

// TestShipmatesTies: shipmates both ways at once, ended both ways, and
// forgotten with an account; a line between shipmates is delivered only
// with shipmates' messages on.
func TestShipmatesTies(t *testing.T) {
	ann, bob := [16]byte{1}, [16]byte{2}
	ties := NewTies(nil, nil)
	ties.SetShipmates(ann, bob, true)
	if !ties.Shipmates(ann, bob) || !ties.Shipmates(bob, ann) || len(ties.ShipmatesOf(bob)) != 1 {
		t.Fatal("not shipmates both ways")
	}
	sw := NewSwitches(DefaultLifetime)
	r := Rules{Switches: sw, Ties: ties}
	from := Speaker{Account: ann, Human: ann, Band: Adult, Rules: true}
	to := Speaker{Account: bob, Human: bob, Band: Adult, Rules: true}
	if !r.Delivered(from, to, Together{Shipmates: true}, time.Now()) {
		t.Fatal("a line between shipmates not delivered")
	}
	sw.SetShipmateMessages(false)
	if r.Delivered(from, to, Together{Shipmates: true}, time.Now()) {
		t.Fatal("a line between shipmates delivered with their messages off")
	}
	ties.Forget(bob)
	if ties.Shipmates(ann, bob) || len(ties.ShipmatesOf(ann)) != 0 {
		t.Fatal("a deleted account's shipmates kept")
	}
}
