# SPDX-License-Identifier: AGPL-3.0-only
# Cloudflare's provider reads its API token from CLOUDFLARE_API_TOKEN.
provider "cloudflare" {}

# Infisical's signs in as gha-accounts with a GitHub OIDC token of the
# job's own, which go run ./tools/accounts puts in INFISICAL_AUTH_JWT: it
# holds no credential of its own, and the tool no session the provider
# could use (Infisical's provider documentation, OIDC Auth).
provider "infisical" {
  host = var.infisical_host
  auth = {
    oidc = {
      identity_id                     = var.infisical_identity_id
      token_environment_variable_name = "INFISICAL_AUTH_JWT"
    }
  }
}
