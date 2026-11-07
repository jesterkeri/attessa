// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NitroValidator} from "nitro-validator/NitroValidator.sol";
import {CborDecode, CborElement, LibCborElement} from "nitro-validator/CborDecode.sol";
import {LibBytes} from "nitro-validator/LibBytes.sol";

/// ERC-8004 Identity Registry (ERC-721).
interface IIdentityRegistry {
    function ownerOf(uint256 agentId) external view returns (address);
}

/// Self Agent Registry, `linked` mode (ADR-014).
interface ISelfAgentRegistry {
    function ownerOf(uint256 selfAgentId) external view returns (address);
    function hasHumanProof(uint256 selfAgentId) external view returns (bool);
    function isProofFresh(uint256 selfAgentId) external view returns (bool);
}

/// SPEC §3.1.
interface IEnclaveRegistry {
    enum ReleaseStatus {
        None,
        Approved,
        Deprecated,
        Revoked
    }
    enum EndpointStatus {
        None,
        Active,
        Retired
    }
    enum SignerStatus {
        None,
        Active,
        Revoked
    }
    enum Check {
        OK,
        UNKNOWN_SIGNER,
        SIGNER_REVOKED,
        SIGNER_EXPIRED,
        RELEASE_NOT_APPROVED,
        ENDPOINT_INACTIVE,
        ENDPOINT_MISMATCH,
        AGENT_MISMATCH,
        OPERATOR_MISMATCH,
        BAD_SIGNATURE,
        PROOF_EXPIRED,
        PROOF_CLOCK_SKEW
    }

    struct Release {
        ReleaseStatus status;
        uint64 approvedAt;
        uint64 statusChangedAt;
    }

    struct Endpoint {
        uint256 agentId;
        address payTo;
        address operator;
        EndpointStatus status;
        uint64 updatedAt;
    }

    struct Signer {
        uint256 agentId;
        bytes32 releaseId;
        bytes32 originHash;
        address operator;
        uint64 registeredAt;
        uint64 expiresAt;
        SignerStatus status;
        bytes32 attestationHash;
    }

    struct ExecutionProof {
        uint256 agentId;
        bytes32 releaseId;
        bytes32 requestId;
        bytes32 requestHash;
        bytes32 responseHash;
        bytes32 inputsHash;
        bytes32 paymentId;
        uint64 issuedAt;
        uint64 expiresAt;
    }

    event SelfAgentLinked(uint256 indexed agentId, uint256 indexed selfAgentId, address owner);
    event ReleaseApproved(
        uint256 indexed agentId, bytes32 indexed releaseId, bytes pcr0, bytes pcr1, bytes pcr2, string sourceRef
    );
    event ReleaseStatusChanged(
        uint256 indexed agentId, bytes32 indexed releaseId, ReleaseStatus from, ReleaseStatus to
    );
    event EndpointAdded(
        bytes32 indexed originHash, uint256 indexed agentId, string origin, address payTo, address operator
    );
    event EndpointRetired(bytes32 indexed originHash, uint256 indexed agentId);
    event SignerRegistered(
        address indexed signer,
        uint256 indexed agentId,
        bytes32 indexed releaseId,
        bytes32 originHash,
        address operator,
        uint64 expiresAt,
        bytes32 attestationHash,
        uint64 attestationTimestamp
    );
    event SignerRevoked(address indexed signer, uint256 indexed agentId);
    event SignerRenewed(
        address indexed signer,
        uint256 indexed agentId,
        uint64 expiresAt,
        bytes32 attestationHash,
        uint64 attestationTimestamp
    );

    function linkSelfAgent(uint256 agentId, uint256 selfAgentId) external;
    function approveRelease(
        uint256 agentId,
        bytes calldata pcr0,
        bytes calldata pcr1,
        bytes calldata pcr2,
        string calldata sourceRef
    ) external returns (bytes32 releaseId);
    function setReleaseStatus(uint256 agentId, bytes32 releaseId, ReleaseStatus to) external;
    function addEndpoint(uint256 agentId, string calldata origin, address payTo, address operator)
        external
        returns (bytes32 originHash);
    function retireEndpoint(bytes32 originHash) external;
    function revokeSigner(address signer) external;
    function registerSigner(
        uint256 agentId,
        bytes32 originHash,
        bytes calldata attestation,
        bytes calldata attestationSigHints
    ) external returns (address signer);
    function renewSigner(address signer, bytes calldata attestation, bytes calldata attestationSigHints) external;

    function releases(uint256 agentId, bytes32 releaseId) external view returns (Release memory);
    function endpoints(bytes32 originHash) external view returns (Endpoint memory);
    function signers(address signer) external view returns (Signer memory);
    function selfLinks(uint256 agentId) external view returns (uint256);
    function checkSigner(address signer, bytes32 originHash)
        external
        view
        returns (Check code, Signer memory s, Endpoint memory e);
    function verifyProof(ExecutionProof calldata p, bytes calldata signature, bytes32 originHash)
        external
        view
        returns (Check code);
    function proofDigest(ExecutionProof calldata p) external view returns (bytes32);
    function livenessDigest(uint256 agentId, bytes32 releaseId, bytes32 originHash, bytes32 challenge, uint64 issuedAt)
        external
        view
        returns (bytes32);

    function identityRegistry() external view returns (address);
    function selfRegistry() external view returns (address);
    function nitroValidator() external view returns (address);
    function allowLocalOrigins() external view returns (bool);
}

/// @title EnclaveRegistry
/// @notice SPEC §3 r5. Immutable, no global admin (ADR-002). Authority comes only from
///         `ownerOf(agentId)` on the ERC-8004 Identity Registry and from an endpoint's operator.
contract EnclaveRegistry is IEnclaveRegistry {
    using CborDecode for bytes;
    using LibCborElement for CborElement;
    using LibBytes for bytes;

    error NotOwner();
    error SelfDisabled();
    error SelfLinkInvalid();
    error InvalidPcr();
    error InvalidSourceRef();
    error ReleaseExists();
    error InvalidTransition();
    error InvalidOrigin();
    error ZeroAddress();
    error OriginTaken();
    error EndpointNotActive();
    error SignerNotActive();
    error EndpointInactive();
    error EndpointMismatch();
    error NotOperator();
    error AttestationFromFuture();
    error AttestationStale();
    error DebugPcrs();
    error ReleaseNotApproved();
    error BindingMismatch(uint8 field);
    error InvalidPublicKey();
    error SignerExists();
    error SignerMismatch();
    error ReleaseMismatch();

    uint64 public constant SIGNER_TTL = 604800;
    uint64 public constant MAX_ATTESTATION_AGE = 1800;
    uint64 public constant MAX_FUTURE_SKEW = 60;
    uint64 public constant MAX_PROOF_SKEW = 120;

    bytes32 public constant BINDING_TYPEHASH = keccak256("AttestedExecution.SignerBinding.v1");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("AttestedExecution");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant EXECUTION_PROOF_TYPEHASH = keccak256(
        "ExecutionProof(uint256 agentId,bytes32 releaseId,bytes32 requestId,bytes32 requestHash,bytes32 responseHash,bytes32 inputsHash,bytes32 paymentId,uint64 issuedAt,uint64 expiresAt)"
    );
    bytes32 private constant LIVENESS_TYPEHASH =
        keccak256("Liveness(uint256 agentId,bytes32 releaseId,bytes32 originHash,bytes32 challenge,uint64 issuedAt)");
    /// secp256k1n / 2: signatures with a larger s are rejected (no malleability).
    uint256 private constant HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    uint256 private constant PCR_LENGTH = 48;
    uint256 private constant USER_DATA_LENGTH = 160;
    uint256 private constant PUBLIC_KEY_LENGTH = 65;

    address public immutable identityRegistry;
    address public immutable nitroValidator;
    address public immutable selfRegistry;
    bool public immutable allowLocalOrigins;

    mapping(uint256 => mapping(bytes32 => Release)) private _releases;
    mapping(bytes32 => Endpoint) private _endpoints;
    mapping(address => Signer) private _signers;
    mapping(uint256 => uint256) private _selfLinks;

    /// What a validated attestation proved (SPEC §3.4 registerSigner steps 2-7).
    struct Attested {
        address signer;
        bytes32 releaseId;
        bytes32 attestationHash;
        uint64 ts;
    }

    constructor(address identityRegistry_, address nitroValidator_, address selfRegistry_, bool allowLocalOrigins_) {
        identityRegistry = identityRegistry_;
        nitroValidator = nitroValidator_;
        selfRegistry = selfRegistry_;
        allowLocalOrigins = allowLocalOrigins_;
    }

    // ---------------------------------------------------------------- owner

    function linkSelfAgent(uint256 agentId, uint256 selfAgentId) external {
        _requireOwner(agentId);
        if (selfRegistry == address(0)) revert SelfDisabled();
        ISelfAgentRegistry self = ISelfAgentRegistry(selfRegistry);
        try self.ownerOf(selfAgentId) returns (address selfOwner) {
            if (selfOwner != msg.sender) revert SelfLinkInvalid();
        } catch {
            revert SelfLinkInvalid();
        }
        try self.hasHumanProof(selfAgentId) returns (bool ok) {
            if (!ok) revert SelfLinkInvalid();
        } catch {
            revert SelfLinkInvalid();
        }
        try self.isProofFresh(selfAgentId) returns (bool ok) {
            if (!ok) revert SelfLinkInvalid();
        } catch {
            revert SelfLinkInvalid();
        }
        _selfLinks[agentId] = selfAgentId;
        emit SelfAgentLinked(agentId, selfAgentId, msg.sender);
    }

    function approveRelease(
        uint256 agentId,
        bytes calldata pcr0,
        bytes calldata pcr1,
        bytes calldata pcr2,
        string calldata sourceRef
    ) external returns (bytes32 releaseId) {
        _requireOwner(agentId);
        if (!_validPcr(pcr0) || !_validPcr(pcr1) || !_validPcr(pcr2)) revert InvalidPcr();
        uint256 refLength = bytes(sourceRef).length;
        if (refLength == 0 || refLength > 256) revert InvalidSourceRef();
        releaseId = keccak256(abi.encodePacked(pcr0, pcr1, pcr2));
        Release storage r = _releases[agentId][releaseId];
        if (r.status != ReleaseStatus.None) revert ReleaseExists();
        r.status = ReleaseStatus.Approved;
        r.approvedAt = uint64(block.timestamp);
        r.statusChangedAt = uint64(block.timestamp);
        emit ReleaseApproved(agentId, releaseId, pcr0, pcr1, pcr2, sourceRef);
    }

    function setReleaseStatus(uint256 agentId, bytes32 releaseId, ReleaseStatus to) external {
        _requireOwner(agentId);
        Release storage r = _releases[agentId][releaseId];
        ReleaseStatus from = r.status;
        bool allowed =
            (from == ReleaseStatus.Approved && (to == ReleaseStatus.Deprecated || to == ReleaseStatus.Revoked))
                || (from == ReleaseStatus.Deprecated && (to == ReleaseStatus.Approved || to == ReleaseStatus.Revoked));
        if (!allowed) revert InvalidTransition();
        r.status = to;
        r.statusChangedAt = uint64(block.timestamp);
        emit ReleaseStatusChanged(agentId, releaseId, from, to);
    }

    function addEndpoint(uint256 agentId, string calldata origin, address payTo, address operator)
        external
        returns (bytes32 originHash)
    {
        _requireOwner(agentId);
        if (!_validOrigin(bytes(origin))) revert InvalidOrigin();
        if (payTo == address(0) || operator == address(0)) revert ZeroAddress();
        originHash = keccak256(bytes(origin));
        Endpoint storage e = _endpoints[originHash];
        if (e.status == EndpointStatus.Active) revert OriginTaken();
        e.agentId = agentId;
        e.payTo = payTo;
        e.operator = operator;
        e.status = EndpointStatus.Active;
        e.updatedAt = uint64(block.timestamp);
        emit EndpointAdded(originHash, agentId, origin, payTo, operator);
    }

    function retireEndpoint(bytes32 originHash) external {
        Endpoint storage e = _endpoints[originHash];
        _requireOwner(e.agentId);
        if (e.status != EndpointStatus.Active) revert EndpointNotActive();
        e.status = EndpointStatus.Retired;
        e.updatedAt = uint64(block.timestamp);
        emit EndpointRetired(originHash, e.agentId);
    }

    function revokeSigner(address signer) external {
        Signer storage s = _signers[signer];
        _requireOwner(s.agentId);
        if (s.status != SignerStatus.Active) revert SignerNotActive();
        s.status = SignerStatus.Revoked;
        emit SignerRevoked(signer, s.agentId);
    }

    // ------------------------------------------------------------- operator

    function registerSigner(
        uint256 agentId,
        bytes32 originHash,
        bytes calldata attestation,
        bytes calldata attestationSigHints
    ) external returns (address signer) {
        Endpoint storage e = _endpoints[originHash];
        if (e.status != EndpointStatus.Active) revert EndpointInactive();
        if (e.agentId != agentId) revert EndpointMismatch();
        if (msg.sender != e.operator) revert NotOperator();

        Attested memory a = _verifyAttestation(agentId, originHash, attestation, attestationSigHints);
        signer = a.signer;
        Signer storage s = _signers[signer];
        if (s.status != SignerStatus.None) revert SignerExists();

        uint64 expiresAt = uint64(block.timestamp) + SIGNER_TTL;
        s.agentId = agentId;
        s.releaseId = a.releaseId;
        s.originHash = originHash;
        s.operator = e.operator;
        s.registeredAt = uint64(block.timestamp);
        s.expiresAt = expiresAt;
        s.status = SignerStatus.Active;
        s.attestationHash = a.attestationHash;
        emit SignerRegistered(signer, agentId, a.releaseId, originHash, e.operator, expiresAt, a.attestationHash, a.ts);
    }

    function renewSigner(address signer, bytes calldata attestation, bytes calldata attestationSigHints) external {
        Signer storage s = _signers[signer];
        if (s.status != SignerStatus.Active || block.timestamp >= s.expiresAt) revert SignerNotActive();
        Endpoint storage e = _endpoints[s.originHash];
        if (e.status != EndpointStatus.Active) revert EndpointInactive();
        if (e.agentId != s.agentId) revert EndpointMismatch();
        if (msg.sender != e.operator || e.operator != s.operator) revert NotOperator();

        Attested memory a = _verifyAttestation(s.agentId, s.originHash, attestation, attestationSigHints);
        if (a.signer != signer) revert SignerMismatch();
        if (a.releaseId != s.releaseId) revert ReleaseMismatch();

        uint64 expiresAt = uint64(block.timestamp) + SIGNER_TTL;
        s.expiresAt = expiresAt;
        s.attestationHash = a.attestationHash;
        emit SignerRenewed(signer, s.agentId, expiresAt, a.attestationHash, a.ts);
    }

    // ---------------------------------------------------------------- views

    function releases(uint256 agentId, bytes32 releaseId) external view returns (Release memory) {
        return _releases[agentId][releaseId];
    }

    function endpoints(bytes32 originHash) external view returns (Endpoint memory) {
        return _endpoints[originHash];
    }

    function signers(address signer) external view returns (Signer memory) {
        return _signers[signer];
    }

    function selfLinks(uint256 agentId) external view returns (uint256) {
        return _selfLinks[agentId];
    }

    function checkSigner(address signer, bytes32 originHash)
        public
        view
        returns (Check code, Signer memory s, Endpoint memory e)
    {
        s = _signers[signer];
        e = _endpoints[originHash];
        if (s.status == SignerStatus.None) return (Check.UNKNOWN_SIGNER, s, e);
        if (s.status == SignerStatus.Revoked) return (Check.SIGNER_REVOKED, s, e);
        if (block.timestamp >= s.expiresAt) return (Check.SIGNER_EXPIRED, s, e);
        if (s.originHash != originHash) return (Check.ENDPOINT_MISMATCH, s, e);
        if (e.status != EndpointStatus.Active) return (Check.ENDPOINT_INACTIVE, s, e);
        if (e.agentId != s.agentId) return (Check.AGENT_MISMATCH, s, e);
        if (e.operator != s.operator) return (Check.OPERATOR_MISMATCH, s, e);
        if (_releases[s.agentId][s.releaseId].status != ReleaseStatus.Approved) {
            return (Check.RELEASE_NOT_APPROVED, s, e);
        }
        return (Check.OK, s, e);
    }

    function verifyProof(ExecutionProof calldata p, bytes calldata signature, bytes32 originHash)
        external
        view
        returns (Check code)
    {
        address recovered = _recover(proofDigest(p), signature);
        if (recovered == address(0)) return Check.BAD_SIGNATURE;
        Signer memory s;
        (code, s,) = checkSigner(recovered, originHash);
        if (code != Check.OK) return code;
        if (p.agentId != s.agentId) return Check.AGENT_MISMATCH;
        if (p.releaseId != s.releaseId) return Check.RELEASE_NOT_APPROVED;
        if (block.timestamp > p.expiresAt) return Check.PROOF_EXPIRED;
        uint256 skew = p.issuedAt > block.timestamp ? p.issuedAt - block.timestamp : block.timestamp - p.issuedAt;
        if (skew > MAX_PROOF_SKEW) return Check.PROOF_CLOCK_SKEW;
        return Check.OK;
    }

    function proofDigest(ExecutionProof calldata p) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                EXECUTION_PROOF_TYPEHASH,
                p.agentId,
                p.releaseId,
                p.requestId,
                p.requestHash,
                p.responseHash,
                p.inputsHash,
                p.paymentId,
                p.issuedAt,
                p.expiresAt
            )
        );
        return _hashTyped(structHash);
    }

    function livenessDigest(uint256 agentId, bytes32 releaseId, bytes32 originHash, bytes32 challenge, uint64 issuedAt)
        external
        view
        returns (bytes32)
    {
        return _hashTyped(keccak256(abi.encode(LIVENESS_TYPEHASH, agentId, releaseId, originHash, challenge, issuedAt)));
    }

    // ------------------------------------------------------------- internal

    /// Owner = `ownerOf(agentId)` read now; a revert inside `ownerOf` (burned token) is `NotOwner`.
    function _requireOwner(uint256 agentId) private view {
        try IIdentityRegistry(identityRegistry).ownerOf(agentId) returns (address owner) {
            if (owner != msg.sender) revert NotOwner();
        } catch {
            revert NotOwner();
        }
    }

    /// registerSigner steps 2-7. Every field is read from `tbs` through the validator's `Ptrs`;
    /// nothing is ever read from `attestation`.
    function _verifyAttestation(uint256 agentId, bytes32 originHash, bytes calldata attestation, bytes calldata hints)
        private
        returns (Attested memory a)
    {
        // Step 2.
        NitroValidator validator = NitroValidator(nitroValidator);
        (bytes memory tbs, bytes memory sig) = validator.decodeAttestationTbs(attestation);
        NitroValidator.Ptrs memory ptrs = validator.validateAttestationWithHints(tbs, sig, hints);

        // Step 3. The age guard keeps ts in (now, now + MAX_FUTURE_SKEW] from underflowing.
        uint64 ts = ptrs.timestamp / 1000;
        if (ts > block.timestamp + MAX_FUTURE_SKEW) revert AttestationFromFuture();
        uint256 age = ts > block.timestamp ? 0 : block.timestamp - ts;
        if (age > MAX_ATTESTATION_AGE) revert AttestationStale();

        // Steps 4 and 5.
        a.releaseId = _releaseIdOf(tbs, ptrs);
        if (_releases[agentId][a.releaseId].status != ReleaseStatus.Approved) revert ReleaseNotApproved();

        // Step 6.
        _checkBinding(tbs, ptrs.userData, agentId, originHash);

        // Step 7.
        a.signer = _signerOf(tbs, ptrs.publicKey);
        a.attestationHash = keccak256(tbs);
        a.ts = ts;
    }

    /// Step 4: PCR0-2 non-null, 48 bytes, not all zero. Returns keccak256(pcr0 ‖ pcr1 ‖ pcr2).
    function _releaseIdOf(bytes memory tbs, NitroValidator.Ptrs memory ptrs) private pure returns (bytes32) {
        bytes memory pcr0 = _pcrAt(tbs, ptrs, 0);
        bytes memory pcr1 = _pcrAt(tbs, ptrs, 1);
        bytes memory pcr2 = _pcrAt(tbs, ptrs, 2);
        if (_allZero(pcr0) || _allZero(pcr1) || _allZero(pcr2)) revert DebugPcrs();
        return keccak256(abi.encodePacked(pcr0, pcr1, pcr2));
    }

    /// Step 6: `user_data` is exactly abi.encode(BINDING_TYPEHASH, chainid, this, agentId, originHash).
    function _checkBinding(bytes memory tbs, CborElement ptr, uint256 agentId, bytes32 originHash) private view {
        if (ptr.isNull() || ptr.length() != USER_DATA_LENGTH) revert BindingMismatch(0);
        bytes memory userData = tbs.slice(ptr);
        bytes memory expected = abi.encode(BINDING_TYPEHASH, block.chainid, address(this), agentId, originHash);
        for (uint8 field = 1; field <= 5; field++) {
            uint256 offset = uint256(field - 1) * 32;
            if (userData.keccak(offset, 32) != expected.keccak(offset, 32)) revert BindingMismatch(field);
        }
    }

    /// Step 7: `public_key` is 0x04 ‖ X ‖ Y; signer = address(keccak256(X ‖ Y)).
    function _signerOf(bytes memory tbs, CborElement ptr) private pure returns (address) {
        if (ptr.isNull() || ptr.length() != PUBLIC_KEY_LENGTH) revert InvalidPublicKey();
        bytes memory publicKey = tbs.slice(ptr);
        if (publicKey[0] != 0x04) revert InvalidPublicKey();
        return address(uint160(uint256(publicKey.keccak(1, 64))));
    }

    /// PCR `index` from `tbs`: non-null and exactly 48 bytes.
    function _pcrAt(bytes memory tbs, NitroValidator.Ptrs memory ptrs, uint256 index)
        private
        pure
        returns (bytes memory)
    {
        CborElement ptr = ptrs.pcrs[index];
        if (ptr.isNull() || ptr.length() != PCR_LENGTH) revert InvalidPcr();
        return tbs.slice(ptr);
    }

    function _validPcr(bytes calldata pcr) private pure returns (bool) {
        return pcr.length == PCR_LENGTH && !_allZero(pcr);
    }

    function _allZero(bytes memory b) private pure returns (bool) {
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] != 0) return false;
        }
        return true;
    }

    function _validOrigin(bytes calldata origin) private view returns (bool) {
        if (origin.length < 9 || origin.length > 267) return false;
        if (_hasPrefix(origin, "https://")) return true;
        return allowLocalOrigins && _hasPrefix(origin, "http://localhost");
    }

    function _hasPrefix(bytes calldata s, bytes memory prefix) private pure returns (bool) {
        return s.length >= prefix.length && keccak256(s[:prefix.length]) == keccak256(prefix);
    }

    function _hashTyped(bytes32 structHash) private view returns (bytes32) {
        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    /// 65-byte r ‖ s ‖ v, v in {27, 28}, low s. Returns zero for anything malformed.
    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (v != 27 && v != 28) return address(0);
        if (uint256(s) > HALF_N) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
