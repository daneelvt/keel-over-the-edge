// SPDX-License-Identifier: AGPL-3.0-only

package race

import (
	"context"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/certs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// certSea is a sea whose races ask the certificates: what a sailor may
// sail, read from the store, and where it stands toward its next.
func certSea(t *testing.T) (*sea, *certs.Ladder) {
	s := newSea(t)
	l := certs.New(s.cat)
	s.svc.cfg.MaySail = func(ctx context.Context, id store.AccountID, boat string) (string, error) {
		r, err := s.db.SailRights(ctx, id)
		if err != nil {
			return "", err
		}
		return l.Needs(&r, boat), nil
	}
	s.svc.cfg.Standing = func(ctx context.Context, id store.AccountID) (certs.Standing, error) {
		return l.Of(ctx, s.db.Exam(), id)
	}
	return s, l
}

// closed is a kind of boat the first certificate opens, by its id.
func closed(t *testing.T, s *sea, l *certs.Ladder) string {
	for i := range s.cat.Boats {
		if id := string(s.cat.Boats[i].ID); l.Opener(id) == 0 && s.svc.inAreas(&s.cat.Boats[i], &Courses{Areas: []Area{{Number: 1}}}) {
			return id
		}
	}
	t.Fatal("no buoy racer the first certificate opens")
	return ""
}

// TestRacesAskTheCertificates: a sailor without the certificate a boat
// needs is refused entry to her race, with the certificate named, and
// may not make one in her; the owner's every boat opens both; the
// standing trials on the board say what a run counts toward.
func TestRacesAskTheCertificates(t *testing.T) {
	s, l := certSea(t)
	keel := closed(t, s, l)
	starts := s.now.Add(time.Hour)
	code := s.harbour(keel, starts)[0]
	ann, mary := s.human(), s.human()
	_, err := s.svc.Enter(s.ctx, ann, code, false)
	if r, ok := RefusalOf(err); !ok || r.Reason != RefuseCertificate || r.Needs != l.Name(0) {
		t.Fatalf("entering a race of a closed kind: %v", err)
	}
	b, err := s.svc.Board(s.ctx, ann)
	if err != nil {
		t.Fatal(err)
	}
	for _, h := range b.Harbour {
		if h.Code == code && (h.Enter.OK || h.Enter.Reason != RefuseCertificate || h.Enter.Needs != l.Name(0)) {
			t.Errorf("the board's race of a closed kind: %+v", h.Enter)
		}
	}
	_, err = s.svc.Make(s.ctx, ann, Making{Kind: KindTrial, Course: "buoy:triangle:short", Boat: keel, Who: WhoEveryone})
	if r, ok := RefusalOf(err); !ok || r.Reason != RefuseCertificate {
		t.Fatalf("making a trial of a closed kind: %v", err)
	}
	if err := s.db.SetEveryBoat(s.ctx, mary.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.svc.Enter(s.ctx, mary, code, false); err != nil {
		t.Fatalf("every boat's entry: %v", err)
	}
	if _, err := s.svc.Make(s.ctx, mary, Making{Kind: KindTrial, Course: "buoy:triangle:short", Boat: keel, Who: WhoEveryone}); err != nil {
		t.Fatalf("every boat's trial: %v", err)
	}
	if _, _, err := s.svc.Harbour(s.ctx, s.lease, s.now); err != nil {
		t.Fatal(err)
	}
	b, err = s.svc.Board(s.ctx, ann)
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Trials) < 3 || b.Trials[0].Toward != l.Name(0) || b.Trials[1].Toward != "" {
		t.Errorf("the standing trials: %+v", b.Trials)
	}
}
