import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Creates and pre-execs the shared stub shim once, before workers start, so suites that
    // put a stub on PATH don't each pay the OS's first-exec scan (tests/unit/helpers/stub-bin.ts).
    globalSetup: ['tests/unit/helpers/stub-bin.ts'],
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] },
      },
      {
        // The pipeline library's tests (plan 0001 §3). The library reads an adopter's files at
        // the fixed paths of chapter 11, relative to the working directory, as a lane runs it
        // in the adopter's checkout, so these run inside the fixture adopter. They name Kanon's
        // own files through `ROOT` (tests/library/helpers/adopter.ts).
        extends: true,
        test: {
          name: 'library',
          include: ['tests/library/**/*.test.ts'],
          setupFiles: ['tests/library/helpers/in-adopter.ts'],
          env: { TZ: 'UTC' },
        },
      },
    ],
  },
});
