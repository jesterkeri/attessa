/** A small JSON-RPC client. Errors keep their `code` and revert `data` so the CLI can name the revert. */

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

/** The node could not be reached or answered something that isn't JSON-RPC. */
export class RpcUnavailable extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RpcUnavailable';
  }
}

export interface Rpc {
  readonly url: string;
  request(method: string, params: unknown[]): Promise<unknown>;
}

export class HttpRpc implements Rpc {
  readonly url: string;
  private readonly timeoutMs: number;
  private id = 0;
  constructor(url: string, timeoutMs = 20_000) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }

  async request(method: string, params: unknown[]): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new RpcUnavailable(`${method}: ${(e as Error).message}`, { cause: e });
    }
    let json: { result?: unknown; error?: { code: number; message: string; data?: unknown } };
    try {
      json = (await res.json()) as typeof json;
    } catch (e) {
      throw new RpcUnavailable(`${method}: HTTP ${res.status}, not JSON`, { cause: e });
    }
    if (json.error) throw new RpcError(json.error.code, json.error.message, json.error.data);
    if (!('result' in json)) throw new RpcUnavailable(`${method}: no result`);
    return json.result;
  }
}

/** Revert data from an `eth_call`/`eth_estimateGas` error, if the node returned any. */
export function revertData(e: unknown): `0x${string}` | null {
  if (!(e instanceof RpcError)) return null;
  const d = e.data;
  if (typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d)) return d as `0x${string}`;
  if (typeof d === 'object' && d !== null && typeof (d as { data?: unknown }).data === 'string') return (d as { data: `0x${string}` }).data;
  return null;
}
