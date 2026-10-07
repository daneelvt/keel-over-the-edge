// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATALOG_VERSION, catalog } from '.';

describe('catalog', () => {
  it('has boats with every required field', () => {
    expect(catalog.boats.length).toBeGreaterThan(0);
    for (const b of catalog.boats) {
      expect(b.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(b.name).not.toBe('');
      expect(b.capacity).toBeGreaterThanOrEqual(1);
      expect(b.lengthOverall).toBeGreaterThan(0);
    }
  });

  it('is the same data, and the same version, as the server has', () => {
    const goJSON = readFileSync(
      new URL('../../../internal/catalog/catalog.gen.json', import.meta.url),
      'utf8',
    );
    const goTypes = readFileSync(
      new URL('../../../internal/catalog/types.gen.go', import.meta.url),
      'utf8',
    );
    expect(JSON.parse(goJSON)).toEqual(catalog);
    expect(goTypes).toContain(`const Version = "${CATALOG_VERSION}"`);
  });
});
