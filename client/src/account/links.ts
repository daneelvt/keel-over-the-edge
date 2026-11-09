// SPDX-License-Identifier: AGPL-3.0-only

// The links the game is opened at, each a query on the page's own
// address: ?s=<token> a skipper's link to come aboard, ?w=<code> a
// sailor's to watch and ?f=<code> a fleet's. Once a link has been used,
// it is taken out of the address, the rest of the query kept, so that a
// reload just sails.

/** The query without keys, as a search string: "" or "?…". */
export function withoutParams(search: string, ...keys: string[]): string {
  const q = new URLSearchParams(search);
  for (const k of keys) {
    q.delete(k);
  }
  const s = q.toString();
  return s === '' ? '' : `?${s}`;
}

/** Takes keys out of the page's address, its path, the rest of its query and its hash kept. */
export function forgetParams(...keys: string[]): void {
  const search = withoutParams(location.search, ...keys);
  if (search !== location.search) {
    history.replaceState(history.state, '', `${location.pathname}${search}${location.hash}`);
  }
}
