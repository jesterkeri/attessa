import { originHash } from '@attessa/core';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/index.ts';
import { AGENT, ORIGIN, onboarded, world, type World } from './harness.ts';

// Adversary T21 r60: a confirm that answers "no" under --json ends `{"ok":false,"lines":[...]}`, exit 1, with no
// error code, no message and no next action.
//
// bin.ts's confirm returns false without asking whenever stdin is not a TTY (`if (!process.stdin.isTTY) return
// false;`), which is how an agent runs the CLI. planOrSend (tx.ts) then returns 'cancelled' and every write
// (registry.ts write(), owner.ts, signer.ts) returns 1 with nothing more said, so run()'s finish() prints only
// `ok:false` and the buffered prompt. An agent parsing stdout sees a failure it cannot name or act on, and is never
// told the one thing that works: `--yes`.
//
// FLOWS.md:832 (Recovery): "Every error row has one next action". FLOWS.md:833 (Undo over confirm): "... `revoke`
// (permanent, takes the service offline) ... `--yes` / `--accept-unprotected` for non-interactive agents." Every
// other `ok:false` object run() prints carries `error`, `message` and `next` (index.ts catch block).
//
// The fake chain is the CLI harness's own (harness.ts, fake-chain.ts). The confirm stub answers false, as bin.ts's
// does for a non-TTY stdin, so nothing is sent.

const SRC = 'https://github.com/acme/risk/commit/a1b2c3d';

let w: World;
const signer = privateKeyToAccount(generatePrivateKey()).address.toLowerCase() as Address;

describe('T21 adversary r60: a declined or non-TTY confirm under --json', () => {
  beforeEach(() => {
    w = world();
    onboarded(w);
    w.chain.approveRelease(AGENT, w.rid, SRC);
    w.chain.addSigner(signer, { agentId: AGENT, releaseId: w.rid, originHash: originHash(ORIGIN), operator: w.operator });
    w.env.ATTESSA_PRIVATE_KEY = w.ownerKey;
    w.confirmAnswer = false; // bin.ts: stdin is not a TTY, so the confirm answers false without asking
  });

  it('revoke release --json without --yes: the JSON object names why it stopped and its one next action', async () => {
    const code = await run(['revoke', 'release', w.rid, '--json'], w.deps());
    expect(code).toBe(1);
    expect(w.chain.sent).toHaveLength(0);
    const j = JSON.parse(w.out.at(-1)!) as { ok: boolean; error?: string; message?: string; next?: string | null };
    expect(j.ok).toBe(false);
    // FLOWS:832: an ok:false result an agent gets must say what stopped it and the one action that proceeds.
    expect({ error: j.error ?? null, next: j.next ?? null }).toEqual({ error: expect.any(String), next: expect.stringMatching(/\S/) });
  });
});
