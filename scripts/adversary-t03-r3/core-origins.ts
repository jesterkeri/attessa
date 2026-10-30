// Prints core normalizeOrigin results for each input in the JSON file argv[2]: [[input, local], ...]
import { readFileSync } from 'node:fs';
import { normalizeOrigin, OriginError } from '../../packages/core/src/origin.ts';
const cases: [string, boolean][] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const out = cases.map(([input, local]) => {
  try { return ['ok', normalizeOrigin(input, { local })]; }
  catch (e) { return ['err', e instanceof OriginError ? e.reason : String(e)]; }
});
process.stdout.write(JSON.stringify(out));
