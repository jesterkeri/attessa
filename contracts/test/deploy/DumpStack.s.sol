// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {P384Verifier} from "nitro-validator/P384Verifier.sol";
import {NitroValidator} from "nitro-validator/NitroValidator.sol";
import {CertManagerDemo} from "../../lib/nitro-validator/test/helpers/CertManagerDemo.sol";
import {EnclaveRegistry} from "../../src/EnclaveRegistry.sol";
import {MockNitroValidator} from "../mocks/Mocks.sol";
import {ValidatorStackDeployer, RegistryDeployer} from "../../script/DeployBase.sol";

/// Test-only, for scripts/check-deploy.test.mjs. Runs the deploy scripts' own deploy code in-process
/// (no RPC, no transactions) and dumps the resulting state, which the test loads into anvil as genesis.
/// `variant`: "production" (the deploy scripts' code), "demo" (CertManagerDemo, as base's demo script
/// deploys it) or "mock-validator" (the registry wired to MockNitroValidator). check-deploy must pass
/// only the first.
contract DumpStack is Script, ValidatorStackDeployer, RegistryDeployer {
    string internal constant DIR = "cache/check-deploy/";

    function run(string calldata variant) external {
        vm.chainId(CELO_SEPOLIA);
        address admin = address(uint160(uint256(keccak256("attessa check-deploy test admin"))));
        bytes32 v = keccak256(bytes(variant));
        ValidatorStack memory s;
        address validator;
        if (v == keccak256("demo")) {
            s.p384Verifier = new P384Verifier();
            s.certManager = new CertManagerDemo(s.p384Verifier, 365 days);
            s.nitroValidator = new NitroValidator(s.certManager, s.p384Verifier);
            admin = s.certManager.owner(); // CertManagerDemo makes its deployer owner; so only the code check fails
            validator = address(s.nitroValidator);
        } else if (v == keccak256("mock-validator")) {
            s = _deployValidatorStack(admin);
            validator = address(new MockNitroValidator());
        } else {
            require(v == keccak256("production"), "variant: production, demo or mock-validator");
            s = _deployValidatorStack(admin);
            validator = address(s.nitroValidator);
        }
        EnclaveRegistry registry = _deployRegistry(validator);

        string memory k = "manifest";
        vm.serializeAddress(k, "Admin", admin);
        vm.serializeAddress(k, "P384Verifier", address(s.p384Verifier));
        vm.serializeAddress(k, "CertManager", address(s.certManager));
        vm.serializeAddress(k, "NitroValidator", validator);
        string memory json = vm.serializeAddress(k, "EnclaveRegistry", address(registry));
        vm.createDir(DIR, true);
        vm.writeJson(json, string.concat(DIR, variant, ".manifest.json"));
        vm.dumpState(string.concat(DIR, variant, ".state.json"));
    }
}
