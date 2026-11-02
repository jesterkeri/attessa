import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against @attessa/core's and @attessa/seller-host's source, so `pnpm --filter @attessa/cli test` needs no prior build.
export default defineConfig({
  resolve: {
    alias: {
      '@attessa/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@attessa/seller-host': fileURLToPath(new URL('../seller-host/src/index.ts', import.meta.url)),
    },
  },
  test: { testTimeout: 20000, hookTimeout: 20000, pool: 'forks' },
});
