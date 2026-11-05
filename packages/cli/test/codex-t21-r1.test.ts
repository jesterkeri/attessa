import { describe, expect, it } from 'vitest';
import { BUY, BUYERR, CliError, ERR, rpcShownSafe, unexpected } from '../src/copy.ts';

// Codex T21 review r1. Major 1: an RPC URL can carry a provider key (userinfo, `/v3/<key>` path, `?api_key=`,
// fragment), so no line ever prints more than its scheme, host and port. Major 3: every error row has one next
// action (FLOWS.md:832), including usage errors, the unexpected-error line and rows built without one.

const LEAKY = 'https://user:pw@rpc.example:8545/v3/PATHKEY?api_key=QUERYKEY#FRAGKEY';
const SECRETS = ['user', 'pw', 'PATHKEY', 'QUERYKEY', 'FRAGKEY'];

describe('RPC URLs are shown as scheme://host[:port] only (Codex T21 r1 Major 1)', () => {
  it('rpcShownSafe drops userinfo, path, query and fragment', () => {
    expect(rpcShownSafe(LEAKY)).toBe('https://rpc.example:8545');
    expect(rpcShownSafe('wss://forno.celo.org/ws?k=1')).toBe('wss://forno.celo.org');
    expect(rpcShownSafe('http://127.0.0.1:8545')).toBe('http://127.0.0.1:8545');
  });

  it('anything that is not an http(s)/ws(s) URL is "your RPC"; the fixed label stays', () => {
    expect(rpcShownSafe('rpc.example/?api_key=X')).toBe('your RPC');
    expect(rpcShownSafe('file:///etc/passwd')).toBe('your RPC');
    expect(rpcShownSafe('')).toBe('your RPC');
    expect(rpcShownSafe('your --rpc')).toBe('your --rpc');
  });

  it('every line that names the RPC hides the key parts', () => {
    const lines = [ERR.rpcUnavailable(LEAKY).message, BUYERR.cancelNotSent(LEAKY).message, BUY.networkLocal(LEAKY)];
    for (const l of lines) {
      expect(l).toContain('https://rpc.example:8545');
      for (const s of SECRETS) expect(l).not.toContain(s);
    }
  });
});

describe('every error has one next action (Codex T21 r1 Major 3)', () => {
  it('a CliError built without one takes its fallback; never null', () => {
    expect(ERR.usage('--body <file|json> is required.').next).toBe('Run `attessa seller --help` for the commands and their flags.');
    expect(unexpected(new Error('x')).next).toMatch(/^Run the command again/);
    expect(new CliError('some_code', 'Something failed.').next).toBeTruthy();
  });

  it('the rows Codex named carry their own next action', () => {
    // FLOWS says these rows' action inside the line itself: --json carries it in `next`, text prints it once.
    expect([ERR.invalidOrigin().next, ERR.invalidOrigin().inline]).toEqual(['Use just the scheme and host, like https://risk.example.', true]);
    expect(ERR.releaseExists('7', '0x' + '11'.repeat(32)).next).toContain('attessa status --agent 7');
    expect(ERR.debugMode().next).toBe('Restart without --debug-mode.');
  });
});
