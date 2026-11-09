// SPDX-License-Identifier: AGPL-3.0-only

// The links the game is opened at, each a query on the page's own
// address: ?s=<token> a skipper's link to come aboard, ?w=<code> a
// sailor's to watch and ?f=<code> a fleet's. Once a link has been used,
// it is taken out of the address, the rest of the query kept, so that a
// reload just sails.

/** The query without keys, as a search string, "" or "?…", the rest as it was written. */
export function withoutParams(search: string, ...keys: string[]): string {
  const kept = (search.startsWith('?') ? search.slice(1) : search)
    .split('&')
    .filter((part) => {
      if (part === '') {
        return false;
      }
      const eq = part.indexOf('=');
      const key = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
      return !keys.includes(key);
    });
  return kept.length === 0 ? '' : `?${kept.join('&')}`;
}

/** Takes keys out of the page's address, its path, the rest of its query and its hash kept. */
export function forgetParams(...keys: string[]): void {
  const search = withoutParams(location.search, ...keys);
  if (search !== location.search) {
    history.replaceState(history.state, '', `${location.pathname}${search}${location.hash}`);
  }
}
