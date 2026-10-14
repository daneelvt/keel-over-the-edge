// SPDX-License-Identifier: AGPL-3.0-only

package physics

import (
	"math"
	"testing"
)

// The articles' recorded situations, testdata/articles.json.
type situationBoat struct {
	X, Y       float64
	Heading    float64
	Heel       float64
	Boom       float64
	SailorMode float64 `json:"sailorMode"`
	WindFrom   float64 `json:"windFrom"`
	Tack       float64
	Tacking    float64
	Settled    float64
	Course     float64
}

type situation struct {
	Name        string
	Case        int
	Rule        string
	Description string
	Boats       [2]situationBoat
	Since       float64
	By          string
	Expect      struct {
		Keeper       string
		Article      string
		Fault        string
		FaultArticle string `json:"faultArticle"`
	}
}

var whichNames = map[string]float64{"neither": Neither, "first": First, "second": Second}

var articleNames = map[string]float64{
	"10": Article10, "11": Article11, "12": Article12, "13": Article13,
	"15": Article15, "16.1": Article16, "22": Article22,
}

// encounterOf is a situation as the Articles read it.
func encounterOf(sit *situation) Encounter {
	var e Encounter
	for i, b := range sit.Boats {
		e.X[i], e.Y[i] = b.X, b.Y
		e.Heading[i] = wrapAngle(b.Heading * degree)
		e.Heel[i], e.Boom[i] = b.Heel*degree, b.Boom*degree
		e.SailorMode[i] = b.SailorMode
		e.WindFrom[i] = b.WindFrom * degree
		e.Tack[i], e.Tacking[i], e.Settled[i] = b.Tack, b.Tacking, b.Settled
		e.Course[i] = wrapAngle(b.Course * degree)
	}
	e.Since, e.By = sit.Since, whichNames[sit.By]
	return e
}

// Every recorded situation gets the verdict and the Article it expects,
// and its boats' tacks are what the tracker makes of their headings and
// booms; with the boats swapped, the same verdict for the same boat.
func TestArticlesSituations(t *testing.T) {
	b := jolly(t)
	ep := testEncounters(t)
	var f struct{ Situations []situation }
	readJSON(t, "testdata/articles.json", &f)
	if len(f.Situations) < 15 {
		t.Fatalf("%d situations", len(f.Situations))
	}
	swap := map[float64]float64{Neither: Neither, First: Second, Second: First}
	for _, sit := range f.Situations {
		t.Run(sit.Name, func(t *testing.T) {
			e := encounterOf(&sit)
			for i := range 2 {
				twa := wrapAngle(e.WindFrom[i] - e.Heading[i])
				if got := tackOf(twa, e.Boom[i], e.Tack[i], ep); got != e.Tack[i] {
					t.Errorf("boat %d is on tack %g by its heading and boom, not %g", i+1, got, e.Tack[i])
				}
			}
			v := Judge(&e, b, b, ep)
			want := Verdict{
				Keeper: whichNames[sit.Expect.Keeper], Article: articleNames[sit.Expect.Article],
				Fault: whichNames[sit.Expect.Fault], FaultArticle: articleNames[sit.Expect.FaultArticle],
			}
			if v != want {
				t.Errorf("%s\n got  %+v\n want %+v", sit.Description, v, want)
			}
			// The same boats the other way round.
			r := e
			for _, p := range []*[2]float64{&r.X, &r.Y, &r.Heading, &r.Heel, &r.Boom, &r.SailorMode, &r.WindFrom, &r.Tack, &r.Tacking, &r.Settled, &r.Course} {
				p[0], p[1] = p[1], p[0]
			}
			r.By = swap[e.By]
			rv := Judge(&r, b, b, ep)
			if rv.Keeper != swap[v.Keeper] || rv.Fault != swap[v.Fault] || rv.Article != v.Article || rv.FaultArticle != v.FaultArticle {
				t.Errorf("swapped: %+v, against %+v", rv, v)
			}
		})
	}
}

// The tracker's tack against the definition at every 5° of true wind
// angle, with the boom on its usual side and by the lee, and through head
// to wind both ways.
func TestTrackerTack(t *testing.T) {
	b := jolly(t)
	ep := testEncounters(t)
	for deg := -175; deg <= 180; deg += 5 {
		twa := float64(deg) * degree
		// The boom out to leeward, the side away from the wind.
		boom := -sign(twa) * 0.5
		s := State{Heading: 1, Boom: boom}
		c := Course{}
		TrackCourse(&c, &s, 1+twa, b, ep)
		want := sign(twa)
		if deg == 0 {
			// Head to wind on her first tick: starboard, by default.
			want = 1
		}
		if deg == 180 {
			// Dead downwind: the side opposite the boom.
			want = -sign(boom)
			if boom == 0 {
				want = c.Tack
			}
		}
		if c.Tack != want {
			t.Errorf("wind %d° off the bow, boom %.1f: tack %g, want %g", deg, boom, c.Tack, want)
		}
		if math.Abs(twa) > math.Pi/2 && math.Abs(twa) < math.Pi-ep.headToWind {
			// By the lee: the boom on the windward side.
			s.Boom = sign(twa) * 0.5
			c = Course{}
			TrackCourse(&c, &s, 1+twa, b, ep)
			if c.Tack != -sign(twa) {
				t.Errorf("wind %d° off the bow by the lee: tack %g, want %g", deg, c.Tack, -sign(twa))
			}
		}
	}
	// Through head to wind, both ways: the tack changes once past the
	// margin, and she is tacking until close-hauled, whatever her speed
	// (Case Book, Case 17).
	for _, dir := range []float64{1, -1} {
		s := State{Heading: dir * 45 * degree, Boom: dir * 0.2}
		c := Course{}
		TrackCourse(&c, &s, 0, b, ep)
		start := c.Tack
		changed := false
		for d := 45.0; d >= -60; d -= 0.5 {
			s.Heading = dir * d * degree
			s.Boom = sign(s.Heading) * 0.2
			TrackCourse(&c, &s, 0, b, ep)
			twa := math.Abs(d)
			switch {
			case d > -ep.headToWind/degree:
				if c.Tack != start || c.Tacking != 0 {
					t.Fatalf("heading %g° off the wind before passing head to wind: tack %g, tacking %g", d, c.Tack, c.Tacking)
				}
			case twa < 40:
				changed = true
				if c.Tack != -start || c.Tacking != 1 {
					t.Fatalf("%g° past head to wind: tack %g, tacking %g", twa, c.Tack, c.Tacking)
				}
			default:
				if c.Tacking != 0 {
					t.Fatalf("close-hauled at %g°, still tacking", twa)
				}
			}
		}
		if !changed {
			t.Fatal("never passed head to wind")
		}
	}
	// A gybe changes the tack but is no tack.
	s := State{Heading: 170 * degree, Boom: -1.2}
	c := Course{}
	TrackCourse(&c, &s, 0, b, ep)
	s.Heading, s.Boom = -170*degree, 1.2
	TrackCourse(&c, &s, 0, b, ep)
	if c.Tacking != 0 || c.Settled != 0 {
		t.Errorf("after a gybe: tacking %g, settled %g", c.Tacking, c.Settled)
	}
}

// Overlap against the definition's line, for a boat placed every 0.25 m
// fore and aft of another on a parallel course: clear astern exactly when
// her bow is behind the other's transom.
func TestOverlapLine(t *testing.T) {
	b := jolly(t)
	for _, heading := range []float64{0, 0.7, -2.5} {
		sin, cos := math.Sincos(heading)
		for k := -40; k <= 40; k++ {
			d := float64(k) * 0.25
			e := Encounter{Heading: [2]float64{heading, heading}}
			e.X[1] = d*sin + 2*cos
			e.Y[1] = d*cos - 2*sin
			got := clearAhead(&e, b, b)
			want := float64(Neither)
			switch {
			case d+b.outline.bow < -b.outline.aft:
				want = First
			case d-b.outline.aft > b.outline.bow:
				want = Second
			}
			if got != want {
				t.Errorf("heading %g, %g m ahead: clear ahead %g, want %g", heading, d, got, want)
			}
		}
	}
}

// Of two overlapped boats the windward one is the same seen from either.
func TestWindwardEitherWay(t *testing.T) {
	b := jolly(t)
	for _, tack := range []float64{-1, 1} {
		for k := range 24 {
			ha := -tack * 45 * degree
			hb := ha + float64(k-12)*degree
			e := Encounter{Heading: [2]float64{ha, hb}, Tack: [2]float64{tack, tack}}
			e.X[1], e.Y[1] = 1.3*math.Cos(ha)-0.5*math.Sin(ha), -1.3*math.Sin(ha)-0.5*math.Cos(ha)
			v := Relate(&e, b, b)
			r := e
			r.X, r.Y, r.Heading = [2]float64{e.X[1], 0}, [2]float64{e.Y[1], 0}, [2]float64{hb, ha}
			rv := Relate(&r, b, b)
			if v.Article != Article11 || rv.Article != Article11 || rv.Keeper == v.Keeper {
				t.Errorf("tack %g, headings %g° apart: %+v one way, %+v the other", tack, float64(k-12), v, rv)
			}
		}
	}
}

func TestArticlesAllocateNothing(t *testing.T) {
	b := jolly(t)
	ep := testEncounters(t)
	var f struct{ Situations []situation }
	readJSON(t, "testdata/articles.json", &f)
	e := encounterOf(&f.Situations[0])
	s := State{Heading: 0.3, Boom: -0.2}
	var c Course
	var v Verdict
	n := testing.AllocsPerRun(1000, func() {
		TrackCourse(&c, &s, 1, b, ep)
		v = Judge(&e, b, b, ep)
	})
	if n != 0 {
		t.Errorf("the Articles allocate %v times", n)
	}
	_ = v
}

func BenchmarkJudge(bm *testing.B) {
	b := jolly(bm)
	ep := testEncounters(bm)
	var f struct{ Situations []situation }
	readJSON(bm, "testdata/articles.json", &f)
	e := encounterOf(&f.Situations[7])
	for bm.Loop() {
		Judge(&e, b, b, ep)
	}
}
