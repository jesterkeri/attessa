// The CLI's own command table, read from packages/cli/src/index.ts: command -> accepted flags (its own plus the global ones).
// Used by the tests that hold the site's commands and flags to the code. CLI_INDEX overrides the path.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = process.env.SITE_SRC ?? join(here, '..', '..', 'src');
const index = readFileSync(process.env.CLI_INDEX ?? join(src, '..', '..', 'cli', 'src', 'index.ts'), 'utf8');

const section = (start, endMarker) => {
  const a = index.indexOf(start);
  return index.slice(a, index.indexOf(endMarker, a));
};
// flag -> 'string' | 'boolean', as the table declares it (a string flag takes the next token as its value).
const typedFlagsIn = text => new Map([...text.matchAll(/(?:'([a-z][a-z-]*)'|\b([a-z][a-z-]*)): \{ type: '(string|boolean)'/g)].map(m => [m[1] ?? m[2], m[3]]));
const flagsIn = text => new Set([...text.matchAll(/(?:'([a-z][a-z-]*)'|\b([a-z][a-z-]*)): \{ type:/g)].map(m => m[1] ?? m[2]));

export const GLOBAL_FLAGS = flagsIn(section('const GLOBAL', '} as const'));
const GLOBAL_TYPES = typedFlagsIn(section('const GLOBAL', '} as const'));
const block = section('const COMMANDS', '\n};');
const heads = [...block.matchAll(/^ {2}(?:'([a-z -]+)'|([a-z]+)): \{/gm)];
export const COMMANDS = new Map(heads.map((m, i) => {
  const body = block.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : block.length);
  return [m[1] ?? m[2], new Set([...GLOBAL_FLAGS, ...flagsIn(body.slice(body.indexOf('opts:')))])];
}));
/** command -> { flags: Map(flag -> type), args: how many positionals follow its words }, from the same table. */
export const SPECS = new Map(heads.map((m, i) => {
  const body = block.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : block.length);
  const args = [...body.matchAll(/\bargs: (\d+)/g)].pop();
  return [m[1] ?? m[2], { flags: new Map([...GLOBAL_TYPES, ...typedFlagsIn(body.slice(body.indexOf('opts:')))]), args: Number(args[1]) }];
}));
// `attessa gateway ...` is handled before the table, by @attessa/gateway (pause, resume, status, export).
COMMANDS.set('gateway', new Set([...GLOBAL_FLAGS]));
SPECS.set('gateway', { flags: new Map(GLOBAL_TYPES), args: 0 });
export const GATEWAY_SUBCOMMANDS = ['pause', 'resume', 'status', 'export'];

/** The longest command in the table that starts the words, or null. */
export const commandOf = words => {
  const two = words.slice(0, 2).join(' ');
  return COMMANDS.has(two) ? two : COMMANDS.has(words[0]) ? words[0] : null;
};
