// [需求@2026-06-17 E2E] Playwright config — mate E2E 测试
//
// - webServer 自动启 mate (mock mode + 临时 DB + 端口 8722)
// - chromium only(其它浏览器 cold-start 慢)
// - retries 1 次,避免偶发 race condition flaky
// - 串行跑 — mate server 内部状态不能并发

const { defineConfig, devices } = require('@playwright/test');
const path = require('node:path');
const os = require('node:os');

const PORT = 8722;
const TEST_DB = path.join(os.tmpdir(), 'mate-e2e-test.sqlite');

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    actionTimeout: 5_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // 用完整 chromium 而不是 headless_shell(后者要额外下载)
        channel: undefined,
        launchOptions: {
          // 强制走 chromium full 浏览器
        },
      },
    },
  ],

  webServer: {
    command: `node server/index.js`,
    port: PORT,
    timeout: 15_000,
    reuseExistingServer: false,
    env: {
      PORT: String(PORT),
      MATE_DB: TEST_DB,
      MATE_MOCK_TERMS: '1',
      PREHEAT_POOL_ON_BOOT: 'false',
      LOG_LEVEL: 'warn',
    },
  },
});
