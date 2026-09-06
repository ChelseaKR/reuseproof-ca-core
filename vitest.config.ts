import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // `scripts/verify.ts` is the shipped `reuseproof-verify` command, not a dev
      // script: `package.json` `bin` points a consumer at it. A published surface
      // outside the coverage scope is a floor that cannot fail, so it is named
      // here. `scripts/demo.ts` stays out on purpose: `npm run demo:check` runs it
      // as a subprocess, which this provider does not follow, so including it would
      // report 0% for code that does run.
      include: ['src/**/*.ts', 'scripts/verify.ts'],
      reporter: ['text', 'json-summary'],
      thresholds: {
        perFile: true,
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
        'src/domain/**': {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
        'src/artifact-output.ts': {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
        'src/report-lifecycle.ts': {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
        'src/reconciled-evaluation.ts': {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
        'src/report-render.ts': {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
        'src/report-schema.ts': {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95,
        },
      },
    },
    testTimeout: 5_000,
  },
});
