/** SPEC §4.3 request body: at most 2,048 bytes, exactly these four keys, lowercase hex, decimal strings. */

export const MAX_BODY_BYTES = 2048;

const ADDRESS_LC = /^0x[0-9a-f]{40}$/;
const AMOUNT = /^(0|[1-9][0-9]{0,77})$/;
const DEC = /^(0|[1-9][0-9]*)$/;
const BODY_KEYS = ['amount', 'asset', 'chainId', 'payTo'];

export interface PaymentCheckRequest {
  chainId: string;
  payTo: string;
  asset: string;
  amount: string;
}

/** The parsed body, or null when it breaks the §4.3 schema (`bad_request`). */
export function parseRequestBody(bytes: Uint8Array, chainId: number): PaymentCheckRequest | null {
  if (bytes.length === 0 || bytes.length > MAX_BODY_BYTES) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== BODY_KEYS.length || keys.some((k, i) => k !== BODY_KEYS[i])) return null;
  if (typeof o.chainId !== 'string' || !DEC.test(o.chainId) || o.chainId !== String(chainId)) return null;
  if (typeof o.payTo !== 'string' || !ADDRESS_LC.test(o.payTo)) return null;
  if (typeof o.asset !== 'string' || !ADDRESS_LC.test(o.asset)) return null;
  if (typeof o.amount !== 'string' || !AMOUNT.test(o.amount)) return null;
  return { chainId: o.chainId, payTo: o.payTo, asset: o.asset, amount: o.amount };
}
