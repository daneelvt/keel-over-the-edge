// SPDX-License-Identifier: AGPL-3.0-only

// A file read as text by Vite, as the tests read the static files' headers.
declare module '*?raw' {
  const text: string;
  export default text;
}
