// Runs packages/core's own test suite with one module swapped for a mutant (MUTANT=origin|headers).
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const m = process.env.MUTANT;
const alias = m === 'origin' ? [{ find: /^\.\/origin\.ts$/, replacement: here('./mut-origin-password.ts') }]
  : m === 'headers' ? [{ find: /^\.\/headers\.ts$/, replacement: here('./mut-headers-safeint.ts') }] : [];
export default defineConfig({ resolve: { alias }, test: { include: ['test/**/*.test.ts'], exclude: process.env.KILL ? [] : ['test/adversary-t03-r3.test.ts'] } });
