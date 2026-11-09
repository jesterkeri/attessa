import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against the workspace packages' source, so `pnpm --filter @attessa/mcp test` needs no prior build.
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      '@attessa/core': src('../core/src/index.ts'),
      '@attessa/sdk': src('../sdk/src/index.ts'),
      '@attessa/seller-host': src('../seller-host/src/index.ts'),
      '@attessa/gateway': src('../gateway/src/index.ts'),
      '@attessa/cli': src('../cli/src/index.ts'),
    },
  },
  test: { testTimeout: 20000, hookTimeout: 20000, pool: 'forks', setupFiles: ['../cli/test/pin-fake-registry.ts'] },
});
