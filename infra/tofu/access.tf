# SPDX-License-Identifier: AGPL-3.0-only
# The game's status, GET /api/status on play., is the website's: only its
# Worker may read it. Cloudflare Access stands in front of that one path
# with a Service Auth policy that lets through one service token, the
# Worker's, and refuses everyone else before the tunnel; keel checks the
# token Access signs what it lets through with too, so either lock holds
# alone (docs/development.md, "/api/status").

# The Zero Trust organisation: its team's domain, which signs Access's
# tokens.
data "cloudflare_zero_trust_organization" "team" {
  account_id = var.cloudflare_account_id
}

# The token lasts a year; an e-mail comes a week before it ends
# (notifications.tf). Two numbers move it on, each by an apply, whose
# deploy hands the Worker what is new (infra/MANUAL-STEPS.md):
#
#   - website_token_term: raising it replaces the token, a new one for a
#     year from then, with a new ID and secret: the yearly renewal.
#   - website_token_generation: raising it gives the token a new secret,
#     the same ID and end, the old secret still let through until
#     website_token_old_until, set a little after the apply (an hour,
#     say): a rotation, for a secret that may have leaked.
locals {
  website_token_term       = 1
  website_token_generation = 1
  website_token_old_until  = "2026-11-17T00:00:00Z"
}

resource "terraform_data" "website_token_term" {
  input = local.website_token_term
}

resource "cloudflare_zero_trust_access_service_token" "website" {
  account_id            = var.cloudflare_account_id
  name                  = "website"
  duration              = "8760h"
  client_secret_version = local.website_token_generation
  # The secret before the last rotation: let through until then.
  previous_client_secret_expires_at = local.website_token_old_until

  lifecycle {
    replace_triggered_by  = [terraform_data.website_token_term]
    create_before_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "website" {
  account_id = var.cloudflare_account_id
  name       = "The website's Worker"
  decision   = "non_identity"
  include = [
    { service_token = { token_id = cloudflare_zero_trust_access_service_token.website.id } },
  ]
}

# The one path. A request without the token is answered 401, never sent to
# a sign-in page: no person ever signs in here.
resource "cloudflare_zero_trust_access_application" "status" {
  account_id                = var.cloudflare_account_id
  name                      = "The game's status"
  type                      = "self_hosted"
  destinations              = [{ type = "public", uri = "${local.play}/api/status" }]
  policies                  = [{ id = cloudflare_zero_trust_access_policy.website.id, precedence = 1 }]
  service_auth_401_redirect = true
  app_launcher_visible      = false
}

# keel's settings for its check: the team's domain and the application's
# audience tag, which Cloudflare makes. Neither is a secret; they reach
# keel through Infisical, which the cluster's External Secrets reads into
# the Secret keel-access, so nothing is copied by hand.
resource "infisical_secret_folder" "keel_access" {
  project_id       = var.cluster_project_id
  environment_slug = local.cluster_environment
  folder_path      = "/"
  name             = "keel-access"
}

resource "infisical_secret" "access_team" {
  workspace_id = var.cluster_project_id
  env_slug     = local.cluster_environment
  folder_path  = infisical_secret_folder.keel_access.path
  name         = "KEEL_ACCESS_TEAM"
  value        = data.cloudflare_zero_trust_organization.team.auth_domain
}

resource "infisical_secret" "access_aud" {
  workspace_id = var.cluster_project_id
  env_slug     = local.cluster_environment
  folder_path  = infisical_secret_folder.keel_access.path
  name         = "KEEL_ACCESS_AUD"
  value        = cloudflare_zero_trust_access_application.status.aud
}

# The token for the website's deploy, which hands it to wrangler as the
# Worker's secrets: kept in the (encrypted) state, never printed.
output "website_access_client_id" {
  description = "The website's service token's client ID, the Worker's CF-Access-Client-Id."
  value       = cloudflare_zero_trust_access_service_token.website.client_id
  sensitive   = true
}

output "website_access_client_secret" {
  description = "The website's service token's secret, the Worker's CF-Access-Client-Secret."
  value       = cloudflare_zero_trust_access_service_token.website.client_secret
  sensitive   = true
}
