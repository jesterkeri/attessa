// Reads newline-separated JSON texts from argv[2]; prints core jcs() of each (or ERR) as a JSON array.
import { readFileSync } from 'node:fs';
import { jcs } from '../../packages/core/src/jcs.ts';
const lines = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean);
process.stdout.write(JSON.stringify(lines.map((l) => { try { return jcs(JSON.parse(l)); } catch { return 'ERR'; } })));
