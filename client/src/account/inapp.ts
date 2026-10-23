// SPDX-License-Identifier: AGPL-3.0-only

// Browsers that cannot make a passkey, found before anything is asked of
// the player. An app that opens links in a browser of its own (a webview)
// rarely can: on Android a WebView has WebAuthn off unless its app turns
// it on, and on iOS a webview makes passkeys only for its app's own
// domains (Apple's developer forums, WebKit bug 250912). Such a page is
// asked to open the game in the phone's own browser.
//
// The apps are known by the marks they put in the user agent; the list is
// kept here alone, to be kept up to date. The capability signals mislead
// (the Google app's webview says it makes passkeys when it does not, and
// iOS 26.2 said no in every browser), so they only ever warn: the one
// block is a browser with no WebAuthn at all.

/** An app whose browser is its own. */
export interface InApp {
  /** The app's name, as the player knows it, or null for one unknown. */
  app: string | null;
  /** Where in the app the way to the phone's browser is. */
  steps: string;
}

const MENU = 'Tap the menu (⋯ or ⋮) and choose Open in browser.';

/** The apps' marks in the user agent, the first that matches naming the app. */
const MARKS: readonly { marks: readonly string[]; app: string; steps?: string }[] = [
  { marks: ['Instagram'], app: 'Instagram', steps: 'Tap ⋯ at the top and choose Open in browser.' },
  { marks: ['Barcelona'], app: 'Threads' },
  { marks: ['MessengerForiOS', 'Orca-Android'], app: 'Messenger' },
  {
    marks: ['FBAN', 'FBAV', 'FB_IAB', 'FB4A'],
    app: 'Facebook',
    steps: 'Tap ⋯ at the top and choose Open in browser.',
  },
  { marks: ['BytedanceWebview', 'musical_ly', 'Trill'], app: 'TikTok' },
  { marks: ['Twitter'], app: 'X' },
  { marks: ['LinkedInApp'], app: 'LinkedIn' },
  { marks: ['Snapchat'], app: 'Snapchat' },
  { marks: ['Pinterest'], app: 'Pinterest' },
  {
    marks: ['MicroMessenger'],
    app: 'WeChat',
    steps: 'Tap ⋯ at the top and choose Open in browser.',
  },
  { marks: ['Line/'], app: 'LINE' },
  {
    marks: [' GSA/'],
    app: 'the Google app',
    steps: 'Tap the share button and choose Open in Safari or Chrome.',
  },
];

/** The app whose browser a user agent is, or null for a browser of the phone's own. */
export function inAppBrowser(ua: string): InApp | null {
  for (const m of MARKS) {
    if (m.marks.some((mark) => ua.includes(mark))) {
      return { app: m.app, steps: m.steps ?? MENU };
    }
  }
  // On iOS every browser of its own says Safari/ (Chrome, Firefox and Edge
  // too); a webview does not.
  if (/\b(iPhone|iPad|iPod)\b/.test(ua) && ua.includes('Mobile/') && !ua.includes('Safari/')) {
    return { app: null, steps: MENU };
  }
  // An Android WebView marks itself "; wv)".
  if (ua.includes('Android') && /;\s*wv\)/.test(ua)) {
    return { app: null, steps: MENU };
  }
  return null;
}

/** Whether this browser can make the player's passkey. */
export type Support =
  /** An app's own browser: ask to open the game in the phone's. */
  | { kind: 'in-app'; app: InApp }
  /** No WebAuthn at all. */
  | { kind: 'none' }
  /** Neither this device nor a phone by QR code is offered: warn, never block. */
  | { kind: 'maybe' }
  | { kind: 'yes' };

/** What the check reads of the browser, so tests can stand in for it. */
export interface SupportEnv {
  userAgent: string;
  pkc:
    | {
        isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
        getClientCapabilities?: () => Promise<Record<string, boolean>>;
      }
    | undefined;
}

/** Checks, before anything is asked of the player, whether a passkey can be made here. */
export async function passkeySupport(env: SupportEnv): Promise<Support> {
  const app = inAppBrowser(env.userAgent);
  if (app !== null) {
    return { kind: 'in-app', app };
  }
  if (env.pkc === undefined) {
    return { kind: 'none' };
  }
  let platform = true;
  let hybrid = false;
  try {
    platform = (await env.pkc.isUserVerifyingPlatformAuthenticatorAvailable?.()) ?? true;
  } catch {
    // Unknown: assume it can.
  }
  try {
    hybrid = (await env.pkc.getClientCapabilities?.())?.hybridTransport === true;
  } catch {
    // Unknown.
  }
  return !platform && !hybrid ? { kind: 'maybe' } : { kind: 'yes' };
}
