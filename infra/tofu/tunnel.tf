# SPDX-License-Identifier: AGPL-3.0-only
# The one way in for players: a tunnel that cloudflared, in the cluster,
# dials out to, so nothing listens on the machine. Managed remotely: its
# routes are here, and the cluster holds nothing but its token.

# The tunnel's generation: raising it replaces the tunnel, with a new ID,
# record and token, and writes the new token into Infisical. That is how
# the tunnel's credential is rotated (docs/development.md, "Online").
locals {
  tunnel_generation = 1
}

resource "terraform_data" "tunnel_generation" {
  input = local.tunnel_generation
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "prod" {
  account_id = var.cloudflare_account_id
  name       = "keel-prod"
  # Cloudflare makes the tunnel's secret, and its routes live at
  # Cloudflare rather than in a file beside cloudflared.
  config_src = "cloudflare"

  lifecycle {
    replace_triggered_by = [terraform_data.tunnel_generation]
  }
}

# play. goes to Traefik inside the cluster, which routes by host as
# before, keeping the original Host header; anything else that reaches the
# tunnel is refused.
resource "cloudflare_zero_trust_tunnel_cloudflared_config" "prod" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.prod.id
  config = {
    ingress = [
      {
        hostname = local.play
        service  = "http://traefik.kube-system.svc.cluster.local:80"
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

# The token cloudflared runs with. Cloudflare's provider keeps it in the
# (encrypted) state; it reaches Infisical write-only, so not a second time.
data "cloudflare_zero_trust_tunnel_cloudflared_token" "prod" {
  account_id = var.cloudflare_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.prod.id
}

resource "infisical_secret_folder" "cloudflared" {
  project_id       = var.cluster_project_id
  environment_slug = local.cluster_environment
  folder_path      = "/"
  name             = "cloudflared"
}

resource "infisical_secret" "tunnel_token" {
  workspace_id = var.cluster_project_id
  env_slug     = local.cluster_environment
  folder_path  = infisical_secret_folder.cloudflared.path
  name         = "TUNNEL_TOKEN"
  value_wo     = data.cloudflare_zero_trust_tunnel_cloudflared_token.prod.token
  # Written again whenever the tunnel is replaced.
  value_wo_version = local.tunnel_generation
}
