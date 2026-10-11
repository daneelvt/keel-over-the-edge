# SPDX-License-Identifier: AGPL-3.0-only
# What the configuration is given. The identifiers are
# infra/production.yaml's, passed by go run ./tools/accounts; the
# passphrase and the owner's address are read from Infisical by the same
# tool and reach OpenTofu in its environment alone (TF_VAR_…).

variable "cloudflare_account_id" {
  description = "The Cloudflare account that owns the tunnel."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "The zone keelovertheedge.com."
  type        = string
}

variable "infisical_host" {
  description = "Infisical's region, as https://us.infisical.com."
  type        = string
}

variable "infisical_identity_id" {
  description = "gha-accounts, the identity the accounts workflow signs in to Infisical as, with the job's OIDC token."
  type        = string
}

variable "cluster_project_id" {
  description = "keel-cluster, the Infisical project the cluster's External Secrets reads."
  type        = string
}

variable "notify_email" {
  description = "Where Cloudflare's tunnel alerts and certificate authorities' reports go: the owner's address, kept out of the repository."
  type        = string
  sensitive   = true
}

variable "state_passphrase" {
  description = "The passphrase the state's and plans' key is made from."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.state_passphrase) >= 16
    error_message = "OpenTofu's pbkdf2 key provider needs a passphrase of at least 16 characters."
  }
}

locals {
  domain = "keelovertheedge.com"
  play   = "play.${local.domain}"
  # Every secret the cluster reads is in keel-cluster's one environment.
  cluster_environment = "prod"
}
