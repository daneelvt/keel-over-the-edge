# SPDX-License-Identifier: AGPL-3.0-only
# An e-mail to the owner when the tunnel's health changes: the way in,
# watched from outside the machine.
resource "cloudflare_notification_policy" "tunnel" {
  account_id  = var.cloudflare_account_id
  name        = "keel-prod tunnel health"
  description = "The tunnel to production is degraded, down, or healthy again."
  alert_type  = "tunnel_health_event"
  enabled     = true
  filters = {
    tunnel_id = [cloudflare_zero_trust_tunnel_cloudflared.prod.id]
  }
  mechanisms = {
    email = [{ id = var.notify_email }]
  }
}

# An e-mail to the owner a week before an Access service token expires:
# the website's, which reads the game's status, lasts a year
# (access.tf).
resource "cloudflare_notification_policy" "service_token" {
  account_id  = var.cloudflare_account_id
  name        = "Access service token expiring"
  description = "The website's service token ends within a week: renew it by raising its generation and applying."
  alert_type  = "expiring_service_token_alert"
  enabled     = true
  mechanisms = {
    email = [{ id = var.notify_email }]
  }
}
