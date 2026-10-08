import { existsSync } from 'node:fs';
import type { PlaywrightTestConfig } from '@playwright/test';
export function browserOptions(local = false): NonNullable<PlaywrightTestConfig['use']> {
  const browserName = (process.env.PLAYWRIGHT_BROWSER || 'chromium') as 'chromium' | 'firefox' | 'webkit';
  if (!['chromium', 'firefox', 'webkit'].includes(browserName)) throw new Error('Unsupported PLAYWRIGHT_BROWSER');
  let executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (local && browserName === 'chromium' && !executablePath) executablePath = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
  const mesa = local && executablePath && existsSync('/usr/share/vulkan/icd.d/lvp_icd.x86_64.json');
  return { browserName, channel: browserName === 'chromium' ? 'chromium' : undefined,
    viewport: { width: 1000, height: 750 }, deviceScaleFactor: 1, trace: 'retain-on-failure',
    launchOptions: browserName === 'chromium' ? { executablePath,
      args: ['--use-gl=angle', `--use-angle=${process.env.PLAYWRIGHT_CHROMIUM_BACKEND || (mesa ? 'vulkan' : 'swiftshader-webgl')}`, '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--ignore-gpu-blocklist'],
      ...(mesa ? { env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: '1', EGL_PLATFORM: 'surfaceless', VK_DRIVER_FILES: '/usr/share/vulkan/icd.d/lvp_icd.x86_64.json' } } : {}),
    } : { executablePath: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE_PATH },
  };
}
