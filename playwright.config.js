import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120000,
  expect: {timeout: 60000},
  workers: 1,
  outputDir: 'artifacts/browser',
  reporter: 'list',
  use: {baseURL: 'http://127.0.0.1:8000', headless: true, screenshot: 'only-on-failure'},
  projects: [
    {name: 'desktop', use: {viewport: {width: 1365, height: 900}}},
    {name: 'mobile', use: {viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true}},
  ],
});
