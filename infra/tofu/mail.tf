# SPDX-License-Identifier: AGPL-3.0-only
# The contact address, which the website and the game's privacy and safety
# pages give: Cloudflare's Email Routing receives its mail and forwards it
# to the owner's own address, which is in no file here and in no DNS
# record. Every other address in the domain is refused. Nothing is sent in
# the domain's name: an answer goes out from the owner's own address.

# Email Routing on for the zone: Cloudflare adds its MX records and its
# DKIM key and locks them. It adds no SPF record to a zone that has one,
# hence after ours, which names its include (dns.tf). It refuses a zone
# with an MX record of another's (its error 2008): the null MX this zone
# had is removed by the apply that first makes this, in no order OpenTofu
# keeps, so that one apply may need running twice (infra/MANUAL-STEPS.md).
# No name: Cloudflare takes one for a subdomain alone, and refuses the
# zone's own (its error 2007).
resource "cloudflare_email_routing_dns" "zone" {
  zone_id = var.cloudflare_zone_id

  depends_on = [cloudflare_dns_record.spf]
}

# Where the mail goes. Cloudflare sends this address a link when it is
# made, and forwards nothing until the link is followed.
resource "cloudflare_email_routing_address" "owner" {
  account_id = var.cloudflare_account_id
  email      = var.notify_email
}

resource "cloudflare_email_routing_rule" "contact" {
  zone_id = var.cloudflare_zone_id
  name    = "The contact address, to the owner"
  enabled = true
  matchers = [{
    type  = "literal"
    field = "to"
    value = local.contact
  }]
  actions = [{
    type  = "forward"
    value = [var.notify_email]
  }]

  depends_on = [cloudflare_email_routing_dns.zone, cloudflare_email_routing_address.owner]
}
