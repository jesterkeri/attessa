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
abstract contract ValidatorStackChecker {
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
