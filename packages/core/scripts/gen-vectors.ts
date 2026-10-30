// Writes vectors/*.json at the repo root. Run: pnpm --filter @attessa/core gen:vectors
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildVectors, serialize } from './vectors.ts';

const dir = fileURLToPath(new URL('../../../vectors/', import.meta.url));
mkdirSync(dir, { recursive: true });
for (const [file, v] of Object.entries(await buildVectors())) {
  writeFileSync(dir + file, serialize(v));
  console.log(`wrote vectors/${file}`);
}
