import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Writes a file, creating its directory first: `agent register` writes docs/agent.json, and docs/ may not exist yet. */
export function writeFileMakingDirs(path: string, data: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}
