# SPDX-License-Identifier: AGPL-3.0-only
# The zone's rules: what Cloudflare caches, what it refuses, and how fast
# one address may make accounts. Each phase has one ruleset per zone, its
# entry point, so each ruleset here holds every rule of its phase.

# The page's hashed assets are cached at the edge for as long as the game
# says (a year, immutable), and so are the world's chunks, at their signed
# addresses under /w/ (public, a year, immutable; any other address there is
# a 404 the game marks no-store). Cloudflare would cache .bin files by
# their extension alone, but the rule says so whatever its default list
# becomes. The game's status, which the website reads, is cached as the
# game says (30 s), so the website's readers never reach the game. The page
# and the rest of the API are not cached: Cloudflare caches neither by
# default, and the page says no-cache.
resource "cloudflare_ruleset" "cache" {
  zone_id = var.cloudflare_zone_id
  name    = "cache"
  kind    = "zone"
  phase   = "http_request_cache_settings"
  rules = [
    {
      ref         = "assets"
      description = "The page's hashed assets, as long as the origin says"
      expression  = "(http.host eq \"${local.play}\" and starts_with(http.request.uri.path, \"/assets/\"))"
      action      = "set_cache_settings"
      action_parameters = {
        cache       = true
        edge_ttl    = { mode = "respect_origin" }
        browser_ttl = { mode = "respect_origin" }
      }
    },
    {
      ref         = "chunks"
      description = "The world's chunks, as long as the origin says"
      expression  = "(http.host eq \"${local.play}\" and starts_with(http.request.uri.path, \"/w/\"))"
      action      = "set_cache_settings"
      action_parameters = {
        cache       = true
        edge_ttl    = { mode = "respect_origin" }
        browser_ttl = { mode = "respect_origin" }
      }
    },
    {
      ref         = "status"
      description = "The game's status, as long as the origin says"
      expression  = "(http.host eq \"${local.play}\" and http.request.uri.path eq \"/api/status\")"
      action      = "set_cache_settings"
      action_parameters = {
        cache       = true
        edge_ttl    = { mode = "respect_origin" }
        browser_ttl = { mode = "respect_origin" }
      }
    },
  ]
}

# Smart Tiered Cache: the data centres players reach ask one upper tier,
# and only it asks the origin, so a chunk leaves the game about once rather
# than once per data centre. It is free.
resource "cloudflare_tiered_cache" "zone" {
  zone_id = var.cloudflare_zone_id
  value   = "on"
}

# The game answers GET, HEAD and POST; the WebSocket's upgrade is a GET.
# Cloudflare's free managed ruleset stays on beside this, as it is.
resource "cloudflare_ruleset" "firewall" {
  zone_id = var.cloudflare_zone_id
  name    = "firewall"
  kind    = "zone"
  phase   = "http_request_firewall_custom"
  rules = [
    {
      ref         = "methods"
      description = "Only the methods the game answers"
      expression  = "(http.host eq \"${local.play}\" and not http.request.method in {\"GET\" \"HEAD\" \"POST\"})"
      action      = "block"
    },
  ]
}

# Accounts are made with no human check yet: a burst of them from one
# address is stopped at the edge. Signing in is never limited. The free plan's one rate rule: its expression may
# name the path alone, counting is per address (and per Cloudflare data
# centre, which every rule counts by), over 10 s, blocking for 10 s
# (Cloudflare's rate limiting rules, availability).
resource "cloudflare_ruleset" "rate" {
  zone_id = var.cloudflare_zone_id
  name    = "rate"
  kind    = "zone"
  phase   = "http_ratelimit"
  rules = [
    {
      ref         = "accounts"
      description = "New accounts: 10 in 10 s per address"
      expression  = "(http.request.uri.path eq \"/account/begin\")"
      action      = "block"
      ratelimit = {
        characteristics     = ["cf.colo.id", "ip.src"]
        period              = 10
        requests_per_period = 10
        mitigation_timeout  = 10
      }
    },
  ]
}

# Nothing added to the game's page: Cloudflare puts its Web Analytics
# beacon (Real User Monitoring, a script from static.cloudflareinsights.com)
# into every HTML answer of a proxied zone unless told not to, and Zaraz
# would add its own. The page loads its own scripts alone.
resource "cloudflare_ruleset" "config" {
  zone_id = var.cloudflare_zone_id
  name    = "config"
  kind    = "zone"
  phase   = "http_config_settings"
  rules = [
    {
      ref         = "nothing-injected"
      description = "No script of Cloudflare's in the game's page"
      expression  = "(http.host eq \"${local.play}\")"
      action      = "set_config"
      action_parameters = {
        disable_rum   = true
        disable_zaraz = true
      }
    },
  ]
}
