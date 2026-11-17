# SPDX-License-Identifier: AGPL-3.0-only
# The zone's settings, each set outright, so that a plan shows when
# Cloudflare changes a default under it. TLS from end to end, and nothing
# that rewrites the game's page or answers in its place: the page's
# content security policy allows no script Cloudflare would inject.

locals {
  zone_settings = {
    # Cloudflare checks the origin's certificate; the tunnel carries the
    # traffic, so this is what any other origin would be held to.
    ssl              = "strict"
    always_use_https = "on"
    min_tls_version  = "1.2"
    tls_1_3          = "on"
    # Early data can be replayed, and the account's routes make accounts,
    # sessions and passkeys.
    "0rtt"     = "off"
    websockets = "on"

    # Features that change a response or stand in for the game.
    # (content_converter, Markdown for agents, is not left to a free zone
    # to set: Cloudflare refuses to edit it.)
    always_online            = "off"
    automatic_https_rewrites = "off"
    email_obfuscation        = "off"
    rocket_loader            = "off"
    server_side_exclude      = "off"
    mirage                   = "off"
    pre_render               = "off"
    replace_insecure_js      = "off"
    webmcp_enabled           = "off"

    # CF-Connecting-IP carries a player's own IPv6 address, never a made-up
    # IPv4 one in its place: keel counts new sailors by an IPv6 /56.
    pseudo_ipv4 = "off"
  }

  # HSTS for six months (180 days), the zone's hosts included: the way in
  # has settled (it began at a day, so a mistake lasted no longer). No
  # preload: leaving a preload list takes months, and it would bind the
  # website's host too.
  hsts_max_age = 15552000
}

resource "cloudflare_zone_setting" "zone" {
  for_each   = local.zone_settings
  zone_id    = var.cloudflare_zone_id
  setting_id = each.key
  value      = each.value
}

resource "cloudflare_zone_setting" "hsts" {
  zone_id    = var.cloudflare_zone_id
  setting_id = "security_header"
  value = {
    strict_transport_security = {
      enabled            = true
      include_subdomains = true
      max_age            = local.hsts_max_age
      nosniff            = true
      preload            = false
    }
  }
}

# Bots and AI agents are players too: nothing blocks them for what they
# are. Bot Fight Mode cannot be told what to leave alone on the free plan,
# so it is off; the rate rule and the game's own limits hold the line.
# Cloudflare's AI bot groups, search, training and agents acting for a
# person (its AI Crawl Control), are each allowed: "disabled" is the
# block switched off.
resource "cloudflare_bot_management" "zone" {
  zone_id                 = var.cloudflare_zone_id
  fight_mode              = false
  enable_js               = false
  ai_bots_protection      = "disabled"
  crawler_protection      = "disabled"
  content_bots_protection = "disabled"
  aisearch                = "disabled"
  ai_training             = "disabled"
  ai_user                 = "disabled"
}
