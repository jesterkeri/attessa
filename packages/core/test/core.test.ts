import { describe, expect, it } from 'vitest';
import {
  concat,
  encodeAbiParameters,
  hexToBytes,
  isAddress,
  keccak256,
  slice,
  stringToBytes,
  stringToHex,
  type Hex,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import {
  BINDING_TYPEHASH,
  DEPLOYMENTS,
  GATEWAY_ERRORS,
  OriginError,
  decodeAttestedProof,
  deploymentForChainId,
  derivedRequestId,
  eip712Domain,
  encodeAttestedProof,
  encodeUserData,
  inputsHash,
  jcs,
  livenessDigest,
  normalizeOrigin,
  originHash,
  parsePayerSig,
  payerSigMessage,
  proofDigest,
  proofFromJson,
  proofToJson,
  recoverDigestSigner,
  releaseId,
  requestHash,
  signerFromPublicKey,
  type ExecutionProof,
} from '../src/index.ts';

const KEY = keccak256(stringToBytes('attessa-core-unit-test-key'));
const REGISTRY = '0x5fbdb2315678afecb367f032d93f642f64180aa3' as const;
const h = (s: string) => keccak256(stringToBytes(s));

function reason(input: string, local = false): string {
  try {
    return normalizeOrigin(input, { local });
  } catch (e) {
    return e instanceof OriginError ? `!${e.reason}` : '!threw';
  }
}

describe('normalizeOrigin (SPEC §2.1)', () => {
  it('handles the T03 edge cases with the built-in WHATWG URL', () => {
    expect(reason('https://münchen.de/x')).toBe('https://xn--mnchen-3ya.de'); // IDN
    expect(reason('https://Straße.de')).toBe('https://xn--strae-oqa.de'); // ß non-transitional
    expect(reason('https://example.com.')).toBe('!trailing_dot');
    expect(reason('https://192.168.1.1')).toBe('!ip_literal');
    expect(reason('https://[2001:db8::1]')).toBe('!ip_literal');
    expect(reason('https://example.com:443/')).toBe('https://example.com');
    expect(reason('https://example.com:8443/')).toBe('https://example.com:8443');
    expect(reason('https://EXAMPLE.COM')).toBe('https://example.com');
    const host259 = `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`;
    expect(reason(`https://${host259}`)).toHaveLength(267);
    expect(reason(`https://${host259}x`)).toBe('!length'); // 268 bytes
  });

  it('allows http://localhost:<port> and IP literals only on local', () => {
    expect(reason('http://localhost:8545')).toBe('!not_https');
    expect(reason('http://localhost:8545', true)).toBe('http://localhost:8545');
    expect(reason('http://127.0.0.1:8545', true)).toBe('!not_https');
    expect(reason('https://127.0.0.1:8443', true)).toBe('https://127.0.0.1:8443');
  });

  it('rejects userinfo and non-https schemes', () => {
    expect(reason('https://u@example.com')).toBe('!userinfo');
    expect(reason('http://example.com')).toBe('!not_https');
    expect(reason('wss://example.com')).toBe('!not_https');
  });

  it('originHash is keccak256 of the UTF-8 string', () => {
    expect(originHash('https://example.com')).toBe(keccak256(stringToHex('https://example.com')));
  });
});

describe('JCS (RFC 8785)', () => {
  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      'דּ': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      'ö': 'Latin Small Letter O With Diaeresis',
    };
    expect(jcs(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it('serialises numbers and literals as RFC 8785 does', () => {
    expect(jcs([1e21, 1e-7, -0, 0.1, 333333333.3333333, null, true, false])).toBe(
      '[1e+21,1e-7,0,0.1,333333333.3333333,null,true,false]',
    );
    expect(jcs({ b: [], a: {} })).toBe('{"a":{},"b":[]}');
  });

  it('refuses what JSON cannot represent canonically', () => {
    expect(() => jcs(Number.NaN)).toThrow();
    expect(() => jcs('\ud800')).toThrow();
    expect(() => jcs({ a: undefined })).toThrow();
    expect(() => jcs(1n)).toThrow();
  });
});

describe('hashes (SPEC §2.2)', () => {
  it('requestHash is METHOD ‖ 0x00 ‖ pathAndQuery ‖ 0x00 ‖ body', () => {
    const body = stringToBytes('{"a":"b"}');
    const manual = keccak256(concat([stringToHex('POST'), '0x00', stringToHex('/v1/evaluate?x=1'), '0x00', stringToHex('{"a":"b"}')]));
    expect(requestHash('POST', '/v1/evaluate?x=1', body)).toBe(manual);
    expect(requestHash('post', '/v1/evaluate?x=1', body)).toBe(manual);
    expect(() => requestHash('POST', 'v1/evaluate', body)).toThrow();
  });

  it('inputsHash hashes the JCS text', () => {
    expect(inputsHash({ b: '1', a: '2' })).toBe(keccak256(stringToHex('{"a":"2","b":"1"}')));
  });

  it('releaseId concatenates three 48-byte PCRs', () => {
    const p = ('0x' + '11'.repeat(48)) as Hex;
    expect(releaseId(p, p, p)).toBe(keccak256(('0x' + '11'.repeat(144)) as Hex));
    expect(() => releaseId(('0x' + '11'.repeat(47)) as Hex, p, p)).toThrow();
    expect(() => releaseId(p, p, ('0x' + '11'.repeat(32)) as Hex)).toThrow();
  });

  it('derived requestId left-pads asset and payer to 32 bytes', () => {
    const asset = '0x01c5c0122039549ad1493b8220cabedd739bc44e';
    const payer = '0x1111111111111111111111111111111111111111';
    const nonce = h('n');
    const manual = keccak256(concat([`0x${'00'.repeat(12)}${asset.slice(2)}`, `0x${'00'.repeat(12)}${payer.slice(2)}`, nonce]));
    expect(derivedRequestId(asset, payer, nonce)).toBe(manual);
  });
});

describe('binding (SPEC §2.4)', () => {
  it('user_data is 160 bytes in the stated field order', () => {
    const oh = originHash('https://seller.example');
    const ud = encodeUserData({ chainId: 11142220n, registry: REGISTRY, agentId: 5n, originHash: oh });
    expect(hexToBytes(ud)).toHaveLength(160);
    expect(BINDING_TYPEHASH).toBe(keccak256(stringToHex('AttestedExecution.SignerBinding.v1')));
    expect(slice(ud, 0, 32)).toBe(BINDING_TYPEHASH);
    expect(BigInt(slice(ud, 32, 64))).toBe(11142220n);
    expect(slice(ud, 76, 96)).toBe(REGISTRY);
    expect(BigInt(slice(ud, 96, 128))).toBe(5n);
    expect(slice(ud, 128, 160)).toBe(oh);
  });

  it('signer comes from keccak256(X ‖ Y)', () => {
    const acct = privateKeyToAccount(KEY);
    expect(signerFromPublicKey(acct.publicKey)).toBe(acct.address.toLowerCase());
    expect(() => signerFromPublicKey(`0x02${acct.publicKey.slice(4)}`)).toThrow();
    expect(() => signerFromPublicKey(acct.publicKey.slice(0, 130) as Hex)).toThrow();
  });
});

const PROOF: ExecutionProof = {
  agentId: 3n,
  releaseId: h('release'),
  requestId: h('request'),
  requestHash: h('reqhash'),
  responseHash: h('resphash'),
  inputsHash: h('inputs'),
  paymentId: h('nonce'),
  issuedAt: 1761700000n,
  expiresAt: 1761700600n,
};

describe('EIP-712 (SPEC §2.3)', () => {
  const domain = eip712Domain(11142220n, REGISTRY);
  const ds = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [
        keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
        keccak256(stringToHex('AttestedExecution')),
        keccak256(stringToHex('1')),
        11142220n,
        REGISTRY,
      ],
    ),
  );

  it('proofDigest matches an encoding built by hand from the SPEC type string', () => {
    const typehash = keccak256(
      stringToHex(
        'ExecutionProof(uint256 agentId,bytes32 releaseId,bytes32 requestId,bytes32 requestHash,bytes32 responseHash,bytes32 inputsHash,bytes32 paymentId,uint64 issuedAt,uint64 expiresAt)',
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        ['bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint64', 'uint64'].map((type) => ({ type })),
        [typehash, PROOF.agentId, PROOF.releaseId, PROOF.requestId, PROOF.requestHash, PROOF.responseHash, PROOF.inputsHash, PROOF.paymentId, PROOF.issuedAt, PROOF.expiresAt],
      ),
    );
    expect(proofDigest(domain, PROOF)).toBe(keccak256(concat(['0x1901', ds, structHash])));
  });

  it('livenessDigest matches an encoding built by hand from the SPEC type string', () => {
    const l = { agentId: 3n, releaseId: h('r'), originHash: h('o'), challenge: h('c'), issuedAt: 9n };
    const typehash = keccak256(stringToHex('Liveness(uint256 agentId,bytes32 releaseId,bytes32 originHash,bytes32 challenge,uint64 issuedAt)'));
    const structHash = keccak256(
      encodeAbiParameters(
        ['bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32', 'uint64'].map((type) => ({ type })),
        [typehash, l.agentId, l.releaseId, l.originHash, l.challenge, l.issuedAt],
      ),
    );
    expect(livenessDigest(domain, l)).toBe(keccak256(concat(['0x1901', ds, structHash])));
  });

  it('recovers v=27/28 low-s signatures and refuses the rest', async () => {
    const digest = proofDigest(domain, PROOF);
    const sig = await sign({ hash: digest, privateKey: KEY, to: 'hex' });
    const signer = privateKeyToAccount(KEY).address.toLowerCase();
    expect(await recoverDigestSigner(digest, sig)).toBe(signer);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const s = BigInt(slice(sig, 32, 64));
    const v = Number(BigInt(slice(sig, 64, 65)));
    const highS = `${sig.slice(0, 66)}${(n - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;
    expect(await recoverDigestSigner(digest, highS)).toBeNull();
    expect(await recoverDigestSigner(digest, `${sig.slice(0, 130)}0${v - 27}`)).toBeNull();
    expect(await recoverDigestSigner(digest, sig.slice(0, 130))).toBeNull();
    expect(await recoverDigestSigner(digest, sig.toUpperCase().replace('0X', '0x'))).toBeNull();
  });

  it('JSON encoding is all strings and round-trips', () => {
    const json = proofToJson(PROOF);
    expect(Object.values(json).every((v) => typeof v === 'string')).toBe(true);
    expect(json.agentId).toBe('3');
    expect(proofFromJson(json)).toEqual(PROOF);
    expect(() => proofFromJson({ ...json, issuedAt: 1 })).toThrow();
    expect(() => proofFromJson({ ...json, extra: '1' })).toThrow();
    expect(() => proofFromJson({ ...json, issuedAt: (2n ** 64n).toString() })).toThrow();
  });
});

describe('headers (SPEC §2.5)', () => {
  it('X-Attested-Proof round-trips and is base64 of JCS', async () => {
    const sig = await sign({ hash: proofDigest(eip712Domain(1n, REGISTRY), PROOF), privateKey: KEY, to: 'hex' });
    const signer = privateKeyToAccount(KEY).address.toLowerCase() as `0x${string}`;
    const header = encodeAttestedProof({ proof: PROOF, signature: sig, signer });
    const text = Buffer.from(header, 'base64').toString('utf8');
    expect(text).toBe(jcs(JSON.parse(text)));
    expect(text.startsWith('{"proof":{"agentId":"3",')).toBe(true);
    expect(decodeAttestedProof(header)).toEqual({ proof: PROOF, signature: sig, signer });
  });

  it('X-Attest-Payer-Sig grammar and message', () => {
    const sig = `0x${'ab'.repeat(65)}`;
    expect(parsePayerSig(`1761700000.${sig}`)).toEqual({ unixSeconds: 1761700000, signature: sig });
    expect(parsePayerSig(`1761700000.${sig.slice(0, 130)}`)).toBeNull();
    expect(payerSigMessage(`0x${'AB'.repeat(32)}`, 5)).toBe(`attested-exec:results:0x${'ab'.repeat(32)}:5`);
  });
});

describe('deployments and pins (SPEC §2.6, §3.5)', () => {
  it('pins the SPEC addresses and domains', () => {
    const sep = deploymentForChainId(11142220);
    expect(sep).toBe(DEPLOYMENTS['celo-sepolia']);
    expect(sep.x402Network).toBe('eip155:11142220');
    expect(sep.assets.usdc).toEqual({ address: '0x01c5c0122039549ad1493b8220cabedd739bc44e', name: 'USDC', version: '2' });
    expect(sep.assets.usat).toBeUndefined();
    const main = deploymentForChainId(42220);
    expect(main.assets.usat).toEqual({ address: '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771', name: 'Tether America USD', version: '1' });
    for (const d of Object.values(DEPLOYMENTS)) {
      expect(isAddress(d.identityRegistry) && isAddress(d.selfRegistry)).toBe(true);
      expect(d.enclaveRegistry).toBeNull(); // set by T10 / T30
    }
    expect(() => deploymentForChainId(31337)).toThrow();
  });

  it('carries every SPEC §10 code', () => {
    expect(Object.keys(GATEWAY_ERRORS)).toHaveLength(16);
    expect(GATEWAY_ERRORS.settle_pending.http).toBe(202);
    expect(GATEWAY_ERRORS.payment_invalid.suggestion).toBeNull();
  });
});
