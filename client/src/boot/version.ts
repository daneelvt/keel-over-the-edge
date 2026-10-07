// SPDX-License-Identifier: AGPL-3.0-only

// The server's version, and whether its catalog matches the client's. A
// client and a server with different catalogs never play together.

export interface ServerVersion {
  build: string;
  catalog: string;
}

export function parseVersion(value: unknown): ServerVersion | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const { build, catalog } = value as Record<string, unknown>;
  if (typeof build !== 'string' || typeof catalog !== 'string') {
    return null;
  }
  return { build, catalog };
}

export function catalogsMatch(server: ServerVersion, clientCatalog: string): boolean {
  return server.catalog === clientCatalog;
}

export async function fetchVersion(fetchFn: typeof fetch = fetch): Promise<ServerVersion> {
  const res = await fetchFn('/api/version', { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`/api/version answered ${res.status}`);
  }
  const version = parseVersion(await res.json());
  if (!version) {
    throw new Error('/api/version answered something else than a version');
  }
  return version;
}
