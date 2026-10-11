// SPDX-License-Identifier: AGPL-3.0-only

package store

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

// TestReachableWaitsForAListener: a refused connection is tried again
// until something listens; what answers then is not PostgreSQL, which is
// returned at once rather than waited out.
func TestReachableWaitsForAListener(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	go func() {
		time.Sleep(300 * time.Millisecond)
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			return
		}
		defer ln.Close()
		c, err := ln.Accept()
		if err == nil {
			c.Write([]byte("not postgres\n"))
			c.Close()
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	err = Reachable(ctx, "postgres://keel@"+addr+"/keel?sslmode=disable&connect_timeout=2")
	if err == nil {
		t.Fatal("something that is not PostgreSQL was taken for it")
	}
	if took := time.Since(start); took < 250*time.Millisecond || took > 5*time.Second {
		t.Errorf("it gave up after %v: %v", took, err)
	}
	if strings.Contains(err.Error(), "did not answer") {
		t.Errorf("an answer that was not PostgreSQL's was waited out: %v", err)
	}
}

func TestReachableGivesUp(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	ln.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	if err := Reachable(ctx, "postgres://keel@"+addr+"/keel?sslmode=disable"); err == nil || !strings.Contains(err.Error(), "did not answer") {
		t.Fatalf("nothing listening: %v", err)
	}
	if err := Reachable(context.Background(), "postgres://keel@[::1/keel"); err == nil {
		t.Fatal("a URL pgx cannot read was accepted")
	}
}
