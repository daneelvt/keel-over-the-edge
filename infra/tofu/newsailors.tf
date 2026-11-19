# SPDX-License-Identifier: AGPL-3.0-only
# New sailors: the human check every one of them passes, Cloudflare
# Turnstile's widget on the players' host, and the key keel keeps their
# addresses under for the day they count.
#
# The widget is managed: Cloudflare asks a visitor to act only when it
# doubts them. Its site key is public (the page renders the widget with
# it), its secret is keel's alone; both go to Infisical, under /keel, from
# where External Secrets hands them to keel together, so keel never has
# one without the other.
resource "cloudflare_turnstile_widget" "play" {
  account_id = var.cloudflare_account_id
  name       = "play"
  domains    = [local.play]
  mode       = "managed"
  region     = "world"
}

resource "infisical_secret" "turnstile_sitekey" {
  workspace_id = var.cluster_project_id
  env_slug     = local.cluster_environment
  folder_path  = infisical_secret_folder.keel.path
  name         = "TURNSTILE_SITEKEY"
  value        = cloudflare_turnstile_widget.play.sitekey
}

# The secret is in the (encrypted) state, as the widget's attribute;
# written to Infisical write-only, so no plan prints it.
resource "infisical_secret" "turnstile_secret" {
  workspace_id     = var.cluster_project_id
  env_slug         = local.cluster_environment
  folder_path      = infisical_secret_folder.keel.path
  name             = "TURNSTILE_SECRET"
  value_wo         = cloudflare_turnstile_widget.play.secret
  value_wo_version = 1
}

# The address key: 44 letters and digits, which keel reads as base64 of
# 33 bytes, made as the database's password is, ephemeral, in no plan and
# no state. Bumping value_wo_version makes a new one: every count of new
# sailors starts again, which is harmless.
ephemeral "random_password" "address_key" {
  length  = 44
  special = false
}

resource "infisical_secret" "address_key" {
  workspace_id     = var.cluster_project_id
  env_slug         = local.cluster_environment
  folder_path      = infisical_secret_folder.keel.path
  name             = "ADDRESS_KEY"
  value_wo         = ephemeral.random_password.address_key.result
  value_wo_version = 1
}
