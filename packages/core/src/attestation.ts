import { toHex, type Hex } from 'viem';

/**
 * Reads a Nitro attestation document (COSE_Sign1, CBOR) off chain, without verifying it: the CLI checks
 * its fields before spending gas, and seller-host checks its binding at boot. The registry re-checks everything.
 */

// ---- Minimal CBOR (RFC 8949) decoder: definite and indefinite lengths, no floats needed.

type Cbor = bigint | Uint8Array | string | Cbor[] | Map<Cbor, Cbor> | boolean | null | undefined | { tag: bigint; value: Cbor };

function decodeCbor(bytes: Uint8Array): Cbor {
  let off = 0;
  const need = (n: number) => {
    if (off + n > bytes.length) throw new Error('CBOR: truncated');
  };
  const arg = (ai: number): bigint | null => {
    if (ai < 24) return BigInt(ai);
    const len = ai === 24 ? 1 : ai === 25 ? 2 : ai === 26 ? 4 : ai === 27 ? 8 : -1;
    if (ai === 31) return null;
    if (len < 0) throw new Error(`CBOR: bad additional info ${ai}`);
    need(len);
    let v = 0n;
    for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(bytes[off + i]!);
    off += len;
    return v;
  };
  const item = (depth: number): Cbor => {
    if (depth > 16) throw new Error('CBOR: too deep');
    need(1);
    const ib = bytes[off++]!;
    const major = ib >> 5;
    const ai = ib & 0x1f;
    if (major === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      if (ai === 23) return undefined;
      throw new Error(`CBOR: unsupported simple/float ${ai}`);
    }
    const n = arg(ai);
    switch (major) {
      case 0:
        return n!;
      case 1:
        return -1n - n!;
      case 2:
      case 3: {
        if (n === null) throw new Error('CBOR: indefinite strings unsupported');
        const len = Number(n);
        need(len);
        const s = bytes.slice(off, off + len);
        off += len;
        return major === 2 ? s : new TextDecoder('utf-8', { fatal: true }).decode(s);
      }
      case 4: {
        const out: Cbor[] = [];
        if (n === null) {
          while ((need(1), bytes[off]) !== 0xff) out.push(item(depth + 1));
          off++;
        } else for (let i = 0n; i < n; i++) out.push(item(depth + 1));
        return out;
      }
      case 5: {
        const m = new Map<Cbor, Cbor>();
        const pair = () => {
          const k = item(depth + 1);
          m.set(k, item(depth + 1));
        };
        if (n === null) {
          while ((need(1), bytes[off]) !== 0xff) pair();
          off++;
        } else for (let i = 0n; i < n; i++) pair();
        return m;
      }
      case 6:
        return { tag: n!, value: item(depth + 1) };
      default:
        throw new Error(`CBOR: major type ${major}`);
    }
  };
  const v = item(0);
  if (off !== bytes.length) throw new Error('CBOR: trailing bytes');
  return v;
}

function bytesOrNull(v: Cbor | undefined, what: string): Uint8Array | null {
  if (v === null || v === undefined) return null;
  if (!(v instanceof Uint8Array)) throw new Error(`attestation: ${what} is not bytes`);
  return v;
}

export interface ParsedAttestation {
  raw: Buffer;
  /** Milliseconds since the epoch, AWS-signed. */
  timestampMs: bigint;
  pcrs: Map<number, Hex>;
  publicKey: Hex | null;
  userData: Hex | null;
  certificate: Buffer;
  /** cabundle[0] is the root, then intermediates down to the leaf's issuer. */
  cabundle: Buffer[];
}

/** Accepts raw bytes, or a file holding base64 or 0x-hex of them. */
export function attestationBytes(input: Uint8Array): Buffer {
  const b = Buffer.from(input);
  if (b[0] === 0xd2 || b[0] === 0x84) return b;
  const text = b.toString('utf8').trim();
  if (/^0x([0-9a-fA-F]{2})+$/.test(text)) return Buffer.from(text.slice(2), 'hex');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return Buffer.from(text, 'base64');
  throw new Error('attestation: not COSE bytes, base64 or hex');
}

export function parseAttestation(input: Uint8Array): ParsedAttestation {
  const raw = attestationBytes(input);
  let top = decodeCbor(raw);
  if (typeof top === 'object' && top !== null && 'tag' in top) top = top.value; // COSE_Sign1 tag 18
  if (!Array.isArray(top) || top.length !== 4 || !(top[2] instanceof Uint8Array)) throw new Error('attestation: not a COSE_Sign1 array');
  const payload = decodeCbor(top[2]);
  if (!(payload instanceof Map)) throw new Error('attestation: payload is not a map');
  const ts = payload.get('timestamp');
  if (typeof ts !== 'bigint') throw new Error('attestation: no timestamp');
  const pcrsRaw = payload.get('pcrs');
  if (!(pcrsRaw instanceof Map)) throw new Error('attestation: no pcrs');
  const pcrs = new Map<number, Hex>();
  for (const [k, v] of pcrsRaw) if (typeof k === 'bigint' && v instanceof Uint8Array) pcrs.set(Number(k), toHex(v));
  const cert = bytesOrNull(payload.get('certificate'), 'certificate');
  const bundle = payload.get('cabundle');
  if (!cert || !Array.isArray(bundle) || bundle.length < 2 || !bundle.every((c) => c instanceof Uint8Array)) {
    throw new Error('attestation: certificate or cabundle missing');
  }
  const pk = bytesOrNull(payload.get('public_key'), 'public_key');
  const ud = bytesOrNull(payload.get('user_data'), 'user_data');
  return {
    raw,
    timestampMs: ts,
    pcrs,
    publicKey: pk ? toHex(pk) : null,
    userData: ud ? toHex(ud) : null,
    certificate: Buffer.from(cert),
    cabundle: (bundle as Uint8Array[]).map((c) => Buffer.from(c)),
  };
}
