import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/** Performance runs (ADR 0028): `pnpm --filter @acct/api perf` (PERF_SCALE=smoke|full). */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['perf/**/*.perf.ts'],
    testTimeout: 4 * 3600_000,
    hookTimeout: 4 * 3600_000,
    fileParallelism: false,
  },
});
