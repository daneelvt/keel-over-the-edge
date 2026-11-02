// SPDX-License-Identifier: AGPL-3.0-only

// The GPU the browser tests draw on. On Linux, CI's runners have none: the
// browser draws on a software GPU, the CPU's Vulkan, which WebGL 2 reaches
// through ANGLE and WebGPU through Dawn. WebGL 2 draws on Mesa's lavapipe by
// default (mesa-vulkan-drivers), as three.js's own tests do, or on
// Chrome's SwiftShader with SOFTWARE_GPU=swiftshader, to compare. WebGPU
// draws on SwiftShader either way: Chromium offers WebGPU no CPU adapter but
// its own, whatever the flags, headless or not. On the Mac, the Mac's GPU.
//
// Without lavapipe's driver installed Chromium does not fall back to
// SwiftShader: it runs with no WebGL at all; and the WebGPU project skips
// its tests where there is no adapter. So pr.render checks, before its
// tests, that both back ends draw on the GPU asked for:
//
//	node e2e/gpu.ts    print what each back end draws on; fail if it is not the one asked for

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type SoftwareGPU = 'lavapipe' | 'swiftshader';

/** The software GPU asked for: SOFTWARE_GPU=swiftshader, or lavapipe. */
export function softwareGPUAsked(): SoftwareGPU {
  return process.env.SOFTWARE_GPU === 'swiftshader' ? 'swiftshader' : 'lavapipe';
}

/**
 * Mesa's lavapipe's driver file, as Ubuntu's mesa-vulkan-drivers installs
 * it (lvp_icd.json on 24.04, lvp_icd.x86_64.json on some releases); the
 * folder's first name if none is there, so that the check says so.
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

/** Chromium's arguments, for the platform. */
export function chromiumArgs(linux: boolean, gpu = softwareGPUAsked()): string[] {
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
export function chromiumEnv(linux: boolean, gpu = softwareGPUAsked()): Record<string, string> {
  return linux && gpu === 'lavapipe' ? { VK_DRIVER_FILES: lavapipeICD() } : {};
}

/** What a page draws on: WebGL 2's renderer and WebGPU's adapter, as the page sees them. */
export interface Drawn {
  webgl2: string;
  webgpu: string;
}

/** Whether what a page draws on is what the software GPU asked for gives. */
export function drawsOn(drawn: Drawn, gpu: SoftwareGPU): { webgl2: boolean; webgpu: boolean } {
  const webgl2 = gpu === 'lavapipe' ? /llvmpipe/i : /swiftshader/i;
  return { webgl2: webgl2.test(drawn.webgl2), webgpu: /swiftshader/i.test(drawn.webgpu) };
}

async function check(): Promise<void> {
  const { chromium } = await import('@playwright/test');
  const linux = process.platform === 'linux';
  const gpu = softwareGPUAsked();
  const browser = await chromium.launch({
    headless: process.env.HEADED === undefined,
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
    const drawn: Drawn = await page.evaluate(async () => {
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
    process.stdout.write(
      `**The GPU:** ${linux ? gpu : 'the machine’s own'}. WebGL 2 draws on ${drawn.webgl2}; WebGPU on ${drawn.webgpu}.\n\n`,
    );
    if (linux) {
      // The WebGPU project skips its tests where there is no adapter: one
      // missing here would skip them all.
      const ok = drawsOn(drawn, gpu);
      if (!ok.webgl2 || !ok.webgpu) {
        throw new Error(
          `the page does not draw where ${gpu} should: WebGL 2 on ${drawn.webgl2}, WebGPU on ${drawn.webgpu}`,
        );
      }
    }
  } finally {
    await browser.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await check();
}
