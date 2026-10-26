// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"time"

	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// The words an AI app is refused with: in the token endpoint's
// error_description (RFC 6749, 5.2) and the MCP address's
// WWW-Authenticate (RFC 6750, 3.1), which an app may show its player. They
// go in a header, so they are plain ASCII, with no quotation marks.

// day is a date as the words write it: 22 January.
func day(t time.Time, zone *time.Location) string {
	if zone == nil {
		zone = time.UTC
	}
	return t.In(zone).Format("2 January")
}

// EndedWords are the words for a token whose grant has ended: by the
// lifetime (why empty), or revoked by what why says; connection says the
// grant was a connection token's.
func EndedWords(connection bool, why string, at time.Time, zone *time.Location) string {
	if connection {
		switch why {
		case "":
			return "This connection token for Keel Over the Edge ended on " + day(at, zone) + ": make a new one on the account page."
		case store.RevokedReplaced:
			return "This connection token for Keel Over the Edge was replaced by a new one: use the new token, or make another on the account page."
		case store.RevokedOperator:
			return "This connection token for Keel Over the Edge was revoked by the game's operator: make a new one on the account page."
		default:
			return "This connection token for Keel Over the Edge was revoked on the account page: make a new one there."
		}
	}
	switch why {
	case "":
		return "This approval of Keel Over the Edge ended on " + day(at, zone) + ". Approve the app again from your AI app, with your passkey."
	case store.RevokedOwner:
		return "This approval of Keel Over the Edge was revoked on the account page. Approve the app again from your AI app, with your passkey."
	case store.RevokedReplaced:
		return "This approval of Keel Over the Edge was replaced: the app was approved again for this machine sailor. Use the newer approval."
	case store.RevokedReuse:
		return "This approval of Keel Over the Edge was ended because one of its tokens was used twice. Approve the app again, with your passkey."
	case store.RevokedOperator:
		return "This approval of Keel Over the Edge was revoked by the game's operator."
	default:
		return "This approval of Keel Over the Edge was revoked by the app. Approve the app again from your AI app, with your passkey."
	}
}

// WordsStopped are the words for a machine sailor stopped by the game's
// operator, or whose human is: at the MCP address, and as its waiting call
// ends.
const WordsStopped = "This machine sailor has been stopped by Keel Over the Edge: its tokens no longer work."

// The other words.
const (
	wordsExpired   = "The access token has expired: refresh it, or approve the app again."
	wordsInvalid   = "This is not a token of Keel Over the Edge, or it is no longer known. Approve the app again, or make a new connection token on the account page."
	wordsCode      = "The code is unknown, used already or expired. Approve the app again."
	wordsCodeTwice = "The code was used twice, so its approval was ended. Approve the app again."
	wordsClient    = "The token was issued to another app."
	wordsVerifier  = "The code verifier does not match the code challenge."
	wordsRedirect  = "The redirect URI is not the one the code was given for."
	wordsSecret    = "Keel Over the Edge's apps are public clients: send no client secret or assertion."
	wordsResource  = "The resource is not Keel Over the Edge's MCP address."
)
