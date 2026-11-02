// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {console} from "forge-std/Script.sol";
import {DeployScript, ValidatorStackDeployer} from "./DeployBase.sol";

/// SPEC §3.5: production P384Verifier -> CertManager(p384, admin, admin) -> NitroValidator(certManager, p384).
/// env ATTESSA_ADMIN: the cold admin EOA that owns the CertManager and holds its revoker role (L3).
contract DeployValidatorStack is DeployScript, ValidatorStackDeployer {
    function run() external returns (ValidatorStack memory s) {
        _requireSepolia();
        address admin = vm.envAddress("ATTESSA_ADMIN");
        address deployer = _startBroadcast();
        require(admin != address(0), "ATTESSA_ADMIN is zero");
        require(admin != deployer, "ATTESSA_ADMIN must be the cold admin key, not the deployer");
        s = _deployValidatorStack(admin);
        vm.stopBroadcast();

        console.log("deployer      ", deployer);
        console.log("admin         ", admin);
        console.log("P384Verifier  ", address(s.p384Verifier));
        console.log("CertManager   ", address(s.certManager));
        console.log("NitroValidator", address(s.nitroValidator));
    }
}
