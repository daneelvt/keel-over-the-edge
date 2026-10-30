# SPDX-License-Identifier: AGPL-3.0-only
# OpenTofu and its providers, each at an exact version from OpenTofu's
# registry, their files' hashes in .terraform.lock.hcl for every platform
# that runs them: a provider changes only by a reviewed pull request.
terraform {
  required_version = "~> 1.13.0"

  required_providers {
    cloudflare = {
      source  = "registry.opentofu.org/cloudflare/cloudflare"
      version = "5.28.1"
    }
    infisical = {
      source  = "registry.opentofu.org/infisical/infisical"
      version = "0.20.8"
    }
    random = {
      source  = "registry.opentofu.org/hashicorp/random"
      version = "3.9.1"
    }
  }
}
