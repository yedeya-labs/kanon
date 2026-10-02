import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Creates and pre-execs the shared stub shim once, before workers start, so suites that
    // put a stub on PATH don't each pay the OS's first-exec scan (tests/unit/helpers/stub-bin.ts).
    globalSetup: ['tests/unit/helpers/stub-bin.ts'],
  },
});
