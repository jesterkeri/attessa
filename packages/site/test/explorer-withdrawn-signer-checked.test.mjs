// Adversary round 6 on the site fixes (1c05ae5..edbdaa0, truth pass 5ff468a..edbdaa0).
// Intended home: packages/site/test/explorer-withdrawn-signer-checked.test.mjs
// Run from the repo root: node --test packages/site/test/explorer-withdrawn-signer-checked.test.mjs
// (or anywhere with SITE_SRC=<repo>/site/src)
//
// fb1a4d7 turned the explorer's "unapproved" sample into a build whose approval was withdrawn mid-call:
// the gateway's proof check fails with release_not_approved. Its own verdict line says a build that was
// never approved can't register a signer, so this signer was registered and attested. The sample still
// marks "Sealed machine" as "Skipped: Not checked: the call stopped at the failed check."
//
// SPEC says the signer was checked, and passed, before release_not_approved could be returned:
// - SPEC §6.2 step 9: "recover r = ecrecover(...) ... require r == header.signer", then
//   "checkSigner(r, originHash) == OK".
// - SPEC §3.4 checkSigner, "first failure wins": 1 UNKNOWN_SIGNER, 2 SIGNER_REVOKED, 3 SIGNER_EXPIRED,
//   4 ENDPOINT_MISMATCH, 5 ENDPOINT_INACTIVE, 6 AGENT_MISMATCH, 7 OPERATOR_MISMATCH,
//   8 RELEASE_NOT_APPROVED. Reaching 8 means 1 to 7 passed.
// - SPEC §7 ProofCheck keeps 'signer_not_active' and 'release_not_approved' apart, so the explorer
//   (T44: "one test per ProofCheck lands on its row") would show a passed signer here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = process.env.SITE_SRC ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const siteJs = readFileSync(join(src, 'static', 'assets', 'site.js'), 'utf8');
const m = siteJs.match(/(const chip = name =>[\s\S]*?\n {2}const STATES = \{[\s\S]*?\n {2}\};)/);
const { NAMES, STATES } = m ? vm.runInNewContext(`${m[1]}\n({ NAMES, STATES });`, { copySvg: '' }) : {};
const text = v => String(typeof v === 'function' ? v() : v ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

test('a sample fails at release_not_approved after a withdrawn approval (precondition)', () => {
  assert.ok(STATES, 'could not read STATES from site.js');
  const st = STATES.unapproved;
  assert.ok(st, 'no "unapproved" sample');
  assert.match(text(st.rows[0].term), /release_not_approved/);
  assert.match(text(st.rows[0].line), /withdrew this build's approval/);
});

test('when the proof check fails at release_not_approved, the signer row is not "Not checked"', () => {
  const bad = [];
  for (const [key, st] of Object.entries(STATES)) {
    const at = st.rows.findIndex(r => r.s === 'fail' && /release_not_approved/.test(text(r.term)));
    if (at < 0) continue;
    const i = NAMES.indexOf('Sealed machine');
    const row = st.rows[i];
    if (row.s !== 'pass') bad.push(`${key}: "${NAMES[i]}" is ${row.w ?? row.s}: ${text(row.line)}`);
  }
  assert.deepEqual(bad, [], 'checkSigner returns RELEASE_NOT_APPROVED only after the signer checks pass (SPEC §3.4, §6.2 step 9)');
});
