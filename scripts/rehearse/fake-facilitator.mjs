#!/usr/bin/env node
// Rehearsal-only x402 v2 "exact" facilitator: settles with the real token's transferWithAuthorization on the LOCAL FORK.
// Refuses to start unless the send RPC is http://127.0.0.1 and answers anvil_nodeInfo. Never a production component.
//   REHEARSE_PORT=18546 node scripts/rehearse/fake-facilitator.mjs <listenPort>
import { createServer } from 'node:http';
import { parseAbi, getAddress } from '../../packages/core/node_modules/viem/_esm/index.js';
import { assertLocal, pub, wallet, walletClient, fund } from './lib.mjs';

await assertLocal();
const listen = Number(process.argv[2] || 18700);
const fac = wallet('facilitator');
await fund(fac.address, 10);
const wc = walletClient(fac.account), pc = pub();
const abiBytes = parseAbi(['function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,bytes signature)']);
const abiVrs = parseAbi(['function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)']);
const log = (...a) => console.error(new Date().toISOString(), ...a);

function args(body) {
  const a = body.paymentPayload.payload.authorization, sig = body.paymentPayload.payload.signature;
  const asset = getAddress(body.paymentRequirements.asset);
  return { asset, a, sig };
}
async function call(body, send) {
  const { asset, a, sig } = args(body);
  const base = [getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce];
  const vrs = [parseInt(sig.slice(130, 132), 16), '0x' + sig.slice(2, 66), '0x' + sig.slice(66, 130)];
  const attempts = [
    { abi: abiBytes, args: [...base, sig] },
    { abi: abiVrs, args: [...base, ...vrs] },
  ];
  let last;
  for (const t of attempts) {
    try {
      const req = { address: asset, abi: t.abi, functionName: 'transferWithAuthorization', args: t.args, account: fac.account };
      await pc.simulateContract(req);
      if (!send) return { ok: true };
      const hash = await wc.writeContract(req);
      const rc = await pc.waitForTransactionReceipt({ hash });
      return { ok: rc.status === 'success', hash };
    } catch (e) { last = e; }
  }
  return { ok: false, reason: (last?.shortMessage || String(last)).slice(0, 60).replace(/[^A-Za-z0-9_.:-]/g, '_') };
}
const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const send = (st, b) => { res.writeHead(st, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
  try {
    if (req.method === 'GET' && req.url === '/supported') return send(200, { kinds: [{ x402Version: 2, scheme: 'exact', network: 'eip155:42220' }], extensions: [], signers: {} });
    const body = JSON.parse(Buffer.concat(chunks).toString() || 'null');
    const payer = body?.paymentPayload?.payload?.authorization?.from ?? '';
    if (req.url === '/verify') { const r = await call(body, false); log('verify', r.ok, r.reason ?? ''); return send(200, r.ok ? { isValid: true, payer } : { isValid: false, invalidReason: r.reason, payer }); }
    if (req.url === '/settle') {
      const r = await call(body, true); log('settle', r.ok, r.hash ?? r.reason ?? '');
      return r.ok ? send(200, { success: true, transaction: r.hash, network: 'eip155:42220', payer }) : send(400, { success: false, errorReason: r.reason, payer, transaction: '', network: 'eip155:42220' });
    }
    send(404, { error: 'not found' });
  } catch (e) { log('error', e.message); send(500, { error: 'internal' }); }
});
server.listen(listen, '127.0.0.1', () => log(`fake facilitator on 127.0.0.1:${listen}, facilitator wallet ${fac.address}, send RPC local only`));
