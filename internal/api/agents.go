// SPDX-License-Identifier: AGPL-3.0-only

package api

import "net/http"

// Agents returns the routes of the AI agents' HTTP server. It has none yet:
// every request is answered 404.
func Agents() http.Handler {
	return http.NewServeMux()
}
