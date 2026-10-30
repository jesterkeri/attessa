// Writes systemd/ from src/units.ts. Run: pnpm --filter @attessa/seller-host render-units
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderUnits } from '../src/units.ts';

const dir = fileURLToPath(new URL('../systemd/', import.meta.url));
mkdirSync(dir, { recursive: true });
for (const [name, text] of Object.entries(renderUnits())) writeFileSync(`${dir}${name}`, text);
