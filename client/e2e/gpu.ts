// SPDX-License-Identifier: AGPL-3.0-only

// The GPU the browser tests draw on. On Linux, CI's runners have none: the
// browser draws on a software GPU, the CPU's Vulkan, which WebGL 2 reaches
// through ANGLE and WebGPU through Dawn. On the Mac, the Mac's GPU.
//
// The webgl2 project draws on Mesa's lavapipe (mesa-vulkan-drivers), as
// three.js's own tests do: its frames take a fifth of SwiftShader's on CI's
// runners, and Chrome has deprecated SwiftShader for WebGL. SOFTWARE_GPU=
// swiftshader draws it on Chrome's SwiftShader instead, to compare. The
// webgpu and compat projects draw on SwiftShader: Chromium offers WebGPU no
// CPU adapter but its own, whatever the flags, headless or not, and with
// lavapipe's flags its pictures are composited differently, for no time
// saved.
//
// Without lavapipe's driver installed Chromium does not fall back to
// SwiftShader: it runs with no WebGL at all; and the WebGPU projects skip
// their tests where there is no adapter. So the workflows check, before the
// tests, that each back end draws where it should:
//
//	node e2e/gpu.ts    print what each back end draws on; fail if not where it should

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type SoftwareGPU = 'lavapipe' | 'swiftshader';

/** The software GPU a project draws on, on Linux. */
export function softwareGPUOf(project: string): SoftwareGPU {
  if (project !== 'webgl2' || process.env.SOFTWARE_GPU === 'swiftshader') {
    return 'swiftshader';
  }
  return 'lavapipe';
}

/**
 * Mesa's lavapipe's driver file, as Ubuntu's mesa-vulkan-drivers installs
 * it (lvp_icd.json on 24.04, lvp_icd.x86_64.json on some releases); the
 * plain name if none is there, so that the check says so.
 */
function lavapipeICD(): string {
  const dir = '/usr/share/vulkan/icd.d';
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    // No Vulkan drivers at all.
  }
  return `${dir}/${names.find((n) => /^lvp_icd.*\.json$/.test(n)) ?? 'lvp_icd.json'}`;
}

/** Chromium's arguments, for the platform and the software GPU. */
export function chromiumArgs(linux: boolean, gpu: SoftwareGPU): string[] {
  const args = ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'];
  if (!linux) {
    return args;
  }
  if (gpu === 'swiftshader') {
    return [
      ...args,
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--use-webgpu-adapter=swiftshader',
      '--use-angle=swiftshader',
    ];
  }
  // Vulkan with no surface to present to, and no watchdog to end the GPU
  // process while a long shader compiles on the CPU (three.js's flags).
  return [
    ...args,
    '--enable-features=Vulkan',
    '--use-angle=vulkan',
    '--disable-vulkan-surface',
    '--disable-gpu-watchdog',
  ];
}

/** The environment Chromium needs for the GPU: lavapipe's driver, and no other. */
export function chromiumEnv(linux: boolean, gpu: SoftwareGPU): Record<string, string> {
  return linux && gpu === 'lavapipe' ? { VK_DRIVER_FILES: lavapipeICD() } : {};
}

/** What a page draws on: WebGL 2's renderer and WebGPU's adapter, as the page sees them. */
export interface Drawn {
  webgl2: string;
  webgpu: string;
}

/** What a page draws on, in a Chromium given the software GPU's arguments. */
async function drawnOn(gpu: SoftwareGPU, linux: boolean): Promise<Drawn> {
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({
    args: chromiumArgs(linux, gpu),
    env: { ...process.env, ...chromiumEnv(linux, gpu) },
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  });
  try {
    const page = await browser.newPage();
    // WebGPU is offered to a secure context only: localhost is one.
    await page.route('http://localhost/', (r) =>
      r.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
    );
    await page.goto('http://localhost/');
    return await page.evaluate(async () => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_debug_renderer_info');
      const webgl2 =
        gl === null || gl === undefined
          ? 'none'
          : String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      const gpuApi = (
        navigator as Navigator & {
          gpu?: {
            requestAdapter(): Promise<{
              info: { vendor: string; architecture: string; device: string; description: string };
            } | null>;
          };
        }
      ).gpu;
      const a = await gpuApi?.requestAdapter();
      const webgpu =
        a === null || a === undefined
          ? 'none'
          : [a.info.vendor, a.info.architecture, a.info.device, a.info.description]
              .filter((s) => s !== '')
              .join(', ');
      return { webgl2, webgpu };
    });
  } finally {
    await browser.close();
  }
}

async function check(): Promise<void> {
  const linux = process.platform === 'linux';
  const webgl2 = softwareGPUOf('webgl2');
  const onWebGL2 = (await drawnOn(webgl2, linux)).webgl2;
  const onWebGPU = (await drawnOn(softwareGPUOf('webgpu'), linux)).webgpu;
  process.stdout.write(`**The GPU:** WebGL 2 draws on ${onWebGL2}; WebGPU on ${onWebGPU}.\n\n`);
  if (!linux) {
    return;
  }
  // The WebGPU projects skip their tests where there is no adapter: one
  // missing here would skip them all.
  const wantWebGL2 = webgl2 === 'lavapipe' ? /llvmpipe/i : /swiftshader/i;
  if (!wantWebGL2.test(onWebGL2) || !/swiftshader/i.test(onWebGPU)) {
    throw new Error(
      `WebGL 2 should draw on ${webgl2} and WebGPU on SwiftShader: WebGL 2 draws on ${onWebGL2}, WebGPU on ${onWebGPU}`,
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await check();
}
