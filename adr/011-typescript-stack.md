# ADR-011: TypeScript pnpm workspace (core, sdk, cli, gateway, seller-host) on Node 22 with viem and Fastify

- Status: accepted.
- Context: one language for everything outside the enclave and contracts. buy's ecosystem is TypeScript; viem ≥ 2.45 supports the attribution `dataSuffix`.
- Options:
  1. TS workspace.
  2. Go gateway + TS SDK.
  3. Python.
- Decision: (1). SQLite (better-sqlite3) for the gateway; `keytar` for the CLI key store.
- Consequences:
  - Install scripts are disabled by default with an allowlist (better-sqlite3 and keytar need native builds; listed explicitly).
  - We give up a single static binary for the gateway.
- Confirmation: `pnpm -r typecheck` strict.
