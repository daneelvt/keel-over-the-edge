// SPDX-License-Identifier: AGPL-3.0-only

package news

import (
	"math"
	"slices"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Candidate is a story as the choice sees it: its kind and score, when it
// happened (ms of UTC), the sailors it is about (its own first), what it
// turns on, and its place among the day's in the order they were written.
type Candidate struct {
	Kind   string
	Score  int
	At     int64
	About  []store.AccountID
	Amount float64
	Order  int
}

// Rules are how an edition is chosen: at most Stories stories, at most
// OfKind of a kind; a story's score halved after Ease ms of age, and
// times GiveWay (thousandths) if a sailor it is about was in the recent
// editions; of the kinds in Best only the day's greatest amount is told.
type Rules struct {
	Stories, OfKind int
	Shipmates       int
	Recent          int
	Ease            int64
	GiveWay         int64
	Best            map[string]bool
}

// RulesOf are the catalog's rules.
func RulesOf(c *catalog.Catalog) Rules {
	e := &c.News.Edition
	return Rules{
		Stories: e.Stories, OfKind: e.OfKind, Shipmates: e.Shipmates, Recent: e.Recent,
		Ease:    int64(math.Round(e.Ease * 3600 * 1000)),
		GiveWay: int64(math.Round(e.GiveWay * 1000)),
		Best:    map[string]bool{store.StoryRun: true},
	}
}

// Weight is a candidate's score as the choice weighs it at at (ms):
// millionths of its score, eased with its age, given way if a sailor it
// is about is in recent. Integer arithmetic only: the same on every
// machine.
func Weight(c *Candidate, recent map[store.AccountID]bool, at int64, r *Rules) int64 {
	age := max(at-c.At, 0)
	w := int64(c.Score) * 1_000_000
	if r.Ease > 0 {
		w = w * r.Ease / (r.Ease + age)
	}
	for _, a := range c.About {
		if recent[a] {
			w = w * r.GiveWay / 1000
			break
		}
	}
	return w
}

// Choose is the front page chosen from cands at at (ms): the indexes of
// the stories, the first first. The highest weight first; never two
// stories about one sailor, never more than OfKind of a kind; of each kind
// in Best, only the greatest amount of the day (the earliest of equals).
// It is a pure function of its arguments.
func Choose(cands []Candidate, recent map[store.AccountID]bool, at int64, r *Rules) []int {
	return pick(cands, order(cands, recent, at, r), r.Stories, r.OfKind, nil, nil)
}

// Box is the reader's own box: up to n of cands not in chosen, about a
// sailor of about, by the same weights, never two about one sailor.
func Box(cands []Candidate, chosen []int, about map[store.AccountID]bool, recent map[store.AccountID]bool, at int64, r *Rules, n int) []int {
	if n <= 0 || len(about) == 0 {
		return nil
	}
	skip := make(map[int]bool, len(chosen))
	for _, i := range chosen {
		skip[i] = true
	}
	return pick(cands, order(cands, recent, at, r), n, n, skip, about)
}

// order is cands' indexes by weight, the heaviest first, then the
// earliest, then the first written; the lesser of each Best kind left
// out.
func order(cands []Candidate, recent map[store.AccountID]bool, at int64, r *Rules) []int {
	best := map[string]int{}
	for i := range cands {
		c := &cands[i]
		if !r.Best[c.Kind] {
			continue
		}
		if j, ok := best[c.Kind]; !ok || c.Amount > cands[j].Amount {
			best[c.Kind] = i
		}
	}
	weights := make([]int64, len(cands))
	idx := make([]int, 0, len(cands))
	for i := range cands {
		c := &cands[i]
		if r.Best[c.Kind] && best[c.Kind] != i {
			continue
		}
		weights[i] = Weight(c, recent, at, r)
		idx = append(idx, i)
	}
	slices.SortStableFunc(idx, func(a, b int) int {
		ca, cb := &cands[a], &cands[b]
		switch {
		case weights[a] != weights[b]:
			if weights[a] > weights[b] {
				return -1
			}
			return 1
		case ca.At != cb.At:
			if ca.At < cb.At {
				return -1
			}
			return 1
		}
		return ca.Order - cb.Order
	})
	return idx
}

// pick takes up to n of idx in order, at most ofKind of a kind, none
// sharing a sailor with one taken, none in skip, and, with about, only
// those about a sailor in it.
func pick(cands []Candidate, idx []int, n, ofKind int, skip map[int]bool, about map[store.AccountID]bool) []int {
	var out []int
	taken := map[store.AccountID]bool{}
	kinds := map[string]int{}
next:
	for _, i := range idx {
		if len(out) >= n {
			break
		}
		c := &cands[i]
		if skip[i] || kinds[c.Kind] >= ofKind {
			continue
		}
		if about != nil {
			ok := false
			for _, a := range c.About {
				ok = ok || about[a]
			}
			if !ok {
				continue
			}
		}
		for _, a := range c.About {
			if taken[a] {
				continue next
			}
		}
		for _, a := range c.About {
			taken[a] = true
		}
		kinds[c.Kind]++
		out = append(out, i)
	}
	return out
}
