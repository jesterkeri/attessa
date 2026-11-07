import { parseAbi } from 'viem';

/** SPEC §3.1 functions and errors the CLI calls, plus the NitroValidator/CertManager reads of the hinted flow. */
export const REGISTRY_ABI = parseAbi([
  'function approveRelease(uint256 agentId, bytes pcr0, bytes pcr1, bytes pcr2, string sourceRef) returns (bytes32)',
  'function addEndpoint(uint256 agentId, string origin, address payTo, address operator) returns (bytes32)',
  'function registerSigner(uint256 agentId, bytes32 originHash, bytes attestation, bytes attestationSigHints) returns (address)',
  'function setReleaseStatus(uint256 agentId, bytes32 releaseId, uint8 to)',
  'function retireEndpoint(bytes32 originHash)',
  'function revokeSigner(address signer)',
  'function linkSelfAgent(uint256 agentId, uint256 selfAgentId)',
  'function renewSigner(address signer, bytes attestation, bytes attestationSigHints)',
  'function releases(uint256 agentId, bytes32 releaseId) view returns ((uint8 status, uint64 approvedAt, uint64 statusChangedAt))',
  'function endpoints(bytes32 originHash) view returns ((uint256 agentId, address payTo, address operator, uint8 status, uint64 updatedAt))',
  'function signers(address signer) view returns ((uint256 agentId, bytes32 releaseId, bytes32 originHash, address operator, uint64 registeredAt, uint64 expiresAt, uint8 status, bytes32 attestationHash))',
  'function identityRegistry() view returns (address)',
  'function nitroValidator() view returns (address)',
  'function allowLocalOrigins() view returns (bool)',
  'error NotOwner()',
  'error SelfDisabled()',
  'error SelfLinkInvalid()',
  'error InvalidPcr()',
  'error InvalidSourceRef()',
  'error ReleaseExists()',
  'error InvalidTransition()',
  'error InvalidOrigin()',
  'error ZeroAddress()',
  'error OriginTaken()',
  'error EndpointNotActive()',
  'error SignerNotActive()',
  'error EndpointInactive()',
  'error EndpointMismatch()',
  'error NotOperator()',
  'error AttestationFromFuture()',
  'error AttestationStale()',
  'error DebugPcrs()',
  'error ReleaseNotApproved()',
  'error BindingMismatch(uint8 field)',
  'error InvalidPublicKey()',
  'error SignerExists()',
  'error SignerMismatch()',
  'error ReleaseMismatch()',
  'error Error(string)',
]);

/** SPEC §3.3 events the CLI reads (`status --agent`, `revoke release`, `revoke signer`). */
export const REGISTRY_EVENTS = parseAbi([
  'event ReleaseApproved(uint256 indexed agentId, bytes32 indexed releaseId, bytes pcr0, bytes pcr1, bytes pcr2, string sourceRef)',
  'event EndpointAdded(bytes32 indexed originHash, uint256 indexed agentId, string origin, address payTo, address operator)',
  'event SignerRegistered(address indexed signer, uint256 indexed agentId, bytes32 indexed releaseId, bytes32 originHash, address operator, uint64 expiresAt, bytes32 attestationHash, uint64 attestationTimestamp)',
]);

/** ERC-8004 IdentityRegistry (an ERC-721 with EIP-712 `setAgentWallet`, EIP-5267 domain). */
export const IDENTITY_ABI = parseAbi([
  'function ownerOf(uint256 agentId) view returns (address)',
  'function register(string agentURI) returns (uint256 agentId)',
  'function transferFrom(address from, address to, uint256 tokenId)',
  'function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);

/** SPEC §8 `agent wallet-sig`: the struct the reference IdentityRegistry hashes. */
export const AGENT_WALLET_SET_TYPES = {
  AgentWalletSet: [
    { name: 'agentId', type: 'uint256' },
    { name: 'newWallet', type: 'address' },
    { name: 'owner', type: 'address' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export const VALIDATOR_ABI = parseAbi(['function certManager() view returns (address)']);

export const CERT_MANAGER_ABI = parseAbi([
  'function loadVerified(bytes32 certHash) view returns ((bool ca, uint64 notAfter, int64 maxPathLen, bytes32 subjectHash, bytes pubKey))',
  'function verifyCACertWithHints(bytes cert, bytes32 parentCertHash, bytes signatureHints) returns (bytes32)',
  'function verifyClientCertWithHints(bytes cert, bytes32 parentCertHash, bytes signatureHints) returns ((bool ca, uint64 notAfter, int64 maxPathLen, bytes32 subjectHash, bytes pubKey))',
  'error Error(string)',
]);

/** IEnclaveRegistry enums (SPEC §3.1). */
export const RELEASE_STATUS = ['None', 'Approved', 'Deprecated', 'Revoked'] as const;
export const ENDPOINT_STATUS = ['None', 'Active', 'Retired'] as const;
export const SIGNER_STATUS = ['None', 'Active', 'Revoked'] as const;

/** BindingMismatch(field) (SPEC §3.4 step 6). */
export const BINDING_FIELDS = ['length', 'typehash', 'chain', 'registry', 'agent', 'origin'] as const;
