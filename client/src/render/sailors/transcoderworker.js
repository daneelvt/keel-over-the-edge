// SPDX-License-Identifier: AGPL-3.0-only

// The texture transcoder's worker, started from this file of the page's own
// (transcoder.ts) rather than from a blob: a worker started from a blob
// keeps the page's policy, which lets no string be run as code, and the
// Basis transcoder (Emscripten's embind) makes its functions from strings.
// A worker started from a file has the policy its file came with, and keel
// sends none with the page's assets. It runs what three.js's KTX2Loader
// built, a blob of this page's own, and nothing else.
//
// The page names the blob in its first message. Not in the # of this
// file's address: a worker whose file the service worker answers has the
// address the answer was kept under, which has no #, and so on every
// visit after the first there was no blob to run and no sailor drawn.
//
// three.js's blob has no type, and WebKit's importScripts refuses a script
// without a JavaScript type ("Load failed"). So the blob is read here and
// run as a copy that has one; read at once (a worker may), within the
// first message's turn, so the transcoder listens before the page's next
// message is handed to it.

self.addEventListener(
  'message',
  (e) => {
    const source = e.data?.type === 'start' ? String(e.data.source) : '';
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
  },
  { once: true },
);
