// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {CborElement, LibCborElement} from "nitro-validator/CborDecode.sol";
import {EnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {MockNitroValidator} from "../mocks/Mocks.sol";

/// Builds mock attestations: tbs = 16-byte header ‖ timestamp ‖ pcr0 ‖ pcr1 ‖ pcr2 ‖ user_data ‖
/// public_key, attestation = 64 junk bytes ‖ tbs, and registers the matching `Ptrs` (offsets into
/// tbs) with the mock validator.
abstract contract AttestationKit {
    uint8 internal constant NULL_PCR0 = 1;
    uint8 internal constant NULL_PCR1 = 2;
    uint8 internal constant NULL_PCR2 = 4;
    uint8 internal constant NULL_PUBLIC_KEY = 8;
    uint8 internal constant NULL_USER_DATA = 16;

    struct AttInput {
        uint64 timestampMs;
        bytes pcr0;
        bytes pcr1;
        bytes pcr2;
        bytes userData;
        bytes publicKey;
        uint8 nullMask;
    }

    function _junk() internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256("attessa junk a"), keccak256("attessa junk b"));
    }

    function _tbsOf(AttInput memory a) internal pure returns (bytes memory) {
        return abi.encodePacked("attessa-mock-tbs", a.timestampMs, a.pcr0, a.pcr1, a.pcr2, a.userData, a.publicKey);
    }

    function _attest(MockNitroValidator nitro, AttInput memory a) internal returns (bytes memory attestation) {
        bytes memory tbs = _tbsOf(a);
        MockNitroValidator.Result memory r;
        r.set = true;
        r.timestampMs = a.timestampMs;
        uint256 off = 16 + 8;
        r.pcr0 = _ptr(a.nullMask & NULL_PCR0 != 0, off, a.pcr0.length);
        off += a.pcr0.length;
        r.pcr1 = _ptr(a.nullMask & NULL_PCR1 != 0, off, a.pcr1.length);
        off += a.pcr1.length;
        r.pcr2 = _ptr(a.nullMask & NULL_PCR2 != 0, off, a.pcr2.length);
        off += a.pcr2.length;
        r.userData = _ptr(a.nullMask & NULL_USER_DATA != 0, off, a.userData.length);
        off += a.userData.length;
        r.publicKey = _ptr(a.nullMask & NULL_PUBLIC_KEY != 0, off, a.publicKey.length);
        nitro.setResult(keccak256(tbs), r);
        attestation = abi.encodePacked(_junk(), tbs);
    }

    function _ptr(bool isNull, uint256 start, uint256 length) private pure returns (uint256) {
        if (isNull) return CborElement.unwrap(LibCborElement.toCborElement(0xf6, 0, 0));
        return CborElement.unwrap(LibCborElement.toCborElement(0x40, start, length));
    }

    function _binding(EnclaveRegistry registry, uint256 agentId, bytes32 originHash)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(registry.BINDING_TYPEHASH(), block.chainid, address(registry), agentId, originHash);
    }

    function _publicKey(uint256 x, uint256 y) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes1(0x04), x, y);
    }

    function _fill(bytes1 b, uint256 n) internal pure returns (bytes memory out) {
        out = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            out[i] = b;
        }
    }
}
