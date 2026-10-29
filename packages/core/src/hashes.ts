import { concat, encodeAbiParameters, keccak256, size, stringToBytes, type Address, type Hex } from 'viem';
import { jcs } from './jcs.ts';

/** SPEC §2.2: `keccak256(utf8(METHOD) ‖ 0x00 ‖ utf8(pathAndQuery) ‖ 0x00 ‖ bodyBytes)`. */
export function requestHash(method: string, pathAndQuery: string, body: Uint8Array): Hex {
  if (!pathAndQuery.startsWith('/')) throw new Error('requestHash: pathAndQuery must start with /');
  return keccak256(
    concat([
      stringToBytes(method.toUpperCase()),
      new Uint8Array([0]),
      stringToBytes(pathAndQuery),
      new Uint8Array([0]),
      body,
    ]),
  );
}

/** SPEC §2.2: `keccak256(responseBodyBytes)`, the exact bytes sent. */
export function responseHash(body: Uint8Array): Hex {
  return keccak256(body);
}

/** SPEC §2.2: `keccak256(JCS(inputs))` (RFC 8785). */
export function inputsHash(inputs: unknown): Hex {
  return keccak256(stringToBytes(jcs(inputs)));
}

/** SPEC §2.2: `keccak256(pcr0 ‖ pcr1 ‖ pcr2)`, each PCR as its raw 48 bytes. */
export function releaseId(pcr0: Hex, pcr1: Hex, pcr2: Hex): Hex {
  for (const pcr of [pcr0, pcr1, pcr2]) {
    if (size(pcr) !== 48) throw new Error('releaseId: each PCR must be 48 bytes');
  }
  return keccak256(concat([pcr0, pcr1, pcr2]));
}

/** SPEC §2.2: gateway-derived `requestId = keccak256(asset ‖ payer ‖ nonce)`, each 32-byte left-padded. */
export function derivedRequestId(asset: Address, payer: Address, nonce: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [asset, payer, nonce]),
  );
}
