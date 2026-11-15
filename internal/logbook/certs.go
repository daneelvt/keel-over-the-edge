// SPDX-License-Identifier: AGPL-3.0-only

package logbook

import (
	"context"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/certs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// A log's certificates: the one its sailor holds, at its head, read by
// whoever may read the log; and, in the sailor's own log alone, where it
// stands toward the next, at the head of its ribbons, each task with how
// far it has come and a course's task with the Harbourmaster's course
// that counts for it. The certificate earned is a line of its day too:
// the log's own entry.

// Certificate is the certificate a log's sailor holds: its name, whether
// earned by hand, and whether it is the last there is.
type Certificate struct {
	Name   string `json:"name"`
	ByHand bool   `json:"byHand,omitempty"`
	Last   bool   `json:"last,omitempty"`
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
// Harbourmaster's course that counts for it ("" for none open).
type TowardTask struct {
	Name   string `json:"name"`
	Done   bool   `json:"done,omitempty"`
	Way    string `json:"way,omitempty"`
	Course bool   `json:"course,omitempty"`
	Runs   int    `json:"runs,omitempty"`
	Of     int    `json:"of,omitempty"`
	Code   string `json:"code,omitempty"`
}

// certificates sets out's certificate held and, in one's own, where its
// sailor stands toward the next.
func (s *Service) certificates(ctx context.Context, out *Log, id store.AccountID) error {
	if s.cfg.Standing == nil {
		return nil
	}
	st, err := s.cfg.Standing(ctx, id)
	if err != nil {
		return err
	}
	if st.Held >= 0 {
		out.Certificate = &Certificate{Name: st.HeldName, ByHand: st.ByHand, Last: st.Next < 0}
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
		}
		t.Tasks = append(t.Tasks, tt)
	}
	return t
}
