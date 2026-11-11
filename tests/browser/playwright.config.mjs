import {defineConfig} from '@playwright/test';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const localChrome = process.env.DSH_TEST_CHROME || (process.platform === 'win32'
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '');
export default defineConfig({
  testDir: fileURLToPath(new URL('./', import.meta.url)),
  testMatch: '**/*.spec.mjs',
  globalSetup: fileURLToPath(new URL('./prepare.mjs', import.meta.url)),
  outputDir: fileURLToPath(new URL('../../.build/browser-results/', import.meta.url)),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: {width: 1440, height: 1000},
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    launchOptions: localChrome && existsSync(localChrome) ? {executablePath: localChrome} : {},
  },
});
