import { describe, expect, it } from 'vitest';
import {
  BINDING_TYPEHASH,
  derivedRequestId,
  eip712Domain,
  encodeUserData,
  inputsHash,
  livenessDigest,
  normalizeOrigin,
  originHash,
  payerSigDigest,
  payerSigMessage,
  proofDigest,
  releaseId,
  requestHash,
  responseHash,
  signerFromPublicKey,
} from '../src/index.ts';

// Independent oracle for the vector families (Codex T03 r1, M2). Every expected value below was
// computed with Foundry `cast` (keccak, abi-encode, hash-message) from a preimage built by hand
// per SPEC §2, never by core or viem, so regenerating vectors/ from a broken core cannot make
// these pass. The script and its output are in DONE.md under "T03 Codex r1 fixes".
// Sanity on the oracle itself: the generator point G hashes to the well-known 0x7E5F...5Bdf.

const enc = (s: string) => new TextEncoder().encode(s);
const REGISTRY = '0x2222222222222222222222222222222222222222';
const DOMAIN = eip712Domain(11142220n, REGISTRY);

const ORACLE = {
  requestHash: '0x5d1aa7aa21ef8b05305c2597aeedbbec369a030fc7748b7d88f41b3bcea9eeed',
  responseHash: '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8',
  inputsHash: '0x15df7fce9381b47f01cc5e529f28510242a455d8807a842982451477317eaa63',
  releaseId: '0x8763f7b4ff8be9260da66b94bf5e8fab677768a66074d4f2bf62e85ba173cef4',
  requestId: '0x6e9d096c1fcfc86df0b783e0d1ad161d50f427ffd71baec165c5226c8dd3cd5c',
  originHash: '0xedba3f8cfcd4165f73cd4641ced2b2ec0d3ba4338e3eec30edd58777d86b53b2',
  bindingTypehash: '0xb24622f3f6428908d4d6e4f6326726cb263a0d74b13db222bbaaac66273a5fb1',
  userData:
    '0xb24622f3f6428908d4d6e4f6326726cb263a0d74b13db222bbaaac66273a5fb10000000000000000000000000000000000000000000000000000000000aa044c00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000000007edba3f8cfcd4165f73cd4641ced2b2ec0d3ba4338e3eec30edd58777d86b53b2',
  publicKey:
    '0x0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8',
  signer: '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf',
  proofDigest: '0xa00670f91c01e63736525da63705f4bad666b5dcf69a7eb20f0c7266682bf741',
  livenessDigest: '0xe3c011e5a4c4bd985a90feaf629908211b76ccfad6ac68d9ec83a46653c3e50c',
  payerSigMessage: 'attested-exec:results:0x6e9d096c1fcfc86df0b783e0d1ad161d50f427ffd71baec165c5226c8dd3cd5c:1761800000',
  payerSigDigest: '0x4b9c223730535b700dba97ba79743353fc18b5e6a0c942d86260ff3a93fb95fb',
} as const;

describe('core against fixed values computed independently with cast (INV-18)', () => {
  it('hashes (SPEC §2.2)', () => {
    // preimage: "POST" 0x00 "/v1/evaluate?a=1" 0x00 '{"x":1}'; the method is uppercased first.
    expect(requestHash('post', '/v1/evaluate?a=1', enc('{"x":1}'))).toBe(ORACLE.requestHash);
    expect(responseHash(enc('hello'))).toBe(ORACLE.responseHash);
    // JCS of {"b":2,"a":"x"} is {"a":"x","b":2}.
    expect(inputsHash({ b: 2, a: 'x' })).toBe(ORACLE.inputsHash);
    expect(releaseId(`0x${'11'.repeat(48)}`, `0x${'22'.repeat(48)}`, `0x${'33'.repeat(48)}`)).toBe(ORACLE.releaseId);
    // abi.encode(address asset, address payer, bytes32 nonce)
    expect(
      derivedRequestId('0x01c5c0122039549ad1493b8220cabedd739bc44e', '0x1111111111111111111111111111111111111111', `0x${'ab'.repeat(32)}`),
    ).toBe(ORACLE.requestId);
  });

  it('origin (SPEC §2.1)', () => {
    expect(originHash(normalizeOrigin('HTTPS://Example.COM:443/'))).toBe(ORACLE.originHash);
  });

  it('attestation binding (SPEC §2.4)', () => {
    expect(BINDING_TYPEHASH).toBe(ORACLE.bindingTypehash);
    expect(encodeUserData({ chainId: 11142220n, registry: REGISTRY, agentId: 7n, originHash: ORACLE.originHash })).toBe(ORACLE.userData);
    expect(signerFromPublicKey(ORACLE.publicKey)).toBe(ORACLE.signer);
  });

  it('EIP-712 digests (SPEC §2.3)', () => {
    expect(
      proofDigest(DOMAIN, {
        agentId: 7n,
        releaseId: ORACLE.releaseId,
        requestId: ORACLE.requestId,
        requestHash: ORACLE.requestHash,
        responseHash: ORACLE.responseHash,
        inputsHash: ORACLE.inputsHash,
        paymentId: `0x${'cd'.repeat(32)}`,
        issuedAt: 1761800000n,
        expiresAt: 1761800600n,
      }),
    ).toBe(ORACLE.proofDigest);
    expect(
      livenessDigest(DOMAIN, {
        agentId: 7n,
        releaseId: ORACLE.releaseId,
        originHash: ORACLE.originHash,
        challenge: `0x${'ef'.repeat(32)}`,
        issuedAt: 1761800000n,
      }),
    ).toBe(ORACLE.livenessDigest);
  });

  it('payer signature digest (SPEC §2.5, EIP-191)', () => {
    expect(payerSigMessage(ORACLE.requestId, 1761800000)).toBe(ORACLE.payerSigMessage);
    expect(payerSigDigest(ORACLE.requestId, 1761800000)).toBe(ORACLE.payerSigDigest);
  });
});
