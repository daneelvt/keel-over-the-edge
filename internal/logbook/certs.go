// SPDX-License-Identifier: AGPL-3.0-only

package logbook

import (
	"context"
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/certs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A log's certificates: the one its sailor holds, at its head, and every
// one held with when, in which world and whether by hand, read by
// whoever may read the log; and, in the sailor's own log alone, the tasks
// that counted toward each held and where it stands toward the next,
// each task with how far it has come and a course's task with the
// Harbourmaster's course that counts for it. The certificate earned is a
// line of its day too: the log's own entry.

// Certificate is the certificate a log's sailor holds: its name, whether
// earned by hand, and whether it is the last there is; and the pendant it
// wears at the neck, its place in the catalog's list and one, as the game
// sends it (Person.pendant).
type Certificate struct {
	Name    string `json:"name"`
	ByHand  bool   `json:"byHand,omitempty"`
	Last    bool   `json:"last,omitempty"`
	Pendant int    `json:"pendant"`
}

// Toward is where a sailor stands toward its next certificate: its name,
// how many of its tasks it needs and how many are done, and its tasks.
type Toward struct {
	Name  string       `json:"name"`
	Needs int          `json:"needs"`
	Done  int          `json:"done"`
	Tasks []TowardTask `json:"tasks"`
}

// TowardTask is a task of the next certificate: its name; whether done,
// and the way (hand, pilot or log); for a course's task, whether it is
// one, its venture's runs so far of those it asks, and the code of the
// Harbourmaster's course that counts for it ("" for none open). A task of
// the log not yet done says how far it has come: Have of At, nautical
// miles for a distance and a count for the rest; the lip's closest
// approach survived so far, m (nil for none yet); and, where every
// weather is asked, the kinds met so far (MetGale, MetStorm, MetFog,
// MetNight).
type TowardTask struct {
	Name    string   `json:"name"`
	Done    bool     `json:"done,omitempty"`
	Way     string   `json:"way,omitempty"`
	Course  bool     `json:"course,omitempty"`
	Runs    int      `json:"runs,omitempty"`
	Of      int      `json:"of,omitempty"`
	Code    string   `json:"code,omitempty"`
	Have    float64  `json:"have,omitempty"`
	At      float64  `json:"at,omitempty"`
	Closest *float64 `json:"closest,omitempty"`
	Met     []string `json:"met,omitempty"`
}

// Earned is a certificate a log's sailor holds: its place in the
// catalog's list, when it was earned and in which world, and whether by
// hand; in one's own log alone, the tasks that counted.
type Earned struct {
	Place  int          `json:"place"`
	At     int64        `json:"at"`
	World  int          `json:"world"`
	ByHand bool         `json:"byHand,omitempty"`
	Tasks  []EarnedTask `json:"tasks,omitempty"`
}

// EarnedTask is a task that counted toward a certificate held: its place
// among the certificate's tasks, and its way (hand, pilot or log).
type EarnedTask struct {
	Task int    `json:"task"`
	Way  string `json:"way"`
}

// certificates sets out's certificate held and every one held; in one's
// own, the tasks that counted and where its sailor stands toward the
// next.
func (s *Service) certificates(ctx context.Context, out *Log, id store.AccountID) error {
	if s.cfg.Standing == nil {
		return nil
	}
	st, err := s.cfg.Standing(ctx, id)
	if err != nil {
		return err
	}
	if st.Held >= 0 {
		out.Certificate = &Certificate{Name: st.HeldName, ByHand: st.ByHand, Last: st.Next < 0, Pendant: st.Held + 1}
	}
	for _, e := range st.Earned {
		c := Earned{Place: e.Place, At: ms(e.At), World: e.World, ByHand: e.ByHand}
		if out.Own {
			for _, k := range e.Tasks {
				c.Tasks = append(c.Tasks, EarnedTask{Task: k.Task, Way: k.Way})
			}
		}
		out.Certificates = append(out.Certificates, c)
	}
	if !out.Own || st.Next < 0 {
		return nil
	}
	var codes map[string]string
	if s.cfg.Trials != nil {
		if codes, err = s.cfg.Trials(ctx, id); err != nil {
			return err
		}
	}
	out.Toward = towardOf(&st, codes)
	return nil
}

// towardOf is a standing toward its next certificate as the log shows
// it, each course's task with the first of its courses' codes.
func towardOf(st *certs.Standing, codes map[string]string) *Toward {
	t := &Toward{Name: st.Name, Needs: st.Needs, Done: min(st.Done, st.Needs), Tasks: make([]TowardTask, 0, len(st.Tasks))}
	for _, k := range st.Tasks {
		tt := TowardTask{Name: k.Name, Done: k.Done, Way: k.Way, Course: k.Course}
		if k.Course {
			tt.Runs, tt.Of = k.Runs, k.Of
			if i := slices.IndexFunc(k.Courses, func(c string) bool { return codes[c] != "" }); i >= 0 {
				tt.Code = codes[k.Courses[i]]
			}
		}
		if !k.Done {
			tt.Way = ""
			progress(&tt, &k)
		}
		t.Tasks = append(t.Tasks, tt)
	}
	return t
}

// progress sets how far a task of the log not yet done has come.
func progress(tt *TowardTask, k *certs.Task) {
	switch catalog.Measure(k.Measure) {
	case "":
	case catalog.MeasureLip:
		tt.At = k.At
		if k.Survived {
			// To the metre: the page says no more.
			m := math.Round(k.Closest)
			tt.Closest = &m
		}
	case catalog.MeasureEveryWeather:
		tt.Met = metKinds(k.Met)
	case catalog.MeasureDistance:
		// To a hundredth of a mile, rounded down: never the mark itself
		// while the task is undone.
		tt.Have, tt.At = math.Floor(k.Have*100)/100, k.At
	default:
		tt.Have, tt.At = k.Have, k.At
	}
}
