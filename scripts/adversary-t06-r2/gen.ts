// Adversary T06 r2: differential cases for the SPEC §2.5 header grammars.
// Every case is judged by @attessa/core (packages/core/src/headers.ts), the TypeScript reference,
// and emitted as Solidity so contracts/test/adv/AdversaryT06r2.t.sol can hold HeaderGrammar.sol to
// the same verdict and the same decoded fields.
// Run: node scripts/adversary-t06-r2/gen.ts  (from the repo root)
import { readFileSync, writeFileSync } from 'node:fs';
import {
  decodeAttestedProof,
  decodeBase64Strict,
  isRequestIdHeader,
  isRetryAfterHeader,
  parsePayerSig,
} from '../../packages/core/src/headers.ts';
import { jcs } from '../../packages/core/src/jcs.ts';

const root = new URL('../../', import.meta.url);
const vectors = JSON.parse(readFileSync(new URL('vectors/headers.json', root), 'utf8'));

// Deterministic PRNG so the emitted file is reproducible.
let seed = 0x7a11e55a;
const rnd = (n: number) => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed % n;
};

const b64 = (s: string | Buffer) => (typeof s === 'string' ? Buffer.from(s, 'utf8') : s).toString('base64');
const hexOf = (s: string | Buffer) => (typeof s === 'string' ? Buffer.from(s, 'latin1') : s).toString('hex');

// ------------------------------------------------------------ scalar cases
const bytes32Good = vectors.bytes32.valid[0].value as string;
const scalarBytes32: string[] = [
  bytes32Good, '0x' + 'f'.repeat(64), '0x' + 'a'.repeat(63) + 'g', '0x' + 'A' + bytes32Good.slice(3),
  bytes32Good + '\n', '\n' + bytes32Good, ' ' + bytes32Good, bytes32Good.slice(0, 65), '0x', '0',
  '00' + bytes32Good.slice(2), '0x0x' + bytes32Good.slice(6), bytes32Good + '\0', '0x' + '0'.repeat(64),
  bytes32Good.replace('0x', '0\u00d7'), '0x' + '٠'.repeat(32),
];
const retry: string[] = [
  '0', '1', '9', '10', '00', '01', '+1', '-0', '1 ', ' 1', '1\n', '١', '0x10', '1e3', '',
  '115792089237316195423570985008687907853269984665640564039457584007913129639936', '9'.repeat(200),
  '18446744073709551616', '3600', '1,2',
];
const sigGood = vectors.payerSig.valid[0].signature as string;
const payer: string[] = [];
for (const t of ['0', '1', '9007199254740991', '9007199254740992', '9007199254740993', '18446744073709551615',
  '1'.repeat(80), '00', '01', '+1', ' 1', '1 ', '1e9', '١', '-0', '']) payer.push(`${t}.${sigGood}`);
payer.push(`1.${sigGood}\n`, `1..${sigGood}`, `1.${sigGood}.`, `1.${sigGood}00`, `1.${sigGood.slice(0, -2)}`,
  `1.0X${sigGood.slice(2)}`, `1.${sigGood.slice(2)}`, `1.2.${sigGood}`, `1.${sigGood.toUpperCase().replace('0X', '0x')}`);

// ------------------------------------------------------------ proof cases
type ProofCase = { name: string; header: string };
const proofCases: ProofCase[] = [];
const goods = vectors.attestedProof.valid.map((c: { json: string }) => c.json as string);
const good = JSON.parse(goods[0]) as { proof: Record<string, string>; signature: string; signer: string };
const add = (name: string, text: string | Buffer) => proofCases.push({ name, header: b64(text) });
const addRaw = (name: string, header: string) => proofCases.push({ name, header });
const withProof = (patch: Record<string, unknown>, drop?: string) => {
  const p: Record<string, unknown> = { ...good.proof, ...patch };
  if (drop) delete p[drop];
  return jcs({ ...good, proof: p });
};

goods.forEach((g: string, i: number) => add(`vector valid ${i}`, g));
const uintFields = ['agentId', 'expiresAt', 'issuedAt'];
const bytesFields = ['inputsHash', 'paymentId', 'releaseId', 'requestHash', 'requestId', 'responseHash'];
const uintValues = ['0', '1', '00', '01', '-1', '+1', ' 1', '1 ', '1.0', '1e3', '0x1', '', '١',
  (2n ** 64n - 1n).toString(), (2n ** 64n).toString(), (2n ** 256n - 1n).toString(), (2n ** 256n).toString(),
  (2n ** 257n).toString(), '9'.repeat(78), '9'.repeat(79)];
for (const f of uintFields) for (const v of uintValues) add(`${f}=${JSON.stringify(v)}`, withProof({ [f]: v }));
const typeValues: unknown[] = [1, 0, -1, 1.5, 1e21, 2 ** 53 + 2, true, false, null, [], ['1'], {}, { a: '1' }];
for (const f of [...uintFields, 'requestId']) for (const v of typeValues) add(`${f} as ${JSON.stringify(v)}`, withProof({ [f]: v }));
const b = good.proof.requestId!;
const bytesValues = ['0x' + '0'.repeat(64), '0x' + 'f'.repeat(64), b.slice(0, -1), b + '0', b.slice(0, -2),
  b.replace('0x', '0X'), b.slice(2), '0x' + 'g' + b.slice(3), b.slice(0, -1) + 'F', ' ' + b];
for (const f of bytesFields) for (const v of bytesValues) add(`${f}=${v.slice(0, 8)}..${v.length}`, withProof({ [f]: v }));
for (const f of [...uintFields, ...bytesFields]) add(`drop ${f}`, withProof({}, f));
const s = good.signature;
for (const v of [s.slice(0, -2), s + '00', s.replace('0x', '0X'), s.slice(2), s.slice(0, -1) + 'B', '0x', ''])
  add(`signature=${v.slice(0, 6)}..${v.length}`, jcs({ ...good, signature: v }));
for (const v of [good.signer.slice(0, -2), good.signer + '00', good.signer.slice(2), '0x' + '0'.repeat(40), ''])
  add(`signer=${v.slice(0, 6)}..${v.length}`, jcs({ ...good, signer: v }));
for (const v of typeValues) {
  add(`signature as ${JSON.stringify(v)}`, jcs({ ...good, signature: v }));
  add(`signer as ${JSON.stringify(v)}`, jcs({ ...good, signer: v }));
  add(`proof as ${JSON.stringify(v)}`, jcs({ ...good, proof: v }));
}
for (const k of ['signature', 'signer', 'proof']) {
  const o: Record<string, unknown> = { ...good }; delete o[k]; add(`drop top ${k}`, jcs(o));
}
add('empty object', '{}');
add('empty proof', jcs({ ...good, proof: {} }));
// Unknown members, in many value forms and key forms, at both levels.
const extraKeys = ['a', 'zz', 'proof2', 'signaturf', 'Signer', '', ' ', 'é', '\u{E000}', '\u{10000}', '"', '\\', '\n', '\u007f'];
for (const k of extraKeys) {
  add(`extra top key ${JSON.stringify(k)}`, jcs({ ...good, [k]: '1' }));
  add(`extra proof key ${JSON.stringify(k)}`, withProof({ [k]: '1' }));
}
for (const v of [...typeValues, '\\', '"', '\n', 'é', '\u{10000}', '\u007f', { b: [1, { c: null }] }]) {
  add(`extra top value ${JSON.stringify(v)}`, jcs({ ...good, extra: v }));
  add(`extra proof value ${JSON.stringify(v)}`, withProof({ zz: v }));
}
// Two unknown keys whose UTF-16 and UTF-8 orders disagree.
add('extra keys E000 and 10000', jcs({ ...good, '\u{E000}': '1', '\u{10000}': '1' }));
// Hand-built non-canonical texts.
const g = goods[0];
const nonCanon: [string, string][] = [
  ['trailing newline', g + '\n'], ['leading space', ' ' + g], ['trailing space', g + ' '],
  ['space after colon', g.replace('"proof":', '"proof": ')], ['tab after comma', g.replace(',"signer"', ',\t"signer"')],
  ['trailing comma top', g.slice(0, -1) + ',}'], ['trailing comma proof', g.replace('"},"signature"', '",}, "signature"')],
  ['duplicate signer', g.slice(0, -1) + `,"signer":"${good.signer}"}`],
  ['keys reversed', `{"signer":"${good.signer}","signature":"${good.signature}","proof":${JSON.stringify(good.proof)}}`],
  ['escaped key', g.replace('"proof"', '"\\u0070roof"')], ['escaped value char', g.replace('"agentId":"1"', '"agentId":"\\u0031"')],
  ['escaped solidus', g.replace('"agentId":"1"', '"agentId":"\\/1"')], ['array top', `[${g}]`],
  ['two objects', g + g], ['nul after', g + '\0'], ['BOM', '\ufeff' + g], ['utf16le', ''],
  ['upper true literal', g.slice(0, -1) + ',"zz":TRUE}'], ['number with plus', g.slice(0, -1) + ',"zz":+1}'],
  ['minus zero', g.slice(0, -1) + ',"zz":-0}'], ['exponent', g.slice(0, -1) + ',"zz":1e2}'],
  ['leading zero number', g.slice(0, -1) + ',"zz":01}'], ['big number', g.slice(0, -1) + ',"zz":123456789012345678901234567890}'],
  ['fraction 1.0', g.slice(0, -1) + ',"zz":1.0}'], ['fraction 0.5', g.slice(0, -1) + ',"zz":0.5}'],
  ['unterminated', g.slice(0, -1)], ['single quotes', g.replace(/"/g, "'")],
  ['raw control char in extra', g.slice(0, -1) + ',"zz":"a\u0001"}'], ['raw DEL in extra', g.slice(0, -1) + ',"zz":"a\u007f"}'],
];
for (const [n, t] of nonCanon) if (t) add(`noncanon ${n}`, t);
// Nesting depth under an unknown key: valid JCS at every depth, refused by TS as an unknown field.
for (const d of [2, 4, 6, 8, 10, 12, 16, 20, 32, 64]) {
  add(`depth ${d} under extra key`, g.slice(0, -1) + ',"zz":' + '{"a":'.repeat(d) + '1' + '}'.repeat(d) + '}');
}
add('invalid utf8 in extra value', Buffer.concat([Buffer.from(g.slice(0, -1) + ',"zz":"'), Buffer.from([0xff]), Buffer.from('"}')]));
add('invalid utf8 overlong in extra', Buffer.concat([Buffer.from(g.slice(0, -1) + ',"zz":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}')]));
// base64 forms.
const H = b64(g);
const Hpad = proofCases.find((c) => c.header.endsWith('=='))?.header ?? H;
const H1 = proofCases.find((c) => c.header.endsWith('=') && !c.header.endsWith('=='))?.header ?? H;
for (const [n, h] of [
  ['urlsafe', H.replace(/\+/g, '-').replace(/\//g, '_')], ['no pad ==', Hpad.replace(/=+$/, '')], ['no pad =', H1.replace(/=+$/, '')],
  ['extra pad', Hpad + '=='], ['triple pad', Hpad.replace(/==$/, '===')], ['pad mid', 'QQ==' + H], ['newline in middle', H.slice(0, 8) + '\n' + H.slice(8)],
  ['space at end', H + ' '], ['CRLF at end', H + '\r\n'], ['lowercase swap', H.toLowerCase()], ['empty', ''], ['only pad', '===='],
  ['one char', 'Q'], ['A===', 'A==='], ['nonzero bits ==', Hpad.slice(0, -3) + String.fromCharCode(Hpad.charCodeAt(Hpad.length - 3) + 1) + '=='],
  ['nonzero bits =', H1.slice(0, -2) + String.fromCharCode(H1.charCodeAt(H1.length - 2) + 1) + '='],
] as [string, string][]) addRaw(`b64 ${n}`, h);
// Random single-byte edits of a valid text.
for (let k = 0; k < 400; k++) {
  const base = Buffer.from(goods[rnd(goods.length)], 'utf8');
  const pos = rnd(base.length);
  const op = rnd(3);
  const alphabet = '{}[]",:0123456789abcdefABCDEFx-+.eE \\tnulrs\u0000';
  const ch = Buffer.from(alphabet[rnd(alphabet.length)]!, 'utf8');
  let t: Buffer;
  if (op === 0) t = Buffer.concat([base.subarray(0, pos), base.subarray(pos + 1)]);
  else if (op === 1) t = Buffer.concat([base.subarray(0, pos), ch, base.subarray(pos)]);
  else t = Buffer.concat([base.subarray(0, pos), ch, base.subarray(pos + 1)]);
  add(`fuzz ${k} op${op} @${pos}`, t);
}
// Codex r2: canonical numbers whose digits end in zeros (integer zeros, around the 1e21 switch to
// exponent form, and past 2^53), under an unknown key. Valid JCS, so TS refuses them as a field.
for (const v of [10, 100, 1000, 120, -1000, 1e20, 1e21, 1.5e21, -1.2e22, 2 ** 53 * 1000, 1e300, 1e-7, 100.25, 1050.5]) {
  add(`extra proof number ${jcs(v)}`, withProof({ zz: v }));
}
add('extra top number 1000', jcs({ ...good, extra: 1000 }));

// ------------------------------------------------------------ verdicts
type Verdict = { accept: boolean; jcsValid: boolean };
const proofOut = proofCases.map((c) => {
  let accept = true;
  let decoded: ReturnType<typeof decodeAttestedProof> | null = null;
  try { decoded = decodeAttestedProof(c.header); } catch { accept = false; }
  // jcsValid: strict base64, UTF-8, JSON and canonical. A refusal of such a text is not "not_jcs".
  let jcsValid = false;
  const bytes = decodeBase64Strict(c.header);
  if (bytes) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      jcsValid = jcs(JSON.parse(text)) === text;
    } catch { /* not JCS */ }
  }
  return { ...c, accept, jcsValid, decoded };
});

const lit = (s: string) => `hex"${Buffer.from(s, 'latin1').toString('hex')}"`;
const litUtf8 = (s: string) => `hex"${Buffer.from(s, 'utf8').toString('hex')}"`;
let sol = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// GENERATED by scripts/adversary-t06-r2/gen.ts from @attessa/core verdicts. Do not edit by hand.

library AdvT06r2Cases {
    struct Scalar { bytes value; bool accept; uint256 n; }
    struct Proof { string name; bytes header; bool accept; bool jcsValid; bytes32[6] b; uint256 agentId; uint64 expiresAt; uint64 issuedAt; bytes signature; address signer; }
`;
const scal = (fn: string, items: { v: string; accept: boolean; n: bigint }[]) => {
  sol += `\n    function ${fn}() internal pure returns (Scalar[] memory c) {\n        c = new Scalar[](${items.length});\n`;
  items.forEach((it, i) => { sol += `        c[${i}] = Scalar(${litUtf8(it.v)}, ${it.accept}, ${it.n});\n`; });
  sol += `    }\n`;
};
scal('bytes32Cases', scalarBytes32.map((v) => ({ v, accept: isRequestIdHeader(v), n: 0n })));
scal('retryCases', retry.map((v) => ({ v, accept: isRetryAfterHeader(v), n: 0n })));
scal('payerCases', payer.map((v) => { const p = parsePayerSig(v); return { v, accept: p !== null, n: p ? BigInt(p.unixSeconds) : 0n }; }));
const CHUNK = 60;
for (let c0 = 0, part = 0; c0 < proofOut.length; c0 += CHUNK, part++) {
  const chunk = proofOut.slice(c0, c0 + CHUNK);
  sol += `\n    function proofCases${part}() internal pure returns (Proof[] memory c) {\n        c = new Proof[](${chunk.length});\n`;
  chunk.forEach((p, i) => {
    const d = p.decoded;
    const bs = d ? bytesFields.map((f) => (d.proof as unknown as Record<string, string>)[f]) : Array(6).fill('0x' + '0'.repeat(64));
    sol += `        c[${i}] = Proof(${JSON.stringify(p.name.replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '/').replace(/"/g, "'"))}, ${lit(p.header)}, ${p.accept}, ${p.jcsValid}, [bytes32(${bs.join('), bytes32(')})], ${d ? d.proof.agentId : 0}, ${d ? d.proof.expiresAt : 0}, ${d ? d.proof.issuedAt : 0}, hex"${d ? d.signature.slice(2) : ''}", address(bytes20(hex"${d ? d.signer.slice(2) : '00'.repeat(20)}")));\n`;
  });
  sol += `    }\n`;
}
sol += `\n    uint256 internal constant PROOF_PARTS = ${Math.ceil(proofOut.length / CHUNK)};\n}\n`;
writeFileSync(new URL('contracts/test/adv/AdvT06r2Cases.sol', root), sol);
console.log(`bytes32 ${scalarBytes32.length}, retry ${retry.length}, payer ${payer.length}, proof ${proofOut.length} (accepted ${proofOut.filter((p) => p.accept).length}, jcsValid refused ${proofOut.filter((p) => !p.accept && p.jcsValid).length})`);
