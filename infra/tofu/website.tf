# SPDX-License-Identifier: AGPL-3.0-only
# The website at the apex, keelovertheedge.com: a Worker with its static
# assets, which wrangler deploys with its custom domain (the custom domain
# makes the apex's record, so none is made here). What lasts beyond a
# deploy is here: the Worker's KV namespace, where its cron keeps the last
# good copy of the world's map, and the redirects in front of it.

resource "cloudflare_workers_kv_namespace" "website" {
  account_id = var.cloudflare_account_id
  title      = "website"
}

output "website_kv_namespace_id" {
  description = "The website's KV namespace, which wrangler binds the Worker to."
  value       = cloudflare_workers_kv_namespace.website.id
}

# www. answers nothing of its own: a redirect needs a proxied name, and
# 100:: is the address for one that goes nowhere (RFC 6666).
resource "cloudflare_dns_record" "www" {
  zone_id = var.cloudflare_zone_id
  name    = local.www
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
}

# www. to the apex, the path and query kept; the apex's /play to the game,
# its query kept, as a link to watch (?w=…) carries one.
resource "cloudflare_ruleset" "redirects" {
  zone_id = var.cloudflare_zone_id
  name    = "redirects"
  kind    = "zone"
  phase   = "http_request_dynamic_redirect"
  rules = [
    {
      ref         = "www"
      description = "www. to the website"
      expression  = "(http.host eq \"${local.www}\")"
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code           = 301
          target_url            = { expression = "concat(\"https://${local.domain}\", http.request.uri.path)" }
          preserve_query_string = true
        }
      }
    },
    {
      ref         = "play"
      description = "The website's /play to the game"
      expression  = "(http.host eq \"${local.domain}\" and http.request.uri.path in {\"/play\" \"/play/\"})"
      action      = "redirect"
      action_parameters = {
        from_value = {
          status_code           = 302
          target_url            = { value = "https://${local.play}/" }
          preserve_query_string = true
        }
      }
    },
  ]
}
