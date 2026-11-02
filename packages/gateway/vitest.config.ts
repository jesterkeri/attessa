import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against @attessa/core's source, so `pnpm --filter @attessa/gateway test` needs no prior build.
export default defineConfig({
  resolve: { alias: { '@attessa/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) } },
  test: { testTimeout: 20000, hookTimeout: 20000, pool: 'forks' },
});
