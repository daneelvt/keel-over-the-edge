# SPDX-License-Identifier: AGPL-3.0-only
# The zone's records: play., agents., and what keeps certificates and
# e-mail from being issued or sent in the domain's name. Nothing else: no
# apex or www record yet.

# play. through Cloudflare to the tunnel.
resource "cloudflare_dns_record" "play" {
  zone_id = var.cloudflare_zone_id
  name    = local.play
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.prod.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1 # automatic, as for every proxied record
}

# agents., the MCP address AI apps connect to, through Cloudflare to the
# same tunnel.
resource "cloudflare_dns_record" "agents" {
  zone_id = var.cloudflare_zone_id
  name    = local.agents
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.prod.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
}

# The zone signed. Its DS record is entered at the registrar by hand once
# (infra/MANUAL-STEPS.md), from Cloudflare's DNS settings.
resource "cloudflare_zone_dnssec" "zone" {
  zone_id = var.cloudflare_zone_id
  status  = "active"
}

# Only the certificate authorities Cloudflare's Universal SSL uses may
# issue for the domain (Cloudflare's documentation, "CAA records"; it adds
# them by itself too once a zone has any CAA record), and a refused request
# is reported to the owner.
locals {
  universal_ssl_cas = ["letsencrypt.org", "pki.goog; cansignhttpexchanges=yes", "ssl.com", "sectigo.com"]
  caa = merge(
    { for ca in local.universal_ssl_cas : "issue ${split(";", ca)[0]}" => { tag = "issue", value = ca } },
    { for ca in local.universal_ssl_cas : "issuewild ${split(";", ca)[0]}" => { tag = "issuewild", value = ca } },
    { iodef = { tag = "iodef", value = "mailto:${var.notify_email}" } },
  )
}

resource "cloudflare_dns_record" "caa" {
  for_each = local.caa
  zone_id  = var.cloudflare_zone_id
  name     = local.domain
  type     = "CAA"
  ttl      = 3600
  data = {
    flags = 0
    tag   = each.value.tag
    value = each.value.value
  }
}

# The domain sends no e-mail and receives none: a null MX (RFC 7505), an
# SPF record that allows no sender, and DMARC rejecting whatever claims to
# come from it.
resource "cloudflare_dns_record" "null_mx" {
  zone_id  = var.cloudflare_zone_id
  name     = local.domain
  type     = "MX"
  content  = "."
  priority = 0
  ttl      = 3600
}

resource "cloudflare_dns_record" "spf" {
  zone_id = var.cloudflare_zone_id
  name    = local.domain
  type    = "TXT"
  content = "\"v=spf1 -all\""
  ttl     = 3600
}

resource "cloudflare_dns_record" "dmarc" {
  zone_id = var.cloudflare_zone_id
  name    = "_dmarc.${local.domain}"
  type    = "TXT"
  content = "\"v=DMARC1; p=reject\""
  ttl     = 3600
}
