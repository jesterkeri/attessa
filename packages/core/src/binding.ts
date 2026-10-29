import { encodeAbiParameters, keccak256, size, slice, stringToBytes, type Address, type Hex } from 'viem';

/** SPEC §2.4: `keccak256("AttestedExecution.SignerBinding.v1")`. */
export const BINDING_TYPEHASH: Hex = keccak256(stringToBytes('AttestedExecution.SignerBinding.v1'));

export interface Binding {
  chainId: bigint;
  registry: Address;
  agentId: bigint;
  originHash: Hex;
}

/** SPEC §2.4: `user_data = abi.encode(BINDING_TYPEHASH, chainId, registry, agentId, originHash)`, 160 bytes. */
export function encodeUserData(b: Binding): Hex {
  return encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
    [BINDING_TYPEHASH, b.chainId, b.registry, b.agentId, b.originHash],
  );
}

/** SPEC §2.4: signer = `address(uint160(uint256(keccak256(X ‖ Y))))` of the 65-byte `0x04 ‖ X ‖ Y` key, lowercase. */
export function signerFromPublicKey(publicKey: Hex): Address {
  if (size(publicKey) !== 65 || slice(publicKey, 0, 1) !== '0x04') {
    throw new Error('signerFromPublicKey: expected a 65-byte uncompressed key starting 0x04');
  }
  return slice(keccak256(slice(publicKey, 1)), 12).toLowerCase() as Address;
}
