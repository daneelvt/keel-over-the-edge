// SPDX-License-Identifier: AGPL-3.0-only

package edge

import (
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
	"github.com/daneelvt/keel-over-the-edge/internal/physics"
	"github.com/daneelvt/keel-over-the-edge/internal/protocol/pb"
	"github.com/daneelvt/keel-over-the-edge/internal/race/committee"
)

// raceFrame is a frame of a race of two boats under way on a buoy course.
func raceFrame(t *testing.T) *bus.Frame {
	t.Helper()
	f := bus.NewFrame(4)
	f.Tick = 9000
	for s := range 2 {
		f.Occupied[s] = true
		f.Live = append(f.Live, int32(s))
		f.Boat[s] = uint64(s + 1)
		f.Owner[s] = bus.Account{byte(s + 1)}
		f.BoatName[s] = []string{"Gull", "Tern"}[s]
		f.State[s] = physics.State{X: float64(10 * s), Y: -300, Heading: 1}
	}
	st := &committee.Stage{Areas: []committee.Area{{Number: 1, Radius: 450}}, Kinds: []committee.Kind{{Length: 4}}}
	call := &bus.RaceCall{ID: [16]byte{1}, Course: 1, Start: f.Tick + committee.Warning,
		Entrants: []bus.RaceEntrant{{Account: bus.Account{1}, Number: 1}, {Account: bus.Account{2}, Number: 2, Machine: true}}}
	c := st.Lay(f, call, 5, 0, 2)
	committee.Begin(f, call, c, []committee.Placing{{Slot: 0, Boat: 1, Placed: true}, {Slot: 1, Boat: 2, Placed: true}})
	return f
}

func TestRaceTold(t *testing.T) {
	f := raceFrame(t)
	m := raceTold(f, 0, bus.Account{2}, []string{"Ann", ""}).GetRaceTold()
	if m.Race != 1 || len(m.Line) != 4 || len(m.Finish) != 4 || len(m.Marks) != 1 || len(m.Legs) != 3 || len(m.Way) != 6 ||
		m.Start != f.Races[0].Start || m.Expected <= 0 {
		t.Fatalf("told %+v", m)
	}
	e := m.Entrants
	if len(e) != 2 || e[0].Name != "Ann" || e[0].Boat != "Gull" || e[0].Me || e[1].Name != "" || !e[1].Machine || !e[1].Me {
		t.Errorf("entrants %+v", e)
	}
}

func TestRacePicture(t *testing.T) {
	f := raceFrame(t)
	f.Racers[1].ToGo, f.Racers[0].ToGo = 500, 600
	m := racePicture(f, 0).GetRacePicture()
	if len(m.Racers) != 2 || m.Racers[0].Number != 2 || m.Racers[0].Place != 1 || m.Racers[1].Place != 2 || m.Racers[1].Gap == 0 ||
		m.Racers[0].State != pb.RacerState_RACER_STATE_PLACED || m.Racers[1].North != -300 {
		t.Errorf("picture %+v", m.Racers)
	}
}

func TestRaceEvents(t *testing.T) {
	f := raceFrame(t)
	signal, kind := raceEvent(f, &f.RaceEvents[1])
	if s := signal.GetRaceSignal(); kind != outRaceSignal || s.Signal != pb.RaceSignalKind_RACE_SIGNAL_KIND_WARNING || !s.Gun {
		t.Errorf("the warning: %+v", s)
	}
	call, _ := raceEvent(f, &bus.RaceEvent{Race: 1, Kind: bus.RaceCalled, Number: 2, Other: 1, Article: physics.Article10, Added: 10})
	if c := call.GetRaceCall(); c.Kind != pb.RaceCallKind_RACE_CALL_KIND_BUMP || c.Article != "10" || c.Added != 10 || c.Number != 2 {
		t.Errorf("a call: %+v", c)
	}
	if m, _ := raceEvent(f, &bus.RaceEvent{Race: 1, Kind: bus.RacePlaced}); m != nil {
		t.Error("the placing sent as an event")
	}
	f.Races[0].Phase = bus.RaceEnded
	f.Racers[0].State, f.Racers[0].Place, f.Racers[0].Home = bus.RacerFinished, 1, f.Races[0].Start+300*committee.Second
	f.Racers[1].State, f.Racers[1].Place, f.Racers[1].Awards = bus.RacerPlacedAtEnd, 2, bus.AwardSpoon
	res, kind := raceEvent(f, &bus.RaceEvent{Race: 1, Kind: bus.RaceOver})
	r := res.GetRaceResults()
	if kind != outRaceResults || len(r.Results) != 2 || r.Results[0].ElapsedMs != 300000 || r.Results[0].How != "finished" ||
		r.Results[1].How != "placed" || len(r.Results[1].Awards) != 1 {
		t.Errorf("results %+v", r)
	}
}
