#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { TcpEnclaveTransport } from '@attessa/seller-host';
import { run, type Deps, type RunResult } from './index.ts';
import { HttpRpc } from './rpc.ts';

/** `attessa` / `attest`: real process wiring for `run`. */
const deps: Deps = {
  io: {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    async confirm(yesWord) {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const a = await rl.question(`Type ${yesWord} to continue, anything else cancels: `);
      rl.close();
      return a.trim() === yesWord;
    },
  },
  env: process.env,
  cwd: process.cwd(),
  rpc: (url) => new HttpRpc(url),
  runner: {
    run: (cmd, args, opts) =>
      new Promise<RunResult>((resolve) => {
        const p = spawn(cmd, args, { cwd: opts?.cwd, env: { ...process.env, ...opts?.env }, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', (b) => (stdout += b));
        p.stderr.on('data', (b) => (stderr += b));
        p.on('error', (e) => resolve({ code: 127, stdout, stderr: e.message }));
        p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      }),
  },
  fetch,
  enclave: (port) => new TcpEnclaveTransport(port),
  readFile: (p) => readFileSync(p),
  writeFile: (p, d) => writeFileSync(p, d),
  exists: (p) => existsSync(p),
  readdir: (p) => readdirSync(p),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  arch: process.arch,
};

run(process.argv.slice(2), deps).then(
  (code) => process.exit(code),
  (e: unknown) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  },
);
