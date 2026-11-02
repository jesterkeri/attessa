// Mutant M1: core's normalizeOrigin with Node's built-in URL (ada) instead of whatwg-url.
// Prints every committed origins vector whose result the mutant would change.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../packages/core/src/origin.ts', import.meta.url), 'utf8')
  .replace("import { URL } from 'whatwg-url';", '');
import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./origin-m1.ts', import.meta.url), src);
const { normalizeOrigin, OriginError } = await import('./origin-m1.ts');
const v = JSON.parse(readFileSync(new URL('../../vectors/origins.json', import.meta.url), 'utf8'));
let changed = 0;
for (const c of v.valid) {
  let got; try { got = normalizeOrigin(c.input, { local: c.local }); } catch (e) { got = 'err:' + (e as any).reason; }
  if (got !== c.normalized) { changed++; console.log('valid', JSON.stringify(c.input), '->', got); }
}
for (const c of v.invalid) {
  let got; try { got = 'ok:' + normalizeOrigin(c.input, { local: c.local }); } catch (e) { got = (e as any).reason; }
  if (got !== c.reason) { changed++; console.log('invalid', JSON.stringify(c.input), c.reason, '->', got); }
}
console.log('changed', changed);
