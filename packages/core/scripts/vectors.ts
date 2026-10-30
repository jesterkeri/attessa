// Builds the cross-language vectors (INV-18). Every expected value is computed by
// @attessa/core; hand-written expectations (normalized origins, refusal reasons) are
// asserted here, so the generator refuses to write a vector that disagrees with them.
import {
  domainSeparator,
  hashStruct,
  keccak256,
  numberToHex,
  stringToBytes,
  stringToHex,
  bytesToHex,
  hexToBytes,
  concat,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import {
  BINDING_TYPEHASH,
  EIP712_TYPES,
  OriginError,
  decodeAttestedProof,
  derivedRequestId,
  eip712Domain,
  encodeAttestedProof,
  encodeUserData,
  inputsHash,
  isChallengeHeader,
  isRequestIdHeader,
  isRetryAfterHeader,
  jcs,
  livenessDigest,
  livenessToJson,
  normalizeOrigin,
  originHash,
  parsePayerSig,
  payerSigDigest,
  payerSigMessage,
  proofDigest,
  proofToJson,
  recoverDigestSigner,
  releaseId,
  requestHash,
  responseHash,
  signerFromPublicKey,
  type ExecutionProof,
  type Liveness,
} from '../src/index.ts';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_UINT64 = 2n ** 64n - 1n;

/** Deterministic test keys, derived from a public label. They hold nothing and are never written to a vector. */
function testKey(n: number): Hex {
  return keccak256(stringToBytes(`attessa-test-vector-key-${n}`));
}

/** Deterministic filler bytes of any length. */
function filler(label: string, len: number): Hex {
  let out: Hex = '0x';
  for (let i = 0; out.length < 2 + len * 2; i++) out = concat([out, keccak256(stringToBytes(`${label}/${i}`))]);
  return out.slice(0, 2 + len * 2) as Hex;
}

function hex32(label: string): Hex {
  return keccak256(stringToBytes(label));
}

function check(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`vector self-check failed: ${msg}`);
}

const SEPOLIA_REGISTRY: Address = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const MAINNET_REGISTRY: Address = '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512';

// ---------------------------------------------------------------- origins

function origins() {
  const l63 = (c: string) => c.repeat(63);
  const host259 = `${l63('a')}.${l63('b')}.${l63('c')}.${l63('d')}.com`; // 255 + 4
  const valid: { name: string; input: string; local: boolean; expected: string }[] = [
    { name: 'plain', input: 'https://example.com', local: false, expected: 'https://example.com' },
    { name: 'uppercase host and scheme', input: 'HTTPS://EXAMPLE.COM', local: false, expected: 'https://example.com' },
    { name: 'port 443 dropped', input: 'https://example.com:443', local: false, expected: 'https://example.com' },
    { name: 'port 443 with leading zero dropped', input: 'https://example.com:0443/', local: false, expected: 'https://example.com' },
    { name: 'other port kept', input: 'https://example.com:8443', local: false, expected: 'https://example.com:8443' },
    {
      name: 'path query fragment dropped',
      input: 'https://api.Example.com:8443/v1/evaluate?x=1#frag',
      local: false,
      expected: 'https://api.example.com:8443',
    },
    { name: 'IDN', input: 'https://münchen.de', local: false, expected: 'https://xn--mnchen-3ya.de' },
    { name: 'IDN uppercase', input: 'https://MÜNCHEN.DE/', local: false, expected: 'https://xn--mnchen-3ya.de' },
    { name: 'sharp s non-transitional (not strasse)', input: 'https://Straße.de', local: false, expected: 'https://xn--strae-oqa.de' },
    { name: 'sharp s only', input: 'https://ß.example', local: false, expected: 'https://xn--zca.example' },
    { name: 'fullwidth mapped', input: 'https://ＥＸＡＭＰＬＥ.com', local: false, expected: 'https://example.com' },
    { name: 'emoji', input: 'https://😀.com', local: false, expected: 'https://xn--e28h.com' },
    { name: 'percent-encoded host', input: 'https://ex%41mple.com', local: false, expected: 'https://example.com' },
    { name: 'minimum length 9 bytes', input: 'https://a', local: false, expected: 'https://a' },
    { name: 'maximum length 267 bytes', input: `https://${host259}/path`, local: false, expected: `https://${host259}` },
    { name: 'local http localhost with port', input: 'http://localhost:8545/', local: true, expected: 'http://localhost:8545' },
    { name: 'local https IPv4 literal', input: 'https://127.0.0.1:8443', local: true, expected: 'https://127.0.0.1:8443' },
  ];
  const invalid: { name: string; input: string; local: boolean; reason: string }[] = [
    { name: 'http', input: 'http://example.com', local: false, reason: 'not_https' },
    { name: 'ftp', input: 'ftp://example.com', local: false, reason: 'not_https' },
    { name: 'http localhost off local', input: 'http://localhost:8545', local: false, reason: 'not_https' },
    { name: 'http localhost without port on local', input: 'http://localhost', local: true, reason: 'not_https' },
    { name: 'trailing dot', input: 'https://example.com.', local: false, reason: 'trailing_dot' },
    { name: 'trailing dot with port', input: 'https://example.com.:8443/', local: false, reason: 'trailing_dot' },
    { name: 'IPv4 literal', input: 'https://127.0.0.1', local: false, reason: 'ip_literal' },
    { name: 'IPv4 literal in hex form', input: 'https://0x7f.1', local: false, reason: 'ip_literal' },
    { name: 'IPv6 literal', input: 'https://[::1]:8443', local: false, reason: 'ip_literal' },
    { name: 'userinfo', input: 'https://user:pw@example.com', local: false, reason: 'userinfo' },
    { name: '268 bytes', input: `https://${host259}x`, local: false, reason: 'length' },
    { name: 'not a URL', input: 'example.com', local: false, reason: 'invalid_url' },
    { name: 'invalid punycode label', input: 'https://xn--a.com', local: false, reason: 'invalid_url' },
    { name: 'zero-width joiner', input: 'https://a‍b.com', local: false, reason: 'invalid_url' },
    // UTS-46 CheckBidi (RFC 5893), which WHATWG sets and Node's built-in URL skips.
    { name: 'bidi: label of Arabic-Indic digits', input: 'https://\u0661\u0662.com', local: false, reason: 'invalid_url' },
    { name: 'bidi: same label as punycode', input: 'https://xn--9hbc.com', local: false, reason: 'invalid_url' },
    { name: 'bidi: Latin label with an Arabic-Indic digit', input: 'https://a\u0661.com', local: false, reason: 'invalid_url' },
  ];
  return {
    spec: 'SPEC §2.1. valid[].normalized = normalizeOrigin(input), originHash = keccak256(utf8(normalized)). local = --network local.',
    valid: valid.map((c) => {
      const normalized = normalizeOrigin(c.input, { local: c.local });
      check(normalized === c.expected, `origin ${c.name}: got ${normalized}`);
      return { name: c.name, input: c.input, local: c.local, normalized, bytes: stringToBytes(normalized).length, originHash: originHash(normalized) };
    }),
    invalid: invalid.map((c) => {
      let reason = 'accepted';
      try {
        normalizeOrigin(c.input, { local: c.local });
      } catch (e) {
        reason = e instanceof OriginError ? e.reason : 'threw';
      }
      check(reason === c.reason, `origin ${c.name}: got ${reason}`);
      return c;
    }),
  };
}

// ---------------------------------------------------------------- hashes

const ALLOW_BODY = '{"amount":"20000","asset":"0x01c5c0122039549ad1493b8220cabedd739bc44e","chainId":"11142220","payTo":"0x1111111111111111111111111111111111111111"}';
const SAMPLE_INPUTS = {
  source: 'forno',
  payTo: { nonce: '7', code: '0x', balanceWei: '1000000000000000000', address: '0x1111111111111111111111111111111111111111' },
  block: { timestamp: '1761700000', number: '12345678', hash: hex32('block-12345678') },
};

/** RFC 8785 Appendix B: IEEE-754 bit patterns and their JCS text (NaN and Infinity omitted: JCS refuses them). */
const APPENDIX_B: [string, string][] = [
  ['0000000000000000', '0'],
  ['8000000000000000', '0'],
  ['0000000000000001', '5e-324'],
  ['8000000000000001', '-5e-324'],
  ['7fefffffffffffff', '1.7976931348623157e+308'],
  ['ffefffffffffffff', '-1.7976931348623157e+308'],
  ['4340000000000000', '9007199254740992'],
  ['c340000000000000', '-9007199254740992'],
  ['4430000000000000', '295147905179352830000'],
  ['44b52d02c7e14af5', '9.999999999999997e+22'],
  ['44b52d02c7e14af6', '1e+23'],
  ['44b52d02c7e14af7', '1.0000000000000001e+23'],
  ['444b1ae4d6e2ef4e', '999999999999999700000'],
  ['444b1ae4d6e2ef4f', '999999999999999900000'],
  ['444b1ae4d6e2ef50', '1e+21'],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
  ['3eb0c6f7a0b5ed8d', '0.000001'],
  ['41b3de4355555553', '333333333.3333332'],
  ['41b3de4355555554', '333333333.33333325'],
  ['41b3de4355555555', '333333333.3333333'],
  ['41b3de4355555556', '333333333.3333334'],
  ['41b3de4355555557', '333333333.33333343'],
  ['becbf647612f3696', '-0.0000033333333333333333'],
  ['43143ff3c1cb0959', '1424953923781206.2'],
];

function f64(bits: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${bits}`));
  return view.getFloat64(0);
}

function hashes() {
  const enc = (s: string) => stringToBytes(s);
  const requestCases: { name: string; method: string; pathAndQuery: string; body: Uint8Array }[] = [
    { name: 'evaluate POST', method: 'POST', pathAndQuery: '/v1/evaluate', body: enc(ALLOW_BODY) },
    { name: 'lowercase method is uppercased', method: 'post', pathAndQuery: '/v1/evaluate', body: enc(ALLOW_BODY) },
    { name: 'GET with empty body', method: 'GET', pathAndQuery: `/v1/results/${hex32('rid')}`, body: new Uint8Array() },
    { name: 'query string kept as sent', method: 'POST', pathAndQuery: '/v1/evaluate?a=1&b=%20x', body: enc('{}') },
    { name: 'binary body with zero bytes', method: 'PUT', pathAndQuery: '/', body: hexToBytes('0x00ff0000017f80') },
    // ASCII-only uppercasing: 'ß' stays 'ß' (Unicode uppercasing would give 'SS').
    { name: 'non-ASCII method uppercased ASCII-only', method: 'po\u00dft', pathAndQuery: '/v1/evaluate', body: enc('{}') },
  ];
  const responseBodies: { name: string; body: Uint8Array }[] = [
    { name: 'empty', body: new Uint8Array() },
    {
      name: 'evaluate response',
      body: enc(jcs({ verdict: 'review', reasons: ['pay_to_never_sent'], rulesVersion: '1', inputs: SAMPLE_INPUTS })),
    },
    { name: 'binary', body: hexToBytes(filler('response', 100)) },
  ];
  const inputsCases: { name: string; inputs: unknown; expectJcs?: string }[] = [
    { name: 'forno inputs, keys out of order', inputs: SAMPLE_INPUTS },
    {
      name: 'buy inputs, contract payTo',
      inputs: {
        block: { number: '44000000', hash: hex32('b44'), timestamp: '1762000000' },
        payTo: { address: '0x2222222222222222222222222222222222222222', code: '0x6080604052', nonce: '1', balanceWei: '0' },
        source: 'buy:celo-rpc',
      },
    },
    {
      name: 'JCS escaping and UTF-16 key order',
      inputs: { '€': 'euro', '\r': 'cr', '1': 'one', a: 'line\nbreak "q" \\ \u0007 é 😀', A: ['x', 'y'] },
    },
    {
      name: 'RFC 8785 3.2.3 sort example (UTF-16 code units, not code points)',
      inputs: {
        '\u20ac': 'Euro Sign',
        '\r': 'Carriage Return',
        '\ufb33': 'Hebrew Letter Dalet With Dagesh',
        '1': 'One',
        '\ud83d\ude00': 'Emoji: Grinning Face',
        '\u0080': 'Control',
        '\u00f6': 'Latin Small Letter O With Diaeresis',
      },
      expectJcs:
        '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    },
    {
      name: 'empty key, emoji before U+E000 (code-point order would swap them)',
      inputs: { '\ue000': 'private use', '\ud83d\ude00': 'emoji', '': 'empty' },
      expectJcs: '{"":"empty","\ud83d\ude00":"emoji","\ue000":"private use"}',
    },
    {
      name: 'RFC 8785 Appendix B numbers',
      inputs: { numbers: APPENDIX_B.map(([bits]) => f64(bits)) },
      expectJcs: `{"numbers":[${APPENDIX_B.map(([, text]) => text).join(',')}]}`,
    },
  ];
  for (const c of inputsCases) if (c.expectJcs !== undefined) check(jcs(c.inputs) === c.expectJcs, `jcs ${c.name}: got ${jcs(c.inputs)}`);
  const pcr = (l: string) => filler(l, 48);
  const releaseCases: { name: string; pcrs: [Hex, Hex, Hex] }[] = [
    { name: 'distinct PCRs', pcrs: [pcr('pcr0'), pcr('pcr1'), pcr('pcr2')] },
    { name: 'swapped PCRs differ', pcrs: [pcr('pcr1'), pcr('pcr0'), pcr('pcr2')] },
    { name: 'all zero (hash only; approveRelease rejects it)', pcrs: [bytesToHex(new Uint8Array(48)), bytesToHex(new Uint8Array(48)), bytesToHex(new Uint8Array(48))] },
  ];
  const requestIdCases: { name: string; asset: Address; payer: Address; nonce: Hex }[] = [
    { name: 'sepolia USDC', asset: '0x01c5c0122039549ad1493b8220cabedd739bc44e', payer: privateKeyToAccount(testKey(1)).address.toLowerCase() as Address, nonce: hex32('nonce-1') },
    { name: 'mainnet USA₮, zero nonce', asset: '0xd2ab3c9a02dbbab236bfec45d1d755df4267f771', payer: '0xffffffffffffffffffffffffffffffffffffffff', nonce: bytesToHex(new Uint8Array(32)) },
  ];
  return {
    spec: 'SPEC §2.2. Bytes are lowercase hex; requestHash uppercases method; inputsHash = keccak256(utf8(jcs)).',
    requestHash: requestCases.map((c) => ({
      name: c.name,
      method: c.method,
      pathAndQuery: c.pathAndQuery,
      body: bytesToHex(c.body),
      expected: requestHash(c.method, c.pathAndQuery, c.body),
    })),
    responseHash: responseBodies.map((c) => ({ name: c.name, body: bytesToHex(c.body), expected: responseHash(c.body) })),
    inputsHash: inputsCases.map((c) => ({ name: c.name, inputs: c.inputs, jcs: jcs(c.inputs), expected: inputsHash(c.inputs) })),
    releaseId: releaseCases.map((c) => ({ name: c.name, pcr0: c.pcrs[0], pcr1: c.pcrs[1], pcr2: c.pcrs[2], expected: releaseId(...c.pcrs) })),
    requestId: requestIdCases.map((c) => ({ ...c, expected: derivedRequestId(c.asset, c.payer, c.nonce) })),
  };
}

// ---------------------------------------------------------------- binding

function binding() {
  const cases = [
    { name: 'sepolia agent 1', chainId: 11142220n, registry: SEPOLIA_REGISTRY, agentId: 1n, originHash: originHash('https://seller.example') },
    { name: 'mainnet', chainId: 42220n, registry: MAINNET_REGISTRY, agentId: 4242n, originHash: originHash('https://pay.example.com') },
    { name: 'anvil', chainId: 31337n, registry: SEPOLIA_REGISTRY, agentId: 0n, originHash: originHash('http://localhost:8545') },
    { name: 'max agentId', chainId: 11142220n, registry: SEPOLIA_REGISTRY, agentId: MAX_UINT256, originHash: originHash('https://a') },
    { name: 'max chainId, high-bit registry', chainId: MAX_UINT256, registry: '0xffffffffffffffffffffffffffffffffffffffff' as Address, agentId: 1n, originHash: hex32('o') },
    { name: 'all zero', chainId: 0n, registry: '0x0000000000000000000000000000000000000000' as Address, agentId: 0n, originHash: bytesToHex(new Uint8Array(32)) },
  ];
  return {
    spec: 'SPEC §2.4. userData = abi.encode(typehash, uint256 chainId, address registry, uint256 agentId, bytes32 originHash), 160 bytes. signer = last 20 bytes of keccak256(publicKey[1:65]).',
    typehashPreimage: 'AttestedExecution.SignerBinding.v1',
    typehash: BINDING_TYPEHASH,
    userData: cases.map((c) => {
      const expected = encodeUserData(c);
      check(hexToBytes(expected).length === 160, 'user_data length');
      return { name: c.name, chainId: c.chainId.toString(), registry: c.registry, agentId: c.agentId.toString(), originHash: c.originHash, expected };
    }),
    signer: [1, 2, 3, 4].map((n) => {
      const acct = privateKeyToAccount(testKey(n));
      const expected = signerFromPublicKey(acct.publicKey);
      check(expected === acct.address.toLowerCase(), 'signer derivation');
      return { name: `test key ${n}`, publicKey: acct.publicKey, expected };
    }),
  };
}

// ---------------------------------------------------------------- eip712

const PROOF_TYPE = 'ExecutionProof(uint256 agentId,bytes32 releaseId,bytes32 requestId,bytes32 requestHash,bytes32 responseHash,bytes32 inputsHash,bytes32 paymentId,uint64 issuedAt,uint64 expiresAt)';
const LIVENESS_TYPE = 'Liveness(uint256 agentId,bytes32 releaseId,bytes32 originHash,bytes32 challenge,uint64 issuedAt)';

function sampleProof(label: string, agentId: bigint, issuedAt: bigint): ExecutionProof {
  return {
    agentId,
    releaseId: releaseId(filler(`${label}0`, 48), filler(`${label}1`, 48), filler(`${label}2`, 48)),
    requestId: hex32(`${label}/requestId`),
    requestHash: requestHash('POST', '/v1/evaluate', stringToBytes(ALLOW_BODY)),
    responseHash: hex32(`${label}/response`),
    inputsHash: inputsHash(SAMPLE_INPUTS),
    paymentId: hex32(`${label}/nonce`),
    issuedAt,
    expiresAt: issuedAt + 600n,
  };
}

const PROOFS: { name: string; chainId: bigint; registry: Address; proof: ExecutionProof }[] = [
  { name: 'sepolia', chainId: 11142220n, registry: SEPOLIA_REGISTRY, proof: sampleProof('p1', 1n, 1761700000n) },
  { name: 'mainnet', chainId: 42220n, registry: MAINNET_REGISTRY, proof: sampleProof('p2', 77n, 1762000000n) },
  {
    name: 'max values',
    chainId: 11142220n,
    registry: SEPOLIA_REGISTRY,
    proof: { ...sampleProof('p3', MAX_UINT256, MAX_UINT64 - 600n), expiresAt: MAX_UINT64 },
  },
];

/** Flips the last data character before the padding so the unused bits are non-zero. */
function nonCanonicalPadding(header: string): string {
  const i = header.indexOf('=') - 1;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const c = alphabet[alphabet.indexOf(header[i]!) ^ 1]!;
  return header.slice(0, i) + c + header.slice(i + 1);
}

function signature65(r: bigint, s: bigint, v: number): Hex {
  return concat([numberToHex(r, { size: 32 }), numberToHex(s, { size: 32 }), numberToHex(v, { size: 1 })]);
}

async function eip712() {
  const proof = PROOFS.map((c) => {
    const domain = eip712Domain(c.chainId, c.registry);
    return {
      name: c.name,
      chainId: c.chainId.toString(),
      verifyingContract: c.registry,
      domainSeparator: domainSeparator({ domain }),
      ...proofToJson(c.proof),
      structHash: hashStruct({ types: EIP712_TYPES, primaryType: 'ExecutionProof', data: c.proof }),
      digest: proofDigest(domain, c.proof),
    };
  });
  const lives: { name: string; chainId: bigint; registry: Address; l: Liveness }[] = [
    { name: 'sepolia', chainId: 11142220n, registry: SEPOLIA_REGISTRY, l: { agentId: 1n, releaseId: PROOFS[0]!.proof.releaseId, originHash: originHash('https://seller.example'), challenge: hex32('challenge-1'), issuedAt: 1761700000n } },
    { name: 'mainnet', chainId: 42220n, registry: MAINNET_REGISTRY, l: { agentId: 77n, releaseId: PROOFS[1]!.proof.releaseId, originHash: originHash('https://pay.example.com'), challenge: hex32('challenge-2'), issuedAt: 1762000000n } },
    { name: 'zero challenge, issuedAt 0', chainId: 11142220n, registry: SEPOLIA_REGISTRY, l: { agentId: 0n, releaseId: hex32('r'), originHash: originHash('https://a'), challenge: bytesToHex(new Uint8Array(32)), issuedAt: 0n } },
  ];
  const liveness = lives.map((c) => {
    const domain = eip712Domain(c.chainId, c.registry);
    return {
      name: c.name,
      chainId: c.chainId.toString(),
      verifyingContract: c.registry,
      domainSeparator: domainSeparator({ domain }),
      ...livenessToJson(c.l),
      structHash: hashStruct({ types: EIP712_TYPES, primaryType: 'Liveness', data: c.l }),
      digest: livenessDigest(domain, c.l),
    };
  });

  const signatures: { name: string; digest: Hex; signature: Hex; valid: boolean; signer: string; reason: string }[] = [];
  const addSig = async (name: string, digest: Hex, signature: Hex, expect: string, reason: string) => {
    const got = (await recoverDigestSigner(digest, signature)) ?? '';
    check(got === expect, `signature ${name}: got ${got}`);
    signatures.push({ name, digest, signature, valid: expect !== '', signer: expect, reason });
  };
  for (const [i, d] of [proof[0]!.digest, proof[1]!.digest, liveness[0]!.digest].entries()) {
    const key = testKey(10 + i);
    const signer = privateKeyToAccount(key).address.toLowerCase();
    const sig = await sign({ hash: d, privateKey: key, to: 'hex' });
    await addSig(`valid, key ${10 + i}`, d, sig, signer, 'ok');
  }
  const d = proof[0]!.digest;
  const key = testKey(10);
  const raw = await sign({ hash: d, privateKey: key });
  const v = Number(raw.v);
  await addSig('another key signs the same digest', d, await sign({ hash: d, privateKey: testKey(20), to: 'hex' }), privateKeyToAccount(testKey(20)).address.toLowerCase(), 'ok');
  await addSig('high-s twin of a valid signature', d, signature65(BigInt(raw.r), N - BigInt(raw.s), v === 27 ? 28 : 27), '', 'high_s');
  await addSig('v = 0', d, signature65(BigInt(raw.r), BigInt(raw.s), v - 27), '', 'bad_v');
  await addSig('v = 29', d, signature65(BigInt(raw.r), BigInt(raw.s), 29), '', 'bad_v');
  await addSig('r = 0', d, signature65(0n, BigInt(raw.s), v), '', 'zero_r');
  await addSig('64 bytes (compact)', d, signature65(BigInt(raw.r), BigInt(raw.s), v).slice(0, 130) as Hex, '', 'bad_length');

  return {
    spec: 'SPEC §2.3. Domain {name:"AttestedExecution",version:"1",chainId,verifyingContract}. Proof and liveness fields are the §2.3 JSON strings. Signatures r‖s‖v, v in {27,28}, high-s invalid; signer "" when invalid.',
    domain: { name: 'AttestedExecution', version: '1' },
    typeStrings: { ExecutionProof: PROOF_TYPE, Liveness: LIVENESS_TYPE },
    typehashes: { ExecutionProof: keccak256(stringToHex(PROOF_TYPE)), Liveness: keccak256(stringToHex(LIVENESS_TYPE)) },
    proof,
    liveness,
    signatures,
  };
}

// ---------------------------------------------------------------- headers

async function headers() {
  const bytes32 = {
    valid: [
      { name: 'random', value: hex32('rid-1') },
      { name: 'zero', value: bytesToHex(new Uint8Array(32)) },
    ],
    invalid: [
      { name: 'uppercase hex', value: hex32('rid-1').toUpperCase().replace('0X', '0x') },
      { name: 'uppercase prefix', value: hex32('rid-1').replace('0x', '0X') },
      { name: '31 bytes', value: hex32('rid-1').slice(0, 64) },
      { name: '33 bytes', value: `${hex32('rid-1')}00` },
      { name: 'no prefix', value: hex32('rid-1').slice(2) },
      { name: 'trailing space', value: `${hex32('rid-1')} ` },
      { name: 'empty', value: '' },
    ],
  };
  for (const c of bytes32.valid) check(isRequestIdHeader(c.value) && isChallengeHeader(c.value), `bytes32 ${c.name}`);
  for (const c of bytes32.invalid) check(!isRequestIdHeader(c.value) && !isChallengeHeader(c.value), `bytes32 ${c.name}`);

  const retryAfter = {
    valid: ['0', '5', '300'].map((value) => ({ name: value, value })),
    invalid: [
      { name: 'leading zero', value: '05' },
      { name: 'negative', value: '-1' },
      { name: 'fraction', value: '1.5' },
      { name: 'HTTP date', value: 'Wed, 21 Oct 2026 07:28:00 GMT' },
    ],
  };
  for (const c of retryAfter.valid) check(isRetryAfterHeader(c.value), `retry ${c.name}`);
  for (const c of retryAfter.invalid) check(!isRetryAfterHeader(c.value), `retry ${c.name}`);

  // X-Attest-Payer-Sig
  const payerValid = [];
  for (const [i, t] of [1761700000, 0].entries()) {
    const key = testKey(30 + i);
    const requestId = hex32(`payer-rid-${i}`);
    const digest = payerSigDigest(requestId, t);
    const signature = await sign({ hash: digest, privateKey: key, to: 'hex' });
    const header = `${t}.${signature}`;
    const parsed = parsePayerSig(header);
    const signer = privateKeyToAccount(key).address.toLowerCase();
    check(parsed !== null && (await recoverDigestSigner(digest, parsed.signature)) === signer, `payer sig ${i}`);
    payerValid.push({ name: `key ${30 + i}, t=${t}`, header, requestId, unixSeconds: String(t), signature, message: payerSigMessage(requestId, t), digest, signer });
  }
  const goodSig = payerValid[0]!.signature;
  const payerInvalid = [
    { name: 'no dot', header: `1761700000${goodSig}` },
    { name: 'leading zero seconds', header: `01761700000.${goodSig}` },
    { name: 'negative seconds', header: `-1.${goodSig}` },
    { name: 'uppercase hex', header: `1761700000.0x${goodSig.slice(2).toUpperCase()}` },
    { name: '64-byte signature', header: `1761700000.${goodSig.slice(0, 130)}` },
    { name: 'space after dot', header: `1761700000. ${goodSig}` },
    { name: 'empty seconds', header: `.${goodSig}` },
  ];
  for (const c of payerInvalid) check(parsePayerSig(c.header) === null, `payer invalid ${c.name}`);

  // X-Attested-Proof
  const proofValid = [];
  for (const [i, c] of PROOFS.entries()) {
    const key = testKey(40 + i);
    const signature = await sign({ hash: proofDigest(eip712Domain(c.chainId, c.registry), c.proof), privateKey: key, to: 'hex' });
    const signer = privateKeyToAccount(key).address.toLowerCase() as Address;
    const header = encodeAttestedProof({ proof: c.proof, signature, signer });
    const back = decodeAttestedProof(header);
    check(back.signer === signer && back.proof.agentId === c.proof.agentId, `attested proof ${c.name}`);
    proofValid.push({
      name: c.name,
      header,
      json: Buffer.from(header, 'base64').toString('utf8'),
      chainId: c.chainId.toString(),
      verifyingContract: c.registry,
      signature,
      signer,
    });
  }
  const goodJson = JSON.parse(proofValid[0]!.json) as { proof: Record<string, string>; signature: string; signer: string };
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
  const withProof = (patch: Record<string, unknown>, drop?: string) => {
    const p: Record<string, unknown> = { ...goodJson.proof, ...patch };
    if (drop) delete p[drop];
    return b64(jcs({ ...goodJson, proof: p }));
  };
  const goodHeader = proofValid[0]!.header;
  const paddedHeader = proofValid.find((c) => c.header.endsWith('='))?.header ?? '';
  check(paddedHeader !== '', 'need a padded attested-proof header');
  const proofInvalid = [
    { name: 'non-standard alphabet character', header: `-${goodHeader.slice(1)}`, reason: 'base64' },
    { name: 'padding removed', header: paddedHeader.replace(/=+$/, ''), reason: 'base64' },
    { name: 'non-zero padding bits', header: nonCanonicalPadding(paddedHeader), reason: 'base64' },
    { name: 'whitespace JSON (not JCS)', header: b64(JSON.stringify(goodJson, null, 1)), reason: 'not_jcs' },
    { name: 'extra top-level field', header: b64(jcs({ ...goodJson, extra: '1' })), reason: 'unknown_field' },
    { name: 'extra proof field', header: withProof({ zz: '1' }), reason: 'unknown_field' },
    { name: 'missing proof field', header: withProof({}, 'paymentId'), reason: 'missing_field' },
    { name: 'number instead of string', header: withProof({ issuedAt: 1761700000 }), reason: 'field_grammar' },
    { name: 'uppercase bytes32', header: withProof({ requestId: goodJson.proof.requestId!.toUpperCase().replace('0X', '0x') }), reason: 'field_grammar' },
    { name: 'leading zero integer', header: withProof({ agentId: '01' }), reason: 'field_grammar' },
    { name: 'uint64 overflow', header: withProof({ expiresAt: (MAX_UINT64 + 1n).toString() }), reason: 'field_grammar' },
    { name: 'UTF-8 BOM before the JCS bytes', header: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(jcs(goodJson), 'utf8')]).toString('base64'), reason: 'not_jcs' },
    { name: 'uppercase signer', header: b64(jcs({ ...goodJson, signer: goodJson.signer.toUpperCase().replace('0X', '0x') })), reason: 'field_grammar' },
  ];
  for (const c of proofInvalid) {
    let threw = false;
    try {
      decodeAttestedProof(c.header);
    } catch {
      threw = true;
    }
    check(threw, `attested proof invalid ${c.name}`);
  }

  return {
    spec: 'SPEC §2.5. X-Request-Id and X-Attest-Challenge share the bytes32 grammar. X-Attest-Payer-Sig message is EIP-191 personal_sign. X-Attested-Proof is base64(JCS); its proof fields are in eip712.json grammar.',
    bytes32: bytes32,
    retryAfter,
    payerSig: { valid: payerValid, invalid: payerInvalid },
    attestedProof: { valid: proofValid, invalid: proofInvalid },
  };
}

export async function buildVectors(): Promise<Record<string, unknown>> {
  return {
    'origins.json': origins(),
    'hashes.json': hashes(),
    'binding.json': binding(),
    'eip712.json': await eip712(),
    'headers.json': await headers(),
  };
}

/** The exact file text written for a vectors object. */
export function serialize(v: unknown): string {
  return `${JSON.stringify(v, null, 2)}\n`;
}
