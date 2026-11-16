// SPDX-License-Identifier: AGPL-3.0-only

declare const __KEEL_BUILD__: string;

/**
 * The build this page came from, as the image was built (its BUILD), or
 * "dev" from the development server. The hello sends it, so the server's
 * logs name the page's build.
 */
export const BUILD: string = __KEEL_BUILD__;
