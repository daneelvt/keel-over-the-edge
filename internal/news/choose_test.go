// SPDX-License-Identifier: AGPL-3.0-only

package news

import (
	"math/rand/v2"
	"slices"
	"testing"
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

func testCatalog(t testing.TB) *catalog.Catalog {
	t.Helper()
	c, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func sailor(n int) store.AccountID { return store.AccountID{byte(n >> 8), byte(n), 7} }

// day is a synthetic day of boats sailors: what a load-bot day writes,
// every candidate of a kind with its catalog score, at times through the
// day, drawn from seed.
func day(c *catalog.Catalog, boats int, seed uint64) []Candidate {
	r := rand.New(rand.NewPCG(seed, 1))
	start := time.Date(2026, 11, 12, 5, 0, 0, 0, time.UTC).UnixMilli()
	score := func(of catalog.NewsStoryOf) int { return c.StoryScore(of) }
	var out []Candidate
	add := func(kind catalog.NewsStoryOf, who store.AccountID, amount float64, named ...store.AccountID) {
		out = append(out, Candidate{Kind: string(kind), Score: score(kind), At: start + r.Int64N(18*3600*1000),
			About: append([]store.AccountID{who}, named...), Amount: amount, Order: len(out)})
	}
	for b := range boats {
		who := sailor(b)
		for range r.IntN(6) {
			add(catalog.NewsStoryOfCharting, who, 0)
		}
		for range r.IntN(3) {
			add(catalog.NewsStoryOfRun, who, 1852+r.Float64()*40000)
		}
		switch x := r.IntN(100); {
		case x < 5:
			add(catalog.NewsStoryOfGreat, who, 0)
		case x < 8:
			add(catalog.NewsStoryOfRecord, who, r.Float64()*100)
		case x < 10:
			add(catalog.NewsStoryOfLife, who, 0)
		case x < 12:
			add(catalog.NewsStoryOfCrew, who, 0, sailor(b+1), sailor(b+2), sailor(b+3))
		case x < 14:
			add(catalog.NewsStoryOfFirst, who, 0)
		case x < 15:
			add(catalog.NewsStoryOfMilestone, who, 0)
		}
	}
	slices.SortStableFunc(out, func(a, b Candidate) int { return int(a.At - b.At) })
	for i := range out {
		out[i].Order = i
	}
	return out
}

// checkPage holds a front page to the rules: at most so many, never two
// about one sailor, never more than ofKind of one kind, and of a Best kind
// only the day's greatest.
func checkPage(t *testing.T, cands []Candidate, page []int, r *Rules) {
	t.Helper()
	if len(page) > r.Stories {
		t.Errorf("%d stories", len(page))
	}
	seen := map[store.AccountID]bool{}
	kinds := map[string]int{}
	for _, i := range page {
		c := &cands[i]
		for _, a := range c.About {
			if seen[a] {
				t.Errorf("two stories about %x", a[:3])
			}
			seen[a] = true
		}
		kinds[c.Kind]++
		if kinds[c.Kind] > r.OfKind {
			t.Errorf("%d stories of %s", kinds[c.Kind], c.Kind)
		}
		if r.Best[c.Kind] {
			for j := range cands {
				if cands[j].Kind == c.Kind && cands[j].Amount > c.Amount {
					t.Errorf("a %s of %.0f told over one of %.0f", c.Kind, c.Amount, cands[j].Amount)
				}
			}
		}
	}
}

// TestChooseTwoHundredBoats: a day of two hundred boats sets a front page
// of six stories by the rules, the same twice, quickly.
func TestChooseTwoHundredBoats(t *testing.T) {
	c := testCatalog(t)
	r := RulesOf(c)
	cands := day(c, 200, 1)
	at := time.Date(2026, 11, 13, 5, 0, 0, 0, time.UTC).UnixMilli()
	start := time.Now()
	page := Choose(cands, nil, at, &r)
	took := time.Since(start)
	if len(page) != r.Stories {
		t.Fatalf("%d stories from %d candidates", len(page), len(cands))
	}
	checkPage(t, cands, page, &r)
	if again := Choose(slices.Clone(cands), nil, at, &r); !slices.Equal(again, page) {
		t.Errorf("chosen twice: %v, then %v", page, again)
	}
	var kinds []string
	for _, i := range page {
		kinds = append(kinds, cands[i].Kind)
	}
	t.Logf("%d candidates of 200 boats: %v chosen in %v", len(cands), kinds, took)
}

// TestChooseTwoBoats: a day of two boats is a short edition: a story
// about each at most, never padded.
func TestChooseTwoBoats(t *testing.T) {
	c := testCatalog(t)
	r := RulesOf(c)
	cands := day(c, 2, 3)
	page := Choose(cands, nil, time.Date(2026, 11, 13, 5, 0, 0, 0, time.UTC).UnixMilli(), &r)
	if len(page) == 0 || len(page) > 2 {
		t.Fatalf("%d stories of two boats: %v", len(page), page)
	}
	checkPage(t, cands, page, &r)
	if got := Choose(nil, nil, 0, &r); len(got) != 0 {
		t.Errorf("a quiet day's stories: %v", got)
	}
}

// TestChooseRules: the heaviest first; a sailor of the recent editions
// gives way to one who was not; a fresh story outweighs an older greater
// one late in the day; only the day's longest run; never three of a
// kind.
func TestChooseRules(t *testing.T) {
	c := testCatalog(t)
	r := RulesOf(c)
	hour := int64(3600 * 1000)
	at := 20 * hour
	ann, bob, cat, dan := sailor(1), sailor(2), sailor(3), sailor(4)
	cands := []Candidate{
		{Kind: store.StoryCrew, Score: 5, At: at, About: []store.AccountID{ann}, Order: 0},
		{Kind: store.StoryFirst, Score: 5, At: at, About: []store.AccountID{bob}, Order: 1},
	}
	if got := Choose(cands, nil, at, &r); !slices.Equal(got, []int{0, 1}) {
		t.Errorf("equal stories: %v", got)
	}
	if got := Choose(cands, map[store.AccountID]bool{ann: true}, at, &r); !slices.Equal(got, []int{1, 0}) {
		t.Errorf("Ann in the recent editions: %v", got)
	}
	// A great story of the morning, a lesser fresh one at night.
	aged := []Candidate{
		{Kind: store.StoryRecord, Score: 8, At: 0, About: []store.AccountID{ann}, Order: 0},
		{Kind: store.StoryCrew, Score: 5, At: at, About: []store.AccountID{bob}, Order: 1},
	}
	if got := Choose(aged, nil, at, &r); got[0] != 1 {
		t.Errorf("the page does not move through the day: %v", got)
	}
	if got := Choose(aged, nil, hour, &r); got[0] != 0 {
		t.Errorf("early in the day: %v", got)
	}
	runs := []Candidate{
		{Kind: store.StoryRun, Score: 4, At: 0, About: []store.AccountID{ann}, Amount: 9000, Order: 0},
		{Kind: store.StoryRun, Score: 4, At: hour, About: []store.AccountID{bob}, Amount: 12000, Order: 1},
		{Kind: store.StoryRun, Score: 4, At: hour, About: []store.AccountID{cat}, Amount: 3000, Order: 2},
	}
	if got := Choose(runs, nil, at, &r); !slices.Equal(got, []int{1}) {
		t.Errorf("the day's runs: %v", got)
	}
	three := []Candidate{
		{Kind: store.StoryGreat, Score: 10, At: at, About: []store.AccountID{ann}, Order: 0},
		{Kind: store.StoryGreat, Score: 10, At: at, About: []store.AccountID{bob}, Order: 1},
		{Kind: store.StoryGreat, Score: 10, At: at, About: []store.AccountID{cat}, Order: 2},
		{Kind: store.StoryCharting, Score: 1, At: at, About: []store.AccountID{dan}, Order: 3},
	}
	if got := Choose(three, nil, at, &r); !slices.Equal(got, []int{0, 1, 3}) {
		t.Errorf("three of a kind: %v", got)
	}
	// A crew names its sailors: none of them in another story.
	crew := []Candidate{
		{Kind: store.StoryCrew, Score: 5, At: at, About: []store.AccountID{ann, bob, cat}, Order: 0},
		{Kind: store.StoryCharting, Score: 1, At: at, About: []store.AccountID{bob}, Order: 1},
		{Kind: store.StoryCharting, Score: 1, At: at, About: []store.AccountID{dan}, Order: 2},
	}
	if got := Choose(crew, nil, at, &r); !slices.Equal(got, []int{0, 2}) {
		t.Errorf("a crew and its sailors: %v", got)
	}
	// The reader's own box: those not chosen, about their circle.
	box := Box(crew, []int{0, 2}, map[store.AccountID]bool{bob: true}, nil, at, &r, 3)
	if !slices.Equal(box, []int{1}) {
		t.Errorf("Bob's friend's box: %v", box)
	}
	if box := Box(crew, []int{0, 2}, map[store.AccountID]bool{sailor(9): true}, nil, at, &r, 3); len(box) != 0 {
		t.Errorf("a box with no one in it: %v", box)
	}
}

// BenchmarkChoose: a day of two hundred boats' choice.
func BenchmarkChoose(b *testing.B) {
	c := testCatalog(b)
	r := RulesOf(c)
	cands := day(c, 200, 1)
	at := time.Date(2026, 11, 13, 5, 0, 0, 0, time.UTC).UnixMilli()
	for b.Loop() {
		Choose(cands, nil, at, &r)
	}
}
