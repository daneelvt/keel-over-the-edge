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

# The database's two read-only roles, and Grafana's admin: each password
# made the same way, ephemeral, written once and kept in Infisical alone.
# reader is the owner's, for psql; grafana is Grafana's, for its SQL data
# source, written twice: under /keel, where CloudNativePG sets the role's
# password from it, and under /monitoring, where Grafana reads it (a
# namespace's ExternalSecret reads its own folder).

ephemeral "random_password" "reader" {
  length  = 48
  special = false
}

ephemeral "random_password" "grafana_role" {
  length  = 48
  special = false
}

ephemeral "random_password" "grafana_admin" {
  length  = 48
  special = false
}

resource "infisical_secret_folder" "monitoring" {
  project_id       = var.cluster_project_id
  environment_slug = local.cluster_environment
  folder_path      = "/"
  name             = "monitoring"
}

resource "infisical_secret" "reader_password" {
  workspace_id     = var.cluster_project_id
  env_slug         = local.cluster_environment
  folder_path      = infisical_secret_folder.keel.path
  name             = "DB_READER_PASSWORD"
  value_wo         = ephemeral.random_password.reader.result
  value_wo_version = 1
}

# The two copies of grafana's password share a version: bumping it writes
# one new password to both.
locals {
  grafana_role_generation = 1
}

resource "infisical_secret" "grafana_role_password" {
  workspace_id     = var.cluster_project_id
  env_slug         = local.cluster_environment
  folder_path      = infisical_secret_folder.keel.path
  name             = "DB_GRAFANA_PASSWORD"
  value_wo         = ephemeral.random_password.grafana_role.result
  value_wo_version = local.grafana_role_generation
}

resource "infisical_secret" "grafana_role_password_for_grafana" {
  workspace_id     = var.cluster_project_id
  env_slug         = local.cluster_environment
  folder_path      = infisical_secret_folder.monitoring.path
  name             = "DB_GRAFANA_PASSWORD"
  value_wo         = ephemeral.random_password.grafana_role.result
  value_wo_version = local.grafana_role_generation
}

resource "infisical_secret" "grafana_admin_password" {
  workspace_id     = var.cluster_project_id
  env_slug         = local.cluster_environment
  folder_path      = infisical_secret_folder.monitoring.path
  name             = "GRAFANA_ADMIN_PASSWORD"
  value_wo         = ephemeral.random_password.grafana_admin.result
  value_wo_version = 1
}
