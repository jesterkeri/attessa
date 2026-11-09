// Codex site-finish r1 m1: every vendored font family has its SIL OFL 1.1 text and a provenance record; the hashes match the files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const dir = join(src, 'static', 'assets', 'fonts');
const sha = b => createHash('sha256').update(b).digest('hex');
const manifestPath = join(dir, 'PROVENANCE.json');

test('font provenance: the manifest exists and names each family used in fonts.css', () => {
  assert.ok(existsSync(manifestPath), 'fonts/PROVENANCE.json is required');
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.match(m.fetchedAt, /^\d{4}-\d{2}-\d{2}$/);
  const css = readFileSync(join(src, 'static', 'assets', 'fonts.css'), 'utf8');
  const used = [...new Set([...css.matchAll(/font-family:\s*'([^']+)'/g)].map(x => x[1]))].sort();
  assert.deepEqual(m.families.map(f => f.family).sort(), used);
});

test('font provenance: each family has its OFL 1.1 text, upstream commit and hash', () => {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const f of m.families) {
    assert.match(f.upstreamRepo, /^https:\/\/github\.com\/[\w-]+\/[\w.-]+$/, f.family);
    assert.match(f.upstreamCommit, /^[0-9a-f]{40}$/, f.family);
    assert.equal(f.licence, 'SIL Open Font License 1.1');
    assert.match(f.copyright ?? '', /^Copyright/, `${f.family} copyright line`);
    const p = join(dir, f.licenceFile);
    assert.ok(existsSync(p), `${f.licenceFile} is required`);
    const text = readFileSync(p);
    assert.equal(sha(text), f.licenceSha256, `${f.licenceFile} hash`);
    assert.match(text.toString('utf8'), /SIL OPEN FONT LICENSE Version 1\.1/);
    assert.ok(f.licenceUrl.includes(f.upstreamCommit), 'the licence URL is pinned to the commit');
  }
});

test('font provenance: every woff2 is recorded with the sha256 of the file on disk, and nothing else is listed', () => {
  const m = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const listed = m.families.flatMap(f => f.files);
  for (const x of listed) {
    assert.equal(sha(readFileSync(join(dir, x.name))), x.sha256, x.name);
    assert.match(x.googleFontsUrl, /^https:\/\/fonts\.gstatic\.com\//);
    assert.match(x.googleFontsVersion ?? '', /^v\d+$/);
  }
  assert.deepEqual(listed.map(x => x.name).sort(), readdirSync(dir).filter(n => n.endsWith('.woff2')).sort());
  // SHA256SUMS agrees with the manifest.
  const sums = Object.fromEntries(readFileSync(join(dir, 'SHA256SUMS'), 'utf8').trim().split('\n').map(l => l.split(/\s+/).reverse()));
  for (const x of listed) assert.equal(sums[x.name], x.sha256);
});
