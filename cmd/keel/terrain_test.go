// SPDX-License-Identifier: AGPL-3.0-only

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/api"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/replay"
	"github.com/daneelvt/keel-over-the-edge/internal/worldgen"
)

// slowWorld is a generator that takes d of the bubble's time to make an
// empty world, counting its calls and noting the seed of the last.
type slowWorld struct {
	d     time.Duration
	calls atomic.Int32
	seed  atomic.Uint64
}

func (g *slowWorld) make(seed uint64) (*worldgen.Bundle, error) {
	g.calls.Add(1)
	g.seed.Store(seed)
	time.Sleep(g.d)
	return worldgen.Empty(seed), nil
}

// TestTerrainAtFirstStart: a world with no terrain gets one as the server
// starts, from KEEL_WORLD_SEED, the heartbeat beating and the server not
// ready meanwhile; the next start reads it back and makes none.
func TestTerrainAtFirstStart(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		d := &memDB{epoch: bubbleEpoch}
		gen := &slowWorld{d: time.Minute}
		s := startServer(t, map[string]string{"KEEL_WORLD_SEED": "42"}, newMemNet(), d.with(serveOptions{generate: gen.make}))
		time.Sleep(20 * time.Second)
		synctest.Wait()
		if code, body, _ := get(t, s.client, internalURL+"/readyz"); code != 503 || !strings.Contains(body, "terrain") {
			t.Fatalf("/readyz %d %q while the terrain is made", code, body)
		}
		// Past the liveness probe's 30 s: the heartbeat beats on.
		time.Sleep(25 * time.Second)
		synctest.Wait()
		if code, body, _ := get(t, s.client, internalURL+"/livez"); code != 200 {
			t.Fatalf("/livez %d %q 45 s into making the terrain", code, body)
		}
		time.Sleep(20 * time.Second)
		synctest.Wait()
		if code, body, _ := get(t, s.client, internalURL+"/readyz"); code != 200 {
			t.Fatalf("/readyz %d %q once the terrain is made", code, body)
		}
		s.stop(t)
		if gen.calls.Load() != 1 || gen.seed.Load() != 42 {
			t.Fatalf("the generator was called %d times, last with seed %d", gen.calls.Load(), gen.seed.Load())
		}
		if d.bundle == nil || d.bundle.Seed != 42 {
			t.Fatalf("the stored bundle is %+v", d.bundle)
		}
		for _, want := range []string{"the world has no terrain: making it", "the world's terrain is made", "the world's terrain is loaded"} {
			if !strings.Contains(s.logs.String(), want) {
				t.Errorf("the logs lack %q", want)
			}
		}

		// The next start makes nothing.
		again := &slowWorld{}
		s = startServer(t, map[string]string{"KEEL_WORLD_SEED": "7"}, newMemNet(), d.with(serveOptions{generate: again.make}))
		time.Sleep(2 * time.Second)
		synctest.Wait()
		if code, _, _ := get(t, s.client, internalURL+"/readyz"); code != 200 {
			t.Fatal("the second start is not ready")
		}
		s.stop(t)
		if again.calls.Load() != 0 {
			t.Fatalf("the second start made the terrain again")
		}
		if d.bundle.Seed != 42 {
			t.Fatalf("the world's seed is now %d", d.bundle.Seed)
		}
	})
}

// TestTerrainOnceForTwo: two servers starting at once on one database make
// the world's terrain once: the one with the lease makes it, the other
// reads it when its turn comes.
func TestTerrainOnceForTwo(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		d := &memDB{epoch: bubbleEpoch}
		gen := &slowWorld{d: 10 * time.Second}
		first := startServer(t, map[string]string{}, newMemNet(), d.with(serveOptions{generate: gen.make}))
		second := startServer(t, map[string]string{}, newMemNet(), d.with(serveOptions{generate: gen.make}))
		time.Sleep(20 * time.Second)
		synctest.Wait()
		first.stop(t)
		time.Sleep(5 * time.Second)
		synctest.Wait()
		second.stop(t)
		if gen.calls.Load() != 1 {
			t.Fatalf("the terrain was made %d times", gen.calls.Load())
		}
	})
}

// TestLandOff: with KEEL_LAND=off the terrain is made and loaded, and the
// world sails as open sea.
func TestLandOff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		d := &memDB{epoch: bubbleEpoch}
		s := startServer(t, map[string]string{"KEEL_LAND": "off"}, newMemNet(), d.with(serveOptions{}))
		time.Sleep(2 * time.Second)
		synctest.Wait()
		s.stop(t)
		logs := s.logs.String()
		for _, want := range []string{"the world's terrain is loaded", "land is off"} {
			if !strings.Contains(logs, want) {
				t.Errorf("the logs lack %q", want)
			}
		}
		if d.bundle == nil {
			t.Error("no terrain was stored")
		}
	})
}

func TestWorldgenCommand(t *testing.T) {
	if testing.Short() {
		t.Skip("makes a whole world")
	}
	out := filepath.Join(t.TempDir(), "world.bundle")
	var stdout, stderr bytes.Buffer
	if status := run(context.Background(), []string{"worldgen", "-seed", "3", "-out", out}, env(nil), &stdout, &stderr); status != 0 {
		t.Fatalf("status %d: %s", status, stderr.String())
	}
	for _, want := range []string{"seed 3, generator", "Port Royal:", "pass  names"} {
		if !strings.Contains(stdout.String(), want) {
			t.Errorf("the summary lacks %q:\n%s", want, stdout.String())
		}
	}
	data, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	b, err := worldgen.ReadFile(data)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), b.DigestHex()) {
		t.Error("the summary's digest is not the file's")
	}
	// The replay makes the same terrain again from the seed, and refuses a
	// log of another generator unless the bundle is given.
	cat, _ := catalog.Load()
	h := replay.Header{Seed: 3, Generator: worldgen.Version, Terrain: b.Digest}
	if _, terrain, err := replayTerrain(h, cat, ""); err != nil || terrain == nil {
		t.Fatalf("the terrain made again: %v", err)
	}
	h.Generator++
	if _, _, err := replayTerrain(h, cat, ""); !errors.Is(err, errTerrain) {
		t.Fatalf("a log of another generator: %v", err)
	}
	if _, _, err := replayTerrain(h, cat, out); err != nil {
		t.Fatalf("a log of another generator, its bundle given: %v", err)
	}
	h.Terrain[0]++
	if _, _, err := replayTerrain(h, cat, out); !errors.Is(err, errTerrain) {
		t.Fatalf("a bundle of another digest: %v", err)
	}
	if status := run(context.Background(), []string{"worldgen", "-seed", "x"}, env(nil), &stdout, &stderr); status != 2 {
		t.Errorf("a seed that is not a number: status %d", status)
	}
}

// TestChunkKey: a world's terrain is stored with a chunk key of its own;
// one stored without, as before keys, gets one at its next start, once,
// from the process that holds the lease; the key is never logged; and the
// chunks are served at the addresses it signs.
func TestChunkKey(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		d := &memDB{epoch: bubbleEpoch}
		s := startServer(t, map[string]string{}, newMemNet(), d.with(serveOptions{}))
		time.Sleep(2 * time.Second)
		synctest.Wait()
		key := d.bundle.ChunkKey
		if len(key) != 32 {
			t.Fatalf("the stored bundle's chunk key is %x", key)
		}
		// Served at the address the key signs, and nowhere else.
		path := api.ChunkPath(key, [16]byte{}, 136)
		if code, body, h := get(t, s.client, playURL+path); code != 200 || body != string(d.bundle.Chunks[136]) ||
			h.Get("Cache-Control") != "public, max-age=31536000, immutable" {
			t.Errorf("GET %s: %d, %d bytes, %q", path, code, len(body), h.Get("Cache-Control"))
		}
		other := api.ChunkPath(bytes.Repeat([]byte{1}, 32), [16]byte{}, 136)
		if code, _, _ := get(t, s.client, playURL+other); code != 404 {
			t.Errorf("an address of another key: %d", code)
		}
		s.stop(t)
		noKeyIn(t, s.logs.String(), key)

		// A bundle stored without a key gets one at the next start, and
		// keeps it after.
		d.bundle.ChunkKey = nil
		first := startServer(t, map[string]string{}, newMemNet(), d.with(serveOptions{}))
		second := startServer(t, map[string]string{}, newMemNet(), d.with(serveOptions{}))
		time.Sleep(2 * time.Second)
		synctest.Wait()
		made := d.bundle.ChunkKey
		if len(made) != 32 || bytes.Equal(made, key) {
			t.Fatalf("the bundle's new key is %x", made)
		}
		first.stop(t)
		time.Sleep(5 * time.Second)
		synctest.Wait()
		second.stop(t)
		if !bytes.Equal(d.bundle.ChunkKey, made) {
			t.Errorf("the key changed when the second process took the world")
		}
		if n := strings.Count(first.logs.String()+second.logs.String(), "it has one now"); n != 1 {
			t.Errorf("a key was made %d times", n)
		}
		noKeyIn(t, first.logs.String()+second.logs.String(), made)
	})
}

// noKeyIn fails the test if the logs hold the key, in any of the ways it
// might be written.
func noKeyIn(t *testing.T, logs string, key []byte) {
	t.Helper()
	for _, form := range []string{string(key), hex.EncodeToString(key), base64.StdEncoding.EncodeToString(key),
		base64.RawURLEncoding.EncodeToString(key), fmt.Sprint(key)} {
		if strings.Contains(logs, form) {
			t.Errorf("the logs hold the chunk key, as %q", form)
		}
	}
}

// TestNoChunksWithLandOff: with KEEL_LAND=off no chunk is served.
func TestNoChunksWithLandOff(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		d := &memDB{epoch: bubbleEpoch}
		s := startServer(t, map[string]string{"KEEL_LAND": "off"}, newMemNet(), d.with(serveOptions{}))
		time.Sleep(2 * time.Second)
		synctest.Wait()
		path := api.ChunkPath(d.bundle.ChunkKey, [16]byte{}, 136)
		if code, _, _ := get(t, s.client, playURL+path); code != 404 {
			t.Errorf("a chunk with land off: %d", code)
		}
		s.stop(t)
	})
}
