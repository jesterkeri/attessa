// T48: the values Joshua owns live in site.config.json and nowhere else; nothing in the build carries a placeholder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, cpSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..');
const real = JSON.parse(readFileSync(join(pkg, 'site.config.json'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'attessa-site-cfg-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const build = cfg => {
  const dir = join(tmp, String(n++));
  const file = join(tmp, `cfg-${n}.json`);
  writeFileSync(file, JSON.stringify(cfg));
  const r = spawnSync(process.execPath, [join(pkg, 'build.mjs')], { cwd: pkg, encoding: 'utf8', env: { ...process.env, SITE_OUT: dir, SITE_CONFIG: file } });
  return { ...r, dir };
};
const year = () => new Date(Date.now() + 200 * 864e5).toISOString().slice(0, 10);

test('site config: the committed config names the origin and the contact Joshua gave (2026-11-06), with an expiry within a year', () => {
  assert.equal(real.siteOrigin, 'https://attessa.xyz');
  assert.equal(real.securityContact, 'mailto:attessa7@gmail.com');
  const t = Date.parse(real.securityTxtExpires);
  assert.ok(t > Date.now() && t <= Date.now() + 366 * 864e5, real.securityTxtExpires);
});

test('site config: with no contact, security.txt says so and no page or file carries a {placeholder}', () => {
  const r = build({ ...real, securityContact: null, securityTxtExpires: null });
  assert.equal(r.status, 0, r.stderr);
  const txt = readFileSync(join(r.dir, '.well-known', 'security.txt'), 'utf8');
  assert.doesNotMatch(txt, /\{\w+\}/);
  assert.doesNotMatch(txt, /^Contact:/m);
  assert.match(txt, /has not published a security contact yet/);
  assert.match(txt, /Canonical: https:\/\/attessa\.xyz\/\.well-known\/security\.txt/);
  assert.match(readFileSync(join(r.dir, 'security.html'), 'utf8'), /which still has placeholder fields: its contact is published before launch/);
  assert.equal(readFileSync(join(r.dir, 'CNAME'), 'utf8'), 'attessa.xyz\n');
});

test('site config: with a contact and expiry, security.txt is RFC 9116 and the "not published" copy goes', () => {
  const r = build({ ...real, securityContact: 'mailto:security@example.org', securityTxtExpires: year() });
  assert.equal(r.status, 0, r.stderr);
  const txt = readFileSync(join(r.dir, '.well-known', 'security.txt'), 'utf8');
  assert.match(txt, /^Contact: mailto:security@example\.org$/m);
  assert.match(txt, /^Expires: \d{4}-\d{2}-\d{2}T00:00:00Z$/m);
  assert.match(txt, /^Canonical: https:\/\/attessa\.xyz\/\.well-known\/security\.txt$/m);
  assert.doesNotMatch(readFileSync(join(r.dir, 'security.html'), 'utf8'), /placeholder fields/);
});

test('site config: a bad contact, a past or far expiry, one value without the other, or a path in the origin fails the build', () => {
  for (const cfg of [
    { ...real, securityContact: 'security at example.org', securityTxtExpires: year() },
    { ...real, securityContact: 'mailto:a@b.co', securityTxtExpires: '2020-01-01' },
    { ...real, securityContact: 'mailto:a@b.co', securityTxtExpires: '2099-01-01' },
    { ...real, securityContact: 'mailto:a@b.co', securityTxtExpires: null },
    { ...real, siteOrigin: 'https://attessa.xyz/site' },
    { ...real, siteOrigin: 'http://attessa.xyz' },
  ]) {
    const r = build(cfg);
    assert.notEqual(r.status, 0, JSON.stringify(cfg));
    assert.match(r.stderr, /site\.config\.json/);
  }
});

test('site config: the default config refuses to build without a security contact and expiry; SITE_CONFIG is the explicit local opt-out', () => {
  // A copy of the package whose committed site.config.json has both values null.
  const copy = join(tmp, 'pkg-copy');
  mkdirSync(copy);
  for (const f of ['build.mjs', 'csp.mjs', 'config.mjs', 'status.mjs', 'networks.json']) cpSync(join(pkg, f), join(copy, f));
  cpSync(join(pkg, 'src'), join(copy, 'src'), { recursive: true });
  symlinkSync(join(pkg, 'node_modules'), join(copy, 'node_modules'));
  writeFileSync(join(copy, 'site.config.json'), JSON.stringify({ ...real, securityContact: null, securityTxtExpires: null }));
  const env = { ...process.env, SITE_OUT: join(tmp, 'copy-out') };
  delete env.SITE_CONFIG;
  const refused = spawnSync(process.execPath, [join(copy, 'build.mjs')], { cwd: copy, encoding: 'utf8', env });
  assert.notEqual(refused.status, 0, 'a default-config build with null contact must fail');
  assert.match(refused.stderr, /securityContact and securityTxtExpires are null/);
  const optedOut = spawnSync(process.execPath, [join(copy, 'build.mjs')], { cwd: copy, encoding: 'utf8', env: { ...env, SITE_CONFIG: join(copy, 'site.config.json') } });
  assert.equal(optedOut.status, 0, optedOut.stderr);
  // The committed config itself builds as the default.
  assert.ok(real.securityContact && real.securityTxtExpires, 'the committed config carries both values');
});
