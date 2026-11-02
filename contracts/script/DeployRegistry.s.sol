// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Script.sol";
import {EnclaveRegistry} from "../src/EnclaveRegistry.sol";
import {DeployScript, RegistryDeployer, ValidatorStackChecker} from "./DeployBase.sol";

/// SPEC §3.5: EnclaveRegistry(identity, nitroValidator, self, false). Immutable, no admin (ADR-002).
/// env ATTESSA_NITRO_VALIDATOR: the NitroValidator from DeployValidatorStack. Refused before
/// broadcasting unless it and its CertManager and P384Verifier are the production stack.
contract DeployRegistry is DeployScript, RegistryDeployer, ValidatorStackChecker {
    function run() external returns (EnclaveRegistry) {
        return _run(vm.envAddress("ATTESSA_NITRO_VALIDATOR"));
    }

    function _run(address validator) internal returns (EnclaveRegistry registry) {
        _requireSepolia();
        (address certManager, address p384) = _requireProductionStack(validator);
        require(SEPOLIA_IDENTITY.code.length != 0, "ERC-8004 identity registry has no code on this chain");
        require(SEPOLIA_SELF.code.length != 0, "Self registry has no code on this chain");

        address deployer = _startBroadcast();
        registry = _deployRegistry(validator);
        vm.stopBroadcast();

        console.log("deployer       ", deployer);
        console.log("P384Verifier   ", p384);
        console.log("CertManager    ", certManager);
        console.log("NitroValidator ", validator);
        console.log("EnclaveRegistry", address(registry));
    }
}
