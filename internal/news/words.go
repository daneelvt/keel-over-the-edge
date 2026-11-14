// SPDX-License-Identifier: AGPL-3.0-only

package news

import (
	"encoding/binary"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/catalog"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The news's words, in the manner of the old shipping lists: a headword,
// the place in capitals, then a line or two. Each kind of story has
// several phrasings, picked by the story's own seed, so no two days read
// alike, and a story is at most about two lines on a phone held upright.
// The sailors a story names are never in its words: each is a slot, {0},
// {1}, …, its index in the story's names, which the reader's phone (or an
// agent's words) fills in by the naming rule. A slot that opens a
// sentence is written with a capital.

// words are the news's words for the catalog's kinds.
type words struct {
	boats map[string]string            // a boat kind's name, by its ID
	life  map[string]*catalog.LifeKind // a kind of life, by its ID
}

func newWords(c *catalog.Catalog) *words {
	w := &words{boats: map[string]string{}, life: map[string]*catalog.LifeKind{}}
	if c == nil {
		return w
	}
	for _, b := range c.Boats {
		w.boats[string(b.ID)] = b.Name
	}
	for i := range c.Life.Kinds {
		k := &c.Life.Kinds[i]
		w.life[k.ID] = k
	}
	return w
}

// seedOf picks one of n phrasings by a story's ID.
func seedOf(id [16]byte, n int) int {
	return int(binary.BigEndian.Uint64(id[8:]) % uint64(n))
}

// one is one of the phrasings, by the story's seed, its {what} filled in.
func one(id [16]byte, phrasings []string, fill map[string]string) string {
	p := phrasings[seedOf(id, len(phrasings))]
	for k, v := range fill {
		p = strings.ReplaceAll(p, "{"+k+"}", v)
	}
	return p
}

// capital is s with its first letter a capital.
func capital(s string) string {
	if s == "" {
		return s
	}
	r := []rune(s)
	if r[0] >= 'a' && r[0] <= 'z' {
		r[0] += 'A' - 'a'
	}
	return string(r)
}

// lower is a kind's name as words mid-sentence: its first letter small.
func lower(s string) string {
	if s == "" {
		return s
	}
	r := []rune(s)
	if r[0] >= 'A' && r[0] <= 'Z' {
		r[0] += 'a' - 'A'
	}
	return string(r)
}

// withArticle is a kind's name with "a" or "an".
func withArticle(name string) string {
	n := lower(name)
	if n == "" {
		return n
	}
	switch n[0] {
	case 'a', 'e', 'i', 'o', 'u':
		return "an " + n
	}
	return "a " + n
}

// Miles are a distance, m, in nautical miles as the news writes them: to
// a tenth under ten, else whole, with thousands marked.
func Miles(m float64) string {
	nm := m / 1852
	if nm < 10 {
		return strconv.FormatFloat(math.Round(nm*10)/10, 'f', 1, 64)
	}
	return Count(int(math.Round(nm)))
}

// Count is a whole number with its thousands marked: "1,804".
func Count(n int) string {
	s := strconv.Itoa(n)
	if n < 0 {
		return s
	}
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// metres is a distance near the lip, m: whole metres, "8 m".
func metres(m float64) string {
	if m < 10 {
		return strconv.FormatFloat(math.Round(m*10)/10, 'f', -1, 64) + " m"
	}
	return strconv.Itoa(int(math.Round(m))) + " m"
}

// ordinal is a number as an ordinal: "tenth", "20th".
func ordinal(n int) string {
	names := []string{"", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
		"eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"}
	if n > 0 && n < len(names) {
		return names[n]
	}
	suffix := "th"
	if n%100 < 11 || n%100 > 13 {
		switch n % 10 {
		case 1:
			suffix = "st"
		case 2:
			suffix = "nd"
		case 3:
			suffix = "rd"
		}
	}
	return strconv.Itoa(n) + suffix
}

// numberWord is a small count in words: "two", "seven"; larger in figures.
func numberWord(n int) string {
	names := []string{"no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"}
	if n >= 0 && n < len(names) {
		return names[n]
	}
	return strconv.Itoa(n)
}

// The headwords of stories about a sailor away from any place named.
const (
	headFalls     = "AT THE FALLS"
	headSea       = "AT SEA"
	headCompany   = "IN COMPANY"
	headRun       = "THE DAY'S RUN"
	headLog       = "FROM THE LOGS"
	headNewWorld  = "A NEW WORLD"
	headLastWorld = "THE LAST WORLD"
)

// head is a story's headword: the place it is about in capitals, "OFF" a
// place named near where it happened, or its kind's own.
func head(s *store.Story) string {
	switch s.Story {
	case store.StoryArrival:
		return headNewWorld
	case store.StoryReview:
		return headLastWorld
	}
	if s.Subject != store.SubjectSailor && s.Title != "" {
		return strings.ToUpper(s.Title)
	}
	if p := s.Facts.Place; p != "" {
		return "OFF " + strings.ToUpper(p)
	}
	switch s.Story {
	case store.StoryRecord:
		return headFalls
	case store.StoryCrew:
		return headCompany
	case store.StoryRun:
		return headRun
	case store.StoryMilestone:
		return headLog
	}
	return headSea
}

// The phrasings of each kind. {what} is what a place is ("a sea arch on
// Gull Island"), {What} the same opening a sentence; {m} a distance from
// the lip; {nm} a run; {life} a kind of life met; {n} a count.
var (
	greatWords = []string{
		"{What}, first sighted by {0}.",
		"{What}. Sighted and charted by {0}, a great discovery.",
		"{What}, now on the chart: {0} raised it first.",
		"{What}. Reported by {0}, the first to raise it.",
		"{What}, a great find; first sighted by {0}.",
	}
	firstWords = []string{
		"{What}, charted by {0}: a first find, and not the last.",
		"{What}. A new hand's first find: {0} raised it.",
		"{What}, first sighted by {0}, their first place on the chart.",
		"{What}. {0} reports it: a first charting, well done.",
	}
	chartingWords = []string{
		"{What}, charted by {0}.",
		"{What}. Sighted by {0}.",
		"{What}, raised by {0}.",
		"{What}, now on the chart: sighted by {0}.",
	}
	recordWords = []string{
		"{0} passed {m} from the lip, nearer than any boat this world.",
		"{0} came within {m} of the falls and stood off, the nearest yet.",
		"Spoke {0}, {m} from the lip and all well: the nearest this world.",
		"{0} looked over the edge from {m} and sailed home: a record.",
	}
	lifeWords = []string{
		"{0} met {life}.",
		"{Life} kept company with {0} for a while.",
		"{0} reports {life}, close aboard.",
		"{Life} came up beside {0}.",
	}
	runWords = []string{
		"{0} logged {nm} NM in one voyage, the day's longest run.",
		"The day's longest run: {nm} NM, sailed by {0}.",
		"{0} ran {nm} NM before coming home, the longest of the day.",
	}
	distanceWords = []string{
		"{0} has logged {n} NM in all.",
		"{n} NM now in the log of {0}, and counting.",
		"{0} passed {n} NM sailed: a milestone.",
	}
	worldsWords = []string{
		"{0} sails a {nth} world.",
		"A {nth} world for {0}, and the sea still new.",
	}
	placesWords = []string{
		"{0} has charted {n} places.",
		"{n} places on the chart from {0}: a milestone.",
	}
	arrivalWords = []string{
		"The chart is blank: {n} islands wait to be found.",
		"The falls have turned the world over: {n} islands wait to be found.",
		"A fresh sea and a blank chart: {n} islands to be found.",
	}
)

// written is a story's words for a reader: its headword, and its text
// with the slots of names, whose count of others aboard not named is
// counted.
func (w *words) written(s *store.Story, named, counted int) (string, string) {
	// A place's own name is its headword: what it is follows.
	fill := map[string]string{"what": s.What, "What": capital(s.What)}
	var text string
	switch s.Story {
	case store.StoryGreat:
		text = one(s.ID, greatWords, fill)
	case store.StoryFirst:
		text = one(s.ID, firstWords, fill)
	case store.StoryCharting:
		text = one(s.ID, chartingWords, fill)
	case store.StoryRecord:
		fill["m"] = metres(s.Amount)
		text = one(s.ID, recordWords, fill)
	case store.StoryLife:
		l := w.lifeWords(s.Facts.Life)
		fill["life"], fill["Life"] = l, capital(l)
		text = one(s.ID, lifeWords, fill)
		if others := w.aboard(named, counted); others != "" {
			text = strings.TrimSuffix(text, ".") + ", " + others + "."
		}
	case store.StoryCrew:
		text = w.crew(s, named, counted)
	case store.StoryRun:
		fill["nm"] = Miles(s.Amount)
		text = one(s.ID, runWords, fill)
	case store.StoryMilestone:
		v := int(math.Round(s.Facts.Value))
		fill["n"], fill["nth"] = Count(v), ordinal(v)
		switch s.Facts.Milestone {
		case store.MilestoneWorlds:
			text = one(s.ID, worldsWords, fill)
		case store.MilestonePlaces:
			text = one(s.ID, placesWords, fill)
		default:
			text = one(s.ID, distanceWords, fill)
		}
	case store.StoryArrival:
		fill["n"] = Count(s.Facts.Islands)
		text = one(s.ID, arrivalWords, fill)
	case store.StoryReview:
		text = w.review(s, named)
	default:
		text = capital(s.What)
	}
	return head(s), text
}

// lifeWords are a kind of life met, as a phrase: "a humpback whale", "a
// pod of pilot whales", "glowing water".
func (w *words) lifeWords(id string) string {
	k := w.life[id]
	if k == nil {
		return "a creature of the deep"
	}
	switch {
	case k.Plural == k.Name:
		return lower(k.Name)
	case k.Collective != nil && *k.Collective != "":
		return "a " + *k.Collective + " of " + lower(k.Plural)
	}
	return withArticle(k.Name)
}

// others are who else was aboard as words: the slots from 1 of those
// named, then how many more not: "{1}, {2} and three more", "four
// more"; "" for no one.
func others(named, counted int) string {
	var parts []string
	for i := range named {
		parts = append(parts, "{"+strconv.Itoa(1+i)+"}")
	}
	if counted > 0 {
		more := numberWord(counted) + " more"
		if named == 0 {
			more = numberWord(counted) + " others"
			if counted == 1 {
				more = "one other"
			}
		}
		parts = append(parts, more)
	}
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " and " + parts[len(parts)-1]
}

// aboard is who else was aboard: "with {1} and two more aboard".
func (w *words) aboard(named, counted int) string {
	if o := others(named, counted); o != "" {
		return "with " + o + " aboard"
	}
	return ""
}

// crew are a crew in company's words: the skipper, those named aboard and
// how many more.
func (w *words) crew(s *store.Story, named, counted int) string {
	n := s.Facts.Aboard
	if n == 0 {
		n = named + counted + 1
	}
	phrasings := []string{
		"{0} sailed in company, {n} aboard together: {others}.",
		"A crew of {n} under {0}: {others}.",
		"{0} put to sea with a crew of {n}: {others}.",
	}
	o := others(named, counted)
	if o == "" {
		o = "all hands well"
	}
	return one(s.ID, phrasings, map[string]string{"n": numberWord(n), "others": o})
}

// review is the last world in review: its figures, its greatest finds by
// their finders (slots from 0, in order), and who came nearest the falls
// (the last slot), named counts the slots.
func (w *words) review(s *store.Story, named int) string {
	f := &s.Facts
	var b strings.Builder
	fmt.Fprintf(&b, "World %d in review: %s sailors, %s NM sailed", f.World, Count(f.Sailors), Miles(f.Run))
	if f.Of > 0 {
		fmt.Fprintf(&b, ", %s of %s islands charted.", Count(f.Islands), Count(f.Of))
	} else {
		fmt.Fprintf(&b, ", %s islands charted.", Count(f.Islands))
	}
	slot := 0
	if len(f.Finds) > 0 {
		b.WriteString(" Its greatest finds: ")
		for i, fd := range f.Finds {
			if i > 0 {
				b.WriteString("; ")
			}
			fmt.Fprintf(&b, "%s, by {%d}", fd.Title, slot)
			slot++
		}
		b.WriteString(".")
	}
	if f.Nearest != nil && slot < named {
		fmt.Fprintf(&b, " Nearest the falls: {%d}, %s from the lip.", slot, metres(f.Nearest.Least))
	}
	return b.String()
}

// FiguresText is the day in figures in one sentence, never a name: "Sailed
// this day, 212 boats (31 machine) · 1,804 NM · 14 places charted · 5
// crews in company · 37 over the falls, all hands home." A day nobody
// sailed is a quiet day.
func FiguresText(f *store.Figures) string {
	if f.Boats == 0 && f.Charted == 0 {
		return "A quiet day on the water."
	}
	var parts []string
	boats := Count(f.Boats) + " boats"
	if f.Boats == 1 {
		boats = "one boat"
	}
	if f.Machines > 0 {
		boats += " (" + Count(f.Machines) + " machine ⚙)"
	}
	parts = append(parts, "Sailed this day, "+boats)
	if f.Run > 0 {
		parts = append(parts, Miles(f.Run)+" NM")
	}
	if f.Charted > 0 {
		p := Count(f.Charted) + " places charted"
		if f.Charted == 1 {
			p = "one place charted"
		}
		parts = append(parts, p)
	}
	if f.Crews > 0 {
		c := Count(f.Crews) + " crews in company"
		if f.Crews == 1 {
			c = "one crew in company"
		}
		parts = append(parts, c)
	}
	if f.Over > 0 {
		parts = append(parts, Count(f.Over)+" over the falls, all hands home")
	}
	return strings.Join(parts, " · ") + "."
}
