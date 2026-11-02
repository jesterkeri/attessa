// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {P384Verifier} from "nitro-validator/P384Verifier.sol";
import {IP384Verifier} from "nitro-validator/IP384Verifier.sol";
import {CertManager} from "nitro-validator/CertManager.sol";
import {ICertManager} from "nitro-validator/ICertManager.sol";
import {NitroValidator} from "nitro-validator/NitroValidator.sol";
import {EnclaveRegistry} from "../src/EnclaveRegistry.sol";

/// SPEC §3.5 and ADR-001: our own instance of base's production stack from the pinned submodule.
/// Never CertManagerDemo.
abstract contract ValidatorStackDeployer {
    struct ValidatorStack {
        P384Verifier p384Verifier;
        CertManager certManager;
        NitroValidator nitroValidator;
    }

    function _deployValidatorStack(address admin) internal returns (ValidatorStack memory s) {
        s.p384Verifier = new P384Verifier();
        s.certManager = new CertManager(s.p384Verifier, admin, admin);
        s.nitroValidator = new NitroValidator(s.certManager, s.p384Verifier);
    }
}

/// SPEC §3.5: the registry embeds its NitroValidator forever (ADR-002), so before any broadcast the
/// validator, its CertManager and its P384Verifier must run exactly the runtime code this build
/// compiles from the pinned submodule, immutables included. The references are created in the
/// script's own EVM (never broadcast) with the immutables the deployed contracts report, so a
/// code-hash match proves both the code and those immutables. Any look-alike fails.
/// The references come from this build, so a remapping in remappings.txt, foundry.toml or
/// ~/.foundry/foundry.toml that swaps a pinned source would pass that check (T10 adversary r5 M, G).
/// So each runtime code is also pinned whole: keccak256 of the code this repo's committed settings
/// compile from nitro-validator 0ea0d12366b4fa44f9e07e4755f2ad36561cb674, with every immutable's
/// 32-byte word zeroed, after checking that each such word holds the address the stack reports
/// (offsets from the build's immutableReferences). P384Verifier has no immutables: its codehash.
/// Any other byte, length or immutable value is refused (T10 adversary r6 D: a trailer alone is not).
/// All of this runs inside the build it guards: a committed remapping can swap this file itself (T10
/// adversary r7 X). `node scripts/check-deploy.mjs --pre-deploy`, run before every simulation and
/// broadcast, proves that build is the committed one.
/// The CBOR metadata trailers (IPFS hash of the metadata JSON, which commits to every source's path
/// and keccak256 and to the settings) are checked too; the whole-code pin already covers them.
abstract contract ValidatorStackChecker {
    bytes32 internal constant P384_VERIFIER_CODEHASH =
        0x8fd030adc83776191eb6bd006135f34e1ad114d8c6cd5cbb8fb5ce3860cdca3d;
    bytes32 internal constant CERT_MANAGER_CODE = 0x5246ebbad7caa8df452b1f7adbc95883e08e1b0e4bbc64cda7e4c8624ecc224d;
    bytes32 internal constant NITRO_VALIDATOR_CODE = 0xe45bfed4f16e6fdbd5fc5c039901754029e7b75b0c95d0de248a70eaa223a914;

    bytes internal constant P384_VERIFIER_METADATA =
        hex"a2646970667358221220a4380a5295ccfddabe19a6d3ff1c7b2a9578f06e0985c4981082937d6b358b3064736f6c634300081a0033";
    bytes internal constant CERT_MANAGER_METADATA =
        hex"a264697066735822122024d7e8c08531c9b5e7698bae37ecf18a7336d316cdfec4d8acd0b6ac646cf5b064736f6c634300081a0033";
    bytes internal constant NITRO_VALIDATOR_METADATA =
        hex"a2646970667358221220717acedda25a6850820d738ce214e1a556f071e4152e30629dd452946f9f6e5264736f6c634300081a0033";

    function _endsWith(address a, bytes memory tail) private view returns (bool) {
        bytes memory c = a.code;
        if (c.length < tail.length) return false;
        bytes32 h;
        assembly ("memory-safe") {
            h := keccak256(add(add(c, 32), sub(mload(c), mload(tail))), mload(tail))
        }
        return h == keccak256(tail);
    }

    /// True if the 32-byte word at `at` in `code` holds `value`; zeroes that word either way.
    function _takeImmutable(bytes memory code, uint256 at, address value) private pure returns (bool ok) {
        if (at + 32 > code.length) return false;
        uint256 v = uint160(value);
        assembly ("memory-safe") {
            let p := add(add(code, 32), at)
            ok := eq(mload(p), v)
            mstore(p, 0)
        }
    }

    function _requireProductionStack(address validator) internal returns (address certManager, address p384) {
        require(validator.code.length != 0, "ATTESSA_NITRO_VALIDATOR has no code");
        certManager = address(NitroValidator(validator).certManager());
        p384 = address(NitroValidator(validator).p384Verifier());
        require(certManager.code.length != 0, "validator's CertManager has no code");
        require(p384.code.length != 0, "validator's P384Verifier has no code");
        require(
            validator.codehash == address(new NitroValidator(ICertManager(certManager), IP384Verifier(p384))).codehash,
            "ATTESSA_NITRO_VALIDATOR is not the production NitroValidator"
        );
        // owner and revoker are storage, not immutables: any non-zero pair gives the same runtime code.
        require(
            certManager.codehash == address(new CertManager(IP384Verifier(p384), address(1), address(1))).codehash,
            "validator's CertManager is not the production CertManager over the validator's P384Verifier"
        );
        require(
            p384.codehash == address(new P384Verifier()).codehash,
            "validator's P384Verifier is not the production P384Verifier"
        );
        require(
            _endsWith(validator, NITRO_VALIDATOR_METADATA) && _endsWith(certManager, CERT_MANAGER_METADATA)
                && _endsWith(p384, P384_VERIFIER_METADATA),
            "this build of the validator stack is not the pinned nitro-validator sources under the production settings"
        );
        bytes memory nv = validator.code;
        bytes memory cm = certManager.code;
        // Offsets: NitroValidator certManager 599, 6203, 6453 and p384Verifier 445, 3439; CertManager p384Verifier 782, 8275.
        require(
            _takeImmutable(nv, 599, certManager) && _takeImmutable(nv, 6203, certManager)
                && _takeImmutable(nv, 6453, certManager) && _takeImmutable(nv, 445, p384)
                && _takeImmutable(nv, 3439, p384) && keccak256(nv) == NITRO_VALIDATOR_CODE
                && _takeImmutable(cm, 782, p384) && _takeImmutable(cm, 8275, p384) && keccak256(cm) == CERT_MANAGER_CODE
                && p384.codehash == P384_VERIFIER_CODEHASH,
            "the validator stack's runtime code is not the pinned nitro-validator build"
        );
    }
}

/// SPEC §3.5: `EnclaveRegistry(identity, nitroValidator, self, false)` with the §3.5 table's addresses.
abstract contract RegistryDeployer {
    uint256 internal constant CELO_SEPOLIA = 11142220;
    address internal constant SEPOLIA_IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address internal constant SEPOLIA_SELF = 0x043DaCac8b0771DD5b444bCC88f2f8BBDBEdd379;

    function _deployRegistry(address nitroValidator) internal returns (EnclaveRegistry) {
        return new EnclaveRegistry(SEPOLIA_IDENTITY, nitroValidator, SEPOLIA_SELF, false);
    }
}

/// Shared by the two deploy scripts. Celo Sepolia only: mainnet is T30, after Gate 5.
abstract contract DeployScript is Script {
    uint256 internal constant SEPOLIA_CHAIN_ID = 11142220;

    function _requireSepolia() internal view {
        require(block.chainid == SEPOLIA_CHAIN_ID, "Celo Sepolia (11142220) only until Gate 5");
    }

    /// The key comes from `--account <keystore>` (or `--ledger`), or from env PRIVATE_KEY; never inline.
    function _startBroadcast() internal returns (address deployer) {
        uint256 pk = vm.envOr("PRIVATE_KEY", uint256(0));
        if (pk != 0) vm.startBroadcast(pk);
        else vm.startBroadcast();
        (, deployer,) = vm.readCallers();
    }
}
