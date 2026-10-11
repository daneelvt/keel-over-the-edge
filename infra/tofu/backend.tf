# SPDX-License-Identifier: AGPL-3.0-only
# OpenTofu's state, in the private B2 bucket kept for it, through B2's S3
# API. The bucket, its region and its endpoint are infra/production.yaml's,
# given to tofu init by go run ./tools/accounts (a backend reads no
# variables); its key is the B2 application key for this bucket alone.
# B2 keeps every version of the object, so an earlier state is never lost.
#
# The state holds the tunnel's secret and token, which Cloudflare's
# provider keeps in it, so the state and every saved plan are encrypted
# with a key made from the passphrase (OpenTofu's "State and plan
# encryption"), and enforced: a run without the passphrase fails rather
# than write either in plain text.
terraform {
  backend "s3" {
    key = "accounts/terraform.tfstate"

    # B2 is not AWS: no account, no instance metadata, its own regions,
    # and no S3 checksums (OpenTofu's S3 backend documentation).
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true

    # OpenTofu locks with a conditional write (If-None-Match), which B2 is
    # reported to refuse. Two runs are kept apart by the workflows'
    # concurrency group instead: every workflow that changes production
    # waits for the one before it.
    use_lockfile = false
  }

  encryption {
    key_provider "pbkdf2" "passphrase" {
      passphrase = var.state_passphrase
    }
    method "aes_gcm" "passphrase" {
      keys = key_provider.pbkdf2.passphrase
    }
    state {
      method   = method.aes_gcm.passphrase
      enforced = true
    }
    plan {
      method   = method.aes_gcm.passphrase
      enforced = true
    }
  }
}
