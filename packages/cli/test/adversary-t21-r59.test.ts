import { originHash } from '@attessa/core';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/index.ts';
import { AGENT, ORIGIN, onboarded, world, type World } from './harness.ts';

// Adversary T21 r59: an owner write with `--json` and no `--yes` asks for the verb before saying what it does.
//
// With `--json`, run() swaps io.out for a buffer (index.ts: `out: (l) => lines.push(l)`) and prints that buffer only
// in finish(), after the command returns. io.confirm is not swapped. So `attessa revoke release <id> --json` from the
// owner key, without `--yes`, calls io.confirm('revoke') while the J4 prompt ("This stops buyers paying for answers
// from this build ... Revoking is permanent.  [revoke/cancel]") is still sitting in the buffer: on a terminal the
// owner sees only bin.ts's "Type revoke to continue, anything else cancels: ", with no consequence and no cost.
// Typing the verb sends the permanent revoke. FLOWS.md:833 (Undo over confirm): "Confirms only where there is no
// undo ... `revoke` (permanent, takes the service offline). Each prompt names the consequence and uses the verb as
// the button. `--yes` / `--accept-unprotected` for non-interactive agents." SPEC §8 lists `--json` and `--yes` as
// separate global flags, so `--json` without `--yes` is the interactive path.
//
// The fake chain is the CLI harness's own (harness.ts, fake-chain.ts). The confirm stub records what had reached the
// real output (stdout and stderr) at the moment it was asked, then answers "cancel", so nothing is sent.

const SRC = 'https://github.com/acme/risk/commit/a1b2c3d';

let w: World;
const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;

/** Runs argv with a confirm that snapshots the printed output when it is asked, and cancels. */
async function atPrompt(argv: string[]): Promise<{ asked: string | null; shown: string[]; code: number; printed: string[] }> {
  w.out.length = 0;
  w.err.length = 0;
  let asked: string | null = null;
  let shown: string[] = [];
  const d = w.deps();
  d.io.confirm = async (yesWord) => {
    asked = yesWord;
    shown = [...w.out, ...w.err];
    return false;
  };
  const code = await run(argv, d);
  return { asked, shown, code, printed: [...w.out, ...w.err] };
}

describe('T21 adversary r59: a confirm under --json without --yes', () => {
  beforeEach(() => {
    w = world();
    onboarded(w);
    w.chain.approveRelease(AGENT, w.rid, SRC);
    w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
  });

  it('control: without --json the J4 prompt is printed before the revoke is confirmed', async () => {
    const r = await atPrompt(['revoke', 'release', w.rid]);
    expect(r.asked).toBe('revoke');
    expect(r.shown.join('\n')).toContain('Revoking is permanent.  [revoke/cancel]');
    expect(w.chain.sent).toHaveLength(0);
  });

  it('revoke release --json: the owner sees the consequence before being asked to type revoke', async () => {
    const r = await atPrompt(['revoke', 'release', w.rid, '--json']);
    expect(w.chain.sent).toHaveLength(0);
    if (r.asked !== null) {
      // FLOWS:833 "Each prompt names the consequence": by the time the verb is asked for, the permanent,
      // service-ending consequence must have reached the terminal.
      expect(r.shown.join('\n')).toContain('Revoking is permanent.');
    } else {
      // A CLI that refuses to prompt under --json instead must say so with its one next action (FLOWS:832).
      const j = JSON.parse(r.printed.at(-1)!) as { ok: boolean; error?: string; next?: string | null };
      expect(j.ok).toBe(false);
      expect(j.error).toBeTruthy();
      expect(j.next).toBeTruthy();
    }
  });
});
