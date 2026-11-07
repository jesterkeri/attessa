#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { CliError, HttpRpc, lastResortLines } from '@attessa/cli';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.ts';

/**
 * `attessa-mcp`: the MCP server on stdio. Keys come from ATTESSA_PRIVATE_KEY, ATTESSA_KEYSTORE (+ ATTESSA_KEYSTORE_PASSWORD)

 * or the OS keychain, as for the CLI; ATTESSA_REDACT (comma-separated variable names) adds to the secrets hidden from results; ATTESSA_NETWORK, ATTESSA_RPC and ATTESSA_DATA_DIR work as the CLI's flags and folder.
 * Nothing but protocol goes to stdout.
 */
function start(): ReturnType<typeof createMcpServer> {
  return createMcpServer({
  deps: {
    env: process.env,
    cwd: process.cwd(),
    rpc: (url) => new HttpRpc(url),
    runner: { run: async () => ({ code: 1, stdout: '', stderr: 'no runner in the MCP server' }) },
    fetch,
    enclave: () => {
      throw new Error('no enclave in the MCP server');
    },
    readFile: (p) => readFileSync(p),
    writeFile: (p, d) => writeFileSync(p, d),
    exists: (p) => existsSync(p),
    readdir: (p) => readdirSync(p),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    arch: process.arch,
    home: homedir(),
  },
  });
}

// A configured secret that can't be hidden safely stops the server here, with the variable's name (never its value) and a next action.
let server: ReturnType<typeof createMcpServer>;
try {
  server = start();
} catch (e) {
  process.stderr.write(e instanceof CliError ? `${e.message}\n${e.next ?? ''}\n` : lastResortLines(e));
  process.exit(1);
}

server.connect(new StdioServerTransport()).catch((e: unknown) => {
  process.stderr.write(lastResortLines(e));
  process.exit(1);
});
