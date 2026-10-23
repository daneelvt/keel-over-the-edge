// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { inAppBrowser, passkeySupport } from './inapp';

const IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko)';

// The apps' own browsers, as their user agents read.
const APPS: Record<string, string> = {
  Facebook: `${IOS} Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.40.108;FBBV/700000000]`,
  'Facebook ': `${ANDROID} Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/480.0.0.40.108;]`,
  Instagram: `${IOS} Mobile/15E148 Instagram 360.0.0.30.109 (iPhone15,2; iOS 18_6; en_US)`,
  Messenger: `${IOS} Mobile/15E148 [FBAN/MessengerForiOS;FBAV/480.0]`,
  Threads: `${IOS} Mobile/15E148 Barcelona 360.0.0.30.109`,
  TikTok: `${ANDROID} Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 trill_360004 BytedanceWebview/d8a21c6`,
  X: `${IOS} Mobile/15E148 Twitter for iPhone/10.70`,
  LinkedIn: `${IOS} Mobile/15E148 [LinkedInApp]/9.31.1`,
  Snapchat: `${IOS} Mobile/15E148 Snapchat/13.50.0.40 (like Safari/8618.1.15.10.15, panda)`,
  Pinterest: `${IOS} Mobile/15E148 [Pinterest/iOS]`,
  WeChat: `${IOS} Mobile/15E148 MicroMessenger/8.0.50(0x18003231) NetType/WIFI Language/en`,
  LINE: `${IOS} Mobile/15E148 Safari Line/14.10.0`,
  'the Google app': `${IOS} GSA/360.0.0 Mobile/15E148 Safari/604.1`,
};

// The phones' own browsers.
const BROWSERS = [
  `${IOS} Version/18.6 Mobile/15E148 Safari/604.1`,
  `${IOS} CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1`,
  `${IOS} FxiOS/143.0 Mobile/15E148 Safari/605.1.15`,
  `${IOS} EdgiOS/141.0 Version/18.0 Mobile/15E148 Safari/604.1`,
  `${ANDROID} Chrome/141.0.0.0 Mobile Safari/537.36`,
  'Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0',
  `${ANDROID} SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36`,
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36',
];

describe('in-app browsers', () => {
  test('each listed app is asked to open the game in the phone’s browser', async () => {
    for (const [app, ua] of Object.entries(APPS)) {
      const found = inAppBrowser(ua);
      expect(found?.app, app).toBe(app.trim());
      expect(found?.steps.length, app).toBeGreaterThan(10);
      expect(await passkeySupport({ userAgent: ua, pkc: {} }), app).toEqual({
        kind: 'in-app',
        app: found,
      });
    }
  });

  test("an app's webview not listed, by iOS's and Android's marks", () => {
    expect(inAppBrowser(`${IOS} Mobile/15E148`)).toEqual({ app: null, steps: expect.any(String) });
    expect(
      inAppBrowser(
        `Mozilla/5.0 (Linux; Android 14; wv) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36`,
      )?.app,
    ).toBeNull();
  });

  test("a phone's own browsers go to the start screen", async () => {
    for (const ua of BROWSERS) {
      expect(inAppBrowser(ua), ua).toBeNull();
      expect(
        await passkeySupport({
          userAgent: ua,
          pkc: { isUserVerifyingPlatformAuthenticatorAvailable: async () => true },
        }),
        ua,
      ).toEqual({ kind: 'yes' });
    }
  });

  test('a browser without passkeys, and one that may not make them', async () => {
    const ua = BROWSERS[0] as string;
    expect(await passkeySupport({ userAgent: ua, pkc: undefined })).toEqual({ kind: 'none' });
    const no = async () => false;
    expect(
      await passkeySupport({
        userAgent: ua,
        pkc: { isUserVerifyingPlatformAuthenticatorAvailable: no },
      }),
    ).toEqual({ kind: 'maybe' });
    // A phone by its QR code is enough, and a signal that fails is no verdict.
    expect(
      await passkeySupport({
        userAgent: ua,
        pkc: {
          isUserVerifyingPlatformAuthenticatorAvailable: no,
          getClientCapabilities: async () => ({ hybridTransport: true }),
        },
      }),
    ).toEqual({ kind: 'yes' });
    expect(
      await passkeySupport({
        userAgent: ua,
        pkc: {
          isUserVerifyingPlatformAuthenticatorAvailable: async () => Promise.reject(new Error('?')),
        },
      }),
    ).toEqual({ kind: 'yes' });
  });
});
