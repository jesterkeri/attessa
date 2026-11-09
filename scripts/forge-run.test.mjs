// T30 regression: a successful forge build that writes megabytes to stderr must not be reported as
// a failure, and a real failure must still throw with its output. Uses a fake `forge` on PATH.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runForge, failure } from './forge-run.mjs';

function withFakeForge(script, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-forge-'));
  const old = process.env.PATH;
  try {
    writeFileSync(join(dir, 'forge'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(dir, 'forge'), 0o755);
    process.env.PATH = `${dir}:${old}`;
    return fn();
  } finally {
    process.env.PATH = old;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('exit 0 with 8 MB on stderr passes (the 1 MB default buffer would kill it)', () => {
  withFakeForge('head -c 8000000 /dev/zero | tr "\\0" "x" >&2; exit 0', () => {
    runForge(['build']);
  });
});

test('exit 1 still throws, and the failure text carries the exit status and the stderr tail', () => {
  withFakeForge('echo "error: real compile failure" >&2; exit 1', () => {
    assert.throws(() => runForge(['build']), (e) => {
      const f = failure(e);
      assert.match(f, /^exit 1: /);
      assert.match(f, /real compile failure/);
      return true;
    });
  });
});

test('exit 1 after 8 MB of stderr still throws', () => {
  withFakeForge('head -c 8000000 /dev/zero | tr "\\0" "x" >&2; echo "error: boom" >&2; exit 1', () => {
    assert.throws(() => runForge(['build']), (e) => /^exit 1: .*boom/.test(failure(e)));
  });
});
