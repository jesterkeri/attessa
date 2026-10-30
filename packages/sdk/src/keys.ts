import { createDecipheriv, pbkdf2Sync, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { bytesToHex, concat, hexToBytes, keccak256, type Hex, type LocalAccount } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// SPEC §7 key storage: OS keychain (keytar); fallback env ATTESSA_PRIVATE_KEY or --keystore.
// A key is never printed, logged or put in an error message.

export const KEYCHAIN_SERVICE = 'attessa';
export const KEYCHAIN_ACCOUNT = 'default';

/** The two keytar calls the SDK uses. */
export interface Keychain {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
}

export type KeySource = 'env' | 'keystore' | 'keychain' | 'created';

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

function toAccount(key: string, where: string): LocalAccount {
  const k = key.trim();
  if (!PRIVATE_KEY.test(k)) throw new Error(`${where}: not a 32-byte hex private key`);
  return privateKeyToAccount(k as Hex);
}

/** keytar, if it is installed and its native module loads; else null. */
export async function systemKeychain(): Promise<Keychain | null> {
  try {
    const name = 'keytar';
    const m = (await import(name)) as { default?: Keychain } & Partial<Keychain>;
    const k = (m.default ?? m) as Keychain;
    return typeof k.getPassword === 'function' ? k : null;
  } catch {
    return null;
  }
}

interface KeystoreV3 {
  version: number;
  crypto: {
    cipher: string;
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: 'scrypt' | 'pbkdf2';
    kdfparams: { dklen: number; salt: string; n?: number; r?: number; p?: number; c?: number; prf?: string };
    mac: string;
  };
}

/** Decrypts an Ethereum V3 keystore (scrypt or pbkdf2-sha256, aes-128-ctr), as `cast wallet` writes. */
export function decryptKeystore(json: string, password: string): Hex {
  const ks = JSON.parse(json) as KeystoreV3 & { Crypto?: KeystoreV3['crypto'] };
  const c = ks.crypto ?? ks.Crypto;
  if (ks.version !== 3 || !c) throw new Error('keystore: not a V3 keystore');
  if (c.cipher !== 'aes-128-ctr') throw new Error(`keystore: unsupported cipher ${c.cipher}`);
  const salt = hexToBytes(`0x${c.kdfparams.salt.replace(/^0x/, '')}`);
  const dklen = c.kdfparams.dklen;
  let dk: Buffer;
  if (c.kdf === 'scrypt') {
    const { n = 0, r = 0, p = 0 } = c.kdfparams;
    dk = scryptSync(password, salt, dklen, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 });
  } else if (c.kdf === 'pbkdf2') {
    if (c.kdfparams.prf !== 'hmac-sha256') throw new Error('keystore: unsupported pbkdf2 prf');
    dk = pbkdf2Sync(password, salt, c.kdfparams.c ?? 0, dklen, 'sha256');
  } else {
    throw new Error(`keystore: unsupported kdf ${String(c.kdf)}`);
  }
  const ciphertext = hexToBytes(`0x${c.ciphertext.replace(/^0x/, '')}`);
  const mac = hexToBytes(keccak256(concat([dk.subarray(16, 32), ciphertext])));
  const want = hexToBytes(`0x${c.mac.replace(/^0x/, '')}`);
  if (want.length !== mac.length || !timingSafeEqual(mac, want)) throw new Error('keystore: wrong password or corrupted file');
  const d = createDecipheriv('aes-128-ctr', dk.subarray(0, 16), hexToBytes(`0x${c.cipherparams.iv.replace(/^0x/, '')}`));
  const key = Buffer.concat([d.update(ciphertext), d.final()]);
  return bytesToHex(key);
}

/**
 * The buyer's account. Order (FLOWS §6 J0): `ATTESSA_PRIVATE_KEY`, then `--keystore`, then the OS
 * keychain. With `create`, a new key is generated and stored in the keychain; the caller announces
 * it (`source: 'created'`), so wallet creation is never silent. Without a keychain, no key is created.
 */
export async function loadAccount(opts: {
  env?: Record<string, string | undefined>;
  keystore?: { path: string; password: string };
  keychain?: Keychain | null;
  create?: boolean;
} = {}): Promise<{ account: LocalAccount; source: KeySource } | null> {
  const env = opts.env ?? process.env;
  const fromEnv = env.ATTESSA_PRIVATE_KEY;
  if (fromEnv !== undefined && fromEnv !== '') return { account: toAccount(fromEnv, 'ATTESSA_PRIVATE_KEY'), source: 'env' };
  if (opts.keystore) {
    const key = decryptKeystore(readFileSync(opts.keystore.path, 'utf8'), opts.keystore.password);
    return { account: toAccount(key, 'keystore'), source: 'keystore' };
  }
  const kc = opts.keychain === undefined ? await systemKeychain() : opts.keychain;
  if (!kc) return null;
  const stored = await kc.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (stored) return { account: toAccount(stored, 'keychain'), source: 'keychain' };
  if (!opts.create) return null;
  const key = generatePrivateKey();
  await kc.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, key);
  return { account: privateKeyToAccount(key), source: 'created' };
}
