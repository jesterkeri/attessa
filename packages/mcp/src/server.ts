import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
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
 * The secrets this server holds are exactly what it consumes, plus what the operator declares:
 *   - ATTESSA_PRIVATE_KEY and ATTESSA_KEYSTORE_PASSWORD (the wallet; the key only ever goes to the signer),
 *   - the userinfo, path segments, query values and fragment of ATTESSA_RPC (results show an RPC as scheme://host[:port] only),
 *   - every variable named in ATTESSA_REDACT (comma-separated names), for anything the operator knows could reach a result.
 * The server reads no other secret, so no other variable is its to hide, require or refuse, whatever its name.
 */
const CONSUMED = ['ATTESSA_PRIVATE_KEY', 'ATTESSA_KEYSTORE_PASSWORD'];

function declared(env: Record<string, string | undefined>): Array<[string, string]> {
  const names = [...CONSUMED, ...(env.ATTESSA_REDACT ?? '').split(',').map((n) => n.trim()).filter((n) => n !== '')];
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

/** A pattern for `b` as it appears raw, JSON-escaped, or URL-encoded in any mix of upper and lower case hex, with `+` for a space, and reserved characters left literal (encodeURI). */
function secretPattern(b: string): RegExp {
  const pct = [...b]
    .map((ch) => {
      if (UNRESERVED.test(ch)) return escRe(ch);
      const enc = [...Buffer.from(ch, 'utf8')].map((by) => `%${by.toString(16).toUpperCase().padStart(2, '0').replace(/[A-F]/g, (c) => `[${c}${c.toLowerCase()}]`)}`).join('');
      return `(?:${[enc, ...(ch === ' ' ? ['\\+'] : []), ...(URI_LITERAL.includes(ch) ? [escRe(ch)] : [])].join('|')})`;
    })
    .join('');
  return new RegExp(`${pct}|${escRe(JSON.stringify(b).slice(1, -1))}|${escRe(b)}`, 'g');
}

/** Text with the secrets (raw, JSON-escaped, URL-encoded) and URL userinfo removed: the first, cheap layer. */
export function scrub(text: string, env: Record<string, string | undefined>): string {
  let t = text;
  for (const b of secretBases(env)) t = t.replace(secretPattern(b), '[hidden]');
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

/** Every reading of `s` after undoing up to four levels of escaping, with `+` also read as a space. */
function readings(s: string): string[] {
  const out = [s];
  let cur = s;
  for (let i = 0; i < 4; i++) {
    const next = unescapeOnce(cur);
    if (next === cur) break;
    out.push(next);
    cur = next;
  }
  return [...out, ...out.map((x) => x.replace(/\+/g, ' '))];
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

/**
 * The final layer, after every rendering: the serialised text has the secrets removed, and the result is sent only if it
 * still parses, has the same keys, numbers and booleans, has unchanged amounts and hashes, and no string in it, with its
 * escaping undone (\xNN, \uNNNN, %XX, …), still holds a secret. Otherwise a fixed result without any of it is sent instead.
 */
function render(env: Record<string, string | undefined>, v: unknown): { text: string; withheld: boolean } {
  const original = jsonOut(v);
  const bases = secretBases(env);
  const redacted = scrub(original, env);
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
  if (!everyString(parsed, (s) => !readings(s).some((r) => bases.some((b) => r.includes(b))))) return fail;
  return { text: redacted, withheld: false };
}

const text = (env: Record<string, string | undefined>, v: unknown, isError = false): ToolResult => {
  const r = render(env, v);
  return { content: [{ type: 'text', text: r.text }], ...(isError || r.withheld ? { isError: true } : {}) };
};

const failure = (env: Record<string, string | undefined>, e: CliError): ToolResult => text(env, { ok: false, error: e.code, message: e.message, next: e.next }, true);

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
      if (bad !== undefined) return failure(env, unsafeSecretError(bad));
      return await call(name, args);
    } catch (e) {
      if (e instanceof CliError) return failure(env, e);
      // Never an error's own text: a parser or an RPC library may quote a key or a credentialed URL.
      return failure(env, new CliError('unexpected', `${name} failed unexpectedly. Nothing was signed unless a result above says so.`, 'Run `status` to see your open calls, then retry.'));
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
    if (wallet && keystore) full.push('--keystore', keystore);
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
        `maxAmount ${asked} is above the per-call limit of ${saved} that was set for this wallet. Nothing was signed.`,
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
    if (res.ok) return text(env, res);
    const words = CHECK_WORDS[res.check!]?.[0] ?? res.check;
    return text(env, { ...res, error: 'proof_rejected', message: `The proof failed a check: ${safe(words ?? 'unnamed')}.`, next: "Don't use this answer. If you paid for it, run `get_result` with its request id to see what was charged." }, true);
  }

  async function call(name: string, a: Record<string, unknown>): Promise<ToolResult> {
    switch (name) {
      case 'resolve_endpoint':
      case 'check_liveness': {
        const r = await cli(['status', requireUrl(a)], false);
        if (r.json.ok !== true) return text(env, r.json, true);
        const { lines, ...rest } = r.json;
        const view = name === 'resolve_endpoint' ? { ok: true, origin: rest.origin, agentId: rest.agentId, endpoint: rest.endpoint } : { ok: true, origin: rest.origin, liveness: rest.liveness };
        return text(env, { ...view, lines });
      }
      case 'quote': {
        const r = await cli(['call', requireUrl(a), '--body', bodyText(a), ...boundedMaxAmount(a), '--dry-run'], true);
        return text(env, r.json, r.json.ok !== true);
      }
      case 'pay_and_verify': {
        const argv = ['call', requireUrl(a), '--body', bodyText(a), ...boundedMaxAmount(a), '--out', 'answer.json'];
        if (a.newRequest === true) argv.push('--new');
        if (a.noWait === true) argv.push('--no-wait');
        const r = await cli(argv, true);
        keep(r.answers, r.json.requestId);
        const response = r.answers.get('answer.json');
        return text(env, { ...r.json, ...(response !== undefined ? { response } : {}) }, r.json.ok !== true);
      }
      case 'verify_proof':
        try {
          return await verifyProofTool(a);
        } catch (e) {
          // Refused before any check ran: still say that none of them did.
          if (e instanceof CliError) return text(env, { ok: false, error: e.code, message: e.message, next: e.next, scope: 'offline', notChecked: allSkipped() }, true);
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
            if (r.json.ok === true || r.json.error !== undefined || lines.length === 0) return text(env, r.json, r.json.ok !== true);
            const warning = entry.state === 'not_charged' ? null : lines[0]!;
            return text(
              env,
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
          return text(env, {
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
        if (r.json.ok !== true && !Array.isArray(r.json.pending)) return text(env, r.json, true);
        const row = (r.json.pending as Array<Record<string, unknown>>).find((p) => p.requestId === id);
        keep(r.answers);
        const response = r.answers.get(`${id}.json`);
        return text(env, { ok: row?.outcome === 'verified', requestId: id, ...(row ?? { state: entry.state }), ...(response !== undefined ? { response } : {}), lines: r.json.lines });
      }
      case 'list_pending': {
        const dir = buyerDataDir(opts.deps as Deps);
        const open = existsSync(join(dir, 'pending.jsonl')) ? new Ledger(dir).list().filter((e) => !TERMINAL_STATES.includes(e.state)) : [];
        return text(env, {
          ok: true,
          pending: open.map((e) => ({ requestId: e.requestId, origin: e.origin, amount: e.amount, asset: e.asset, state: e.state, validBefore: e.validBefore, payTo: e.payTo })),
          ...(open.length === 0 ? { lines: [BUY.noPending] } : {}),
        });
      }
      case 'cancel_authorization': {
        const r = await cli(['cancel', requireId(a)], true);
        return text(env, r.json, r.json.ok !== true);
      }
      case 'status': {
        const r = await cli(['status'], true);
        return text(env, r.json, r.json.ok !== true);
      }
    }
    throw new CliError('unknown_tool', `There is no tool called ${safe(name)}.`, 'List the tools with tools/list.');
  }

  return server;
}
