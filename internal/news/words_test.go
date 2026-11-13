// SPDX-License-Identifier: AGPL-3.0-only

package news

import (
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The longest a story's text may be with its names filled in, characters:
// about two lines at 16 px on a phone held upright.
const mostStory = 110

var slotRE = regexp.MustCompile(`\{(\d+)\}`)

// filled is a text with each slot a name of an ordinary length.
func filled(text string) string {
	return slotRE.ReplaceAllString(text, "Mary Reade")
}

// TestWords: every phrasing of every kind of story, for every story's
// seed, names only the slots it has, leaves no blank, reads in at most
// about two lines on a phone, and opens with a capital or a slot.
func TestWords(t *testing.T) {
	w := newWords(testCatalog(t))
	cases := []store.Story{
		{Story: store.StoryGreat, Subject: "feature", Title: "Keyhole Arch", What: "a sea arch on Gannet Holm"},
		{Story: store.StoryFirst, Subject: "place", Title: "Pelican Cove", What: "a cove on an island of the middle waters"},
		{Story: store.StoryCharting, Subject: "island", Title: "Gull Reach", What: "one of the Skerries, the rim"},
		{Story: store.StoryRecord, Subject: store.SubjectSailor, Amount: 8.4, Facts: store.StoryFacts{Place: "The Skerries"}},
		{Story: store.StoryLife, Subject: store.SubjectSailor, Facts: store.StoryFacts{Life: "humpback-whale", Place: "Gull Reach"}},
		{Story: store.StoryLife, Subject: store.SubjectSailor, Facts: store.StoryFacts{Life: "glowing-water"}},
		{Story: store.StoryLife, Subject: store.SubjectSailor, Facts: store.StoryFacts{Life: "pilot-whale"}},
		{Story: store.StoryRun, Subject: store.SubjectSailor, Amount: 42.7 * 1852},
		{Story: store.StoryMilestone, Subject: store.SubjectSailor, Facts: store.StoryFacts{Milestone: store.MilestoneDistance, Value: 1000}},
		{Story: store.StoryMilestone, Subject: store.SubjectSailor, Facts: store.StoryFacts{Milestone: store.MilestoneWorlds, Value: 10}},
		{Story: store.StoryMilestone, Subject: store.SubjectSailor, Facts: store.StoryFacts{Milestone: store.MilestonePlaces, Value: 100}},
		{Story: store.StoryArrival, Subject: store.SubjectWorld, Facts: store.StoryFacts{Islands: 64}},
	}
	for _, c := range cases {
		for seed := range 12 {
			c.ID[15] = byte(seed)
			c.ID[8] = byte(seed * 37)
			head, text := w.written(&c, 0, 0)
			check := func(text string, slots int) {
				t.Helper()
				if strings.ContainsAny(slotRE.ReplaceAllString(text, ""), "{}") {
					t.Errorf("%s: a blank left: %q", c.Story, text)
				}
				for _, m := range slotRE.FindAllStringSubmatch(text, -1) {
					if n, _ := strconv.Atoi(m[1]); n >= slots {
						t.Errorf("%s: slot %d of %d: %q", c.Story, n, slots, text)
					}
				}
				if n := len([]rune(filled(text))); n > mostStory {
					t.Errorf("%s: %d characters: %q", c.Story, n, filled(text))
				}
				if r := text[0]; !(r >= 'A' && r <= 'Z') && !(r >= '0' && r <= '9') && r != '{' {
					t.Errorf("%s: opens small: %q", c.Story, text)
				}
			}
			slots := 1
			if c.Story == store.StoryArrival {
				slots = 0
			}
			check(text, slots)
			if head == "" || strings.ToUpper(head) != head {
				t.Errorf("%s: headword %q", c.Story, head)
			}
		}
	}
	// A crew of six, two named, three more; and a rare meeting with one
	// named aboard.
	crew := store.Story{Story: store.StoryCrew, Subject: store.SubjectSailor, Facts: store.StoryFacts{Aboard: 6}}
	for seed := range 6 {
		crew.ID[8] = byte(seed)
		_, text := w.written(&crew, 2, 3)
		if !strings.Contains(text, "{1}, {2} and three more.") || !strings.Contains(text, "six") || strings.Contains(text, "{3}") {
			t.Errorf("the crew: %q", text)
		}
	}
	life := store.Story{Story: store.StoryLife, Subject: store.SubjectSailor, Facts: store.StoryFacts{Life: "humpback-whale"}}
	if _, text := w.written(&life, 1, 0); !strings.Contains(text, "with {1} aboard") || !strings.Contains(text, "a humpback whale") {
		t.Errorf("a whale met with one aboard: %q", text)
	}
	// The last world in review: its finders' slots, then the nearest's.
	review := store.Story{Story: store.StoryReview, Subject: store.SubjectWorld, Facts: store.StoryFacts{
		World: 11, Sailors: 212, Run: 1804 * 1852, Islands: 51, Of: 64,
		Finds:   []store.ReviewFind{{Title: "Keyhole Arch"}, {Title: "Gannet Holm"}, {Title: "The Kettle"}},
		Nearest: &store.Nearest{Least: 4.2, Boat: "Gull"},
	}}
	head, text := w.written(&review, 4, 0)
	want := "World 11 in review: 212 sailors, 1,804 NM sailed, 51 of 64 islands charted. Its greatest finds: Keyhole Arch, by {0}; " +
		"Gannet Holm, by {1}; The Kettle, by {2}. Nearest the falls: {3}, 4.2 m from the lip."
	if head != "THE LAST WORLD" || text != want {
		t.Errorf("the review:\n%s\n%s", head, text)
	}
}

// TestFiguresText: the day in figures in one sentence of counts, a quiet
// day for none.
func TestFiguresText(t *testing.T) {
	for _, c := range []struct {
		f    store.Figures
		want string
	}{
		{store.Figures{}, "A quiet day on the water."},
		{store.Figures{Boats: 212, Machines: 31, Run: 1804 * 1852, Charted: 14, Crews: 5, Over: 37},
			"Sailed this day, 212 boats (31 machine ⚙) · 1,804 NM · 14 places charted · 5 crews in company · 37 over the falls, all hands home."},
		{store.Figures{Boats: 1, Run: 3.27 * 1852, Charted: 1, Crews: 1},
			"Sailed this day, one boat · 3.3 NM · one place charted · one crew in company."},
	} {
		if got := FiguresText(&c.f); got != c.want {
			t.Errorf("%+v:\n%s\nwant\n%s", c.f, got, c.want)
		}
	}
}
