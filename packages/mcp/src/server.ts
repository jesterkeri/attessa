import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  BUY,
  BUYERR,
  CHECK_WORDS,
  CliError,
  ERR,
  buyerDataDir,
  jsonOut,
  parseAmount,
  readConfig,
  run,
  safe,
  type Deps,
} from '@attessa/cli';
import { Ledger, TERMINAL_STATES, type AssetKey } from '@attessa/sdk';
import { allSkipped, registryFor, verifyProof } from './verify-proof.ts';

/** The MCP agent tools (FLOWS §11 "Agent surface"). Payment logic, bounds and copy are the CLI's and the SDK's. */

const REQUEST_ID = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** The folder `answer.json` and `<requestId>.json` are written to, as far as the CLI knows. Never touched: writes there are captured. */
const VIRTUAL_CWD = '/attessa-mcp';

const URL_SCHEMA = { type: 'string', description: 'The service URL, like https://risk.example/v1/evaluate.' } as const;
const BODY_SCHEMA = { description: 'The JSON request body: a JSON object or array (an object, or JSON text). Files are never read.', oneOf: [{ type: 'object' }, { type: 'array' }, { type: 'string' }] } as const;
const MAX_AMOUNT_SCHEMA = {
  type: 'string',
  pattern: '^\\d+(\\.\\d{1,6})?$',
  description: 'Most you will pay for this call, in USDC, like 0.05. It can lower the owner-set per-call limit, never raise it. Required when no limit was set with `attessa init`.',
} as const;
const REQUEST_ID_SCHEMA = { type: 'string', pattern: '^0x[0-9a-f]{64}$', description: 'The request id (0x and 64 hex characters).' } as const;

export const TOOLS: Tool[] = [
  {
    name: 'resolve_endpoint',
    description:
      'Look up a service URL in the Celo registry: which agent runs it, whether the endpoint is active or retired, and who it pays. Read-only, no wallet, signs and spends nothing.',
    inputSchema: { type: 'object', properties: { url: URL_SCHEMA }, required: ['url'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'check_liveness',
    description:
      'Ask a registered service for a fresh liveness proof (signed by the sealed machine, checked against the registry). Read-only, no wallet, signs and spends nothing.',
    inputSchema: { type: 'object', properties: { url: URL_SCHEMA }, required: ['url'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'quote',
    description:
      'Preview a paid call: checks the registry and liveness and shows the price against your limits, then stops before anything is signed. Signs and spends nothing; needs the buyer wallet loaded only to show whose limits apply.',
    inputSchema: {
      type: 'object',
      properties: { url: URL_SCHEMA, body: BODY_SCHEMA, maxAmount: MAX_AMOUNT_SCHEMA, asset: { type: 'string', enum: ['usdc', 'usat'] } },
      required: ['url', 'body'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'pay_and_verify',
    description:
      'SIDE EFFECT, SPENDS MONEY: signs a USDC payment authorization with the buyer wallet and pays the service, within the per-call limit (maxAmount) and the daily cap. The answer is returned only if its proof checks out; otherwise it says what was and was not charged. Refuses before signing when the price is over a limit.',
    inputSchema: {
      type: 'object',
      properties: {
        url: URL_SCHEMA,
        body: BODY_SCHEMA,
        maxAmount: MAX_AMOUNT_SCHEMA,
        asset: { type: 'string', enum: ['usdc', 'usat'] },
        newRequest: { type: 'boolean', description: 'Pay again for the same input instead of resuming an open call.' },
        noWait: { type: 'boolean', description: 'Return at once when the outcome is not yet decided instead of waiting for the authorization to expire.' },
      },
      required: ['url', 'body'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'verify_proof',
    description:
      'Check an X-Attested-Proof header OFFLINE, with no chain read: signature recovery against the registry address, the fixed proof lifetime, and, for each argument you pass, the request id, the request hash (give `requestHash` or `request` {method, pathAndQuery, body}), the response hash and the inputs hash (give `response`). Everything else a paid call is checked for (signer and release status on the chain, payment binding, settlement, time anchors, expiry now, inputs block and values) is listed in `notChecked`: a success is NOT a verified paid result. No wallet, signs and spends nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        proof: { type: 'string', description: 'The X-Attested-Proof header value (base64).' },
        chainId: { type: 'integer', description: 'The chain the registry is on: 11142220 for Celo Sepolia, 42220 for Celo mainnet.' },
        registry: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: 'EnclaveRegistry address; defaults to the pinned one for chainId.' },
        response: { type: 'string', description: 'The exact response body text the proof should cover.' },
        requestId: REQUEST_ID_SCHEMA,
        requestHash: { type: 'string', pattern: '^0x[0-9a-f]{64}$', description: 'The request hash you expect (SPEC §2.2: keccak256 of METHOD, 0x00, path and query, 0x00, body).' },
        request: {
          type: 'object',
          description: 'The request you made, hashed as SPEC §2.2 and compared with the proof.',
          properties: { method: { type: 'string' }, pathAndQuery: { type: 'string', description: 'Starts with /.' }, body: { type: 'string', description: 'The exact request body text.' } },
          required: ['method', 'pathAndQuery', 'body'],
          additionalProperties: false,
        },
      },
      required: ['proof', 'chainId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_result',
    description:
      'SIGNS A PAYER MESSAGE (no payment, no transaction): reports what happened to an earlier call by request id. A verified call is read from the local record (no wallet, no network); a call decided against you (not charged, paid but rejected, settled after refusal) is reported in the CLI FLOWS words and needs the wallet loaded, but sends nothing. A call still open is decided now: if its answer can still come, the buyer wallet signs a short payer message (an EIP-191 text, not a payment) and asks its gateway for it; an open call already refused is only checked against the chain, with no signature. The chain is read. Never pays again and sends no transaction.',
    inputSchema: { type: 'object', properties: { requestId: REQUEST_ID_SCHEMA }, required: ['requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'list_pending',
    description: 'List the open calls recorded on this computer (signed but not yet decided), from the local ledger only. No wallet, no network, signs and spends nothing.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'cancel_authorization',
    description:
      'SIDE EFFECT, SENDS A TRANSACTION: signs and sends a cancel transaction (costs a little CELO gas) that voids an unused payment authorization, so the service can no longer charge it. Refuses when the payment already went through.',
    inputSchema: { type: 'object', properties: { requestId: REQUEST_ID_SCHEMA }, required: ['requestId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'status',
    description:
      'SIGNS A PAYER MESSAGE (no payment, no transaction): shows your spending today against the daily cap and the per-call limit, and decides every open call of this wallet. To decide them the buyer wallet signs a short payer message (an EIP-191 text, not a payment) for each open call whose answer can still come, and asks that gateway for it (an open call already refused is only checked against the chain, with no signature); the chain is read. Needs the buyer wallet. Pays nothing and sends no transaction.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

export interface ServerOptions {
  /** Process wiring for the CLI's `run` (real or fake). `io` is replaced per call. */
  deps: Omit<Deps, 'io'>;
}

interface ToolResult {
  [k: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * What this server does about secrets, and what it does not. Not a closed guarantee.
 *
 * Removed by construction (no code path puts it in a result):
 *   - the private key goes only to the wallet signer; the server reads it from its own copy of the environment (bin.ts removes
 *     it from process.env at start); RPC URLs are shown as scheme://host[:port] by the CLI's `rpcShownSafe`;
 *   - the requested tool name and `maxAmount` are not echoed by any MCP error.
 *
 * Matched (best effort, on the serialised result, after rendering):
 *   - secrets: ATTESSA_PRIVATE_KEY, ATTESSA_KEYSTORE_PASSWORD, the credential pieces of ATTESSA_RPC and every variable named in
 *     ATTESSA_REDACT. Raw, JSON-escaped and URL-encoded spellings are hidden in place; a string that reads back as one once
 *     escaping is undone to a fixed point (bounded), or that holds its base64 or hex form (secrets of 8+ characters only),
 *     withholds the whole result;
 *   - paths: ATTESSA_KEYSTORE and ATTESSA_DATA_DIR (as typed, resolved, and in `~/` form) are hidden as whole values. They are
 *     not secrets, so a short value is never refused.
 *
 * Not covered: a secret split across fields or strings; an encoding not listed; the encoded form of a value under 8
 * characters; a service's answer passed through unchanged apart from the matching above; a secret in a variable that is
 * neither consumed nor named in ATTESSA_REDACT. The per-call limit and the daily cap bound what can be spent either way; the
 * OS keychain, or a keystore holding a low-balance wallet, is the safer setup than a key in the environment.
 */
const CONSUMED = ['ATTESSA_PRIVATE_KEY', 'ATTESSA_KEYSTORE_PASSWORD'];
/** Consumed values that are file paths: public configuration, hidden whole wherever they appear. */
const PATH_VARS = ['ATTESSA_KEYSTORE', 'ATTESSA_DATA_DIR'];

function declared(env: Record<string, string | undefined>): Array<[string, string]> {
  // The path variables are hidden as paths (see `pathForms`), never as secrets: a short one must not stop the server.
  const names = [...CONSUMED, ...(env.ATTESSA_REDACT ?? '').split(',').map((n) => n.trim()).filter((n) => n !== '' && !PATH_VARS.includes(n))];
  return [...new Set(names)].flatMap((n): Array<[string, string]> => (env[n] !== undefined && env[n] !== '' ? [[n, env[n]!]] : []));
}

/** Shortest secret that can be told from protocol data (amounts, block numbers, hash digits) and so hidden without changing a result. */
export const MIN_SECRET_LENGTH = 4;
/** A secret made only of digits collides with amounts and block numbers unless it is this long. */
export const MIN_DIGIT_SECRET_LENGTH = 8;
const redactable = (v: string): boolean => v.length >= MIN_SECRET_LENGTH && !(/^\d+$/.test(v) && v.length < MIN_DIGIT_SECRET_LENGTH);

/** Names of declared secrets whose value can't be redacted safely: the server won't run with them. Never their values. */
export function unsafeSecrets(env: Record<string, string | undefined>): string[] {
  return declared(env).filter(([, v]) => !redactable(v)).map(([k]) => k);
}

export function unsafeSecretError(name: string): CliError {
  return new CliError(
    'unsafe_secret',
    `${name} is set to a value too short to hide safely, so the MCP server won't run with it.`,
    `Use a value of at least ${MIN_SECRET_LENGTH} characters (at least ${MIN_DIGIT_SECRET_LENGTH} if it is only digits) for ${name}, or take ${name} out of ATTESSA_REDACT, then start the server again.`,
  );
}

/** The pieces of ATTESSA_RPC that carry credentials: userinfo, path segments, query values, fragment (decoded and as typed). */
function rpcPieces(rpc: string | undefined): string[] {
  if (!rpc) return [];
  try {
    const u = new URL(rpc);
    const dec = (x: string): string[] => {
      try {
        return [x, decodeURIComponent(x)];
      } catch {
        return [x];
      }
    };
    return [
      ...dec(u.username),
      ...dec(u.password),
      ...u.pathname.split('/').flatMap(dec),
      ...[...u.searchParams.values()].flatMap(dec),
      ...dec(u.hash.replace(/^#/, '')),
    ].filter((x) => x !== '' && redactable(x));
  } catch {
    return [];
  }
}

/** Every string to hide: the declared secrets that can be hidden, a key without its 0x, and the RPC's credential pieces. */
function secretBases(env: Record<string, string | undefined>): string[] {
  const bases = new Set<string>(rpcPieces(env.ATTESSA_RPC));
  for (const [, v] of declared(env)) {
    if (!redactable(v)) continue;
    bases.add(v);
    if (/^0x[0-9a-fA-F]{64}$/.test(v)) bases.add(v.slice(2));
  }
  return [...bases].sort((x, y) => y.length - x.length);
}

const escRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
const UNRESERVED = /^[A-Za-z0-9\-_.~]$/;
const URI_LITERAL = ";,/?:@&=+$#!'()*";

/** The source of a pattern for `b` as it appears raw, JSON-escaped, or URL-encoded in any mix of upper and lower case hex, with `+` for a space, and reserved characters left literal (encodeURI). */
function patternSource(b: string): string {
  const pct = [...b]
    .map((ch) => {
      if (UNRESERVED.test(ch)) return escRe(ch);
      const enc = [...Buffer.from(ch, 'utf8')].map((by) => `%${by.toString(16).toUpperCase().padStart(2, '0').replace(/[A-F]/g, (c) => `[${c}${c.toLowerCase()}]`)}`).join('');
      return `(?:${[enc, ...(ch === ' ' ? ['\\+'] : []), ...(URI_LITERAL.includes(ch) ? [escRe(ch)] : [])].join('|')})`;
    })
    .join('');
  return `${pct}|${escRe(JSON.stringify(b).slice(1, -1))}|${escRe(b)}`;
}

function secretPattern(b: string): RegExp {
  return new RegExp(patternSource(b), 'g');
}

/** Where a path value counts as the whole value: not inside a longer word or name (`ks` is not `ksx`, nor `/tmp/ks/y`). */
function pathPattern(b: string, flags: string): RegExp {
  const before = /^[/~]/.test(b) ? '(?<![\\w.-])' : '(?<![\\w./~-])';
  return new RegExp(`${before}(?:${patternSource(b)})(?![\\w-]|\\.\\w)`, flags);
}

/** Where the process lives, for the forms a path takes in a message. */
export interface PathContext {
  home?: string | undefined;
  cwd?: string | undefined;
}

/** Every form ATTESSA_KEYSTORE and ATTESSA_DATA_DIR can take in a result: as typed, resolved, real, with `safe()` escapes, and as `~/…`. */
function pathForms(env: Record<string, string | undefined>, ctx: PathContext): string[] {
  const out = new Set<string>();
  for (const n of PATH_VARS) {
    const v = env[n];
    if (v === undefined || v === '') continue;
    const abs = ctx.cwd !== undefined ? resolve(ctx.cwd, v) : v;
    let real = abs;
    try {
      real = realpathSync(abs);
    } catch {
      // not there yet: the path as resolved
    }
    for (const f of [v, v.replace(/\/+$/, ''), abs, real]) {
      out.add(f);
      out.add(safe(f));
      if (ctx.home !== undefined && (f === ctx.home || f.startsWith(`${ctx.home}/`))) out.add(`~${f.slice(ctx.home.length)}`);
    }
  }
  return [...out].filter((f) => /[A-Za-z0-9]/.test(f)).sort((x, y) => y.length - x.length);
}

/** Text with the secrets (raw, JSON-escaped, URL-encoded), the path values and URL userinfo removed: the first, cheap layer. */
export function scrub(text: string, env: Record<string, string | undefined>, ctx: PathContext = {}): string {
  let t = text;
  for (const b of secretBases(env)) t = t.replace(secretPattern(b), '[hidden]');
  for (const f of pathForms(env, ctx)) t = t.replace(pathPattern(f, 'g'), '[hidden]');
  return t.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s"'@\\]*@/gi, '$1');
}

/** `s` with one level of escaping undone: \u{…}, \uXXXX, \xNN, \n \/ \\ …, and %XX runs. */
function unescapeOnce(s: string): string {
  const cp = (n: number): string => (n <= 0x10ffff ? String.fromCodePoint(n) : '');
  const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '/': '/', '"': '"', "'": "'" };
  return s
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_m, h: string) => cp(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h: string) => cp(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h: string) => cp(parseInt(h, 16)))
    .replace(/\\([nrtbf\\/"'])/g, (_m, c: string) => simple[c]!)
    .replace(/(?:%[0-9a-fA-F]{2})+/g, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m;
      }
    });
}

/** Most layers of escaping undone, and most characters read in all, for one string. Past either, `readings` gives up. */
const MAX_LAYERS = 64;
const MAX_READ_CHARS = 8 * 1024 * 1024;

/**
 * Every reading of `s` with escaping undone until nothing changes (each layer is shorter than the last, so it ends), and with
 * `+` also read as a space. Null when a bound is hit: the caller treats that as "may hold a secret" and withholds.
 */
function readings(s: string): string[] | null {
  const out = [s];
  let cur = s;
  let chars = s.length;
  for (let i = 0; ; i++) {
    const next = unescapeOnce(cur);
    if (next === cur) break;
    chars += next.length;
    if (i >= MAX_LAYERS || chars > MAX_READ_CHARS) return null;
    out.push(next);
    cur = next;
  }
  return [...out, ...out.flatMap((x) => (x.includes('+') ? [x.replace(/\+/g, ' ')] : []))];
}

/** Secrets shorter than this are not looked for in base64 or hex: those forms would collide with ordinary data. */
export const MIN_ENCODED_SECRET_LENGTH = 8;

/**
 * The base64 (standard and URL-safe, padding dropped: the forms are substrings of the padded ones) and lowercase hex a secret
 * takes inside a longer text. Base64 at each of the three byte alignments, cut to the characters the secret alone decides.
 * For a secret that is itself hex (a key), the bytes it spells are encoded too.
 */
function encodedForms(secret: string): { b64: string[]; hex: string[] } {
  if (secret.length < MIN_ENCODED_SECRET_LENGTH) return { b64: [], hex: [] };
  const byteSets = [Buffer.from(secret, 'utf8')];
  const bare = secret.replace(/^0x/i, '');
  if (bare.length >= 16 && /^(?:[0-9a-fA-F]{2})+$/.test(bare)) byteSets.push(Buffer.from(bare, 'hex'));
  const b64 = new Set<string>();
  const hex = new Set<string>();
  for (const bytes of byteSets) {
    hex.add(bytes.toString('hex'));
    for (const k of [0, 1, 2]) {
      const full = Buffer.concat([Buffer.alloc(k, 0x78), bytes]).toString('base64').replace(/=+$/, '');
      const cut = full.slice([0, 2, 3][k]!, (k + bytes.length) % 3 === 0 ? undefined : -1);
      b64.add(cut);
      b64.add(cut.replace(/\+/g, '-').replace(/\//g, '_'));
    }
  }
  return { b64: [...b64], hex: [...hex] };
}

const PROTOCOL_STRING = /^(?:0x[0-9a-fA-F]{40,}|\d+(?:\.\d+)?)$/;

/** Same keys, same numbers and booleans, same amounts and hashes; only other strings may differ. */
function sameShape(a: unknown, b: unknown): boolean {
  if (typeof a === 'string') return typeof b === 'string' && (!PROTOCOL_STRING.test(a) || a === b);
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => sameShape(x, b[i]));
  if (typeof a === 'object' && a !== null) {
    if (typeof b !== 'object' || b === null || Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameShape((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

function everyString(v: unknown, f: (s: string) => boolean): boolean {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.every((x) => everyString(x, f));
  if (typeof v === 'object' && v !== null) return Object.entries(v).every(([k, x]) => f(k) && everyString(x, f));
  return true;
}

const WITHHELD = {
  ok: false,
  error: 'redaction_withheld',
  message: 'The result was withheld because it would have shown a secret this server holds, or hiding it would have changed a number or a hash.',
  next: 'Check what you passed in and what the service returned; if the secret was exposed outside this server, replace it.',
};

/** What the final layer needs to know: the live environment, and where the process lives (for `~/` and relative paths). */
interface Hide extends PathContext {
  env: Record<string, string | undefined>;
}

/**
 * The final layer, after every rendering: the serialised text has the secrets removed, and the result is sent only if it
 * still parses, has the same keys, numbers and booleans, has unchanged amounts and hashes, and no string in it, with its
 * escaping undone (\xNN, \uNNNN, %XX, …), still holds a secret, its base64 or hex form (8+ characters), or a path value; or whose escaping does not settle within a bound.
 * Otherwise a fixed result without any of it is sent instead.
 */
function render(h: Hide, v: unknown): { text: string; withheld: boolean } {
  const { env } = h;
  const original = jsonOut(v);
  const bases = secretBases(env);
  const paths = pathForms(env, h).map((f) => pathPattern(f, ''));
  const encoded = bases.map(encodedForms);
  const b64 = encoded.flatMap((e) => e.b64);
  const hex = encoded.flatMap((e) => e.hex);
  const redacted = scrub(original, env, h);
  const fail = { text: jsonOut(WITHHELD), withheld: true };
  let parsedOriginal: unknown;
  let parsed: unknown;
  try {
    parsedOriginal = JSON.parse(original);
    parsed = JSON.parse(redacted);
  } catch {
    return fail;
  }
  if (!sameShape(parsedOriginal, parsed)) return fail;
  const clean = (s: string): boolean => {
    const rs = readings(s);
    if (rs === null) return false;
    return !rs.some((r) => {
      const lower = hex.length > 0 ? r.toLowerCase() : '';
      return bases.some((b) => r.includes(b)) || paths.some((p) => p.test(r)) || b64.some((e) => r.includes(e)) || hex.some((e) => lower.includes(e));
    });
  };
  if (!everyString(parsed, clean)) return fail;
  return { text: redacted, withheld: false };
}

const text = (h: Hide, v: unknown, isError = false): ToolResult => {
  const r = render(h, v);
  return { content: [{ type: 'text', text: r.text }], ...(isError || r.withheld ? { isError: true } : {}) };
};

const failure = (h: Hide, e: CliError): ToolResult => text(h, { ok: false, error: e.code, message: e.message, next: e.next }, true);

function str(a: Record<string, unknown>, k: string): string | undefined {
  const v = a[k];
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw ERR.usage(`${k} must be a string.`);
  return v;
}

function requireUrl(a: Record<string, unknown>): string {
  const u = str(a, 'url');
  if (!u) throw ERR.usage('url is required, like https://risk.example/v1/evaluate.');
  return u;
}

function requireId(a: Record<string, unknown>): string {
  const id = str(a, 'requestId')?.toLowerCase();
  if (!id || !REQUEST_ID.test(id)) throw ERR.usage('requestId must be 0x followed by 64 hex characters.');
  return id;
}

/** Inline JSON only: the CLI's `--body` would read a file from a path an agent chose. */
function bodyText(a: Record<string, unknown>): string {
  const b = a.body;
  const t = typeof b === 'string' ? b : typeof b === 'object' && b !== null ? JSON.stringify(b) : undefined;
  if (t === undefined || !/^\s*[[{]/.test(t)) throw ERR.usage('body must be a JSON object or array.');
  return t;
}

export function createMcpServer(opts: ServerOptions): Server {
  const env = opts.deps.env;
  const hide: Hide = { env, home: opts.deps.home ?? homedir(), cwd: opts.deps.cwd };
  const unsafe = unsafeSecrets(env)[0];
  if (unsafe !== undefined) throw unsafeSecretError(unsafe);
  const server = new Server({ name: 'attessa', version: '0.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<ToolResult> => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      // The environment is read live: a secret that became unsafe after start stops every tool, not just the next start.
      const bad = unsafeSecrets(env)[0];
      if (bad !== undefined) return failure(hide, unsafeSecretError(bad));
      return await call(name, args);
    } catch (e) {
      if (e instanceof CliError) return failure(hide, e);
      // Never an error's own text: a parser or an RPC library may quote a key or a credentialed URL.
      const known = TOOLS.some((t) => t.name === name);
      return failure(hide, new CliError('unexpected', `${known ? name : 'The tool'} failed unexpectedly. Nothing was signed unless a result above says so.`, 'Run `status` to see your open calls, then retry.'));
    }
  });

  /** Runs the CLI's own command with `--json`, capturing what it would print and any answer it would write to a file. */
  async function cli(argv: string[], wallet: boolean): Promise<{ code: number; json: Record<string, unknown>; stderr: string[]; answers: Map<string, string> }> {
    const outLines: string[] = [];
    const stderr: string[] = [];
    const answers = new Map<string, string>();
    const keystore = env.ATTESSA_KEYSTORE;
    const full = [...argv, '--json'];
    if (env.ATTESSA_NETWORK) full.push('--network', env.ATTESSA_NETWORK);
    if (env.ATTESSA_RPC) full.push('--rpc', env.ATTESSA_RPC);
    if (wallet && keystore) full.push('--keystore', resolve(opts.deps.cwd, keystore)); // the CLI resolves against VIRTUAL_CWD otherwise
    const d: Deps = {
      ...opts.deps,
      cwd: VIRTUAL_CWD,
      io: { out: (l) => void outLines.push(l), err: (l) => void stderr.push(l), confirm: async () => false },
      writeFile: (p, data) => {
        if (p.startsWith(`${VIRTUAL_CWD}/`)) answers.set(basename(p), Buffer.from(data).toString('utf8'));
        else opts.deps.writeFile(p, data);
      },
      exists: (p) => (p.startsWith(`${VIRTUAL_CWD}/`) ? false : opts.deps.exists(p)),
    };
    const code = await run(full, d);
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(outLines.join('\n')) as Record<string, unknown>;
    } catch {
      json = { ok: code === 0, lines: outLines };
    }
    return { code, json, stderr, answers };
  }

  /** An answer fetched is kept beside the record (the CLI's own rule: a decided call is never fetched again). */
  function keep(answers: Map<string, string>, requestId?: unknown): Record<string, string> {
    const dir = buyerDataDir(opts.deps as Deps);
    const kept: Record<string, string> = {};
    for (const [file, content] of answers) {
      const rid = file === 'answer.json' ? requestId : file.replace(/\.json$/, '');
      if (typeof rid !== 'string' || !REQUEST_ID.test(rid)) continue;
      const dest = join(dir, `${rid}.json`);
      try {
        if (!existsSync(dest)) writeFileSync(dest, content, { mode: 0o600 });
      } catch {
        // the answer is still returned below; the CLI's own "kept" fallback only matters for its own file
      }
      kept[rid] = content;
    }
    return kept;
  }

  /** Per-call limit of this call: the owner's saved limit is a ceiling the agent can lower and never raise. */
  function boundedMaxAmount(a: Record<string, unknown>): string[] {
    const asked = str(a, 'maxAmount');
    const asset = (str(a, 'asset') ?? 'usdc') as AssetKey;
    if (asset !== 'usdc' && asset !== 'usat') throw ERR.usage('asset must be usdc or usat.');
    let saved: string | undefined;
    try {
      saved = readConfig(opts.deps as Deps)?.limits?.[asset]?.maxAmountPerCall;
    } catch {
      throw ERR.usage('The buyer config is not valid JSON. Ask the owner to run `attessa init` again.');
    }
    if (asked === undefined && saved === undefined) throw BUYERR.maxAmountRequired();
    if (asked !== undefined && saved !== undefined && parseAmount(asked, 'maxAmount') > parseAmount(saved, 'maxAmount'))
      throw new CliError(
        'over_max_amount', // not in FLOWS: the CLI lets a flag raise the limit; an agent's argument may not
        `That maxAmount is above the per-call limit of ${saved} that was set for this wallet. Nothing was signed.`,
        `Pass a maxAmount of ${saved} or less, or ask the owner to raise the limit with \`attessa init --max-amount\`.`,
      );
    return ['--max-amount', asked ?? saved!, '--asset', asset];
  }

  async function verifyProofTool(a: Record<string, unknown>): Promise<ToolResult> {
    const proof = str(a, 'proof');
    if (!proof) throw ERR.usage('proof is required: the X-Attested-Proof header value.');
    const chainId = a.chainId;
    if (typeof chainId !== 'number' || !Number.isInteger(chainId) || chainId <= 0) throw ERR.usage('chainId must be a positive integer, like 11142220.');
    const given = str(a, 'registry');
    if (given !== undefined && !ADDRESS.test(given)) throw ERR.usage('registry must be an address.');
    const registry = given?.toLowerCase() ?? registryFor(chainId);
    if (!registry) throw new CliError('no_registry', `No EnclaveRegistry is pinned for chain ${chainId}.`, 'Pass the registry address you expect as `registry`.');
    const requestId = str(a, 'requestId')?.toLowerCase();
    if (requestId !== undefined && !REQUEST_ID.test(requestId)) throw ERR.usage('requestId must be 0x followed by 64 hex characters.');
    const requestHash = str(a, 'requestHash')?.toLowerCase();
    if (requestHash !== undefined && !REQUEST_ID.test(requestHash)) throw ERR.usage('requestHash must be 0x followed by 64 hex characters.');
    let request: { method: string; pathAndQuery: string; body: string } | undefined;
    if (a.request !== undefined) {
      const q = a.request as Record<string, unknown>;
      if (typeof q !== 'object' || q === null || typeof q.method !== 'string' || typeof q.pathAndQuery !== 'string' || typeof q.body !== 'string' || !q.pathAndQuery.startsWith('/'))
        throw ERR.usage('request needs a method, a pathAndQuery that starts with /, and a body (all text).');
      request = { method: q.method, pathAndQuery: q.pathAndQuery, body: q.body };
    }
    const res = await verifyProof({ proof, chainId, registry, response: str(a, 'response'), requestId, requestHash, request }, registry);
    if (res.ok) return text(hide, res);
    const words = CHECK_WORDS[res.check!]?.[0] ?? res.check;
    return text(hide, { ...res, error: 'proof_rejected', message: `The proof failed a check: ${safe(words ?? 'unnamed')}.`, next: "Don't use this answer. If you paid for it, run `get_result` with its request id to see what was charged." }, true);
  }

  async function call(name: string, a: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'resolve_endpoint':
      case 'check_liveness': {
        const r = await cli(['status', requireUrl(a)], false);
        if (r.json.ok !== true) return text(hide, r.json, true);
        const { lines, ...rest } = r.json;
        const view = name === 'resolve_endpoint' ? { ok: true, origin: rest.origin, agentId: rest.agentId, endpoint: rest.endpoint } : { ok: true, origin: rest.origin, liveness: rest.liveness };
        return text(hide, { ...view, lines });
      }
      case 'quote': {
        const r = await cli(['call', requireUrl(a), '--body', bodyText(a), ...boundedMaxAmount(a), '--dry-run'], true);
        return text(hide, r.json, r.json.ok !== true);
      }
      case 'pay_and_verify': {
        const argv = ['call', requireUrl(a), '--body', bodyText(a), ...boundedMaxAmount(a), '--out', 'answer.json'];
        if (a.newRequest === true) argv.push('--new');
        if (a.noWait === true) argv.push('--no-wait');
        const r = await cli(argv, true);
        keep(r.answers, r.json.requestId);
        const response = r.answers.get('answer.json');
        return text(hide, { ...r.json, ...(response !== undefined ? { response } : {}) }, r.json.ok !== true);
      }
      case 'verify_proof':
        try {
          return await verifyProofTool(a);
        } catch (e) {
          // Refused before any check ran: still say that none of them did.
          if (e instanceof CliError) return text(hide, { ok: false, error: e.code, message: e.message, next: e.next, scope: 'offline', notChecked: allSkipped() }, true);
          throw e;
        }
      case 'get_result': {
        const id = requireId(a);
        const dir = buyerDataDir(opts.deps as Deps);
        const ledger = existsSync(join(dir, 'pending.jsonl')) ? new Ledger(dir) : null;
        const entry = ledger?.get(id as `0x${string}`);
        if (!ledger || !entry) throw BUYERR.unknownRequest(id);
        if (TERMINAL_STATES.includes(entry.state)) {
          if (entry.state !== 'verified') {
            // Decided against the buyer or not charged: the CLI's own report of a stored outcome (never re-fetches, never signs
            // a payment), so the FLOWS §6/§8 words and next action are its. It loads the wallet, as `attessa cancel` does.
            const r = await cli(['cancel', id], true);
            const lines = Array.isArray(r.json.lines) ? (r.json.lines as string[]).filter((l) => l.trim() !== '') : [];
            if (r.json.ok === true || r.json.error !== undefined || lines.length === 0) return text(hide, r.json, r.json.ok !== true);
            const warning = entry.state === 'not_charged' ? null : lines[0]!;
            return text(
              hide,
              {
                ...r.json,
                requestId: id,
                state: entry.state,
                ...(warning ? { error: entry.state, message: warning, next: lines.length > 1 ? lines.at(-1)!.trim() : 'Run `status` to see your spending and open calls.' } : {}),
              },
              warning !== null,
            );
          }
          const evidence = ledger.readEvidence().filter((e) => e.requestId === id).at(-1);
          const answer = join(dir, `${id}.json`);
          return text(hide, {
            ok: true,
            requestId: id,
            state: entry.state,
            ...(entry.code ? { code: entry.code } : {}),
            amount: entry.amount,
            asset: entry.asset,
            ...(entry.settlementTx ? { settlementTx: entry.settlementTx } : {}),
            ...(evidence ? { outcome: evidence.outcome } : {}),
            ...(existsSync(answer) ? { response: readFileSync(answer, 'utf8') } : {}),
          });
        }
        const r = await cli(['status', '--pending'], true);
        if (r.json.ok !== true && !Array.isArray(r.json.pending)) return text(hide, r.json, true);
        const row = (r.json.pending as Array<Record<string, unknown>>).find((p) => p.requestId === id);
        keep(r.answers);
        const response = r.answers.get(`${id}.json`);
        return text(hide, { ok: row?.outcome === 'verified', requestId: id, ...(row ?? { state: entry.state }), ...(response !== undefined ? { response } : {}), lines: r.json.lines });
      }
      case 'list_pending': {
        const dir = buyerDataDir(opts.deps as Deps);
        const open = existsSync(join(dir, 'pending.jsonl')) ? new Ledger(dir).list().filter((e) => !TERMINAL_STATES.includes(e.state)) : [];
        return text(hide, {
          ok: true,
          pending: open.map((e) => ({ requestId: e.requestId, origin: e.origin, amount: e.amount, asset: e.asset, state: e.state, validBefore: e.validBefore, payTo: e.payTo })),
          ...(open.length === 0 ? { lines: [BUY.noPending] } : {}),
        });
      }
      case 'cancel_authorization': {
        const r = await cli(['cancel', requireId(a)], true);
        return text(hide, r.json, r.json.ok !== true);
      }
      case 'status': {
        const r = await cli(['status'], true);
        return text(hide, r.json, r.json.ok !== true);
      }
    }
    // Never the requested name, in any spelling: the caller already knows what it asked for.
    throw new CliError('unknown_tool', 'There is no tool with that name.', 'List the tools with tools/list.'); // not in FLOWS
  }

  return server;
}
