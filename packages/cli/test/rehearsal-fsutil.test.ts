import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { writeFileMakingDirs } from '../src/fsutil.ts';

it('writes docs/agent.json into a directory that does not exist yet (agent register crashed with ENOENT after the tx was sent)', () => {
  const d = mkdtempSync(join(tmpdir(), 'fsutil-'));
  try {
    const f = join(d, 'docs', 'agent.json');
    writeFileMakingDirs(f, '{"a":1}\n');
    expect(readFileSync(f, 'utf8')).toBe('{"a":1}\n');
    writeFileMakingDirs(f, '{"a":2}\n'); // overwriting an existing file still works
    expect(readFileSync(f, 'utf8')).toBe('{"a":2}\n');
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
