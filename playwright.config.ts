import { defineConfig } from '@playwright/test';

// Adapter/unit tests run on saved HTML fixtures; no browser is launched.
export default defineConfig({
  testDir: 'tests',
  reporter: [['list']],
  use: { headless: true },
});
