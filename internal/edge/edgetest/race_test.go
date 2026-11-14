// SPDX-License-Identifier: AGPL-3.0-only

package edgetest

import (
	"context"
	"testing"
	"testing/synctest"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/aboard"
	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/client"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// raceCode is the link's code of the race the tests run.
const raceCode = "abcdefghij"

// raceID is its ID.
var raceID = [16]byte{0x40, 7}

// raceServer is a server whose world runs races in a racing area 600 m
// north of the centre; its sailors' age bands are by their accounts'
// months of birth, an adult's if none.
func raceServer(t *testing.T) *Server {
	t.Helper()
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	st := &committee.Stage{Areas: []committee.Area{{Number: 1, X: 0, Y: 600, Radius: 450}}}
	for i := range cat.Boats {
		st.Kinds = append(st.Kinds, committee.Kind{Polar: cat.Polar(i), Length: cat.Boats[i].LengthOverall})
	}
	var srv *Server
	srv = NewServer(t, Config{Races: st,
		RaceOf: func(_ context.Context, code string) ([16]byte, error) {
			if code != raceCode {
				return [16]byte{}, store.ErrNotFound
			}
			return raceID, nil
		},
		Talker: func(ctx context.Context, a bus.Account) (aboard.Speaker, string, error) {
			acc, err := srv.Sessions.Accounts(ctx, []store.AccountID{store.AccountID(a)})
			if err != nil {
				return aboard.Speaker{}, "", err
			}
			b, _ := aboard.BornOf(bornOf(acc[store.AccountID(a)]))
			return aboard.Speaker{Account: a, Human: a, Band: aboard.BandOf(b, time.Now())}, "", nil
		},
	})
	return srv
}

// placeRace places a race of the entrants' boats, in order, on the
// area's line: its key.
func placeRace(t *testing.T, srv *Server, entrants ...bus.RaceEntrant) uint32 {
	t.Helper()
	f := srv.World.Bus().Frames.Acquire()
	tick := f.Tick
	f.Release()
	call := &bus.RaceCall{ID: raceID, Course: 1, Start: tick + committee.Warning + 30, Entrants: entrants}
	if err := srv.World.Bus().Commands.Server().TrySend(bus.Command{Op: bus.RacePlace, Race: call}); err != nil {
		t.Fatal(err)
	}
	for range 30 {
		time.Sleep(100 * time.Millisecond)
		f := srv.World.Bus().Frames.Acquire()
		n, key := len(f.Racers), uint32(0)
		if len(f.Races) > 0 {
			key = f.Races[0].Key
		}
		f.Release()
		if n == len(entrants) {
			return key
		}
	}
	t.Fatal("the race was not placed")
	return 0
}

// racerOf is the race's boat of number n as the world has it.
func racerOf(srv *Server, n int16) bus.Racer {
	f := srv.World.Bus().Frames.Acquire()
	defer f.Release()
	for _, rc := range f.Racers {
		if rc.Number == n {
			return rc
		}
	}
	return bus.Racer{}
}

// raceWatch asks to watch a race's boat.
func raceWatch(race uint32, code string, number uint32) *pb.ClientMessage {
	return &pb.ClientMessage{Body: &pb.ClientMessage_Command{Command: &pb.Command{Body: &pb.Command_Watch{Watch: &pb.Watch{
		Race: race, Code: code, Number: number}}}}}
}

// raceViewer reads a spectator's race's messages as they come.
type raceViewer struct {
	*viewer
	pictures []*pb.RacePicture
	cheered  []*pb.RaceCheered
}

func (v *raceViewer) read(d time.Duration, done func() bool) bool {
	v.t.Helper()
	timeout := time.After(d)
	for done == nil || !done() {
		select {
		case r, ok := <-v.in.C:
			if !ok {
				v.closed = true
				return done != nil && done()
			}
			if r.Message != nil {
				switch m := r.Message.Body.(type) {
				case *pb.ServerMessage_RacePicture:
					v.pictures = append(v.pictures, m.RacePicture)
				case *pb.ServerMessage_RaceCheered:
					v.cheered = append(v.cheered, m.RaceCheered)
				}
			}
			v.take(r)
		case <-timeout:
			return done == nil
		}
	}
	return true
}

func (v *raceViewer) welcomed() *pb.Welcome {
	v.t.Helper()
	v.welcome = nil
	if !v.read(5*time.Second, func() bool { return v.welcome != nil && v.snaps > 0 }) {
		v.t.Fatalf("no Welcome and snapshot (ended %v, closed %v)", v.ended, v.closed)
	}
	return v.welcome
}

func (v *raceViewer) endedWith() pb.WatchEnd {
	v.t.Helper()
	v.ended = nil
	if !v.read(5*time.Second, func() bool { return v.ended != nil }) {
		v.t.Fatalf("no WatchEnded (closed %v)", v.closed)
	}
	return v.ended.GetWhy()
}

// eye reads until a race picture comes, and returns the number it says
// the connection watches.
func (v *raceViewer) eye() uint32 {
	v.t.Helper()
	n := len(v.pictures)
	if !v.read(5*time.Second, func() bool { return len(v.pictures) > n }) {
		v.t.Fatal("no race picture")
	}
	return v.pictures[len(v.pictures)-1].GetEye()
}

// lined is where the i-th boat waits before the race, near its area.
func lined(i int) physics.State {
	return physics.State{X: -200 + 40*float64(i), Y: 300, Heading: 1}
}

// TestWatchingARace: a spectator opens the game connection to watch a race
// by its link's code and is given the boat the edge chooses (before the
// start, the first entered), then switches through every boat of the
// fleet by its race number, one a second; a human who does not allow
// spectators is watched while racing, her name not told, and no longer
// once she has retired.
func TestWatchingARace(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := raceServer(t)
		_, ann := srv.Sailor("Ann Bonny")
		_, owner := srv.Sailor("Dee")
		token, _ := srv.Sailor("Cid")
		srv.Launch(t, ann, false, lined(0))
		entrants := []bus.RaceEntrant{{Account: bus.Account(ann), Number: 1}}
		for i, name := range []string{"Iron Mary", "Tin Tom", "Grey Gull", "Saltwind"} {
			m, _ := srv.Machine(t, name, owner, lined(i+1))
			entrants = append(entrants, bus.RaceEntrant{Account: bus.Account(m), Number: int16(i + 2), Machine: true})
		}
		key := placeRace(t, srv, entrants...)
		hello := client.Hello()
		hello.GetHello().RaceWatch = &pb.Watch{Code: raceCode}
		v := &raceViewer{viewer: dial(t, srv, token, hello)}
		w := v.welcomed()
		if first := racerOf(srv, 1); w.GetBoat() != first.Boat || w.GetWatching().GetSailor() != "" || w.GetWatching().GetMachine() {
			t.Fatalf("the link's Welcome: %v, want the first entered's boat %d, unnamed", w, first.Boat)
		}
		if n := v.eye(); n != 1 {
			t.Fatalf("the picture says the eye is %d", n)
		}
		// Through the fleet and back to the first.
		for _, n := range []uint32{2, 3, 4, 5, 1} {
			time.Sleep(time.Second)
			v.send(raceWatch(key, "", n))
			w := v.welcomed()
			if rc := racerOf(srv, int16(n)); w.GetBoat() != rc.Boat {
				t.Fatalf("number %d: watching boat %d, not %d", n, w.GetBoat(), rc.Boat)
			}
			if machine := n > 1; w.GetWatching().GetMachine() != machine || machine && w.GetWatching().GetSailor() == "" {
				t.Errorf("number %d: watching %v", n, w.GetWatching())
			}
			if e := v.eye(); e != n {
				t.Errorf("number %d: the picture's eye is %d", n, e)
			}
		}
		// Every boat on the line wears her race number: the one watched,
		// and those in view, told afresh after each Welcome.
		numbered := func() bool {
			n := 0
			for _, p := range v.prizes {
				if p.GetNumber() > 1 {
					n++
				}
			}
			return v.own.GetNumber() == 1 && n == 4
		}
		if !v.read(2*time.Second, numbered) {
			t.Errorf("race numbers: own %v, in view %v", v.own, v.prizes)
		}
		// A switch within the second of the last is refused.
		time.Sleep(time.Second)
		v.send(raceWatch(key, "", 2))
		v.send(raceWatch(key, "", 3))
		if why := v.endedWith(); why != pb.WatchEnd_WATCH_END_QUICK || v.ended.GetSailor() != "" {
			t.Errorf("a switch too soon: %v", v.ended)
		}
		// No such boat, no such race.
		time.Sleep(time.Second)
		v.send(raceWatch(key, "", 9))
		if why := v.endedWith(); why != pb.WatchEnd_WATCH_END_NO_RACE {
			t.Errorf("no such boat: %v", why)
		}
		time.Sleep(time.Second)
		v.send(raceWatch(0, "bcdefghijk", 0))
		if why := v.endedWith(); why != pb.WatchEnd_WATCH_END_NO_RACE {
			t.Errorf("no such race: %v", why)
		}
		// Ann retires: out of the race, her watch ends, and she is
		// watchable no longer, by her number or her name.
		time.Sleep(time.Second)
		v.send(raceWatch(key, "", 1))
		v.welcomed()
		if err := srv.World.Bus().Commands.Players().TrySend(bus.Command{Op: bus.RaceRetire, Account: bus.Account(ann)}); err != nil {
			t.Fatal(err)
		}
		if why := v.endedWith(); why != pb.WatchEnd_WATCH_END_OFF || v.ended.GetSailor() != "" {
			t.Errorf("Ann retired: %v", v.ended)
		}
		time.Sleep(time.Second)
		v.send(raceWatch(key, "", 1))
		if why := v.endedWith(); why != pb.WatchEnd_WATCH_END_NO_RACE {
			t.Errorf("Ann retired, by number: %v", why)
		}
		time.Sleep(time.Second)
		v.send(client.Watch("Ann Bonny"))
		if why := v.endedWith(); why != pb.WatchEnd_WATCH_END_CANNOT {
			t.Errorf("Ann retired, by name: %v", why)
		}
	})
}

// TestTeenRacing: a teen's racing boat is refused to an adult who asks
// for it by its race, the refusal naming nobody, and watched by a teen.
func TestTeenRacing(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := raceServer(t)
		// Fifteen and sixteen, by the bubble's clock.
		year := int32(time.Now().Year())
		_, kit := srv.Sessions.add(store.Account{Kind: store.Human, Name: "Kit", Born: (year-15)*100 + 1})
		teenToken, _ := srv.Sessions.add(store.Account{Kind: store.Human, Name: "Lu", Born: (year-16)*100 + 1})
		adultToken, _ := srv.Sailor("Max")
		srv.Launch(t, kit, false, lined(0))
		key := placeRace(t, srv, bus.RaceEntrant{Account: bus.Account(kit), Number: 1})
		adult := &raceViewer{viewer: dial(t, srv, adultToken, client.Hello())}
		adult.welcomed()
		time.Sleep(time.Second)
		adult.send(raceWatch(key, "", 1))
		if why := adult.endedWith(); why != pb.WatchEnd_WATCH_END_CANNOT || adult.ended.GetSailor() != "" {
			t.Errorf("an adult asking for a teen's racing boat: %v", adult.ended)
		}
		teen := &raceViewer{viewer: dial(t, srv, teenToken, client.Hello())}
		teen.welcomed()
		time.Sleep(time.Second)
		teen.send(raceWatch(key, "", 1))
		if w := teen.welcomed(); w.GetBoat() != racerOf(srv, 1).Boat {
			t.Errorf("a teen watching a teen's racing boat: %v", w)
		}
	})
}

// TestCheers: a spectator's cheers count one every ten seconds, gathered
// every two: told to the spectator, theirs, with the crowd's size, and to
// the boat's racer, and added to the racer's cheers in the world.
func TestCheers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		srv := raceServer(t)
		annToken, ann := srv.Sailor("Ann Bonny")
		token, _ := srv.Sailor("Cid")
		token2, _ := srv.Sailor("Dee")
		racer := &raceViewer{viewer: dial(t, srv, annToken, client.Hello())}
		racer.welcomed()
		key := placeRace(t, srv, bus.RaceEntrant{Account: bus.Account(ann), Number: 1})
		cheer := &pb.ClientMessage{Body: &pb.ClientMessage_Command{Command: &pb.Command{Body: &pb.Command_Cheer{Cheer: &pb.Cheer{}}}}}
		var crowd []*raceViewer
		for _, tk := range []string{token, token2} {
			v := &raceViewer{viewer: dial(t, srv, tk, client.Hello())}
			v.welcomed()
			time.Sleep(time.Second)
			v.send(raceWatch(key, "", 1))
			v.welcomed()
			crowd = append(crowd, v)
		}
		v, w := crowd[0], crowd[1]
		// Three cheers in a breath count one; the other's counts too.
		for range 3 {
			v.send(cheer)
		}
		w.send(cheer)
		if !v.read(5*time.Second, func() bool { return len(v.cheered) > 0 }) {
			t.Fatal("no cheers told")
		}
		if c := v.cheered[0]; c.GetRace() != key || c.GetNumber() != 1 || c.GetCount() != 2 || c.GetCrowd() != 2 || !c.GetMine() {
			t.Errorf("the spectator told %v", c)
		}
		if !racer.read(5*time.Second, func() bool { return len(racer.cheered) > 0 }) {
			t.Fatal("the racer was told no cheers")
		}
		if c := racer.cheered[0]; c.GetCount() != 2 || c.GetMine() {
			t.Errorf("the racer told %v", c)
		}
		time.Sleep(100 * time.Millisecond)
		if n := racerOf(srv, 1).Cheers; n != 2 {
			t.Fatalf("the world counts %d cheers", n)
		}
		// Within the ten seconds: nothing more.
		time.Sleep(4 * time.Second)
		v.send(cheer)
		time.Sleep(3 * time.Second)
		if n := racerOf(srv, 1).Cheers; n != 2 {
			t.Errorf("a cheer within ten seconds counted: %d", n)
		}
		// After them: one more, the crowd still two within the last ten.
		time.Sleep(4 * time.Second)
		v.cheered = nil
		v.send(cheer)
		if !v.read(5*time.Second, func() bool { return len(v.cheered) > 0 }) {
			t.Fatal("no second cheer told")
		}
		if c := v.cheered[0]; c.GetCount() != 1 || !c.GetMine() {
			t.Errorf("the second cheer told %v", c)
		}
		time.Sleep(100 * time.Millisecond)
		if n := racerOf(srv, 1).Cheers; n != 3 {
			t.Errorf("the world counts %d cheers", n)
		}
	})
}
