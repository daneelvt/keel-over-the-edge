// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"fmt"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/chat"
)

// publicEdge is an edge with chat whose boat 1 is watched by n spectators,
// every one an adult in the hub, and a machine sailor of its company.
func publicEdge(n int) (*Edge, []*conn, bus.Account) {
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	hub := chat.NewHub(nil, aboard.Rules{Switches: aboard.NewSwitches(aboard.DefaultLifetime), Ties: aboard.NewTies(nil, nil)},
		func() time.Time { return now })
	e := &Edge{}
	e.cfg.Chat = hub
	e.registry.init()
	machine := bus.Account{0xff}
	hub.Join(aboard.Speaker{Account: machine, Human: bus.Account{0xfe}, Machine: true, Band: aboard.Adult, Rules: true}, "Iron Mary")
	conns := make([]*conn, n)
	for i := range conns {
		a := bus.Account{byte(i), byte(i >> 8), 1}
		hub.Join(aboard.Speaker{Account: a, Human: a, Band: aboard.Adult, Rules: true}, "")
		c := &conn{e: e, account: a, queue: make(chan outgoing, 4)}
		e.registry.claim(c)
		e.watchers.set(c, 1, true)
		conns[i] = c
	}
	return e, conns, machine
}

// TestDeliverPublic: a public line reaches every spectator of its boat,
// once, encoded once; a line not public, or a person's, reaches none.
func TestDeliverPublic(t *testing.T) {
	e, conns, machine := publicEdge(3)
	out := chatOut{e: e}
	l := chat.Line{ID: 7, From: machine, Name: "Iron Mary", Machine: true, At: time.Now(), Text: "Fair winds", Public: true}
	out.Deliver(l, 0, 1, nil)
	out.Deliver(chat.Line{ID: 8, From: machine, Machine: true, Text: "not public"}, 0, 1, nil)
	out.Deliver(chat.Line{ID: 9, From: conns[0].account, Text: "a person's", Public: true}, 0, 1, nil)
	out.Deliver(l, 0, 2, nil)
	var first []byte
	for i, c := range conns {
		if got := len(c.queue); got != 1 {
			t.Fatalf("spectator %d was sent %d lines", i, got)
		}
		o := <-c.queue
		if first == nil {
			first = o.b
		} else if &o.b[0] != &first[0] {
			t.Errorf("spectator %d's line was encoded again", i)
		}
		if !c.heardLine(7) || c.heardLine(8) || c.heardLine(9) {
			t.Errorf("spectator %d heard %v", i, c.chat.heard)
		}
	}
}

// BenchmarkDeliverPublic is a machine sailor's line handed to the
// spectators of its boat, up to the spectator limit.
func BenchmarkDeliverPublic(b *testing.B) {
	for _, n := range []int{1, 100, DefaultSpectatorLimit} {
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			e, conns, machine := publicEdge(n)
			out := chatOut{e: e}
			text := "Fair winds from the western reach; shall I knock on your boat after the squall passes?"
			b.ReportAllocs()
			id := uint64(0)
			for b.Loop() {
				id++
				out.Deliver(chat.Line{ID: id, From: machine, Name: "Iron Mary", Machine: true, At: time.Now(), Text: text, Public: true}, 1, 1, nil)
				b.StopTimer()
				for _, c := range conns {
					<-c.queue
				}
				b.StartTimer()
			}
		})
	}
}
