// SPDX-License-Identifier: AGPL-3.0-only

package chat

import (
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// pairs is a door that keeps the messages handed to it.
type pairs struct{ got []bus.Account }

func (*pairs) Deliver(Line, uint32, uint64, []bus.Account) {}
func (p *pairs) DeliverPair(_ Line, to bus.Account)        { p.got = append(p.got, to) }
func (*pairs) Changed([]bus.Account)                       {}

func shipmatesHub(now *time.Time) (*Hub, *pairs, bus.Account, bus.Account) {
	ann, bob := bus.Account{1}, bus.Account{2}
	ties := aboard.NewTies(nil, nil)
	ties.SetShipmates(ann, bob, true)
	h := NewHub(nil, aboard.Rules{Switches: aboard.NewSwitches(aboard.DefaultLifetime), Ties: ties}, func() time.Time { return *now })
	out := &pairs{}
	h.AddOut(out)
	for _, a := range []bus.Account{ann, bob} {
		h.Join(aboard.Speaker{Account: a, Human: a, Band: aboard.Adult, Rules: true}, "")
	}
	return h, out, ann, bob
}

// TestSayTo: a message between shipmates is kept in their pair's ring and
// handed to the receiver; to someone appearing offline it is refused as
// away, unless they wrote to the sender within OfflineAnswers.
func TestSayTo(t *testing.T) {
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	h, out, ann, bob := shipmatesHub(&now)
	if s := h.SayTo(ann, bob, "ahoy"); s.Refused != NotRefused || s.Heard != 1 || len(out.got) != 1 || out.got[0] != bob {
		t.Fatalf("a message: %+v, handed %v", s, out.got)
	}
	if l := h.Rings.Lines(Pair(bob, ann), time.Time{}); len(l) != 1 || l[0].Text != "ahoy" {
		t.Fatalf("the pair's ring: %+v", l)
	}
	h.Update(bob, func(s *aboard.Speaker) { s.Offline = true })
	now = now.Add(3 * time.Second)
	if s := h.SayTo(ann, bob, "still there?"); s.Refused != RefusedAway {
		t.Fatalf("to someone offline who never wrote: %+v", s)
	}
	now = now.Add(3 * time.Second)
	h.SayTo(bob, ann, "yes")
	now = now.Add(3 * time.Second)
	if s := h.SayTo(ann, bob, "good"); s.Refused != NotRefused {
		t.Fatalf("to someone offline who wrote: %+v", s)
	}
	now = now.Add(OfflineAnswers)
	if s := h.SayTo(ann, bob, "gone?"); s.Refused != RefusedAway {
		t.Fatalf("to someone offline who wrote long ago: %+v", s)
	}
}

// BenchmarkSayTo is a message's cost between two shipmates: the rule, the
// limits (each message from a sender of its own), the filter and the ring.
func BenchmarkSayTo(b *testing.B) {
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	h, _, ann, bob := shipmatesHub(&now)
	text := "Fair winds from the western reach; shall I knock on your boat after the squall passes?"
	b.ReportAllocs()
	for i := range b.N {
		now = now.Add(3 * time.Second)
		from, to := ann, bob
		if i%2 == 1 {
			from, to = bob, ann
		}
		if s := h.SayTo(from, to, text); s.Refused != NotRefused {
			b.Fatalf("refused: %+v", s)
		}
	}
}
