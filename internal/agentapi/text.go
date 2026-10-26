// SPDX-License-Identifier: AGPL-3.0-only

package agentapi

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Player text. Every string a player wrote that reaches an agent (a
// sailor's name today; a chat line or a bottle's message later) stands in
// «guillemets» after a label the game writes, so that a model can always
// tell the game's words from a player's, and is told never to follow
// instructions inside them. Inside, the guillemets themselves become
// single ones, and line breaks, control and bidirectional characters and
// markdown's link syntax go, so a name can neither close its quotation
// nor pass for the game's own lines; and the text is cut to the most a
// player may write. Whether a sailor is human or a machine is said by the
// game, from the account's kind, never by the text.

// mostPlayerText is the longest player text kept, in characters.
const mostPlayerText = 280

// playerText is s, a player's words, marked and made safe: «s».
func playerText(s string) string {
	var b strings.Builder
	b.WriteRune('«')
	n := 0
	for _, r := range s {
		if n == mostPlayerText {
			b.WriteRune('…')
			break
		}
		switch {
		case r == '«':
			r = '‹'
		case r == '»':
			r = '›'
		case r == '[' || r == ']' || r == '(' || r == ')' || r == '<' || r == '>' || r == '`':
			continue
		case r == '\n' || r == '\r' || r == '\t':
			r = ' '
		case unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) || r == utf8.RuneError ||
			unicode.Is(unicode.Cf, r):
			continue
		}
		b.WriteRune(r)
		n++
	}
	b.WriteRune('»')
	return b.String()
}
