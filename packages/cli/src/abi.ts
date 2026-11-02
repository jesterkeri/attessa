import { parseAbi } from 'viem';

/** SPEC §3.1 functions and errors the CLI calls, plus the NitroValidator/CertManager reads of the hinted flow. */
export const REGISTRY_ABI = parseAbi([
  'function approveRelease(uint256 agentId, bytes pcr0, bytes pcr1, bytes pcr2, string sourceRef) returns (bytes32)',
  'function addEndpoint(uint256 agentId, string origin, address payTo, address operator) returns (bytes32)',
  'function registerSigner(uint256 agentId, bytes32 originHash, bytes attestation, bytes attestationSigHints) returns (address)',
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

export const IDENTITY_ABI = parseAbi(['function ownerOf(uint256 agentId) view returns (address)']);

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
