// SPDX-License-Identifier: AGPL-3.0-only

// The texture transcoder's worker, started from this file of the page's own
// (transcoder.ts) rather than from a blob: a worker started from a blob
// keeps the page's policy, which lets no string be run as code, and the
// Basis transcoder (Emscripten's embind) makes its functions from strings.
// A worker started from a file has the policy its file came with, and keel
// sends none with the page's assets. It runs what three.js's KTX2Loader
// built, a blob of this page's own named after the # of its address, and
// nothing else.

{
  const source = decodeURIComponent(self.location.hash.slice(1));
  if (!source.startsWith(`blob:${self.location.origin}/`)) {
    throw new Error('The transcoder runs only a blob of this page’s own.');
  }
  importScripts(source);
}
