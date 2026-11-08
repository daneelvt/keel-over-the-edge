// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"fmt"
	"strings"

	"github.com/daneelvt/keel-over-the-edge/internal/bus"
)

// Company aboard, as the report tells it: who else is aboard the boat the
// machine sailor sails or is aboard, each by their name as player text and
// the game's own words for who they are, and who holds the controls.

// aboardWords are the report's Aboard line for the boat in slot sl of f:
// "" for one with nobody but the machine sailor aboard. With mu held.
func (h *helm) aboardWords(s *Sea, f *bus.Frame, sl int32) string {
	me := bus.Account(h.account)
	lo, hi := f.CrewOf(sl)
	crew := f.Owner[sl] != me
	if lo == hi && !crew {
		return ""
	}
	holder := f.Holder[sl]
	who := func(a bus.Account, name string, machine bool, seat uint8) string {
		var marks []string
		if a == me {
			marks = append(marks, "you")
		} else if machine {
			marks = append(marks, "machine")
		} else {
			marks = append(marks, "human")
			if a == bus.Account(h.human) && h.human != ([16]byte{}) {
				marks = append(marks, "your owner")
			}
		}
		if seat == 0 {
			marks = append(marks, "skipper")
		} else {
			marks = append(marks, fmt.Sprintf("seat %d", seat))
		}
		if seat == 0 && holder == (bus.Account{}) || seat > 0 && holder == a {
			marks = append(marks, "holds the controls")
		}
		if a == me {
			return "you (" + strings.Join(marks[1:], ", ") + ")"
		}
		if name == "" {
			name = "a sailor"
		}
		return playerText(name) + " (" + strings.Join(marks, ", ") + ")"
	}
	skipperName := ""
	if crew && s.Chat != nil {
		skipperName = s.Chat.Name(f.Owner[sl])
	}
	people := []string{who(f.Owner[sl], skipperName, f.Machine[sl], 0)}
	for _, a := range f.Crew[lo:hi] {
		people = append(people, who(a.Account, a.Name, a.Machine, a.Seat))
	}
	line := strings.Join(people, " · ")
	if !crew {
		return line
	}
	if holder != me {
		line += " · you don't hold the controls: steer and trim wait until you are handed them (boat take)"
	}
	return line
}
