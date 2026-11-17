// SPDX-License-Identifier: AGPL-3.0-only

// The website's security headers. The static files carry them from
// site/_headers; what the Worker answers carries them from here, since
// _headers never reaches a Worker's own answers. Keep the two the same.

/** Nothing but the site's own files, no frames, no forms: the page, and the map, whose letters are its own shapes. */
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

export const SECURITY: Readonly<Record<string, string>> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/** A response with the security headers set on it: a copy, its own headers being immutable for one fetched. */
export function secured(r: Response): Response {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(SECURITY)) {
    out.headers.set(k, v);
  }
  return out;
}
