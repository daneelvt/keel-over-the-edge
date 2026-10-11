# SPDX-License-Identifier: AGPL-3.0-only
# The database's password, made here and kept in Infisical alone: an
# ephemeral value is in no plan and no state (OpenTofu's ephemeral
# resources and write-only attributes; the random provider's ephemeral
# random_password). The cluster's External Secrets reads it into the
# Secret keel-db-app, which CloudNativePG makes the database with.
#
# Letters and digits only: nothing to quote in a URL, a shell or YAML.
# Bumping value_wo_version makes and writes a new one: the database keeps
# the old until it is changed there too (docs/development.md, "Online").

ephemeral "random_password" "database" {
  length  = 48
  special = false
}

resource "infisical_secret_folder" "keel" {
  project_id       = var.cluster_project_id
  environment_slug = local.cluster_environment
  folder_path      = "/"
  name             = "keel"
}

resource "infisical_secret" "database_password" {
  workspace_id     = var.cluster_project_id
  env_slug         = local.cluster_environment
  folder_path      = infisical_secret_folder.keel.path
  name             = "DB_PASSWORD"
  value_wo         = ephemeral.random_password.database.result
  value_wo_version = 1
}
