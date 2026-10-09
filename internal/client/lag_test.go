// SPDX-License-Identifier: AGPL-3.0-only

package client

import (
	"io"
	"math"
	"net"
	"testing"
	"testing/synctest"
	"time"
)

func TestParseLag(t *testing.T) {
	l, err := ParseLag("200ms,2%")
	if err != nil || l.Delay != 100*time.Millisecond || l.Loss != 0.02 || l.String() != "200ms,2%" {
		t.Fatalf("%+v, %v", l, err)
	}
	for _, bad := range []string{"", "fast", "200ms,x", "200ms,100%", "-1s"} {
		if _, err := ParseLag(bad); err == nil {
			t.Errorf("%q read", bad)
		}
	}
}

// TestLagLine: chunks keep their order, a lost chunk holds up those behind
// it, a seed repeats a run, and the delays are as the model says.
func TestLagLine(t *testing.T) {
	lag := Lag{Delay: 100 * time.Millisecond, Loss: 0.02, Seed: 9}
	a, b := lag.NewLine(1), lag.NewLine(1)
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	const n = 200_000
	var held, retransmitted, blocked int
	var last time.Time
	for i := range n {
		// A chunk every 10 ms: a lost one holds up those for 400 ms after.
		now := start.Add(time.Duration(i) * 10 * time.Millisecond)
		at := a.Hold(now)
		if at != b.Hold(now) {
			t.Fatal("one seed, two runs")
		}
		if at.Before(last) {
			t.Fatal("a chunk overtook the one before it")
		}
		switch d := at.Sub(now); {
		case d < lag.Delay:
			t.Fatalf("a chunk took %v", d)
		case d >= lag.Delay+4*lag.Delay+Retransmission && at != last:
			retransmitted++
		case d >= lag.Delay+4*lag.Delay && at != last:
			held++
		case at == last:
			blocked++
		}
		last = at
	}
	if p := float64(held+retransmitted) / n; math.Abs(p-0.02) > 0.002 {
		t.Errorf("%.4f of chunks lost, want 0.02", p)
	}
	if p := float64(retransmitted) / n; p < 0.0002 || p > 0.0007 {
		t.Errorf("%.5f of chunks lost twice, want 0.0004", p)
	}
	if blocked == 0 {
		t.Error("no chunk was held up behind a lost one")
	}
}

// TestLagConn: bytes written through the model arrive after its delay, in
// order, and closing sends what was written first.
func TestLagConn(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		client, server := net.Pipe()
		c := Lag{Delay: 50 * time.Millisecond}.Wrap(client)
		go func() {
			for i := range 10 {
				c.Write([]byte{byte(i)})
			}
			c.Close()
		}()
		start := time.Now()
		got, err := io.ReadAll(server)
		if err != nil || string(got) != "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09" {
			t.Fatalf("%v, %v", got, err)
		}
		if d := time.Since(start); d != 50*time.Millisecond {
			t.Fatalf("arrived after %v", d)
		}
	})
}

// TestProxy: bytes through the proxy, on real loopback sockets, arrive in
// order after the delay.
func TestProxy(t *testing.T) {
	back, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer back.Close()
	go func() {
		c, err := back.Accept()
		if err != nil {
			return
		}
		defer c.Close()
		io.Copy(c, c) // an echo
	}()
	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go Proxy(t.Context(), front, back.Addr().String(), Lag{Delay: 20 * time.Millisecond, Seed: 1})
	c, err := net.Dial("tcp", front.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	start := time.Now()
	c.Write([]byte("keel"))
	buf := make([]byte, 4)
	if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "keel" {
		t.Fatalf("%q, %v", buf, err)
	}
	if d := time.Since(start); d < 40*time.Millisecond {
		t.Fatalf("an echo through 20 ms each way took %v", d)
	}
}
