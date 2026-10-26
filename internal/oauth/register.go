// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"golang.org/x/time/rate"

	"github.com/daneelvt/keel-over-the-edge/internal/auth"
	"github.com/daneelvt/keel-over-the-edge/internal/obs"
	"github.com/daneelvt/keel-over-the-edge/internal/store"
)

// Dynamic registration (RFC 7591): an app that reads no client metadata
// document registers itself, and is issued a client ID. MCP deprecates it,
// but some main apps have no other way in. Every app registered is a
// public client, issued no secret, whatever it asks for (RFC 7591, 3.2.1:
// the server may replace what a client asks). Hosted apps register from
// their makers' servers, which many players share, so the limit is on
// registrations in all, not per address; the job deletes those unused.

// RegistrationsPerHour bounds registrations, of every app together.
const RegistrationsPerHour = 120

type registrations struct{ limit *rate.Limiter }

func newRegistrations(perHour int) *registrations {
	if perHour <= 0 {
		perHour = RegistrationsPerHour
	}
	return &registrations{limit: rate.NewLimiter(rate.Limit(float64(perHour)/3600), perHour)}
}

// unnamed is the name of an app that gives none.
const unnamed = "An app with no name"

// registration is a registration's request, as far as the game reads it.
type registration struct {
	RedirectURIs            []string `json:"redirect_uris"`
	ClientName              *string  `json:"client_name"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	ApplicationType         string   `json:"application_type"`
	ClientURI               string   `json:"client_uri"`
	Scope                   string   `json:"scope"`
}

// registered is a registration's answer: the metadata as kept.
type registered struct {
	ClientID                string   `json:"client_id"`
	ClientIDIssuedAt        int64    `json:"client_id_issued_at"`
	ClientName              string   `json:"client_name"`
	RedirectURIs            []string `json:"redirect_uris"`
	GrantTypes              []string `json:"grant_types"`
	ResponseTypes           []string `json:"response_types"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	ApplicationType         string   `json:"application_type,omitempty"`
	ClientURI               string   `json:"client_uri,omitempty"`
	Scope                   string   `json:"scope"`
}

func (s *Server) refuseRegistration(w http.ResponseWriter, code, words string) {
	s.cfg.Metrics.OAuthRegistered.WithLabelValues("refused").Inc()
	writeOAuthError(w, http.StatusBadRequest, code, words)
}

// register answers POST /oauth/register.
//
//	201 the client registered
//	400 {"error":"invalid_redirect_uri"|"invalid_client_metadata", …}
//	429 too many registrations lately, with Retry-After
func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	cors(w)
	if mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		s.refuseRegistration(w, "invalid_client_metadata", "The registration is JSON.")
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		s.refuseRegistration(w, "invalid_client_metadata", "The registration could not be read.")
		return
	}
	var req registration
	if err := json.Unmarshal(body, &req); err != nil {
		s.refuseRegistration(w, "invalid_client_metadata", "The registration could not be read.")
		return
	}
	if !redirectList(req.RedirectURIs) {
		s.refuseRegistration(w, "invalid_redirect_uri", "Each redirect URI must be https, or http to this computer (127.0.0.1, [::1] or localhost); one to ten of them.")
		return
	}
	name := unnamed
	if req.ClientName != nil {
		n, ok := clientName(*req.ClientName)
		if !ok {
			s.refuseRegistration(w, "invalid_client_metadata", "The client's name must be 1 to 100 characters.")
			return
		}
		name = n
	}
	for _, g := range req.GrantTypes {
		if g != "authorization_code" && g != "refresh_token" {
			s.refuseRegistration(w, "invalid_client_metadata", "The grant types are authorization_code and refresh_token.")
			return
		}
	}
	for _, t := range req.ResponseTypes {
		if t != "code" {
			s.refuseRegistration(w, "invalid_client_metadata", "The response type is code.")
			return
		}
	}
	if !s.reg.limit.Allow() {
		s.cfg.Metrics.OAuthRegistered.WithLabelValues("limited").Inc()
		w.Header().Set("Retry-After", strconv.Itoa(int(time.Hour/time.Duration(RegistrationsPerHour)/time.Second)))
		writeOAuthError(w, http.StatusTooManyRequests, "temporarily_unavailable", "Too many apps registered lately: try again in a minute.")
		return
	}
	out := registered{
		ClientName: name, RedirectURIs: req.RedirectURIs,
		GrantTypes: []string{"authorization_code", "refresh_token"}, ResponseTypes: []string{"code"},
		TokenEndpointAuthMethod: "none", ApplicationType: req.ApplicationType, ClientURI: req.ClientURI, Scope: Scope,
	}
	now := s.cfg.Now()
	id, err := auth.Issue(s.cfg.Log, "client ID", NewClientID, func(id string) error {
		out.ClientID, out.ClientIDIssuedAt = id, now.Unix()
		meta, _ := json.Marshal(out)
		return s.cfg.Store.RegisterClient(r.Context(), store.Client{ID: id, Name: name, RedirectURIs: req.RedirectURIs, Metadata: meta})
	})
	if errors.Is(err, store.ErrTokenTaken) || err != nil {
		s.cfg.Log.Warn("registering a client", "request_id", obs.RequestID(r.Context()), "err", err)
		writeOAuthError(w, http.StatusServiceUnavailable, "temporarily_unavailable", "The registration could not be kept: try again.")
		return
	}
	out.ClientID = id
	s.cfg.Metrics.OAuthRegistered.WithLabelValues("registered").Inc()
	s.cfg.Log.Info("an app registered", "request_id", obs.RequestID(r.Context()), "client", id, "name", name)
	writeJSON(w, http.StatusCreated, out)
}
