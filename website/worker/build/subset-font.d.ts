// SPDX-License-Identifier: AGPL-3.0-only

// subset-font's one function, which ships no types of its own.
declare module 'subset-font' {
  export default function subsetFont(
    font: Uint8Array,
    text: string,
    options?: { targetFormat?: 'sfnt' | 'woff' | 'woff2' },
  ): Promise<Uint8Array>;
}
