// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Script.sol";
import {NitroValidator} from "nitro-validator/NitroValidator.sol";
import {EnclaveRegistry} from "../src/EnclaveRegistry.sol";
import {DeployScript, RegistryDeployer} from "./DeployBase.sol";

/// SPEC §3.5: EnclaveRegistry(identity, nitroValidator, self, false). Immutable, no admin (ADR-002).
/// env ATTESSA_NITRO_VALIDATOR: the NitroValidator from DeployValidatorStack.
contract DeployRegistry is DeployScript, RegistryDeployer {
    function run() external returns (EnclaveRegistry registry) {
        _requireSepolia();
        address validator = vm.envAddress("ATTESSA_NITRO_VALIDATOR");
        require(validator.code.length != 0, "ATTESSA_NITRO_VALIDATOR has no code");
        require(
            address(NitroValidator(validator).certManager()).code.length != 0, "validator's CertManager has no code"
        );
        require(SEPOLIA_IDENTITY.code.length != 0, "ERC-8004 identity registry has no code on this chain");
        require(SEPOLIA_SELF.code.length != 0, "Self registry has no code on this chain");

        address deployer = _startBroadcast();
        registry = _deployRegistry(validator);
        vm.stopBroadcast();

        console.log("deployer       ", deployer);
        console.log("NitroValidator ", validator);
        console.log("EnclaveRegistry", address(registry));
    }
}
