import { keccak256, stringToBytes, type Hex } from 'viem';
// The WHATWG reference implementation. Node's built-in URL skips UTS-46 CheckBidi, which the
// standard sets (and Rust's url/idna applies), so it accepts hosts such as `xn--9hbc.com`.
import { URL } from 'whatwg-url';

/** Why `normalizeOrigin` refused an input. Stable strings, used in `vectors/origins.json`. */
export type OriginErrorReason =
  | 'invalid_url'
  | 'not_https'
  | 'userinfo'
  | 'trailing_dot'
  | 'ip_literal'
  | 'length';

export class OriginError extends Error {
  readonly reason: OriginErrorReason;
  constructor(reason: OriginErrorReason, input: string) {
    super(`invalid origin (${reason}): ${input}`);
    this.name = 'OriginError';
    this.reason = reason;
  }
}

export const ORIGIN_MIN_BYTES = 9;
export const ORIGIN_MAX_BYTES = 267;

// The WHATWG host serializer always writes an IPv4 host in dotted decimal and an IPv6 host in brackets.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * SPEC §2.1. WHATWG URL parsing, whose host parser applies UTS-46 non-transitional
 * processing (CheckBidi and CheckJoiners on) to ASCII and lowercases. `local` is `--network local`: it allows
 * `http://localhost:<port>` and IP literals.
 */
export function normalizeOrigin(input: string, opts: { local?: boolean } = {}): string {
  const local = opts.local === true;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new OriginError('invalid_url', input);
  }
  const localHttp =
    local && url.protocol === 'http:' && url.hostname === 'localhost' && url.port !== '';
  if (url.protocol !== 'https:' && !localHttp) throw new OriginError('not_https', input);
  if (url.username !== '' || url.password !== '') throw new OriginError('userinfo', input);
  const host = url.hostname;
  if (host.endsWith('.')) throw new OriginError('trailing_dot', input);
  if (!local && (host.startsWith('[') || IPV4.test(host))) throw new OriginError('ip_literal', input);
  // url.host omits the scheme's default port (443 for https).
  const origin = `${url.protocol}//${url.host}`;
  const bytes = stringToBytes(origin).length;
  if (bytes < ORIGIN_MIN_BYTES || bytes > ORIGIN_MAX_BYTES) throw new OriginError('length', input);
  return origin;
}

/** `keccak256(utf8(normalizedOrigin))`. Hashes the string as given, like `addEndpoint` does on chain. */
export function originHash(normalizedOrigin: string): Hex {
  return keccak256(stringToBytes(normalizedOrigin));
}
