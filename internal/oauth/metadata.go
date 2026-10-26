// SPDX-License-Identifier: AGPL-3.0-only

package oauth

import (
	"encoding/json"
	"net/http"
)

// Metadata is the authorization server's metadata (RFC 8414), at
// /.well-known/oauth-authorization-server: the issuer has no path, so it
// is the first address every app tries. No OpenID Connect discovery is
// offered, and no offline_access scope: refresh tokens are always issued.
type Metadata struct {
	Issuer                                     string   `json:"issuer"`
	AuthorizationEndpoint                      string   `json:"authorization_endpoint"`
	TokenEndpoint                              string   `json:"token_endpoint"`
	RevocationEndpoint                         string   `json:"revocation_endpoint"`
	RegistrationEndpoint                       string   `json:"registration_endpoint"`
	ResponseTypesSupported                     []string `json:"response_types_supported"`
	GrantTypesSupported                        []string `json:"grant_types_supported"`
	CodeChallengeMethodsSupported              []string `json:"code_challenge_methods_supported"`
	TokenEndpointAuthMethodsSupported          []string `json:"token_endpoint_auth_methods_supported"`
	RevocationEndpointAuthMethodsSupported     []string `json:"revocation_endpoint_auth_methods_supported"`
	ScopesSupported                            []string `json:"scopes_supported"`
	ClientIDMetadataDocumentSupported          bool     `json:"client_id_metadata_document_supported"`
	AuthorizationResponseIssParameterSupported bool     `json:"authorization_response_iss_parameter_supported"`
}

// Scope is the one scope a grant has: to sail the machine sailor.
const Scope = "sail"

// MetadataOf is the server's metadata for an issuer.
func MetadataOf(issuer string) Metadata {
	return Metadata{
		Issuer:                                     issuer,
		AuthorizationEndpoint:                      issuer + "/oauth/authorize",
		TokenEndpoint:                              issuer + "/oauth/token",
		RevocationEndpoint:                         issuer + "/oauth/revoke",
		RegistrationEndpoint:                       issuer + "/oauth/register",
		ResponseTypesSupported:                     []string{"code"},
		GrantTypesSupported:                        []string{"authorization_code", "refresh_token"},
		CodeChallengeMethodsSupported:              []string{"S256"},
		TokenEndpointAuthMethodsSupported:          []string{"none"},
		RevocationEndpointAuthMethodsSupported:     []string{"none"},
		ScopesSupported:                            []string{Scope},
		ClientIDMetadataDocumentSupported:          true,
		AuthorizationResponseIssParameterSupported: true,
	}
}

func (s *Server) metadata(w http.ResponseWriter, _ *http.Request) {
	body, _ := json.Marshal(MetadataOf(s.cfg.Issuer))
	cors(w)
	h := w.Header()
	h.Set("Content-Type", "application/json")
	h.Set("Cache-Control", "public, max-age=300")
	h.Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(append(body, '\n'))
}
