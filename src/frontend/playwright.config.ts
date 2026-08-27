import path from 'node:path'
import { defineConfig, devices } from '@playwright/test'

const isCI = Boolean(process.env.CI)
const authState = path.join(process.cwd(), 'playwright/.auth/user.json')

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI
    ? [['line'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.005,
      threshold: 0.25,
    },
  },
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: [/.*\.mobile\.spec\.ts/, /.*\.responsive\.spec\.ts/],
      use: {
        ...devices['Desktop Chrome'],
        storageState: authState,
        viewport: { width: 1600, height: 900 },
      },
    },
    {
      name: 'responsive-chromium',
      dependencies: ['setup'],
      testMatch: /.*\.responsive\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: authState,
        viewport: { width: 1600, height: 900 },
        colorScheme: 'light',
        reducedMotion: 'reduce',
      },
    },
    {
      name: 'mobile-chromium',
      dependencies: ['setup'],
      testMatch: /.*\.mobile\.spec\.ts/,
      use: {
        ...devices['Pixel 7'],
        storageState: authState,
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
        colorScheme: 'light',
        reducedMotion: 'reduce',
      },
    },
  ],
})
