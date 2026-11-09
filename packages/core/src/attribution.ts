import { concat, hexToString, isHex, numberToHex, size, slice, stringToHex, type Hex } from 'viem';

/**
 * ERC-8021 transaction attribution, Schema 0 (a flat code list), for the Loops / Celo attribution programme.
 *
 * Sources, quoted from the primary ones (the Loops page https://loops.house/agents-on-open-rails says only "a short
 * ERC-8021 code your app appends to the calldata of every transaction it sends" and points to
 * https://github.com/celo-org/attribution-tags):
 *   - celo-org/attribution-tags INDEXERS.md, "What you're parsing":
 *       Schema 0 (apps): [...your normal calldata...] [code:N] [length:1] [schema:1] [marker:16]
 *                                                              0x00     0x80218021…×8
 *     "The marker is 0x80218021 repeated 8 times (16 bytes total, 32 hex chars)."; the code field is ASCII, its
 *     length byte is 1 to 255.
 *   - celo-org/attribution-tags BUILDERS.md: "Any string matching [a-z0-9_] (1–32 chars) is a valid code on the
 *     wire." The EVM discards the trailing bytes, so execution is unchanged.
 * Not an x402 tag: x402 payment authorizations are signed messages, not transactions, and carry no suffix.
 */
export const ERC8021_MARKER: Hex = `0x${'80218021'.repeat(4)}`;

const CODE = /^[a-z0-9_]{1,32}$/;

/** `[code ASCII][length 1 byte][0x00][marker]`. Throws on a code outside `[a-z0-9_]{1,32}`. */
export function attributionSuffix(code: string): Hex {
  if (!CODE.test(code)) throw new Error('attribution code must be 1 to 32 characters of a-z, 0-9 or _');
  return concat([stringToHex(code), numberToHex(code.length, { size: 1 }), '0x00', ERC8021_MARKER]);
}

/** `data` with the attribution suffix appended; `data` itself when there is no suffix (not mainnet). */
export function withAttribution(data: Hex, suffix: Hex | null | undefined): Hex {
  return suffix ? concat([data, suffix]) : data;
}

/** The chain whose transactions must carry the suffix: Celo mainnet. Policy follows the verified chain id, never a CLI label. */
export const ATTRIBUTION_CHAIN_ID = 42220;

/**
 * True only for a well-formed ERC-8021 Schema 0 suffix: `[code ASCII][length][0x00][marker]` with the code in
 * `[a-z0-9_]{1,32}`, the length byte equal to the code's length, schema byte 0 and the exact total size. Decodes the
 * code and requires `attributionSuffix(code)` to reproduce the input (hex case ignored), so it cannot drift from the writer.
 */
export function isAttributionSuffix(suffix: string | null | undefined): suffix is Hex {
  if (!suffix || !isHex(suffix, { strict: true })) return false;
  const total = size(suffix);
  const markerLen = size(ERC8021_MARKER);
  // code (1..32) + length byte + schema byte + marker
  if (total < 1 + 2 + markerLen || total > 32 + 2 + markerLen) return false;
  const codeLen = total - 2 - markerLen;
  let code: string;
  try {
    code = hexToString(slice(suffix, 0, codeLen));
  } catch {
    return false;
  }
  if (!CODE.test(code) || size(stringToHex(code)) !== codeLen) return false; // rejects non-ASCII and uppercase codes
  return attributionSuffix(code).toLowerCase() === suffix.toLowerCase();
}
