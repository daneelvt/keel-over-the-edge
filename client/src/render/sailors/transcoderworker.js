// SPDX-License-Identifier: AGPL-3.0-only

// The texture transcoder's worker, started from this file of the page's own
// (transcoder.ts) rather than from a blob: a worker started from a blob
// keeps the page's policy, which lets no string be run as code, and the
// Basis transcoder (Emscripten's embind) makes its functions from strings.
// A worker started from a file has the policy its file came with, and keel
// sends none with the page's assets. It runs what three.js's KTX2Loader
// built, a blob of this page's own named after the # of its address, and
// nothing else.
//
// three.js's blob has no type, and WebKit's importScripts refuses a script
// without a JavaScript type ("Load failed"). So the blob is read here and
// run as a copy that has one; read at once (a worker may), so the
// transcoder listens before any message from the page is handed to it.

{
  const source = decodeURIComponent(self.location.hash.slice(1));
  if (!source.startsWith(`blob:${self.location.origin}/`)) {
    throw new Error('The transcoder runs only a blob of this page’s own.');
  }
  const read = new XMLHttpRequest();
  read.open('GET', source, false);
  read.send();
  const typed = URL.createObjectURL(new Blob([read.responseText], { type: 'text/javascript' }));
  try {
    importScripts(typed);
  } finally {
    URL.revokeObjectURL(typed);
  }
}
