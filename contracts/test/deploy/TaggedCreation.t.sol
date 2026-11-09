// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {P384Verifier} from "nitro-validator/P384Verifier.sol";
import {IP384Verifier} from "nitro-validator/IP384Verifier.sol";
import {CertManager} from "nitro-validator/CertManager.sol";
import {ICertManager} from "nitro-validator/ICertManager.sol";
import {NitroValidator} from "nitro-validator/NitroValidator.sol";
import {EnclaveRegistry} from "../../src/EnclaveRegistry.sol";

/// T30: the mainnet route sends each creation as `initcode ++ abi.encode(args) ++ ERC-8021 suffix` (scripts/tagged-deploy.mjs).
/// The EVM runs the initcode, which reads its constructor arguments from a fixed offset and returns a fixed runtime
/// code, so trailing bytes should change nothing. These tests prove it for each of the four contracts, with the
/// suffix for a real-shaped code and for the 32-character maximum, by creating each contract twice with assembly
/// `create` (the opcode a creation transaction runs) and comparing the runtime code and every constructor-set slot.
/// The suffixes below are the output of attributionSuffix() in packages/core/src/attribution.ts.
/// No env var is read or set here: vm.setEnv is process-wide and forge runs tests in parallel.
contract TaggedCreationTest is Test {
    address internal constant ADMIN = address(0xA11CE);
    address internal constant REVOKER = address(0xB0B);
    address internal constant IDENTITY = 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432;
    address internal constant SELF = 0xaC3DF9ABf80d0F5c020C06B04Cced27763355944;
    bytes32 internal constant ROOT_CA_CERT_HASH = 0x311d96fcd5c5e0ccf72ef548e2ea7d4c0cd53ad7c4cc49e67471aed41d61f185;

    // attributionSuffix("celo_test1234"): 13 code bytes, length 0x0d, schema 0x00, marker.
    bytes internal constant SUFFIX_13 = hex"63656c6f5f74657374313233340d0080218021802180218021802180218021";
    // attributionSuffix("abcdefghijklmnopqrstuvwxyz012345"): 32 code bytes, length 0x20, schema 0x00, marker.
    bytes internal constant SUFFIX_32 =
        hex"6162636465666768696a6b6c6d6e6f707172737475767778797a303132333435200080218021802180218021802180218021";
    bytes16 internal constant MARKER = hex"80218021802180218021802180218021";

    function _create(bytes memory data) internal returns (address a) {
        assembly ("memory-safe") {
            a := create(0, add(data, 32), mload(data))
        }
        require(a != address(0), "create failed");
    }

    function _suffixes() internal pure returns (bytes[2] memory s) {
        s[0] = SUFFIX_13;
        s[1] = SUFFIX_32;
    }

    function _slots(address a) internal view returns (bytes32[16] memory out) {
        for (uint256 i = 0; i < 16; i++) {
            out[i] = vm.load(a, bytes32(i));
        }
    }

    function _sameCode(address plain, address tagged) internal view {
        assertGt(plain.code.length, 0, "no code");
        assertEq(tagged.code.length, plain.code.length, "runtime length");
        assertEq(tagged.codehash, plain.codehash, "runtime code hash");
        assertEq(keccak256(tagged.code), keccak256(plain.code), "runtime code");
    }

    function _sameSlots(address plain, address tagged) internal view {
        bytes32[16] memory p = _slots(plain);
        bytes32[16] memory t = _slots(tagged);
        for (uint256 i = 0; i < 16; i++) {
            assertEq(t[i], p[i], "storage slot");
        }
    }

    function test_suffixes_areSchema0() public pure {
        bytes[2] memory s = _suffixes();
        for (uint256 i = 0; i < 2; i++) {
            bytes memory x = s[i];
            uint256 n = uint8(x[x.length - 18]);
            assertEq(uint8(x[x.length - 17]), 0, "schema byte");
            assertEq(x.length, n + 1 + 1 + 16, "code + length + schema + marker");
            bytes16 m;
            assembly ("memory-safe") {
                m := mload(add(add(x, 32), sub(mload(x), 16)))
            }
            assertEq(m, MARKER);
        }
        assertEq(SUFFIX_13.length, 13 + 18);
        assertEq(SUFFIX_32.length, 32 + 18);
    }

    function test_p384Verifier_taggedCreationChangesNothing() public {
        bytes memory base = type(P384Verifier).creationCode;
        address plain = _create(base);
        bytes[2] memory s = _suffixes();
        for (uint256 i = 0; i < 2; i++) {
            address tagged = _create(bytes.concat(base, s[i]));
            _sameCode(plain, tagged);
            _sameSlots(plain, tagged);
        }
    }

    function _certManagerArgs(address p384) internal pure returns (bytes memory) {
        return abi.encode(IP384Verifier(p384), ADMIN, REVOKER);
    }

    function test_certManager_taggedCreationChangesNothing() public {
        address p384 = _create(type(P384Verifier).creationCode);
        bytes memory base = bytes.concat(type(CertManager).creationCode, _certManagerArgs(p384));
        address plain = _create(base);
        bytes[2] memory s = _suffixes();
        for (uint256 i = 0; i < 2; i++) {
            address tagged = _create(bytes.concat(base, s[i]));
            _sameCode(plain, tagged);
            _sameSlots(plain, tagged);
            CertManager t = CertManager(tagged);
            CertManager p = CertManager(plain);
            assertEq(t.owner(), ADMIN, "owner");
            assertEq(t.revoker(), REVOKER, "revoker");
            assertEq(t.owner(), p.owner());
            assertEq(t.revoker(), p.revoker());
            assertEq(address(t.p384Verifier()), p384, "p384 immutable");
            assertEq(address(p.p384Verifier()), p384);
            // The constructor stores the root certificate; the tagged one stores the same bytes.
            assertGt(p.verified(ROOT_CA_CERT_HASH).length, 0, "root stored");
            assertEq(keccak256(t.verified(ROOT_CA_CERT_HASH)), keccak256(p.verified(ROOT_CA_CERT_HASH)), "root cert");
            assertFalse(t.revoked(ROOT_CA_CERT_HASH));
        }
    }

    function test_certManager_sameRoleAdmin() public {
        // The production deploy uses one admin for both roles (SPEC §3.5).
        address p384 = _create(type(P384Verifier).creationCode);
        bytes memory base = bytes.concat(type(CertManager).creationCode, abi.encode(IP384Verifier(p384), ADMIN, ADMIN));
        address tagged = _create(bytes.concat(base, SUFFIX_32));
        assertEq(CertManager(tagged).owner(), ADMIN);
        assertEq(CertManager(tagged).revoker(), ADMIN);
    }

    function test_nitroValidator_taggedCreationChangesNothing() public {
        address p384 = _create(type(P384Verifier).creationCode);
        address cm = _create(bytes.concat(type(CertManager).creationCode, _certManagerArgs(p384)));
        bytes memory base =
            bytes.concat(type(NitroValidator).creationCode, abi.encode(ICertManager(cm), IP384Verifier(p384)));
        address plain = _create(base);
        bytes[2] memory s = _suffixes();
        for (uint256 i = 0; i < 2; i++) {
            address tagged = _create(bytes.concat(base, s[i]));
            _sameCode(plain, tagged);
            _sameSlots(plain, tagged);
            assertEq(address(NitroValidator(tagged).certManager()), cm, "certManager immutable");
            assertEq(address(NitroValidator(tagged).p384Verifier()), p384, "p384 immutable");
        }
    }

    function test_enclaveRegistry_taggedCreationChangesNothing() public {
        address p384 = _create(type(P384Verifier).creationCode);
        address cm = _create(bytes.concat(type(CertManager).creationCode, _certManagerArgs(p384)));
        address nv =
            _create(bytes.concat(type(NitroValidator).creationCode, abi.encode(ICertManager(cm), IP384Verifier(p384))));
        bytes memory base = bytes.concat(type(EnclaveRegistry).creationCode, abi.encode(IDENTITY, nv, SELF, false));
        address plain = _create(base);
        bytes[2] memory s = _suffixes();
        for (uint256 i = 0; i < 2; i++) {
            address tagged = _create(bytes.concat(base, s[i]));
            _sameCode(plain, tagged);
            _sameSlots(plain, tagged);
            EnclaveRegistry r = EnclaveRegistry(tagged);
            assertEq(r.identityRegistry(), IDENTITY, "identity");
            assertEq(r.nitroValidator(), nv, "validator");
            assertEq(r.selfRegistry(), SELF, "self");
            assertFalse(r.allowLocalOrigins(), "allowLocalOrigins");
        }
    }

    /// A creation one word short of its arguments does not quietly take the missing address from the suffix:
    /// the suffix word is not a valid address (upper bits set), so the creation fails. tagged-deploy.mjs still
    /// encodes every argument itself and checks `file minus suffix == bytecode + args`.
    function test_suffixCannotFillAMissingArgument() public {
        address p384 = _create(type(P384Verifier).creationCode);
        bytes memory data =
            bytes.concat(type(CertManager).creationCode, abi.encode(IP384Verifier(p384), ADMIN), SUFFIX_32);
        address a;
        assembly ("memory-safe") {
            a := create(0, add(data, 32), mload(data))
        }
        assertEq(a, address(0), "creation must fail");
    }
}
