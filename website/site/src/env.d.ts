// SPDX-License-Identifier: AGPL-3.0-only

// What Vite gives the page's script: its style sheet, imported for its
// effect, and the sky's clock from the catalog (vite.config.ts).

declare module '*.css' {}

declare const __SKY__: import('./sky').SkyClock;
