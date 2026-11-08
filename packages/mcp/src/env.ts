/**
 * The two variables that hold wallet secrets. The server gets them through its own copy of the environment (`deps.env`) and
 * nothing else in the process should be able to read them: they are removed from `process.env` at start.
 */
export const WALLET_SECRET_NAMES = ['ATTESSA_PRIVATE_KEY', 'ATTESSA_KEYSTORE_PASSWORD'] as const;

/**
 * A private copy of `source` for the server, with the wallet secrets deleted from `source` itself. Call it first thing in the
 * process, with `process.env`. The MCP call path reads the key only from the copy (the CLI's `wallet()` passes `d.env` to the
 * SDK's `loadAccount`, so the SDK's `process.env` fallback is never taken).
 */
export function takeEnvironment(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const copy: Record<string, string | undefined> = { ...source };
  for (const name of WALLET_SECRET_NAMES) delete source[name];
  return copy;
}
