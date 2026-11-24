import { defineConfig } from '@playwright/test';
import os from 'os';
import path from 'path';

const P = {
  vendor: 3004,
  gateway: 3002,
  review: 3003,
  ops: 3001,
  ui: 5173,
};
const health = (port) => `http://127.0.0.1:${port}/api/v1/health`;
const server = (file, port) => ({
  command: `node mock-server/${file}.js`,
  url: health(port),
  reuseExistingServer: true,
  timeout: 30000,
});

export default defineConfig({
  testDir: './tests',
  outputDir: path.join(os.tmpdir(), 'ops-assistant-e2e-results'),
  timeout: 120000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  reporter: [
    ['list'],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: `http://localhost:${P.ui}`,
    channel: 'msedge',
    trace: 'off',
    screenshot: 'off',
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    server('mock-vendor', P.vendor),
    server('gateway', P.gateway),
    server('review-queue', P.review),
    server('ops', P.ops),
    { command: 'npm run dev', url: `http://localhost:${P.ui}`, reuseExistingServer: true, timeout: 30000 },
  ],
});
