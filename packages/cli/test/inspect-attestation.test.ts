import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeNitroChain } from './fake-nitro.ts';

// T12: scripts/inspect-attestation.mjs passes a document shaped like the spike's, and fails each check it names.
const SCRIPT = join(import.meta.dirname, '../../../scripts/inspect-attestation.mjs');
const nitro = new FakeNitroChain();
const dir = mkdtempSync(join(tmpdir(), 'attessa-inspect-'));

function inspect(o: { publicKey?: Buffer; userData?: Buffer; ageS?: number; pcr0?: Buffer }) {
  const doc = nitro.attest({
    timestampMs: BigInt(Date.now() - (o.ageS ?? 2) * 1000),
    publicKey: o.publicKey ?? Buffer.concat([Buffer.from([4]), randomBytes(64)]),
    userData: o.userData ?? randomBytes(160),
    ...(o.pcr0 ? { pcrs: [o.pcr0, randomBytes(48), randomBytes(48)] as [Buffer, Buffer, Buffer] } : {}),
  }).document;
  const f = join(dir, `${Math.random()}.bin`);
  writeFileSync(f, doc);
  const r = spawnSync(process.execPath, [SCRIPT, f], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('scripts/inspect-attestation.mjs (T12)', () => {
  it('passes a fresh document with a 65-byte key, 160-byte user_data and non-zero PCRs', () => {
    const r = inspect({});
    expect(r.out).toContain('ok   public_key length 65');
    expect(r.out).toContain('ok   user_data length 160');
    expect(r.code).toBe(0);
  });
  it('fails a short key, short user_data, a zero PCR0, a stale timestamp, and a file that is not an attestation', () => {
    expect(inspect({ publicKey: randomBytes(33) })).toMatchObject({ code: 1, out: expect.stringContaining('FAIL public_key length 33') });
    expect(inspect({ userData: randomBytes(128) })).toMatchObject({ code: 1, out: expect.stringContaining('FAIL user_data length 128') });
    expect(inspect({ pcr0: Buffer.alloc(48) })).toMatchObject({ code: 1, out: expect.stringContaining('FAIL PCR0 0x000') });
    expect(inspect({ ageS: 120 })).toMatchObject({ code: 1, out: expect.stringContaining('FAIL timestamp') });
    const f = join(dir, 'junk.bin');
    writeFileSync(f, Buffer.from([0]));
    expect(spawnSync(process.execPath, [SCRIPT, f], { encoding: 'utf8' })).toMatchObject({ status: 1, stdout: expect.stringContaining('FAIL not an attestation') });
  });
});
