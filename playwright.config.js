// End-to-end tests in WebKit (Safari's engine) on an emulated iPhone, driving
// the stress lab: npm run e2e. The lab starts on its own ports with its own
// data, so it never touches a lab you have open, or production.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/results',
  timeout: 90_000,
  workers: 1, // one shared fake park: tests take turns
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['iPhone 15 Pro'],
    baseURL: 'http://127.0.0.1:3210',
    serviceWorkers: 'block', // every test sees the code on disk, not a cached copy
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'webkit-iphone', use: { browserName: 'webkit' } }],
  webServer: {
    command: 'node scripts/lab.js',
    env: { LAB_PORT: '4210', APP_PORT: '3210', LAB_DATA: '.lab-data-e2e' },
    url: 'http://127.0.0.1:3210/api/parks',
    timeout: 90_000,
    reuseExistingServer: false,
  },
});
