#!/usr/bin/env node
// Rehearsal-only tamper proxy between a gateway and seller-host (T23's proxy does not exist in the code base).
// It changes the first byte of the "response" field of /internal/evaluate answers, leaving the proof and signature as the enclave made them.
// Refuses to start unless the send RPC is a local anvil, and only listens/forwards on 127.0.0.1.
//   node scripts/rehearse/tamper-proxy.mjs <listen=18701> <upstream=http://127.0.0.1:7070>
import { createServer } from 'node:http';
import { assertLocal } from './lib.mjs';
await assertLocal();
const listen = Number(process.argv[2] || 18701), up = new URL(process.argv[3] || 'http://127.0.0.1:7070');
if (up.hostname !== '127.0.0.1') throw new Error('upstream must be 127.0.0.1');
let tampered = 0;
createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await fetch(new URL(req.url, up), { method: req.method, headers: { 'content-type': 'application/json' }, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) });
  let text = await r.text();
  if (req.url === '/internal/evaluate' && r.status === 200) {
    const j = JSON.parse(text);
    if (typeof j.response === 'string' && j.response.length > 4) {
      const first = j.response[0] === 'A' ? 'B' : 'A';
      j.response = first + j.response.slice(1); text = JSON.stringify(j); tampered++;
      console.error(new Date().toISOString(), `tampered evaluate answer #${tampered}`);
    }
  }
  res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(text);
}).listen(listen, '127.0.0.1', () => console.error(`tamper proxy 127.0.0.1:${listen} -> ${up.origin}`));
