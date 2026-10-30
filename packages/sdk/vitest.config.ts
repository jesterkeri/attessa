import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against @attessa/core's sources, so `pnpm --filter @attessa/sdk test` needs no prior build.
export default defineConfig({
  resolve: { alias: { '@attessa/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)) } },
  test: { testTimeout: 30_000 },
});
