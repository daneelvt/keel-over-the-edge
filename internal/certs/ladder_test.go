// SPDX-License-Identifier: AGPL-3.0-only

package certs

import (
	"slices"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
)

// TestNoTaskIsTooDifficult holds the catalog's certificates to the rules
// written at the head of their file: the first asks no more than
// steering, its course with no beat in it; a beat is first asked at the
// second, and only to be finished; by hand none before the last asks
// more than bronze, the last asks silver once, and none asks gold; and
// each can be earned with no rare thing and at most one medal.
func TestNoTaskIsTooDifficult(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	certs := cat.Certificates
	if len(certs) < 3 {
		t.Fatalf("%d certificates", len(certs))
	}
	rank := map[catalog.Medal]int{catalog.MedalFinish: 0, catalog.MedalBronze: 1, catalog.MedalSilver: 2, catalog.MedalGold: 3}
	// Rare: a storm, fog, or being the first to chart a place.
	rare := []catalog.Measure{catalog.MeasureStormsOrFogs, catalog.MeasurePlacesCharted, catalog.MeasureEveryWeather}
	last := len(certs) - 1
	for place, c := range certs {
		easy, medals, silvers := 0, 0, 0
		for _, k := range c.Tasks {
			if len(k.Courses) == 0 {
				if k.Measure == nil {
					t.Errorf("%s, %s: neither a course's task nor a measure's", c.Name, k.Name)
				} else if !slices.Contains(rare, *k.Measure) {
					easy++
				}
				continue
			}
			if k.Hand == nil || k.Venture == nil {
				t.Errorf("%s, %s: a course's task without both its ways", c.Name, k.Name)
				continue
			}
			beat := slices.ContainsFunc(k.Courses, func(c catalog.CertificateCourse) bool { return c != catalog.CertificateCourseReach })
			hand := rank[k.Hand.Medal]
			switch {
			case place == 0 && (beat || hand > 0):
				t.Errorf("%s, %s: the first certificate's course is the reach, to be finished", c.Name, k.Name)
			case place == 1 && beat && (hand > 0 || rank[k.Venture.Medal] > 0):
				t.Errorf("%s, %s: a beat is held against the clock before the third certificate", c.Name, k.Name)
			case place < last && hand > rank[catalog.MedalBronze]:
				t.Errorf("%s, %s: asks %s by hand before the last certificate", c.Name, k.Name, k.Hand.Medal)
			}
			if hand >= rank[catalog.MedalGold] || rank[k.Venture.Medal] >= rank[catalog.MedalGold] {
				t.Errorf("%s, %s: asks gold", c.Name, k.Name)
			}
			if rank[k.Venture.Medal] > hand {
				t.Errorf("%s, %s: the autopilot's way asks a better medal than by hand", c.Name, k.Name)
			}
			if hand == rank[catalog.MedalSilver] {
				silvers++
			}
			if hand == 0 {
				easy++
			} else {
				medals++
			}
		}
		if place == last && silvers > 1 || place < last && silvers > 0 {
			t.Errorf("%s asks silver by hand %d times", c.Name, silvers)
		}
		if got := easy + min(medals, 1); got < c.Needs {
			t.Errorf("%s needs %d tasks: only %d can be done with no rare thing and at most one medal", c.Name, c.Needs, got)
		}
	}
	// The first two can be earned with no course at all.
	for _, c := range certs[:2] {
		logs := 0
		for _, k := range c.Tasks {
			if len(k.Courses) == 0 && k.Measure != nil && !slices.Contains(rare, *k.Measure) {
				logs++
			}
		}
		if logs < c.Needs {
			t.Errorf("%s needs %d tasks, and has %d that are no course's", c.Name, c.Needs, logs)
		}
	}
}

// TestNoCertificateNeedsAnUpwindCourse: sailing up the wind, in zigzags,
// is the hardest sailing, and stays a choice: every certificate can be
// earned with no task that wears the upwind sign, one whose every course
// has a beat in it.
func TestNoCertificateNeedsAnUpwindCourse(t *testing.T) {
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cat.Certificates {
		others := 0
		for i := range c.Tasks {
			if !UpwindTask(&c.Tasks[i]) {
				others++
			}
		}
		if others < c.Needs {
			t.Errorf("%s needs %d tasks and has %d without the upwind sign", c.Name, c.Needs, others)
		}
	}
	if !UpwindTask(&catalog.CertificateTask{Courses: []catalog.CertificateCourse{catalog.CertificateCourseShort}}) ||
		UpwindTask(&catalog.CertificateTask{Courses: []catalog.CertificateCourse{catalog.CertificateCourseReach, catalog.CertificateCourseShort}}) ||
		UpwindTask(&catalog.CertificateTask{Courses: []catalog.CertificateCourse{catalog.CertificateCourseIsland}}) {
		t.Error("the upwind sign on the wrong tasks")
	}
}
