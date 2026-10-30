import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * A synthetic Nitro attestation for tests: a P-384 chain (root → 3 CAs → leaf) made in-test with
 * random keys, and a COSE_Sign1 document signed by the leaf. Structurally what NSM returns, so the CLI's
 * parser and hint generator run on genuine P-384 signatures. It is not AWS-signed and no chain accepts it.
 */

// ---- DER

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const b: number[] = [];
  while (n > 0) {
    b.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | b.length, ...b]);
}
const tlv = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), len(body.length), body]);
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const int = (v: Buffer) => tlv(0x02, v[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), v]) : v);
const ECDSA_SHA384 = seq(Buffer.from('06082a8648ce3d040303', 'hex'));
const name = (cn: string) => seq(set(seq(Buffer.from('0603550403', 'hex'), tlv(0x0c, Buffer.from(cn)))));
function time(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s));
}

function cert(subject: string, issuer: string, pub: KeyObject, signer: KeyObject, notAfter: Date): Buffer {
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))),
    int(randomBytes(8)),
    ECDSA_SHA384,
    name(issuer),
    seq(time(new Date(notAfter.getTime() - 86_400_000)), time(notAfter)),
    name(subject),
    pub.export({ type: 'spki', format: 'der' }),
  );
  const sig = sign('sha384', tbs, { key: signer, dsaEncoding: 'der' });
  return seq(tbs, ECDSA_SHA384, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
}

// ---- CBOR

function head(major: number, n: number | bigint): Buffer {
  const v = BigInt(n);
  if (v < 24n) return Buffer.from([(major << 5) | Number(v)]);
  if (v < 0x100n) return Buffer.from([(major << 5) | 24, Number(v)]);
  if (v < 0x10000n) return Buffer.from([(major << 5) | 25, Number(v >> 8n), Number(v & 0xffn)]);
  if (v < 0x100000000n) {
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(Number(v), 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = (major << 5) | 27;
  b.writeBigUInt64BE(v, 1);
  return b;
}
type C = bigint | number | string | Buffer | null | C[] | Array<[C, C]> | { map: Array<[C, C]> };
function cbor(v: C): Buffer {
  if (v === null) return Buffer.from([0xf6]);
  if (typeof v === 'number' || typeof v === 'bigint') return head(0, v);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (!Array.isArray(v) && typeof v === 'object' && 'map' in v) return Buffer.concat([head(5, v.map.length), ...v.map.flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  return Buffer.concat([head(4, v.length), ...(v as C[]).map(cbor)]);
}

export interface FakeNitroOptions {
  userData: Buffer | null;
  publicKey: Buffer | null;
  timestampMs: bigint;
  pcrs?: [Buffer, Buffer, Buffer];
  /** notAfter of every certificate. */
  certsNotAfter?: Date;
}

export interface FakeNitro {
  document: Buffer;
  pcrs: [Buffer, Buffer, Buffer];
}

export class FakeNitroChain {
  readonly keys = Array.from({ length: 5 }, () => generateKeyPairSync('ec', { namedCurve: 'secp384r1' }));
  private readonly issued = new Map<number, Buffer[]>();

  /** One certificate chain per notAfter, reused across documents as NSM reuses its chain. */
  certs(notAfter: Date): Buffer[] {
    let c = this.issued.get(notAfter.getTime());
    if (!c) {
      const names = ['aws.nitro-enclaves', 'us-east-1.aws.nitro-enclaves', 'zonal', 'instance', 'leaf'];
      c = this.keys.map((k, i) => cert(names[i]!, names[Math.max(0, i - 1)]!, k.publicKey, this.keys[Math.max(0, i - 1)]!.privateKey, notAfter));
      this.issued.set(notAfter.getTime(), c);
    }
    return c;
  }

  attest(o: FakeNitroOptions): FakeNitro {
    const certs = this.certs(o.certsNotAfter ?? new Date('2049-01-01T00:00:00Z'));
    const pcrs = o.pcrs ?? [randomBytes(48), randomBytes(48), randomBytes(48)];
    const payload = cbor({
      map: [
        ['module_id', 'i-0123456789abcdef0-enc0123456789abcdef'],
        ['digest', 'SHA384'],
        ['timestamp', o.timestampMs],
        ['pcrs', { map: [[0, pcrs[0]], [1, pcrs[1]], [2, pcrs[2]], [3, Buffer.alloc(48)], [4, Buffer.alloc(48)]] }],
        ['certificate', certs[4]!],
        ['cabundle', certs.slice(0, 4)],
        ['public_key', o.publicKey],
        ['user_data', o.userData],
        ['nonce', null],
      ],
    });
    // protected header: bstr(map {1: -35}) (alg ES384)
    const prot = Buffer.from([0xa1, 0x01, 0x38, 0x22]);
    const sigStructure = cbor(['Signature1', prot, Buffer.alloc(0), payload]);
    const sig = sign('sha384', sigStructure, { key: this.keys[4]!.privateKey, dsaEncoding: 'ieee-p1363' });
    const doc = Buffer.concat([Buffer.from([0xd2]), cbor([prot, { map: [] }, payload, sig])]);
    return { document: doc, pcrs };
  }
}
