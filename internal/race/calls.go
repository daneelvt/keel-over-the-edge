// SPDX-License-Identifier: AGPL-3.0-only

package race

import "fmt"

// A race's calls in words: one line, the same for both boats of a bump,
// teaching the Article that judged it in the words the log tells a bump
// in, and what it cost; over early and a mark missed likewise.

// articles are what each Article asks, by its number as the rulebook
// writes it.
var articles = map[string]string{
	"10":   "port tack keeps clear of starboard",
	"11":   "windward keeps clear of leeward",
	"12":   "clear astern keeps clear of clear ahead",
	"13":   "a boat tacking keeps clear",
	"15":   "a boat gaining right of way gives room",
	"16.1": "a boat with right of way changing course gives room",
	"22":   "keep clear of a capsized boat",
}

// CallLine is a bump's call in a race in words, by the Article that put
// the fault on a boat, with the seconds added to it: "Port tack keeps
// clear of starboard (Article 10) · 10 seconds added".
func CallLine(article string, added int) string {
	rule, ok := articles[article]
	if !ok {
		return fmt.Sprintf("A bump · %d seconds added", added)
	}
	return fmt.Sprintf("%s%s (Article %s) · %d seconds added", string(rule[0]-'a'+'A'), rule[1:], article, added)
}

// OverEarlyLine is a boat over the line at the gun, in words.
func OverEarlyLine(added int) string { return fmt.Sprintf("Over early · %d seconds added", added) }

// MissedLine is a mark missed, in words.
func MissedLine(mark int) string { return fmt.Sprintf("Mark %d missed: go back", mark) }
