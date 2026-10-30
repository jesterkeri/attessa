import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inputsHash, jcs, payerSigDigest, proofDigest, recoverDigestSigner, eip712Domain, livenessDigest } from '../src/index.ts';

// Adversary T03 r2. Attacks the Codex r1 M2 fix: packages/core/test/oracle.test.ts and
// scripts/check-vectors-oracle.py. Every fixed value below was produced with Foundry cast 1.8.1
// (keccak, wallet sign) from text written by hand, never by core or viem.

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const read = (f: string) => JSON.parse(readFileSync(join(ROOT, 'vectors', f), 'utf8'));

describe('adversary: JCS of nested objects has no independent oracle (INV-18, SPEC §2.2)', () => {
  // Canonical text written by hand (keys sorted at every depth), hashed with `cast keccak`.
  // A core whose jcs sorts only the top level passes oracle.test.ts ({b,a} is flat), every
  // generator self-check (all pinned expectJcs cases are flat) and check-vectors-oracle.py
  // (it hashes the vector's own `jcs` field and never checks it against `inputs`).
  it('nested keys are sorted at every depth', () => {
    const input = { z: [{ d: '4', c: '3' }], p: { b: '2', a: '1' } };
    expect(jcs(input)).toBe('{"p":{"a":"1","b":"2"},"z":[{"c":"3","d":"4"}]}');
    expect(inputsHash(input)).toBe('0xc3e820394d3a7697011bbc78c607028f1c45c262c85607bd9529dc355b823080');
  });

  it('vectors/hashes.json "forno inputs, keys out of order" matches a hand-written JCS text', () => {
    const c = read('hashes.json').inputsHash.find((x: { name: string }) => x.name === 'forno inputs, keys out of order');
    const hand =
      '{"block":{"hash":"0x400d5726e2bd7a1cbc5e9a4ba9aed263feda826722cc5859ea35b21cbe03a8d3","number":"12345678","timestamp":"1761700000"},' +
      '"payTo":{"address":"0x1111111111111111111111111111111111111111","balanceWei":"1000000000000000000","code":"0x","nonce":"7"},"source":"forno"}';
    expect(c.jcs).toBe(hand);
    expect(c.expected).toBe('0x398d8de5fbb671052db4b85489bb637cc322c02ced5b42ddb65cfa491d2b6233');
    expect(inputsHash(c.inputs)).toBe(c.expected);
  });
});

describe('adversary: signature recovery against cast signatures (SPEC §2.3, §2.5)', () => {
  // Throwaway key from `cast wallet new` (2026-10-30, never stored). The signatures are
  // `cast wallet sign --data <typed data>` and `cast wallet sign <message>` over the oracle.test.ts
  // preimages; scripts/adversary-t03-r2/rederive-oracle.py confirms each equals
  // `cast wallet sign --no-hash <oracle digest>`.
  const ADDR = '0x5a11c9b14040f07a17b6e61a70f1b4966efccfb2';
  const REGISTRY = '0x2222222222222222222222222222222222222222';
  const DOMAIN = eip712Domain(11142220n, REGISTRY);
  const rel = '0x8763f7b4ff8be9260da66b94bf5e8fab677768a66074d4f2bf62e85ba173cef4';
  const rid = '0x6e9d096c1fcfc86df0b783e0d1ad161d50f427ffd71baec165c5226c8dd3cd5c';

  it('recovers the cast signer for proof, liveness and payer digests', async () => {
    const proof = proofDigest(DOMAIN, {
      agentId: 7n,
      releaseId: rel,
      requestId: rid,
      requestHash: '0x5d1aa7aa21ef8b05305c2597aeedbbec369a030fc7748b7d88f41b3bcea9eeed',
      responseHash: '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8',
      inputsHash: '0x15df7fce9381b47f01cc5e529f28510242a455d8807a842982451477317eaa63',
      paymentId: `0x${'cd'.repeat(32)}`,
      issuedAt: 1761800000n,
      expiresAt: 1761800600n,
    });
    const live = livenessDigest(DOMAIN, {
      agentId: 7n,
      releaseId: rel,
      originHash: '0xedba3f8cfcd4165f73cd4641ced2b2ec0d3ba4338e3eec30edd58777d86b53b2',
      challenge: `0x${'ef'.repeat(32)}`,
      issuedAt: 1761800000n,
    });
    const sigs = {
      proof: '0x1cb37c5b466a6ef33c1ed9ce47bffc97aadbe82a2655837932f2590b5d26880342cd61abf5858d8cd789739713a06d81853873d48c20daf550e2e5667ab8714a1b',
      liveness: '0xac1fbe2bec3c398cdaade87204f42e09e9c10dcbbedcaf635722da849a68075f04d9b1d453515053260354c308eab708cc162c25094057169a68e877989c84221c',
      payer: '0xc1af0ee901ab0b69a09368818b254e930e64283cfa3e36e01931fdc3edadaedc790a2ea6f1b4dfcba8ebdd7a86a792f1a756eeaee4aae85ce03fab8759637c061c',
    };
    expect(await recoverDigestSigner(proof, sigs.proof)).toBe(ADDR);
    expect(await recoverDigestSigner(live, sigs.liveness)).toBe(ADDR);
    expect(await recoverDigestSigner(payerSigDigest(rid, 1761800000), sigs.payer)).toBe(ADDR);
  });
});

// The oracle script must reject a wrong vector. Each case writes a scratch copy of vectors/ with
// one value made wrong and runs scripts/check-vectors-oracle.py on it; exit 0 means it passed a
// wrong vector. Tracked files are never touched.
describe('adversary: check-vectors-oracle.py must fail on a wrong vector (INV-18)', () => {
  const FILES = ['origins.json', 'hashes.json', 'binding.json', 'eip712.json', 'headers.json'];
  const flip = (h: string) => h.slice(0, -1) + (h.endsWith('0') ? '1' : '0');
  const castKeccakUtf8 = (s: string) => execFileSync('cast', ['keccak', `0x${Buffer.from(s, 'utf8').toString('hex')}`], { encoding: 'utf8' }).trim();
  type V = Record<string, any>;
  const mutants: [string, (v: V) => void][] = [
    [
      'hashes.inputsHash[0].jcs not canonical (keys in insertion order), expected rehashed to match',
      (v) => {
        const c = v['hashes.json'].inputsHash[0];
        c.jcs = JSON.stringify(c.inputs);
        c.expected = castKeccakUtf8(c.jcs);
      },
    ],
    ['eip712.signatures[0].signer is not the key that signed', (v) => void (v['eip712.json'].signatures[0].signer = flip(v['eip712.json'].signatures[0].signer))],
    ['headers.payerSig.valid[0].signer is not the key that signed', (v) => void (v['headers.json'].payerSig.valid[0].signer = flip(v['headers.json'].payerSig.valid[0].signer))],
    ['headers.attestedProof.valid[0].signer is not the key that signed', (v) => void (v['headers.json'].attestedProof.valid[0].signer = flip(v['headers.json'].attestedProof.valid[0].signer))],
    [
      'headers.attestedProof.valid[0].json no longer the base64 of header',
      (v) => void (v['headers.json'].attestedProof.valid[0].json = v['headers.json'].attestedProof.valid[0].json.replace('"agentId":"1"', '"agentId":"2"')),
    ],
    [
      'headers.bytes32: uppercase hex moved from invalid to valid',
      (v) => void v['headers.json'].bytes32.valid.push(v['headers.json'].bytes32.invalid.shift()),
    ],
    [
      'origins.valid "uppercase host and scheme" normalized keeps an uppercase host',
      (v) => {
        const c = v['origins.json'].valid.find((x: V) => x.name === 'uppercase host and scheme');
        c.normalized = 'https://EXAMPLE.com';
        c.originHash = castKeccakUtf8(c.normalized);
      },
    ],
    ['hashes.requestHash family emptied', (v) => void (v['hashes.json'].requestHash = [])],
  ];

  for (const [name, mutate] of mutants) {
    it(`rejects: ${name}`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'adv-t03-r2-'));
      try {
        mkdirSync(join(dir, 'vectors'));
        const v: V = Object.fromEntries(FILES.map((f) => [f, read(f)]));
        mutate(v);
        for (const f of FILES) writeFileSync(join(dir, 'vectors', f), JSON.stringify(v[f], null, 2));
        const r = spawnSync('python3', ['-I', join(ROOT, 'scripts/check-vectors-oracle.py')], { cwd: dir, encoding: 'utf8' });
        expect(r.status, `${name}\n${r.stdout}${r.stderr}`).not.toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 120_000);
  }
});
