import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    globalSetup: ['server/test/global-setup.ts'],
    // Semua file test memakai satu database uji yang sama.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
