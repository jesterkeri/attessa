// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {NitroValidator} from "nitro-validator/NitroValidator.sol";
import {CborElement, LibCborElement} from "nitro-validator/CborDecode.sol";

/// Stands in for NitroValidator. `decodeAttestationTbs` returns a `tbs` that differs from the
/// attestation (attestation = 64 junk bytes ‖ tbs), and every `Ptrs` field it returns is an offset
/// into `tbs`, so a registry that reads from `attestation` reads the wrong bytes.
contract MockNitroValidator {
    uint256 public constant JUNK_LENGTH = 64;

    /// Raw `CborElement`s (offsets into tbs) and the ms timestamp the test wants returned for a tbs.
    struct Result {
        bool set;
        uint64 timestampMs;
        uint256 pcr0;
        uint256 pcr1;
        uint256 pcr2;
        uint256 publicKey;
        uint256 userData;
    }

    mapping(bytes32 => Result) public results;
    bool public rejectAll;

    function setResult(bytes32 tbsHash, Result calldata r) external {
        results[tbsHash] = r;
    }

    function setRejectAll(bool reject) external {
        rejectAll = reject;
    }

    function decodeAttestationTbs(bytes calldata attestation)
        external
        pure
        returns (bytes memory attestationTbs, bytes memory signature)
    {
        require(attestation.length > JUNK_LENGTH, "mock: short attestation");
        attestationTbs = attestation[JUNK_LENGTH:];
        signature = hex"5151";
    }

    function validateAttestationWithHints(bytes calldata attestationTbs, bytes calldata signature, bytes calldata)
        external
        view
        returns (NitroValidator.Ptrs memory ptrs)
    {
        require(!rejectAll, "mock: invalid sig");
        require(keccak256(signature) == keccak256(hex"5151"), "mock: signature not from decode");
        Result memory r = results[keccak256(attestationTbs)];
        require(r.set, "mock: unknown tbs");
        ptrs.timestamp = r.timestampMs;
        ptrs.pcrs = new CborElement[](32);
        CborElement nullPtr = LibCborElement.toCborElement(0xf6, 0, 0);
        for (uint256 i = 3; i < 32; i++) {
            ptrs.pcrs[i] = nullPtr;
        }
        ptrs.pcrs[0] = CborElement.wrap(r.pcr0);
        ptrs.pcrs[1] = CborElement.wrap(r.pcr1);
        ptrs.pcrs[2] = CborElement.wrap(r.pcr2);
        ptrs.publicKey = CborElement.wrap(r.publicKey);
        ptrs.userData = CborElement.wrap(r.userData);
    }
}

/// ERC-8004 Identity Registry stand-in: `ownerOf` reverts for a missing or burned token.
contract MockIdentityRegistry {
    mapping(uint256 => address) private _owners;

    function setOwner(uint256 agentId, address owner) external {
        _owners[agentId] = owner;
    }

    function ownerOf(uint256 agentId) external view returns (address owner) {
        owner = _owners[agentId];
        require(owner != address(0), "ERC721NonexistentToken");
    }
}

/// Self Agent Registry stand-in. Each read can be made to revert.
contract MockSelfRegistry {
    mapping(uint256 => address) public owners;
    mapping(uint256 => bool) public human;
    mapping(uint256 => bool) public fresh;
    bool public revertOwnerOf;
    bool public revertHuman;
    bool public revertFresh;

    function set(uint256 id, address owner, bool human_, bool fresh_) external {
        owners[id] = owner;
        human[id] = human_;
        fresh[id] = fresh_;
    }

    function setReverts(bool ownerOf_, bool human_, bool fresh_) external {
        revertOwnerOf = ownerOf_;
        revertHuman = human_;
        revertFresh = fresh_;
    }

    function ownerOf(uint256 id) external view returns (address) {
        require(!revertOwnerOf, "self: ownerOf");
        return owners[id];
    }

    function hasHumanProof(uint256 id) external view returns (bool) {
        require(!revertHuman, "self: hasHumanProof");
        return human[id];
    }

    function isProofFresh(uint256 id) external view returns (bool) {
        require(!revertFresh, "self: isProofFresh");
        return fresh[id];
    }
}
