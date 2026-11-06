import { createCipheriv, pbkdf2Sync, randomBytes, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bytesToHex, concat, hexToBytes, keccak256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { decryptKeystore, KEYCHAIN_ACCOUNT, KEYCHAIN_SERVICE, KeyError, loadAccount, type Keychain } from '../src/keys.ts';

// SPEC §7 key storage. Every key here is generated in the test.

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

/** Writes a V3 keystore as geth/foundry do (small KDF cost, for speed). */
function keystore(key: Hex, password: string, kdf: 'scrypt' | 'pbkdf2'): string {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const dk = kdf === 'scrypt' ? scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 }) : pbkdf2Sync(password, salt, 1000, 32, 'sha256');
  const c = createCipheriv('aes-128-ctr', dk.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([c.update(hexToBytes(key)), c.final()]);
  const mac = keccak256(concat([dk.subarray(16, 32), ciphertext]));
  const kdfparams = kdf === 'scrypt' ? { dklen: 32, salt: salt.toString('hex'), n: 1024, r: 8, p: 1 } : { dklen: 32, salt: salt.toString('hex'), c: 1000, prf: 'hmac-sha256' };
  return JSON.stringify({ version: 3, id: 'x', crypto: { cipher: 'aes-128-ctr', ciphertext: ciphertext.toString('hex'), cipherparams: { iv: iv.toString('hex') }, kdf, kdfparams, mac: mac.slice(2) } });
}

function memoryKeychain(): Keychain & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getPassword: async (s, a) => store.get(`${s}/${a}`) ?? null,
    setPassword: async (s, a, p) => void store.set(`${s}/${a}`, p),
  };
}

describe('key storage', () => {
  it('ATTESSA_PRIVATE_KEY wins over everything', async () => {
    const key = generatePrivateKey();
    const kc = memoryKeychain();
    const r = await loadAccount({ env: { ATTESSA_PRIVATE_KEY: key }, keychain: kc, create: true });
    expect(r).toMatchObject({ source: 'env' });
    expect(r!.account.address).toBe(privateKeyToAccount(key).address);
    expect(kc.store.size).toBe(0);
  });

  for (const kdf of ['scrypt', 'pbkdf2'] as const) {
    it(`--keystore (${kdf}) decrypts with the right password and refuses a wrong one`, async () => {
      dir = mkdtempSync(join(tmpdir(), 'attessa-keys-'));
      const key = generatePrivateKey();
      const path = join(dir, 'ks.json');
      writeFileSync(path, keystore(key, 'correct horse', kdf));
      const r = await loadAccount({ env: {}, keystore: { path, password: 'correct horse' }, keychain: null });
      expect(r).toMatchObject({ source: 'keystore' });
      expect(r!.account.address).toBe(privateKeyToAccount(key).address);
      await expect(loadAccount({ env: {}, keystore: { path, password: 'wrong' }, keychain: null })).rejects.toThrow(/wrong password/);
    });
  }

  it('keychain: creates only when asked, says so, then reloads the same key', async () => {
    const kc = memoryKeychain();
    expect(await loadAccount({ env: {}, keychain: kc })).toBeNull();
    const created = await loadAccount({ env: {}, keychain: kc, create: true });
    expect(created!.source).toBe('created');
    expect(kc.store.has(`${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}`)).toBe(true);
    const again = await loadAccount({ env: {}, keychain: kc, create: true });
    expect(again).toMatchObject({ source: 'keychain' });
    expect(again!.account.address).toBe(created!.account.address);
  });

  it('no keychain available: no silent creation', async () => {
    expect(await loadAccount({ env: {}, keychain: null, create: true })).toBeNull();
  });

  // keytar on a headless Linux host loads but every call rejects (no Secret Service): that is no keychain too.
  it('a keychain whose calls reject is unavailable: null, nothing created, no error', async () => {
    const reject = async () => {
      throw new Error('Cannot autolaunch D-Bus without X11 $DISPLAY');
    };
    expect(await loadAccount({ env: {}, keychain: { getPassword: reject, setPassword: reject }, create: true })).toBeNull();
    expect(await loadAccount({ env: {}, keychain: { getPassword: reject, setPassword: reject } })).toBeNull();
    const writeFails = { getPassword: async () => null, setPassword: reject };
    expect(await loadAccount({ env: {}, keychain: writeFails, create: true })).toBeNull();
  });

  it('a malformed key is refused without echoing it', async () => {
    const secretish = `0x${'ab'.repeat(31)}`;
    const err = await loadAccount({ env: { ATTESSA_PRIVATE_KEY: secretish }, keychain: null }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(secretish.slice(2));
  });

  // Adversary T21 r2: a parser's message quotes its input (V8's JSON.parse prints the start of the file, viem quotes
  // bad hex), and a file passed as --keystore may hold a bare key. Only fixed reasons may come out.
  it('--keystore pointing at a non-keystore file: a fixed reason, nothing of the file in the error', async () => {
    dir = mkdtempSync(join(tmpdir(), 'attessa-keys-'));
    const key = generatePrivateKey();
    const ks = JSON.parse(keystore(generatePrivateKey(), 'pw', 'pbkdf2'));
    const cases: Array<[string, string, string]> = [
      ['bare hex key', `${key.slice(2)}\n`, 'not a V3 keystore'],
      ['0x hex key', key, 'not a V3 keystore'],
      ['JSON with the key', JSON.stringify({ privateKey: key }), 'not a V3 keystore'],
      ['bad hex in ciphertext', JSON.stringify({ ...ks, crypto: { ...ks.crypto, ciphertext: `zz${key.slice(2)}` } }), 'not a V3 keystore'],
      ['key in the cipher field', JSON.stringify({ ...ks, crypto: { ...ks.crypto, cipher: key } }), 'unsupported cipher'],
      ['key in the kdf field', JSON.stringify({ ...ks, crypto: { ...ks.crypto, kdf: key } }), 'unsupported kdf'],
    ];
    for (const [name, body, reason] of cases) {
      const path = join(dir, `${name.replace(/\W/g, '-')}.txt`);
      writeFileSync(path, body);
      const err = await loadAccount({ env: {}, keystore: { path, password: 'pw' }, keychain: null }).catch((e: unknown) => e);
      expect(err, name).toBeInstanceOf(KeyError);
      expect((err as KeyError).source, name).toBe('keystore');
      expect((err as KeyError).reason, name).toBe(reason);
      expect((err as KeyError).message, name).toBe(`keystore: ${reason}`);
      expect((err as KeyError).cause, name).toBeUndefined();
    }
  });

  it('--keystore pointing at a missing file: a fixed reason', async () => {
    const err = await loadAccount({ env: {}, keystore: { path: '/nonexistent/attessa/ks.json', password: 'pw' }, keychain: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KeyError);
    expect((err as KeyError).message).toBe("keystore: can't read the file");
  });

  it('decryptKeystore round-trips the exact key bytes', () => {
    const key = generatePrivateKey();
    expect(decryptKeystore(keystore(key, 'pw', 'scrypt'), 'pw')).toBe(bytesToHex(hexToBytes(key)));
  });
});
