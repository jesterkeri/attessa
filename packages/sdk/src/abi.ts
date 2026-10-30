import { parseAbi } from 'viem';

/** The EnclaveRegistry functions and events the SDK reads (SPEC §3.1, §3.3). Enums are uint8 in the ABI. */
export const registryAbi = parseAbi([
  'struct Release { uint8 status; uint64 approvedAt; uint64 statusChangedAt; }',
  'struct Endpoint { uint256 agentId; address payTo; address operator; uint8 status; uint64 updatedAt; }',
  'struct Signer { uint256 agentId; bytes32 releaseId; bytes32 originHash; address operator; uint64 registeredAt; uint64 expiresAt; uint8 status; bytes32 attestationHash; }',
  'function releases(uint256 agentId, bytes32 releaseId) view returns (Release)',
  'function endpoints(bytes32 originHash) view returns (Endpoint)',
  'function signers(address signer) view returns (Signer)',
  'function selfLinks(uint256 agentId) view returns (uint256)',
  'function checkSigner(address signer, bytes32 originHash) view returns (uint8 code, Signer s, Endpoint e)',
  'function identityRegistry() view returns (address)',
  'function selfRegistry() view returns (address)',
  'event ReleaseApproved(uint256 indexed agentId, bytes32 indexed releaseId, bytes pcr0, bytes pcr1, bytes pcr2, string sourceRef)',
  'event ReleaseStatusChanged(uint256 indexed agentId, bytes32 indexed releaseId, uint8 from, uint8 to)',
  'event EndpointAdded(bytes32 indexed originHash, uint256 indexed agentId, string origin, address payTo, address operator)',
  'event EndpointRetired(bytes32 indexed originHash, uint256 indexed agentId)',
  'event SignerRegistered(address indexed signer, uint256 indexed agentId, bytes32 indexed releaseId, bytes32 originHash, address operator, uint64 expiresAt, bytes32 attestationHash, uint64 attestationTimestamp)',
  'event SignerRevoked(address indexed signer, uint256 indexed agentId)',
  'event SignerRenewed(address indexed signer, uint256 indexed agentId, uint64 expiresAt, bytes32 attestationHash, uint64 attestationTimestamp)',
]);

/** EIP-3009 surface of the pinned assets (USDC FiatToken v2, USA₮). */
export const tokenAbi = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
  'function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)',
  'event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/** ERC-8004 Identity Registry and Self Agent Registry reads for the Self link (SPEC §3.4 linkSelfAgent). */
export const identityAbi = parseAbi(['function ownerOf(uint256 agentId) view returns (address)']);
export const selfAbi = parseAbi([
  'function ownerOf(uint256 selfAgentId) view returns (address)',
  'function hasHumanProof(uint256 selfAgentId) view returns (bool)',
  'function isProofFresh(uint256 selfAgentId) view returns (bool)',
]);

/** EIP-3009 typed data. */
export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
  CancelAuthorization: [
    { name: 'authorizer', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/** `Check` enum order (SPEC §3.1). */
export const CHECK = [
  'OK',
  'UNKNOWN_SIGNER',
  'SIGNER_REVOKED',
  'SIGNER_EXPIRED',
  'RELEASE_NOT_APPROVED',
  'ENDPOINT_INACTIVE',
  'ENDPOINT_MISMATCH',
  'AGENT_MISMATCH',
  'OPERATOR_MISMATCH',
  'BAD_SIGNATURE',
  'PROOF_EXPIRED',
  'PROOF_CLOCK_SKEW',
] as const;
export type CheckName = (typeof CHECK)[number];

export const ENDPOINT_STATUS = { None: 0, Active: 1, Retired: 2 } as const;
export const SIGNER_STATUS = { None: 0, Active: 1, Revoked: 2 } as const;
export const RELEASE_STATUS = { None: 0, Approved: 1, Deprecated: 2, Revoked: 3 } as const;
